import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { allowlistBlock, deliverEmail, deliveryMode } from '../billing/delivery';
import { CONTRACT_TYPES } from '../contracts/contract.schemas';
import { OBJECT_TYPES } from '../properties/property.schemas';
import { deliverSms, normalizePhone, smsAllowlistBlock, smsMode, smsParts, smsSender } from './sms';

// -------------------------------------------------------------------- urval

/**
 * Avtalsstatus för urvalet:
 *  - current: hyresgäster som bor eller hyr nu (aktiva avtal som har börjat)
 *  - notice: uppsagda avtal som ännu inte har upphört
 *  - upcoming: aktiva avtal som börjar senare (kommande inflyttning)
 *  - ended: avtal som har upphört (tidigare hyresgäster)
 */
export const CONTRACT_STATUSES = ['current', 'notice', 'upcoming', 'ended'] as const;

export const criteriaSchema = z.object({
  propertyIds: z.array(z.string().uuid()).max(500).default([]),
  objectTypes: z.array(z.enum(OBJECT_TYPES)).max(20).default([]),
  contractTypes: z.array(z.enum(CONTRACT_TYPES)).max(10).default([]),
  contractStatuses: z.array(z.enum(CONTRACT_STATUSES)).max(4).default(['current', 'notice']),
  /** Skicka också till hyresgästens kontaktpersoner. */
  includeContacts: z.boolean().default(false),
});
export type Criteria = z.output<typeof criteriaSchema>;

const text = (max: number) => z.string().max(max).default('');

export const contentSchema = z.object({
  sendEmail: z.boolean().default(true),
  sendSms: z.boolean().default(false),
  subject: text(200),
  body: text(20000),
  smsBody: text(1600),
});

export const previewSchema = z.object({ criteria: criteriaSchema.default({}), content: contentSchema.default({}) });

export const sendSchema = previewSchema
  .extend({
    name: z.string().trim().min(1, 'Ge utskicket ett namn').max(200),
    templateId: z.string().uuid().nullable().optional(),
    /** Hyresgäster som valts bort i förhandsgranskningen. */
    excludeCustomerIds: z.array(z.string().uuid()).max(10000).default([]),
  })
  .superRefine((v, ctx) => contentIssues(v.content).forEach((i) => ctx.addIssue({ code: 'custom', ...i })));

export const testSchema = previewSchema.extend({
  email: z.string().trim().email('Ogiltig e-postadress').optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  customerId: z.string().uuid().nullable().optional(),
});

export const templateSchema = z.object({
  name: z.string().trim().min(1, 'Ange ett namn').max(120),
  subject: text(200),
  body: text(20000),
  smsBody: text(1600),
  active: z.boolean().default(true),
});

function contentIssues(c: z.output<typeof contentSchema>): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
  if (!c.sendEmail && !c.sendSms) out.push({ path: ['content', 'sendEmail'], message: 'Välj e-post, SMS eller båda' });
  if (c.sendEmail && !c.subject.trim()) out.push({ path: ['content', 'subject'], message: 'Skriv en ämnesrad' });
  if (c.sendEmail && !c.body.trim()) out.push({ path: ['content', 'body'], message: 'Skriv ett meddelande' });
  if (c.sendSms && !c.smsBody.trim()) out.push({ path: ['content', 'smsBody'], message: 'Skriv SMS-texten' });
  for (const key of ['subject', 'body', 'smsBody'] as const) {
    const bad = unknownFields(c[key]);
    if (bad.length) out.push({ path: ['content', key], message: `Okänt kopplingsfält: ${bad.map((b) => `{${b}}`).join(', ')}` });
  }
  return out;
}

// -------------------------------------------------------------------- kopplingsfält

export const MERGE_FIELDS: { key: string; label: string; example: string }[] = [
  { key: 'namn', label: 'Hyresgästens namn', example: 'Anna Andersson' },
  { key: 'förnamn', label: 'Förnamn (privatpersoner), annars hela namnet', example: 'Anna' },
  { key: 'kundnummer', label: 'Kundnummer', example: '1001' },
  { key: 'fastighet', label: 'Fastighet', example: 'Kornet 6' },
  { key: 'adress', label: 'Adress till objektet', example: 'Storgatan 1' },
  { key: 'objekt', label: 'Objektnummer', example: '1-1001' },
  { key: 'lägenhet', label: 'Lägenhetsnummer', example: '1102' },
  { key: 'avtal', label: 'Avtalsnummer', example: '12' },
  { key: 'bolag', label: 'Bolagets namn', example: 'Fastighets AB' },
  { key: 'datum', label: 'Dagens datum', example: '2026-11-28' },
];
const FIELD_KEYS = new Set(MERGE_FIELDS.map((f) => f.key));
const FIELD_RE = /\{\s*([a-zA-ZåäöÅÄÖ_]+)\s*\}/g;

export function unknownFields(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(FIELD_RE)) if (!FIELD_KEYS.has(m[1].toLowerCase())) out.add(m[1]);
  return [...out];
}

export function merge(template: string, values: Record<string, string>): string {
  return template.replace(FIELD_RE, (whole, key: string) => {
    const k = key.toLowerCase();
    return FIELD_KEYS.has(k) ? (values[k] ?? '') : whole;
  });
}

// -------------------------------------------------------------------- inbyggda mallar

export const BUILT_IN_TEMPLATES: { key: string; name: string; subject: string; body: string; smsBody: string }[] = [
  {
    key: 'vatten',
    name: 'Vattenavstängning',
    subject: 'Vattnet stängs av i {fastighet}',
    body:
      'Hej {namn},\n\nVi behöver stänga av vattnet i {fastighet} på grund av ett arbete i fastigheten.\n\n' +
      'När: [dag och datum], kl. [från]–[till]\n\nUnder den tiden går det inte att använda kran, dusch eller toalett. ' +
      'Tappa gärna upp vatten i förväg. När vattnet kommer tillbaka kan det vara missfärgat en kort stund. Spola då tills det blir klart.\n\n' +
      'Vi ber om ursäkt för besväret.\n\nVänliga hälsningar\n{bolag}',
    smsBody: 'Hej! Vattnet i {fastighet} stängs av [datum] kl. [från]-[till] på grund av arbete i fastigheten. Hälsningar {bolag}',
  },
  {
    key: 'underhall',
    name: 'Planerat underhåll',
    subject: 'Planerat arbete i {fastighet}',
    body:
      'Hej {namn},\n\nVi vill informera om att [vad som ska göras] kommer att utföras i {fastighet}.\n\n' +
      'När: [datum]\nBerör: [till exempel trapphus, tvättstuga, fasad]\n\n' +
      'Arbetet kan medföra visst buller. Hör av dig om du har frågor.\n\nVänliga hälsningar\n{bolag}',
    smsBody: 'Hej! [Vad] utförs i {fastighet} [datum]. Det kan bli visst buller. Hälsningar {bolag}',
  },
  {
    key: 'tilltrade',
    name: 'Tillträde till lägenhet',
    subject: 'Vi behöver komma in i din lägenhet',
    body:
      'Hej {namn},\n\nVi behöver tillträde till din lägenhet på {adress} för [anledning, till exempel byte av brandvarnare].\n\n' +
      'När: [datum], mellan kl. [från] och [till]\n\nOm du inte är hemma går vi in med huvudnyckel. ' +
      'Passar tiden inte, kontakta oss så hittar vi en annan.\n\nVänliga hälsningar\n{bolag}',
    smsBody: 'Hej! Vi behöver komma in i din lägenhet på {adress} [datum] kl. [från]-[till] för [anledning]. Vi använder huvudnyckel om du inte är hemma. Hälsningar {bolag}',
  },
  {
    key: 'information',
    name: 'Allmän information',
    subject: 'Information från {bolag}',
    body: 'Hej {namn},\n\n[Skriv ditt meddelande här.]\n\nVänliga hälsningar\n{bolag}',
    smsBody: 'Hej! [Meddelande] Hälsningar {bolag}',
  },
];

// -------------------------------------------------------------------- mottagare

export interface Tenant {
  customerId: string;
  customerNr: number;
  name: string;
  kind: 'person' | 'organization';
  email: string | null;
  phone: string | null;
  contacts: { name: string; email: string | null; phone: string | null }[];
  properties: string[];
  addresses: string[];
  objects: string[];
  apartments: string[];
  contracts: number[];
}

/** Hyresgäster i bolaget som har avtal som matchar urvalet, en rad per hyresgäst. */
export async function selectTenants(client: PoolClient, companyId: string, c: Criteria): Promise<Tenant[]> {
  const statuses = c.contractStatuses.length ? c.contractStatuses : [...CONTRACT_STATUSES];
  const { rows } = await client.query(
    `with k as (
       select k.id, k.contract_nr, k.customer_id
       from contract k
       where k.company_id = $1
         and (cardinality($3::text[]) = 0 or k.type = any($3))
         and (
           ('current' = any($2) and k.status = 'active' and k.start_date <= current_date and (k.end_date is null or k.end_date >= current_date))
           or ('notice' = any($2) and k.status = 'terminated' and coalesce(k.end_date, current_date) >= current_date)
           or ('upcoming' = any($2) and k.status = 'active' and k.start_date > current_date)
           or ('ended' = any($2) and k.status in ('active','terminated') and k.end_date < current_date)
         )
     ),
     ko as (
       select k.id as contract_id, k.contract_nr, k.customer_id, o.object_nr, o.apartment_nr,
              coalesce(o.address_line, p.address_line) as address, p.name as property_name
       from k
       join contract_object co on co.contract_id = k.id
       join rental_object o on o.id = co.object_id
       join property p on p.id = o.property_id
       where (cardinality($4::uuid[]) = 0 or p.id = any($4))
         and (cardinality($5::text[]) = 0 or o.type = any($5))
     )
     select c.id as "customerId", c.customer_nr as "customerNr", c.name, c.kind, c.email, c.phone,
            coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'email', x.email, 'phone', x.phone) order by x.name)
                      from customer_contact x where x.customer_id = c.id), '[]') as contacts,
            coalesce(array_agg(distinct ko.property_name) filter (where ko.property_name is not null), '{}') as properties,
            coalesce(array_agg(distinct ko.address) filter (where ko.address is not null), '{}') as addresses,
            coalesce(array_agg(distinct ko.object_nr), '{}') as objects,
            coalesce(array_agg(distinct ko.apartment_nr) filter (where ko.apartment_nr is not null), '{}') as apartments,
            coalesce(array_agg(distinct ko.contract_nr), '{}') as contracts
     from ko
     join customer c on c.id = ko.customer_id
     where c.anonymized_at is null
     group by c.id
     order by c.name, c.customer_nr`,
    [companyId, statuses, c.contractTypes, c.propertyIds, c.objectTypes],
  );
  return rows.map((r) => ({ ...r, contracts: r.contracts.map(Number).sort((a: number, b: number) => a - b) }));
}

export interface Delivery {
  channel: 'email' | 'sms';
  recipient: string | null;
  /** Vem adressen tillhör: hyresgästen eller en kontaktperson. */
  owner: string;
  skip: string | null;
}

/** Adresser och nummer en hyresgäst får utskicket till, och varför något hoppas över. */
export function deliveriesFor(t: Tenant, c: Criteria, content: { sendEmail: boolean; sendSms: boolean }): Delivery[] {
  const people = [{ name: t.name, email: t.email, phone: t.phone, own: true }, ...(c.includeContacts ? t.contacts.map((x) => ({ ...x, own: false })) : [])];
  const out: Delivery[] = [];
  if (content.sendEmail) {
    const seen = new Set<string>();
    for (const p of people) {
      const e = p.email?.trim();
      if (!e) continue;
      if (seen.has(e.toLowerCase())) continue;
      seen.add(e.toLowerCase());
      const valid = z.string().email().safeParse(e).success;
      out.push({ channel: 'email', recipient: e, owner: p.own ? t.name : p.name, skip: valid ? null : 'Ogiltig e-postadress' });
    }
    if (!seen.size) out.push({ channel: 'email', recipient: null, owner: t.name, skip: 'Saknar e-postadress' });
  }
  if (content.sendSms) {
    const seen = new Set<string>();
    let any = false;
    for (const p of people) {
      if (!p.phone?.trim()) continue;
      any = true;
      const n = normalizePhone(p.phone);
      if (n && seen.has(n.e164)) continue;
      if (n) seen.add(n.e164);
      out.push({
        channel: 'sms',
        recipient: n?.e164 ?? p.phone.trim(),
        owner: p.own ? t.name : p.name,
        skip: !n ? 'Ogiltigt telefonnummer' : !n.mobile ? 'Inte ett mobilnummer' : null,
      });
    }
    if (!any) out.push({ channel: 'sms', recipient: null, owner: t.name, skip: 'Saknar mobilnummer' });
  }
  return out;
}

export function valuesFor(t: Tenant, companyName: string): Record<string, string> {
  const first = t.kind === 'person' ? firstName(t.name) : t.name;
  return {
    namn: t.name,
    förnamn: first,
    kundnummer: String(t.customerNr),
    fastighet: t.properties.join(', '),
    adress: t.addresses.join(', '),
    objekt: t.objects.join(', '),
    lägenhet: t.apartments.join(', '),
    avtal: t.contracts.join(', '),
    bolag: companyName,
    datum: new Date().toISOString().slice(0, 10),
  };
}

/** "Andersson, Anna" och "Anna Andersson" ger båda "Anna". */
function firstName(name: string): string {
  const n = name.trim();
  if (n.includes(',')) return n.split(',')[1].trim().split(/\s+/)[0] || n;
  return n.split(/\s+/)[0] || n;
}

async function company(client: PoolClient, companyId: string) {
  const { rows } = await client.query('select name, invoice_email as "invoiceEmail" from company where id = $1', [companyId]);
  if (!rows[0]) throw new NotFoundException('Bolaget finns inte');
  return rows[0] as { name: string; invoiceEmail: string | null };
}

export function deliveryConfig() {
  const email = deliveryMode().email;
  const sms = smsMode();
  return {
    email,
    sms,
    allowlistOnly: process.env.EMAIL_ALLOWLIST_ONLY === 'true' || process.env.SMS_ALLOWLIST_ONLY === 'true',
    fields: MERGE_FIELDS,
  };
}

// -------------------------------------------------------------------- förhandsgranskning

export async function preview(client: PoolClient, companyId: string, input: z.output<typeof previewSchema>) {
  const co = await company(client, companyId);
  const tenants = await selectTenants(client, companyId, input.criteria);
  const { content } = input;
  const recipients = tenants.map((t) => {
    const v = valuesFor(t, co.name);
    const deliveries = deliveriesFor(t, input.criteria, content).map((d) => ({
      ...d,
      // Spärren i testmiljön visas redan i förhandsgranskningen.
      blocked:
        d.skip || !d.recipient
          ? null
          : d.channel === 'email'
            ? deliveryMode().email === 'test' ? null : allowlistBlock(d.recipient)
            : smsMode() === 'test' ? null : smsAllowlistBlock(d.recipient),
    }));
    return {
      customerId: t.customerId,
      customerNr: t.customerNr,
      name: t.name,
      properties: t.properties,
      objects: t.objects,
      deliveries,
      subject: content.sendEmail ? merge(content.subject, v) : null,
      body: content.sendEmail ? merge(content.body, v) : null,
      smsBody: content.sendSms ? merge(content.smsBody, v) : null,
    };
  });
  const all = recipients.flatMap((r) => r.deliveries);
  const smsTexts = recipients.map((r) => r.smsBody).filter((x): x is string => x !== null);
  const longest = smsTexts.reduce((a, b) => ([...b].length > [...a].length ? b : a), content.smsBody);
  return {
    recipients,
    summary: {
      tenants: recipients.length,
      emails: all.filter((d) => d.channel === 'email' && !d.skip).length,
      sms: all.filter((d) => d.channel === 'sms' && !d.skip).length,
      missingEmail: all.filter((d) => d.channel === 'email' && d.skip).length,
      missingSms: all.filter((d) => d.channel === 'sms' && d.skip).length,
      smsParts: smsParts(longest),
    },
    issues: contentIssues(content).map((i) => i.message),
    config: deliveryConfig(),
  };
}

// -------------------------------------------------------------------- utskick

/** Sparar utskicket och alla mottagare. Själva sändningen görs efteråt av sendQueued. */
export async function createCampaign(client: PoolClient, companyId: string, input: z.output<typeof sendSchema>) {
  const co = await company(client, companyId);
  const excluded = new Set(input.excludeCustomerIds);
  const tenants = (await selectTenants(client, companyId, input.criteria)).filter((t) => !excluded.has(t.customerId));
  if (!tenants.length) throw new BadRequestException('Inga hyresgäster matchar urvalet');
  const { content } = input;

  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`message_campaign:${companyId}`]);
  const nr = (await client.query('select coalesce(max(campaign_nr), 0) + 1 as nr from message_campaign where company_id = $1', [companyId])).rows[0].nr;
  const { rows } = await client.query(
    `insert into message_campaign (company_id, campaign_nr, name, send_email, send_sms, subject, body, sms_body, criteria, template_id, recipient_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, campaign_nr as "campaignNr"`,
    [
      companyId,
      nr,
      input.name,
      content.sendEmail,
      content.sendSms,
      content.sendEmail ? content.subject : null,
      content.sendEmail ? content.body : null,
      content.sendSms ? content.smsBody : null,
      JSON.stringify({ ...input.criteria, excludeCustomerIds: input.excludeCustomerIds }),
      input.templateId ?? null,
      tenants.length,
    ],
  );
  const campaignId = rows[0].id as string;

  const cols: unknown[][] = [];
  for (const t of tenants) {
    const v = valuesFor(t, co.name);
    for (const d of deliveriesFor(t, input.criteria, content)) {
      const email = d.channel === 'email';
      cols.push([
        t.customerId,
        d.owner === t.name ? t.name : `${t.name} (${d.owner})`,
        d.channel,
        d.recipient,
        email ? merge(content.subject, v) : null,
        email ? merge(content.body, v) : merge(content.smsBody, v),
        d.skip ? 'skipped' : 'queued',
        d.skip,
      ]);
    }
  }
  const col = (i: number) => cols.map((c) => c[i]);
  await client.query(
    `insert into message_recipient (company_id, campaign_id, customer_id, customer_name, channel, recipient, subject, body, status, note)
     select $1, $2, * from unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])`,
    [companyId, campaignId, col(0), col(1), col(2), col(3), col(4), col(5), col(6), col(7)],
  );
  return { id: campaignId, campaignNr: rows[0].campaignNr as number };
}

/** Antal mottagare som väntar på att skickas. */
export async function queuedCount(client: PoolClient, campaignId: string): Promise<number> {
  return (await client.query(`select count(*)::int as n from message_recipient where campaign_id = $1 and status = 'queued'`, [campaignId])).rows[0].n;
}

/**
 * Skickar upp till limit köade mottagare i utskicket och markerar hur det gick.
 * Returnerar hur många som återstår.
 */
export async function sendBatch(client: PoolClient, campaignId: string, limit = 25): Promise<number> {
  const { rows: c } = await client.query(
    `select m.id, m.company_id as "companyId", co.name as "companyName", co.invoice_email as "replyTo"
     from message_campaign m join company co on co.id = m.company_id where m.id = $1`,
    [campaignId],
  );
  if (!c[0]) throw new NotFoundException('Utskicket finns inte');
  const camp = c[0];
  const { rows } = await client.query(
    `select id, channel, recipient, subject, body from message_recipient
     where campaign_id = $1 and status = 'queued' order by created_at, id limit $2 for update skip locked`,
    [campaignId, limit],
  );
  for (const r of rows) {
    try {
      const out =
        r.channel === 'email'
          ? await deliverEmail(
              { fromName: camp.companyName, to: r.recipient, replyTo: camp.replyTo, subject: r.subject, text: r.body, attachments: [] },
              `utskick-${campaignId}-${r.id}`,
            )
          : await deliverSms({ from: smsSender(camp.companyName), to: r.recipient, text: r.body }, `utskick-${campaignId}-${r.id}`);
      await client.query(`update message_recipient set status = $2, note = $3, sent_at = now() where id = $1`, [r.id, out.status, out.note]);
    } catch (err) {
      await client.query(`update message_recipient set status = 'failed', note = $2 where id = $1`, [r.id, (err as Error).message.slice(0, 500)]);
    }
  }
  const left = await queuedCount(client, campaignId);
  await client.query(`update message_campaign set status = $2 where id = $1 and status <> $2`, [campaignId, left ? 'sending' : 'done']);
  return left;
}

/** Lägger misslyckade mottagare i kö igen. */
export async function requeueFailed(client: PoolClient, campaignId: string): Promise<number> {
  const n = (await client.query(`update message_recipient set status = 'queued', note = null where campaign_id = $1 and status = 'failed'`, [campaignId])).rowCount ?? 0;
  if (n) await client.query(`update message_campaign set status = 'sending' where id = $1`, [campaignId]);
  return n;
}

/** Ett provutskick till användaren själv, med en hyresgästs uppgifter i kopplingsfälten. */
export async function sendTest(client: PoolClient, companyId: string, input: z.output<typeof testSchema>, fallbackEmail: string) {
  const co = await company(client, companyId);
  const tenants = await selectTenants(client, companyId, input.criteria);
  const t = tenants.find((x) => x.customerId === input.customerId) ?? tenants[0];
  const v = t
    ? valuesFor(t, co.name)
    : Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.key === 'bolag' ? co.name : f.example]));
  const { content } = input;
  const result: { channel: string; to: string; status: string; note: string | null }[] = [];
  if (content.sendEmail) {
    const to = input.email || fallbackEmail;
    const out = await deliverEmail(
      { fromName: co.name, to, replyTo: co.invoiceEmail, subject: `[Prov] ${merge(content.subject, v)}`, text: merge(content.body, v), attachments: [] },
      `utskick-prov-${Date.now()}`,
    );
    result.push({ channel: 'email', to, ...out });
  }
  if (content.sendSms) {
    const n = normalizePhone(input.phone);
    if (!n) throw new BadRequestException('Ange ditt mobilnummer för att få ett prov-SMS');
    const out = await deliverSms({ from: smsSender(co.name), to: n.e164, text: merge(content.smsBody, v) }, `utskick-prov-${Date.now()}`);
    result.push({ channel: 'sms', to: n.e164, ...out });
  }
  return { result, tenantName: t?.name ?? null };
}
