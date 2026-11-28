import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { addDays, extendedEndDate, noticeDeadline } from './contract-rules';

/**
 * Avtalsbevakning. Påminnelserna räknas fram ur avtalens datum vid varje anrop,
 * så att de alltid stämmer med avtalet. Bara det som användaren gjort med en
 * påminnelse (klar eller uppskjuten) sparas, i contract_alert_ack.
 */
export type AlertKind =
  | 'notice_deadline'
  | 'auto_extended'
  | 'ending'
  | 'renegotiate'
  | 'index'
  | 'rent_change'
  | 'line_ends'
  | 'security_expiry'
  | 'deposit_due'
  | 'draft'
  | 'no_lines';

/** Inställningen för framförhållning som styr en typ av påminnelse. */
export type LeadGroup = 'notice' | 'ending' | 'renegotiate' | 'index' | 'rent_change' | 'security' | 'fixed';

export const LEAD_GROUP: Record<AlertKind, LeadGroup> = {
  notice_deadline: 'notice',
  auto_extended: 'notice',
  ending: 'ending',
  renegotiate: 'renegotiate',
  index: 'index',
  rent_change: 'rent_change',
  line_ends: 'rent_change',
  security_expiry: 'security',
  deposit_due: 'security',
  draft: 'fixed',
  no_lines: 'fixed',
};

export const KIND_LABEL: Record<AlertKind, string> = {
  notice_deadline: 'Sista dag för uppsägning',
  auto_extended: 'Förlängs automatiskt',
  ending: 'Avtalet upphör',
  renegotiate: 'Omförhandling',
  index: 'KPI-uppräkning',
  rent_change: 'Hyran ändras',
  line_ends: 'Hyresrad upphör',
  security_expiry: 'Säkerhet löper ut',
  deposit_due: 'Säkerhet ska lämnas',
  draft: 'Utkast',
  no_lines: 'Saknar hyra',
};

/** Påminnelser som ligger kvar efter sitt datum tills någon gjort något. */
const STAYS_WHEN_OVERDUE = new Set<AlertKind>(['auto_extended', 'renegotiate', 'index', 'security_expiry', 'deposit_due', 'draft', 'no_lines']);

export interface AlertSettings {
  noticeDays: number;
  endingDays: number;
  renegotiateDays: number;
  indexDays: number;
  rentChangeDays: number;
  securityDays: number;
}

export const DEFAULT_SETTINGS: AlertSettings = {
  noticeDays: 120,
  endingDays: 90,
  renegotiateDays: 120,
  indexDays: 60,
  rentChangeDays: 30,
  securityDays: 60,
};

export function leadDays(s: AlertSettings, kind: AlertKind): number {
  switch (LEAD_GROUP[kind]) {
    case 'notice':
      return s.noticeDays;
    case 'ending':
      return s.endingDays;
    case 'renegotiate':
      return s.renegotiateDays;
    case 'index':
      return s.indexDays;
    case 'rent_change':
      return s.rentChangeDays;
    case 'security':
      return s.securityDays;
    default:
      return 14;
  }
}

export interface AlertAck {
  id: string;
  action: 'done' | 'snooze';
  snoozeUntil: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface ContractAlert {
  key: string;
  kind: AlertKind;
  label: string;
  /** Datumet påminnelsen gäller, till exempel sista dag för uppsägning. */
  date: string;
  severity: 'high' | 'normal';
  overdue: boolean;
  message: string;
  /** Vad som bör göras, kort. */
  action: string | null;
  /** Sida i systemet där åtgärden görs. */
  link: string;
  contractId: string;
  contractNr: number;
  contractType: string;
  companyId: string;
  companyName: string;
  customerName: string;
  objects: string;
  ack: AlertAck | null;
}

interface ContractRow {
  id: string;
  companyId: string;
  companyName: string;
  contractNr: number;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  noticeMonths: number;
  extensionMonths: number | null;
  renegotiateBy: string | null;
  customerName: string;
  objects: string;
  hasLines: boolean;
}

const kr = (ore: number) => `${Math.round(ore / 100).toLocaleString('sv-SE').replace(/\s/g, ' ')} kr`;
const DEPOSIT: Record<string, string> = { deposit: 'Depositionen', bank_guarantee: 'Bankgarantin', surety: 'Borgen', other: 'Säkerheten' };
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

export interface EventQuery {
  from: string;
  to: string;
  contractId?: string;
  /** Referensdag, normalt i dag. */
  now?: string;
}

/**
 * Alla datum som rör avtalen mellan from och to, oavsett framförhållning.
 * Används för kalendern och avtalssidan. Pågående problem (utkast, avtal utan
 * hyra, avtal som förlängts automatiskt) tas med när deras datum ligger i spannet.
 */
export async function contractEvents(client: PoolClient, q: EventQuery): Promise<ContractAlert[]> {
  const now = q.now ?? today();
  const contractId = q.contractId ?? null;
  const { rows: contracts } = await client.query<ContractRow>(
    `select k.id, k.company_id as "companyId", co.name as "companyName", k.contract_nr as "contractNr", k.type, k.status,
            k.start_date::text as "startDate", k.end_date::text as "endDate",
            k.notice_months as "noticeMonths", k.extension_months as "extensionMonths",
            k.renegotiate_by::text as "renegotiateBy", c.name as "customerName",
            coalesce((select string_agg(o.object_nr || ' ' || p.name, ', ' order by o.object_nr) from contract_object x
               join rental_object o on o.id = x.object_id join property p on p.id = o.property_id where x.contract_id = k.id), '') as objects,
            exists (select 1 from contract_line l where l.contract_id = k.id
               and l.valid_from <= greatest($1::date, k.start_date)
               and (l.valid_to is null or l.valid_to >= greatest($1::date, k.start_date))) as "hasLines"
     from contract k
     join customer c on c.id = k.customer_id
     join company co on co.id = k.company_id
     where k.status in ('draft','active','terminated')
       and (k.end_date is null or k.end_date >= $2::date)
       and ($3::uuid is null or k.id = $3)`,
    [now, q.from, contractId],
  );
  const byId = new Map(contracts.map((k) => [k.id, k]));
  const out: ContractAlert[] = [];
  const inRange = (d: string | null): boolean => !!d && d >= q.from && d <= q.to;

  const push = (
    k: ContractRow,
    kind: AlertKind,
    date: string,
    message: string,
    o: { ref?: string; action?: string | null; link?: string; high?: boolean } = {},
  ) => {
    const overdue = date < now;
    out.push({
      key: [kind, k.id, date, o.ref].filter(Boolean).join(':'),
      kind,
      label: KIND_LABEL[kind],
      date,
      overdue,
      severity: o.high || overdue || date <= addDays(now, 30) ? 'high' : 'normal',
      message,
      action: o.action ?? null,
      link: o.link ?? `/avtal/${k.id}`,
      contractId: k.id,
      contractNr: k.contractNr,
      contractType: k.type,
      companyId: k.companyId,
      companyName: k.companyName,
      customerName: k.customerName,
      objects: k.objects,
      ack: null,
    });
  };

  for (const k of contracts) {
    if (k.status === 'draft') {
      if (inRange(k.startDate) || (k.startDate < now && q.from <= now && q.to >= now)) {
        push(k, 'draft', k.startDate, `Avtalet är ett utkast och ska börja gälla ${k.startDate}.`, {
          action: 'Aktivera avtalet när det är undertecknat',
          high: k.startDate <= addDays(now, 14),
        });
      }
      continue;
    }
    if (k.status === 'active' && k.endDate) {
      const deadline = noticeDeadline(k.endDate, k.noticeMonths)!;
      if (deadline >= now && inRange(deadline)) {
        const commercial = k.type === 'commercial';
        push(
          k,
          'notice_deadline',
          deadline,
          `Avtalet löper till ${k.endDate}` +
            (k.extensionMonths ? ` och förlängs annars med ${k.extensionMonths} månader.` : '.') +
            ` Uppsägningen måste ha kommit fram senast ${deadline} (${k.noticeMonths} månaders uppsägningstid).`,
          {
            action: commercial
              ? 'Bestäm om avtalet ska löpa vidare, omförhandlas (säg upp för villkorsändring) eller sägas upp'
              : 'Bestäm om avtalet ska löpa vidare eller sägas upp',
          },
        );
      } else if (deadline < now && k.extensionMonths) {
        const next = extendedEndDate(k.endDate, k.extensionMonths);
        if (k.endDate < now && q.from <= now && q.to >= now) {
          push(k, 'auto_extended', k.endDate, `Avtalstiden gick ut ${k.endDate} utan uppsägning. Avtalet har förlängts till ${next}.`, {
            action: 'Registrera förlängningen på avtalet',
            high: true,
          });
        } else if (inRange(k.endDate)) {
          push(
            k,
            'auto_extended',
            k.endDate,
            `Sista dag för uppsägning var ${deadline}. Avtalet förlängs från ${addDays(k.endDate, 1)} till ${next}.`,
            { action: 'Registrera förlängningen på avtalet' },
          );
        }
      }
      if (!k.extensionMonths && inRange(k.endDate)) {
        push(k, 'ending', k.endDate, `Tidsbestämt avtal utan förlängning. Upphör ${k.endDate}.`, {
          action: 'Planera avflyttning och besiktning, eller teckna nytt avtal',
          high: true,
        });
      }
    }
    if (k.status === 'terminated' && inRange(k.endDate)) {
      push(k, 'ending', k.endDate!, `Avtalet är uppsagt och upphör ${k.endDate}.`, {
        action: 'Planera avflyttning, besiktning och återbetalning av säkerhet',
      });
    }
    if (inRange(k.renegotiateBy)) {
      push(k, 'renegotiate', k.renegotiateBy!, `Avtalet ska omförhandlas senast ${k.renegotiateBy}.`, {
        action: 'Kontakta hyresgästen och för in nya villkor',
      });
    }
    if (k.status === 'active' && !k.hasLines && k.startDate <= addDays(now, 30) && q.from <= now && q.to >= now) {
      push(k, 'no_lines', k.startDate < now ? now : k.startDate, 'Avtalet är aktivt men har inga gällande hyresrader, så ingen hyra aviseras.', {
        action: 'Lägg till hyresrader',
        high: true,
      });
    }
  }

  if (!contracts.length) return out;
  const ids = contracts.map((k) => k.id);
  const fromYear = Number(q.from.slice(0, 4));
  const toYear = Number(q.to.slice(0, 4));

  // KPI-uppräkning: ett datum per år enligt indexklausulen
  const { rows: idx } = await client.query(
    `select ic.contract_id as "contractId", ic.adjust_month as "adjustMonth", ic.base_month as "baseMonth",
            ic.last_adjusted::text as "lastAdjusted", y as year,
            make_date(y, ic.adjust_month, 1)::text as "adjustDate",
            exists (select 1 from contract_line l where l.contract_id = ic.contract_id and l.article = 'index'
              and l.valid_from >= make_date(y, ic.adjust_month, 1)
              and l.valid_from < make_date(y + 1, ic.adjust_month, 1)) as done,
            exists (select 1 from kpi_value v where v.year = y - 1 and v.month = ic.base_month) as "hasKpi"
     from contract_index_clause ic
     cross join generate_series($2::int, $3::int) y
     where ic.contract_id = any($1)`,
    [ids, fromYear, toYear],
  );
  for (const r of idx) {
    const k = byId.get(r.contractId)!;
    if (!inRange(r.adjustDate) || r.done) continue;
    if (r.lastAdjusted && r.lastAdjusted >= r.adjustDate) continue;
    if (k.status === 'draft' || k.startDate > r.adjustDate || (k.endDate && k.endDate < r.adjustDate)) continue;
    // Missade uppräkningar längre bak än ett halvår visas inte som påminnelser
    if (r.adjustDate < addDays(now, -183)) continue;
    const kpiMonth = `${MONTHS[r.baseMonth - 1]} ${r.year - 1}`;
    push(
      k,
      'index',
      r.adjustDate,
      `Hyran ska räknas upp efter KPI från ${r.adjustDate}. ` +
        (r.hasKpi ? `KPI för ${kpiMonth} finns inlagt.` : `KPI för ${kpiMonth} är inte inlagt än.`),
      {
        action: r.hasKpi ? 'Kör indexuppräkningen' : `Lägg in KPI för ${kpiMonth} och kör indexuppräkningen`,
        link: `/avtal/indexering?ar=${r.year}`,
      },
    );
  }

  // Hyresändringar: nya hyresrader som börjar gälla under avtalstiden (trappor, justeringar)
  const { rows: changes } = await client.query(
    `select l.contract_id as "contractId", l.valid_from::text as date,
            string_agg(distinct l.description, ', ') as descriptions,
            (select coalesce(sum(x.amount_ore), 0) from contract_line x where x.contract_id = l.contract_id
               and x.valid_from <= l.valid_from and (x.valid_to is null or x.valid_to >= l.valid_from))::float as "newOre",
            (select coalesce(sum(x.amount_ore), 0) from contract_line x where x.contract_id = l.contract_id
               and x.valid_from <= l.valid_from - 1 and (x.valid_to is null or x.valid_to >= l.valid_from - 1))::float as "oldOre"
     from contract_line l
     join contract k on k.id = l.contract_id
     where l.contract_id = any($1) and l.article <> 'index' and l.valid_from > k.start_date
       and l.valid_from between $2::date and $3::date
     group by l.contract_id, l.valid_from`,
    [ids, q.from, q.to],
  );
  for (const r of changes) {
    const k = byId.get(r.contractId)!;
    if (k.status === 'draft' || (k.endDate && r.date > k.endDate)) continue;
    if (r.newOre === r.oldOre) continue;
    push(k, 'rent_change', r.date, `Hyran ändras från ${r.date} (${r.descriptions}): ${kr(r.oldOre)} blir ${kr(r.newOre)} per månad.`, {
      action: 'Kontrollera att hyresgästen har fått besked',
    });
  }

  // Hyresrader som upphör utan att ersättas, till exempel en tidsbegränsad rabatt
  const { rows: ends } = await client.query(
    `select l.id, l.contract_id as "contractId", l.valid_to::text as date, l.description, l.amount_ore::float as "amountOre"
     from contract_line l
     join contract k on k.id = l.contract_id
     where l.contract_id = any($1) and l.article <> 'index' and l.valid_to between $2::date and $3::date
       and (k.end_date is null or l.valid_to < k.end_date)
       and not exists (select 1 from contract_line n where n.contract_id = l.contract_id and n.article = l.article
                         and n.valid_from = l.valid_to + 1)`,
    [ids, q.from, q.to],
  );
  for (const r of ends) {
    const k = byId.get(r.contractId)!;
    if (k.status === 'draft') continue;
    push(k, 'line_ends', r.date, `Hyresraden ”${r.description}” (${kr(r.amountOre)} per månad) gäller till ${r.date}.`, {
      ref: r.id,
      action: 'Kontrollera om raden ska förlängas eller ersättas',
    });
  }

  // Säkerheter: som ska lämnas, och bankgarantier och borgen som löper ut
  const { rows: deps } = await client.query(
    `select id, contract_id as "contractId", kind, amount_ore::float as "amountOre",
            due_date::text as "dueDate", received_date::text as "receivedDate", returned_date::text as "returnedDate",
            valid_until::text as "validUntil"
     from contract_deposit where contract_id = any($1) and returned_date is null`,
    [ids],
  );
  for (const d of deps) {
    const k = byId.get(d.contractId)!;
    const what = `${DEPOSIT[d.kind] ?? 'Säkerheten'} på ${kr(d.amountOre)}`;
    if (!d.receivedDate && d.dueDate && (inRange(d.dueDate) || (d.dueDate < now && q.from <= now && q.to >= now))) {
      push(k, 'deposit_due', d.dueDate, d.dueDate < now ? `${what} skulle ha lämnats ${d.dueDate}.` : `${what} ska lämnas senast ${d.dueDate}.`, {
        ref: d.id,
        action: 'Påminn hyresgästen och registrera säkerheten när den kommit in',
      });
    }
    if (d.validUntil && (inRange(d.validUntil) || (d.validUntil < now && q.from <= now && q.to >= now)) && k.status !== 'draft') {
      const runsLonger = !k.endDate || k.endDate > d.validUntil;
      if (!runsLonger && d.validUntil >= now) continue;
      push(
        k,
        'security_expiry',
        d.validUntil,
        d.validUntil < now
          ? `${what} gällde till ${d.validUntil} men avtalet löper vidare.`
          : `${what} gäller till ${d.validUntil}, men avtalet löper ${k.endDate ? `till ${k.endDate}` : 'tills vidare'}.`,
        { ref: d.id, action: 'Begär förlängd eller ny säkerhet av hyresgästen' },
      );
    }
  }

  return out;
}

/** Sparade åtgärder (klar eller uppskjuten) per nyckel. */
async function loadAcks(client: PoolClient, keys: string[]): Promise<Map<string, AlertAck>> {
  if (!keys.length) return new Map();
  const { rows } = await client.query(
    `select a.alert_key as key, a.id, a.action, a.snooze_until::text as "snoozeUntil", a.note,
            a.created_at as "createdAt", u.name as "createdByName"
     from contract_alert_ack a left join app_user u on u.id = coalesce(a.updated_by, a.created_by)
     where a.alert_key = any($1)`,
    [keys],
  );
  return new Map(rows.map((r) => [r.key, { id: r.id, action: r.action, snoozeUntil: r.snoozeUntil, note: r.note, createdAt: r.createdAt, createdByName: r.createdByName }]));
}

export async function withAcks(client: PoolClient, items: ContractAlert[]): Promise<ContractAlert[]> {
  const acks = await loadAcks(client, items.map((i) => i.key));
  return items.map((i) => ({ ...i, ack: acks.get(i.key) ?? null }));
}

/** Framförhållning per bolag, med standardvärden för bolag som inte ändrat något. */
export async function loadSettings(client: PoolClient): Promise<Map<string, AlertSettings>> {
  const { rows } = await client.query(
    `select company_id as "companyId", notice_days as "noticeDays", ending_days as "endingDays",
            renegotiate_days as "renegotiateDays", index_days as "indexDays",
            rent_change_days as "rentChangeDays", security_days as "securityDays"
     from contract_alert_setting`,
  );
  return new Map(rows.map(({ companyId, ...s }) => [companyId, s as AlertSettings]));
}

const MAX_LEAD = 730;

export interface ActiveOptions {
  now?: string;
  /** Ta med påminnelser som markerats klara eller skjutits upp. */
  includeHandled?: boolean;
}

/**
 * Påminnelser att agera på nu: de vars datum ligger inom bolagets framförhållning,
 * och de som passerat men fortfarande kräver något. Klara och uppskjutna
 * påminnelser döljs (tills den uppskjutna dagen kommer).
 */
export async function activeAlerts(client: PoolClient, o: ActiveOptions = {}): Promise<ContractAlert[]> {
  const now = o.now ?? today();
  const settings = await loadSettings(client);
  const events = await contractEvents(client, { from: addDays(now, -400), to: addDays(now, MAX_LEAD), now });
  const current = events.filter((e) => {
    const lead = leadDays(settings.get(e.companyId) ?? DEFAULT_SETTINGS, e.kind);
    if (e.date > addDays(now, lead)) return false;
    return e.date >= now || STAYS_WHEN_OVERDUE.has(e.kind);
  });
  const withAck = await withAcks(client, current);
  const visible = o.includeHandled
    ? withAck
    : withAck.filter((e) => !e.ack || (e.ack.action === 'snooze' && e.ack.snoozeUntil! <= now));
  return visible.sort((a, b) =>
    a.severity === b.severity ? a.date.localeCompare(b.date) || a.contractNr - b.contractNr : a.severity === 'high' ? -1 : 1,
  );
}

/** Kalenderfil (iCalendar) med avtalsdatumen, för Outlook, Google Kalender eller iPhone. */
export function toIcs(items: ContractAlert[], baseUrl: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fold = (line: string) => {
    const parts: string[] = [];
    let rest = line;
    while (Buffer.byteLength(rest) > 73) {
      let n = 73;
      while (Buffer.byteLength(rest.slice(0, n)) > 73) n--;
      parts.push(rest.slice(0, n));
      rest = ' ' + rest.slice(n);
    }
    parts.push(rest);
    return parts.join('\r\n');
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fastighetssystem//Avtalsbevakning//SV', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Avtalsbevakning'];
  for (const i of items) {
    const d = i.date.replace(/-/g, '');
    const end = addDays(i.date, 1).replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${i.key.replace(/[^a-z0-9:-]/gi, '')}@fastighetssystem`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${end}`,
      fold(`SUMMARY:${esc(`${i.label}: ${i.customerName}, avtal ${i.contractNr}`)}`),
      fold(`DESCRIPTION:${esc(`${i.message}${i.action ? `\n${i.action}` : ''}\n${i.companyName}${i.objects ? ` · ${i.objects}` : ''}${baseUrl ? `\n${baseUrl}${i.link}` : ''}`)}`),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
