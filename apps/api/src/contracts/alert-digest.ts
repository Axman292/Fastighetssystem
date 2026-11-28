import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { deliverEmail } from '../billing/delivery';
import { getPool, withContext } from '../db/db';
import { activeAlerts, ContractAlert } from './alerts';

const HOUR = 60 * 60 * 1000;
/** Sammanfattningen skickas tidigast den här timmen, svensk tid. */
const SEND_HOUR = 7;

/** Datum, timme och veckodag (1 = måndag) i Sverige. */
export function stockholmNow(d = new Date()): { date: string; hour: number; weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday };
}

export interface Recipient {
  userId: string;
  name: string;
  email: string;
  companyIds: string[];
}

/** Användare som valts att få sammanfattningen och fortfarande har tillgång till bolaget. */
export async function recipients(client: PoolClient, companyIds: string[]): Promise<Recipient[]> {
  const { rows } = await client.query(
    `select u.id as "userId", u.name, u.email, array_agg(r.company_id) as "companyIds"
     from contract_alert_recipient r
     join app_user u on u.id = r.user_id and u.active
     where r.company_id = any($1)
       and (u.is_group_admin or exists (select 1 from membership m where m.user_id = u.id and m.company_id = r.company_id
              and (m.valid_until is null or m.valid_until >= current_date)))
     group by u.id, u.name, u.email
     order by u.name`,
    [companyIds],
  );
  return rows;
}

function line(a: ContractAlert): string {
  return `  ${a.date}  ${a.label}: ${a.customerName}, avtal ${a.contractNr}${a.objects ? ` (${a.objects})` : ''}\n` +
    `              ${a.message}${a.action ? `\n              Att göra: ${a.action}` : ''}`;
}

/** Texten i sammanfattningen. Grupperad på försenat, närmaste 30 dagarna och längre fram. */
export function digestText(items: ContractAlert[], today: string, baseUrl: string, multiCompany: boolean): string {
  const in30 = new Date(`${today}T00:00:00Z`);
  in30.setUTCDate(in30.getUTCDate() + 30);
  const limit = in30.toISOString().slice(0, 10);
  const groups: [string, ContractAlert[]][] = [
    ['Försenat', items.filter((i) => i.date < today)],
    ['Inom 30 dagar', items.filter((i) => i.date >= today && i.date <= limit)],
    ['Längre fram', items.filter((i) => i.date > limit)],
  ];
  const out = ['Hej,', '', `Här är avtalsbevakningen ${today}. ${items.length} ${items.length === 1 ? 'påminnelse' : 'påminnelser'} att hantera.`];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    out.push('', `${title.toUpperCase()} (${list.length})`);
    if (multiCompany) {
      const companies = [...new Set(list.map((i) => i.companyName))];
      for (const c of companies) {
        out.push('', ` ${c}`);
        for (const a of list.filter((i) => i.companyName === c)) out.push(line(a));
      }
    } else {
      for (const a of list) out.push(line(a));
    }
  }
  out.push('');
  if (baseUrl) out.push(`Öppna bevakningen: ${baseUrl}/avtal/bevakning`, '');
  out.push('Markera en påminnelse som klar eller skjut upp den i systemet, så kommer den inte med i nästa sammanfattning.');
  out.push('', 'Det här meddelandet skickas automatiskt. Vilka som får det ändras under Avtal → Bevakning → Inställningar.');
  return out.join('\n');
}

export interface DigestResult {
  recipients: number;
  sent: number;
  test: number;
  items: number;
  note: string;
}

/**
 * Skickar sammanfattningen för bolagen till deras mottagare. En användare som
 * är mottagare i flera bolag får ett samlat mejl. Utan påminnelser skickas inget.
 * Körs i en transaktion där companyIds är de bolag som RLS släpper igenom.
 */
export async function sendDigest(client: PoolClient, companyIds: string[], onlyTo?: Recipient): Promise<DigestResult> {
  const now = stockholmNow();
  const all = (await activeAlerts(client, { now: now.date })).filter((a) => companyIds.includes(a.companyId));
  const list = onlyTo ? [onlyTo] : await recipients(client, companyIds);
  const baseUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '') ?? '';
  const res: DigestResult = { recipients: list.length, sent: 0, test: 0, items: all.length, note: '' };
  for (const r of list) {
    const items = all.filter((a) => r.companyIds.includes(a.companyId));
    if (!items.length) continue;
    const urgent = items.filter((i) => i.severity === 'high').length;
    const { status } = await deliverEmail(
      {
        fromName: 'Fastighetssystemet',
        to: r.email,
        subject: `Avtalsbevakning: ${items.length} ${items.length === 1 ? 'påminnelse' : 'påminnelser'}${urgent ? `, ${urgent} brådskande` : ''}`,
        text: digestText(items, now.date, baseUrl, new Set(items.map((i) => i.companyId)).size > 1),
        attachments: [],
      },
      `avtalsbevakning-${now.date}-${r.userId.slice(0, 8)}`,
    );
    if (status === 'sent') res.sent++;
    else res.test++;
  }
  res.note = !list.length
    ? 'Inga mottagare är valda.'
    : !all.length
      ? 'Inga påminnelser att skicka.'
      : `Skickat till ${res.sent + res.test} av ${list.length} mottagare` + (res.test ? ` (${res.test} i testläge)` : '') + '.';
  return res;
}

/** Bolag där sammanfattningen är på tur nu: påslagen, rätt veckodag, efter kl. 7 och inte skickad i dag. */
export async function runDueDigests(log: (m: string) => void = () => undefined, at = new Date()): Promise<number> {
  const now = stockholmNow(at);
  if (now.hour < SEND_HOUR) return 0;
  const { rows } = await getPool().query(
    `select s.company_id as "companyId", c.group_id as "groupId"
     from contract_alert_setting s join company c on c.id = s.company_id
     where s.digest_enabled and c.active
       and (s.digest_frequency = 'daily' or s.digest_weekday = $2)
       and (s.last_digest_at is null or (s.last_digest_at at time zone 'Europe/Stockholm')::date < $1::date)`,
    [now.date, now.weekday],
  );
  const byGroup = new Map<string, string[]>();
  for (const r of rows) byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), r.companyId]);
  for (const [groupId, companyIds] of byGroup) {
    await withContext({ userId: '', groupId, companyIds }, async (_db, client) => {
      const res = await sendDigest(client, companyIds);
      await client.query(`update contract_alert_setting set last_digest_at = now(), last_digest_note = $2 where company_id = any($1)`, [
        companyIds,
        res.note,
      ]);
      log(`Avtalsbevakning: ${res.note}`);
    });
  }
  return rows.length;
}

/**
 * Skickar avtalsbevakningens e-postsammanfattning. Kontrollen görs varje timme.
 * Stängs av med CONTRACT_ALERTS_AUTO=off (och körs aldrig i testerna).
 */
@Injectable()
export class ContractAlertScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly log = new Logger('Avtalsbevakning');

  onApplicationBootstrap() {
    if (process.env.CONTRACT_ALERTS_AUTO === 'off' || process.env.VITEST) return;
    setTimeout(() => void this.tick(), 60_000).unref();
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      await runDueDigests((m) => this.log.log(m));
    } catch (e) {
      this.log.error(`Sammanfattningen kunde inte skickas: ${(e as Error).message}`);
    }
  }
}
