import type { PoolClient } from 'pg';
import { z } from 'zod';
import { kr } from '../billing/invoice-pdf';

/**
 * GDPR-gallring av tidigare hyresgäster.
 *
 * Steg 1, anonymisering: när hyresgästen har flyttat, allt är betalt och
 * lagringstiden gått tas personuppgifterna bort ur kundregistret, avtalen,
 * påminnelser, utskick, dokument och revisionsloggen.
 *
 * Steg 2, bokföringsunderlag: fakturor och inbetalningar är räkenskaps-
 * information som sparas i sju år efter utgången av det kalenderår då
 * räkenskapsåret avslutades (bokföringslagen 7 kap. 2 §). Därefter rensas
 * namn och adress även på fakturorna och i bankfilernas betalningar.
 *
 * Importfiler rensas efter en egen lagringstid.
 */

export interface GdprSettings {
  autoEnabled: boolean;
  retentionMonths: number;
  bookkeepingYears: number;
  importRetentionMonths: number;
  includeOrganizations: boolean;
  lastAutoRunAt: string | null;
}

export const DEFAULT_SETTINGS: GdprSettings = {
  autoEnabled: false,
  retentionMonths: 24,
  bookkeepingYears: 7,
  importRetentionMonths: 12,
  includeOrganizations: false,
  lastAutoRunAt: null,
};

export const settingsSchema = z.object({
  autoEnabled: z.boolean(),
  retentionMonths: z.number().int().min(6, 'Minst 6 månader').max(120, 'Högst 120 månader'),
  bookkeepingYears: z.number().int().min(7, 'Bokföringslagen kräver minst 7 år').max(20),
  importRetentionMonths: z.number().int().min(1).max(120),
  includeOrganizations: z.boolean(),
});

export async function getSettings(client: PoolClient, companyId: string): Promise<GdprSettings> {
  const r = (
    await client.query(
      `select auto_enabled as "autoEnabled", retention_months as "retentionMonths", bookkeeping_years as "bookkeepingYears",
              import_retention_months as "importRetentionMonths", include_organizations as "includeOrganizations",
              last_auto_run_at as "lastAutoRunAt"
       from gdpr_setting where company_id = $1`,
      [companyId],
    )
  ).rows[0];
  return r ?? { ...DEFAULT_SETTINGS };
}

export async function saveSettings(client: PoolClient, companyId: string, s: z.infer<typeof settingsSchema>) {
  await client.query(
    `insert into gdpr_setting (company_id, auto_enabled, retention_months, bookkeeping_years, import_retention_months, include_organizations)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (company_id) do update set auto_enabled = $2, retention_months = $3, bookkeeping_years = $4,
       import_retention_months = $5, include_organizations = $6`,
    [companyId, s.autoEnabled, s.retentionMonths, s.bookkeepingYears, s.importRetentionMonths, s.includeOrganizations],
  );
  return getSettings(client, companyId);
}

// ---------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Sista dag som bokföringsunderlag från ett visst datum måste sparas:
 * 31 december det sjunde året efter det kalenderår då räkenskapsåret slutade.
 */
export function bookkeepingKeepUntil(lastDate: string, fiscalYearStart: number, years: number): string {
  const [y, m] = lastDate.split('-').map(Number);
  // Räkenskapsåret som innehåller datumet slutar dagen före startmånaden
  const fyEndYear = fiscalYearStart === 1 ? y : m >= fiscalYearStart ? y + 1 : y;
  return `${fyEndYear + years}-12-31`;
}

// ---------------------------------------------------------------------
// Kandidater
// ---------------------------------------------------------------------

interface CandidateRow {
  id: string;
  customerNr: number;
  kind: 'person' | 'organization';
  name: string;
  anonymizedAt: string | null;
  accountingPurgedAt: string | null;
  liveContracts: number;
  lastActivity: string;
  lastBookkeeping: string | null;
  openOre: number;
  unallocatedOre: number;
  depositsHeld: number;
  pendingPayments: number;
  draftInvoices: number;
  contacts: number;
  documents: number;
}

const CANDIDATES_SQL = `
  select c.id, c.customer_nr as "customerNr", c.kind, c.name,
    c.anonymized_at as "anonymizedAt", c.accounting_purged_at as "accountingPurgedAt",
    (select count(*) from contract k where k.customer_id = c.id
       and (k.status = 'draft' or (k.status in ('active','terminated') and (k.end_date is null or k.end_date >= current_date))))::int as "liveContracts",
    greatest(c.created_at::date,
      (select max(k.end_date) from contract k where k.customer_id = c.id and k.status in ('active','terminated')),
      (select max(i.invoice_date) from invoice i where i.customer_id = c.id),
      (select max(p.payment_date) from payment p where p.customer_id = c.id),
      (select max(r.refund_date) from payment_refund r join payment p on p.id = r.payment_id where p.customer_id = c.id),
      (select max(r.reminder_date) from reminder r where r.customer_id = c.id))::text as "lastActivity",
    greatest(
      (select max(i.invoice_date) from invoice i where i.customer_id = c.id and i.status = 'issued'),
      (select max(p.payment_date) from payment p where p.customer_id = c.id),
      (select max(r.refund_date) from payment_refund r join payment p on p.id = r.payment_id where p.customer_id = c.id),
      (select max(t.payment_date) from bank_transaction t where t.customer_id = c.id),
      (select max(r.reminder_date) from reminder r where r.customer_id = c.id))::text as "lastBookkeeping",
    coalesce((select sum(b.balance_ore) from invoice_balance b join invoice i on i.id = b.invoice_id
              where i.customer_id = c.id and b.balance_ore > 0), 0)::float as "openOre",
    coalesce((select sum(pb.unallocated_ore) from payment_balance pb where pb.customer_id = c.id and pb.unallocated_ore > 0), 0)::float as "unallocatedOre",
    (select count(*) from contract_deposit d join contract k on k.id = d.contract_id
       where k.customer_id = c.id and d.kind = 'deposit' and d.received_date is not null and d.returned_date is null)::int as "depositsHeld",
    (select count(*) from bank_transaction t where t.customer_id = c.id and t.status = 'matched')::int as "pendingPayments",
    (select count(*) from invoice i where i.customer_id = c.id and i.status = 'draft')::int as "draftInvoices",
    (select count(*) from customer_contact x where x.customer_id = c.id)::int as contacts,
    (select count(*) from document d where d.company_id = c.company_id
       and ((d.entity_type = 'customer' and d.entity_id = c.id)
         or (d.entity_type = 'contract' and d.entity_id in (select k.id from contract k where k.customer_id = c.id))))::int as documents
  from customer c
  where c.company_id = $1 and ($2::uuid is null or c.id = $2)
    and c.accounting_purged_at is null
  order by c.customer_nr`;


export function blockersFor(r: CandidateRow): string[] {
  const b: string[] = [];
  if (r.liveContracts) b.push(r.liveContracts === 1 ? 'Har ett gällande avtal' : `Har ${r.liveContracts} gällande avtal`);
  if (r.openOre > 0) b.push(`Obetalt ${kr(r.openOre)}`);
  if (r.unallocatedOre > 0) b.push(`Inbetalning på ${kr(r.unallocatedOre)} är inte fördelad eller återbetald`);
  if (r.depositsHeld) b.push('Depositionen är inte återbetald');
  if (r.pendingPayments) b.push('En inbetalning väntar på att bokföras');
  if (r.draftInvoices) b.push('Har fakturautkast');
  return b;
}

export interface Plan {
  today: string;
  settings: GdprSettings;
  anonymize: {
    id: string;
    customerNr: number;
    name: string;
    kind: string;
    lastActivity: string;
    mode: 'full' | 'contacts';
    contacts: number;
    documents: number;
  }[];
  accounting: { id: string; customerNr: number; name: string; lastBookkeeping: string | null; keepUntil: string | null }[];
  blocked: { id: string; customerNr: number; name: string; lastActivity: string; blockers: string[] }[];
  upcoming: { id: string; customerNr: number; name: string; purgeDate: string }[];
  imports: { id: string; batchNr: number; name: string; status: string; lastDate: string; action: 'purge' | 'delete' }[];
  unmatchedBankTransactions: number;
  /** Avslutade ärenden (felanmälningar) utan kopplad hyresgäst vars anmälaruppgifter ska rensas. */
  workOrders: number;
}

/**
 * Räknar fram vad som ska gallras. Inget ändras.
 * Med customerId och request = true gäller bara den kunden, och lagringstiden
 * hoppas över (begäran om radering), men hindren gäller fortfarande.
 */
export async function plan(
  client: PoolClient,
  companyId: string,
  opts: { customerId?: string; request?: boolean } = {},
): Promise<Plan> {
  const settings = await getSettings(client, companyId);
  const today = todayIso();
  const fiscalStart = (await client.query('select fiscal_year_start from company where id = $1', [companyId])).rows[0]?.fiscal_year_start ?? 1;
  const rows = (await client.query(CANDIDATES_SQL, [companyId, opts.customerId ?? null])).rows as CandidateRow[];
  const p: Plan = { today, settings, anonymize: [], accounting: [], blocked: [], upcoming: [], imports: [], unmatchedBankTransactions: 0, workOrders: 0 };

  for (const r of rows) {
    const fullMode = r.kind === 'person' || settings.includeOrganizations;
    let anonymized = !!r.anonymizedAt;
    if (!anonymized) {
      const blockers = blockersFor(r);
      const purgeDate = addMonths(r.lastActivity, settings.retentionMonths);
      const due = opts.request || purgeDate < today;
      if (r.liveContracts) continue; // nuvarande hyresgäster visas inte
      if (blockers.length) {
        if (due) p.blocked.push({ id: r.id, customerNr: r.customerNr, name: r.name, lastActivity: r.lastActivity, blockers });
        continue;
      }
      if (!due) {
        p.upcoming.push({ id: r.id, customerNr: r.customerNr, name: r.name, purgeDate: addMonths(purgeDate, 0) });
        continue;
      }
      p.anonymize.push({
        id: r.id,
        customerNr: r.customerNr,
        name: r.name,
        kind: r.kind,
        lastActivity: r.lastActivity,
        mode: fullMode ? 'full' : 'contacts',
        contacts: r.contacts,
        documents: r.documents,
      });
      anonymized = true;
    }
    if (anonymized && fullMode) {
      const keepUntil = r.lastBookkeeping ? bookkeepingKeepUntil(r.lastBookkeeping, fiscalStart, settings.bookkeepingYears) : null;
      if (!keepUntil || keepUntil < today) {
        p.accounting.push({ id: r.id, customerNr: r.customerNr, name: r.name, lastBookkeeping: r.lastBookkeeping, keepUntil });
      }
    }
  }
  p.upcoming.sort((a, b) => a.purgeDate.localeCompare(b.purgeDate));
  p.upcoming = p.upcoming.slice(0, 100);

  if (!opts.customerId) {
    p.imports = (
      await client.query(
        `select id, batch_nr as "batchNr", name, status,
                coalesce(rolled_back_at, committed_at, updated_at)::date::text as "lastDate",
                case when status in ('committed','rolled_back') then 'purge' else 'delete' end as action
         from import_batch
         where company_id = $1 and purged_at is null
           and coalesce(rolled_back_at, committed_at, updated_at) < now() - make_interval(months => $2)
         order by batch_nr`,
        [companyId, settings.importRetentionMonths],
      )
    ).rows;
    p.unmatchedBankTransactions = (
      await client.query(
        `select count(*)::int as n from bank_transaction
         where company_id = $1 and customer_id is null and payment_date < $2::date
           and (payer_name is not null or payer_address is not null or payer_org_nr is not null or information is not null)`,
        [companyId, unmatchedCutoff(today, settings.bookkeepingYears)],
      )
    ).rows[0].n;
    p.workOrders = (await client.query(`select count(*)::int as n from (${WORK_ORDERS_DUE_SQL}) x`, [companyId, settings.retentionMonths])).rows[0].n;
  }
  return p;
}

/** Betalningar utan kund: rensas när även det senaste möjliga räkenskapsåret har passerat. */
function unmatchedCutoff(today: string, years: number): string {
  return `${Number(today.slice(0, 4)) - years - 1}-01-01`;
}

/**
 * Ärenden där anmälarens uppgifter ska gallras: avslutade eller makulerade sedan
 * lagringstiden och inte kopplade till en hyresgäst (de gallras med hyresgästen).
 */
const WORK_ORDERS_DUE_SQL = `
  select id from work_order
  where company_id = $1 and anonymized_at is null and customer_id is null
    and status in ('closed', 'cancelled')
    and coalesce(closed_at, updated_at) < now() - make_interval(months => $2)
    and (reporter_name is not null or reporter_email is not null or reporter_phone is not null or access_note is not null or reporter_ip is not null)`;

const WORK_ORDER_KEYS = ['reporter_name', 'reporter_email', 'reporter_phone', 'access_note', 'reporter_ip'];

/** Tar bort anmälarens namn, e-post, telefon, tillträdesanteckning och IP-adress, och anmälarens egna meddelanden. */
async function purgeWorkOrders(client: PoolClient, companyId: string, workOrderIds: string[]): Promise<{ workOrders: number; messages: number; auditRows: number }> {
  if (!workOrderIds.length) return { workOrders: 0, messages: 0, auditRows: 0 };
  await client.query(
    `update work_order set reporter_name = null, reporter_email = null, reporter_phone = null, access_note = null, reporter_ip = null,
       notify_reporter = false, anonymized_at = now() where id = any($1::uuid[])`,
    [workOrderIds],
  );
  const eventIds = await ids(
    client,
    `select id from work_order_event where work_order_id = any($1::uuid[]) and (kind = 'reporter_comment' or author_label is not null or kind = 'email')`,
    [workOrderIds],
  );
  await client.query(
    `update work_order_event set author_label = null,
       body = case when kind in ('reporter_comment', 'email') then '[gallrad]' else body end
     where id = any($1::uuid[])`,
    [eventIds],
  );
  let audit = await scrub(client, companyId, 'work_order', workOrderIds, WORK_ORDER_KEYS);
  audit += await scrub(client, companyId, 'work_order_event', eventIds, ['body', 'author_label']);
  return { workOrders: workOrderIds.length, messages: eventIds.length, auditRows: audit };
}

export function label(customerNr: number): string {
  return `Anonymiserad kund ${customerNr}`;
}

// ---------------------------------------------------------------------
// Gallring
// ---------------------------------------------------------------------

const CUSTOMER_KEYS = [
  'name', 'national_id', 'vat_nr', 'email', 'phone', 'address_line', 'care_of', 'postal_code', 'city',
  'invoice_address_line', 'invoice_care_of', 'invoice_postal_code', 'invoice_city', 'invoice_reference', 'peppol_id', 'notes',
];
const CONTACT_KEYS = ['name', 'role', 'email', 'phone'];

interface LogEntry {
  kind: 'anonymize' | 'accounting' | 'import';
  customerId?: string;
  customerNr?: number;
  importBatchId?: string;
  details: Record<string, unknown>;
}

async function scrub(client: PoolClient, companyId: string, table: string, ids: string[], keys: string[]): Promise<number> {
  if (!ids.length) return 0;
  return (await client.query('select app.gdpr_scrub_audit($1, $2, $3, $4) as n', [companyId, table, ids, keys])).rows[0].n;
}

const ids = async (client: PoolClient, sql: string, params: unknown[]) => (await client.query(sql, params)).rows.map((r) => r.id as string);

async function anonymizeCustomer(client: PoolClient, companyId: string, c: Plan['anonymize'][number]): Promise<LogEntry> {
  const name = label(c.customerNr);
  const full = c.mode === 'full';
  const contactIds = await ids(client, 'select id from customer_contact where customer_id = $1', [c.id]);
  const contractIds = await ids(client, 'select id from contract where customer_id = $1', [c.id]);
  const invoiceIds = await ids(client, 'select id from invoice where customer_id = $1', [c.id]);
  const d: Record<string, number> = {};

  if (full) {
    await client.query(
      `update customer set name = $2, national_id = null, vat_nr = null, email = null, phone = null, address_line = null,
         care_of = null, postal_code = null, city = null, invoice_address_line = null, invoice_care_of = null,
         invoice_postal_code = null, invoice_city = null, invoice_reference = null, peppol_id = null, notes = null,
         delivery_method = 'post', active = false, anonymized_at = now()
       where id = $1`,
      [c.id, name],
    );
  } else {
    await client.query(
      `update customer set invoice_reference = null, notes = null, active = false, anonymized_at = now() where id = $1`,
      [c.id],
    );
  }
  d.contacts = (await client.query('delete from customer_contact where customer_id = $1', [c.id])).rowCount ?? 0;
  d.contractNotes = (
    await client.query(
      `update contract set notes = null, termination_reason = null
       where customer_id = $1 and (notes is not null or termination_reason is not null)`,
      [c.id],
    )
  ).rowCount ?? 0;
  const noteEvents = await ids(client, `select id from contract_event where contract_id = any($1::uuid[]) and kind = 'note'`, [contractIds]);
  await client.query('delete from contract_event where id = any($1::uuid[])', [noteEvents]);
  d.contractNotes += noteEvents.length;
  const depositIds = await ids(client, 'select id from contract_deposit where contract_id = any($1::uuid[]) and note is not null', [contractIds]);
  await client.query('update contract_deposit set note = null where id = any($1::uuid[])', [depositIds]);

  const reminderIds = full ? await ids(client, 'select id from reminder where customer_id = $1', [c.id]) : [];
  if (full) {
    await client.query(`update reminder set bill_to = jsonb_build_object('name', $2::text), recipient = null where customer_id = $1`, [c.id, name]);
  }
  d.reminders = reminderIds.length;
  const deliveryIds = full
    ? await ids(client, 'select id from invoice_delivery where invoice_id = any($1::uuid[]) and recipient is not null', [invoiceIds])
    : [];
  await client.query('update invoice_delivery set recipient = null where id = any($1::uuid[])', [deliveryIds]);
  d.deliveries = deliveryIds.length;
  // Utskick till hyresgästen (e-post och SMS) är inget räkenskapsmaterial och tas bort helt.
  d.messages = (await client.query('delete from message_recipient where customer_id = $1', [c.id])).rowCount ?? 0;

  const docIds = await ids(
    client,
    `select id from document where company_id = $1
       and ((entity_type = 'customer' and entity_id = $2) or (entity_type = 'contract' and entity_id = any($3::uuid[])))
       and (retain_until is null or retain_until < current_date)`,
    [companyId, c.id, contractIds],
  );
  await client.query('delete from document where id = any($1::uuid[])', [docIds]);
  d.documents = docIds.length;

  // Felanmälningar som hyresgästen gjort
  const workOrderIds = full ? await ids(client, 'select id from work_order where customer_id = $1 and anonymized_at is null', [c.id]) : [];
  const wo = await purgeWorkOrders(client, companyId, workOrderIds);
  d.workOrders = wo.workOrders;

  // Historiken i revisionsloggen och i importens ångra-logg
  const customerKeys = full ? CUSTOMER_KEYS : ['invoice_reference', 'notes'];
  let audit = 0;
  audit += await scrub(client, companyId, 'customer', [c.id], customerKeys);
  audit += await scrub(client, companyId, 'customer_contact', contactIds, CONTACT_KEYS);
  audit += await scrub(client, companyId, 'contract', contractIds, ['notes', 'termination_reason']);
  audit += await scrub(client, companyId, 'contract_event', noteEvents, ['description']);
  audit += await scrub(client, companyId, 'contract_deposit', depositIds, ['note']);
  audit += await scrub(client, companyId, 'reminder', reminderIds, ['bill_to', 'recipient']);
  audit += await scrub(client, companyId, 'invoice_delivery', deliveryIds, ['recipient']);
  audit += await scrub(client, companyId, 'document', docIds, ['file_name', 'description']);
  d.auditRows = audit + wo.auditRows;
  return { kind: 'anonymize', customerId: c.id, customerNr: c.customerNr, details: { mode: c.mode, ...d } };
}

async function purgeAccounting(client: PoolClient, companyId: string, c: Plan['accounting'][number]): Promise<LogEntry> {
  const d: Record<string, number> = {};
  const invoiceIds = await ids(client, 'select id from invoice where customer_id = $1', [c.id]);
  d.invoices = (await client.query('select app.gdpr_clear_invoice_recipient($1, $2, $3) as n', [companyId, c.id, label(c.customerNr)])).rows[0].n;
  const txIds = await ids(
    client,
    `select id from bank_transaction where customer_id = $1
       and (payer_name is not null or payer_address is not null or payer_org_nr is not null or information is not null or note is not null)`,
    [c.id],
  );
  await client.query(
    `update bank_transaction set payer_name = null, payer_address = null, payer_org_nr = null, information = null,
       extra_references = '[]', note = null where id = any($1::uuid[])`,
    [txIds],
  );
  d.bankTransactions = txIds.length;
  const paymentIds = await ids(client, 'select id from payment where customer_id = $1 and note is not null', [c.id]);
  await client.query('update payment set note = null where id = any($1::uuid[])', [paymentIds]);
  const refundIds = await ids(
    client,
    'select r.id from payment_refund r join payment p on p.id = r.payment_id where p.customer_id = $1 and r.note is not null',
    [c.id],
  );
  await client.query('update payment_refund set note = null where id = any($1::uuid[])', [refundIds]);
  d.payments = paymentIds.length + refundIds.length;
  const contractIds = await ids(client, 'select id from contract where customer_id = $1', [c.id]);
  await client.query('update contract set special_terms = null where customer_id = $1 and special_terms is not null', [c.id]);
  const docIds = await ids(
    client,
    `select id from document where company_id = $1
       and ((entity_type = 'customer' and entity_id = $2) or (entity_type = 'contract' and entity_id = any($3::uuid[])))`,
    [companyId, c.id, contractIds],
  );
  await client.query('delete from document where id = any($1::uuid[])', [docIds]);
  d.documents = docIds.length;

  let audit = 0;
  audit += await scrub(client, companyId, 'invoice', invoiceIds, ['bill_to', 'your_reference']);
  audit += await scrub(client, companyId, 'bank_transaction', txIds, ['payer_name', 'payer_address', 'payer_org_nr', 'information', 'extra_references', 'note']);
  audit += await scrub(client, companyId, 'payment', paymentIds, ['note']);
  audit += await scrub(client, companyId, 'payment_refund', refundIds, ['note']);
  audit += await scrub(client, companyId, 'contract', contractIds, ['special_terms']);
  audit += await scrub(client, companyId, 'document', docIds, ['file_name', 'description']);
  d.auditRows = audit;
  await client.query('update customer set accounting_purged_at = now() where id = $1', [c.id]);
  return { kind: 'accounting', customerId: c.id, customerNr: c.customerNr, details: d };
}

async function purgeImport(client: PoolClient, b: Plan['imports'][number]): Promise<LogEntry> {
  if (b.action === 'delete') {
    // Påbörjad import som aldrig genomfördes: tas bort helt
    const rows = (await client.query('select count(*)::int as n from import_row where batch_id = $1', [b.id])).rows[0].n;
    await client.query('delete from import_batch where id = $1', [b.id]);
    return { kind: 'import', importBatchId: b.id, details: { batchNr: b.batchNr, action: 'deleted', rows } };
  }
  const files = (await client.query('delete from import_file where batch_id = $1', [b.id])).rowCount ?? 0;
  const rows =
    (
      await client.query(
        `update import_row set data = '{}', label = '(gallrad)', issues = '[]', changes = '[]' where batch_id = $1`,
        [b.id],
      )
    ).rowCount ?? 0;
  await client.query(`update import_decision set overrides = '{}' where batch_id = $1`, [b.id]);
  await client.query('update import_event set details = null where batch_id = $1', [b.id]);
  await client.query(
    'update import_batch set purged_at = now(), validation = null, test_result = null, reconciliation = null where id = $1',
    [b.id],
  );
  await client.query('select app.gdpr_clear_import_changes(company_id, id) from import_batch where id = $1', [b.id]);
  return { kind: 'import', importBatchId: b.id, details: { batchNr: b.batchNr, action: 'purged', files, rows } };
}

export interface RunResult {
  runId: string | null;
  runNr: number | null;
  anonymized: number;
  accounting: number;
  imports: number;
  bankTransactions: number;
}

/** Gallrar allt som planen visar, i en transaktion. */
export async function run(
  client: PoolClient,
  companyId: string,
  trigger: 'manual' | 'auto' | 'request',
  opts: { customerId?: string } = {},
): Promise<RunResult> {
  await client.query(`select pg_advisory_xact_lock(hashtext('gdpr:' || $1))`, [companyId]);
  const p = await plan(client, companyId, { customerId: opts.customerId, request: trigger === 'request' });
  const log: LogEntry[] = [];
  for (const c of p.anonymize) log.push(await anonymizeCustomer(client, companyId, c));
  for (const c of p.accounting) log.push(await purgeAccounting(client, companyId, c));
  for (const b of p.imports) log.push(await purgeImport(client, b));

  let bankTransactions = 0;
  if (!opts.customerId && p.unmatchedBankTransactions) {
    const txIds = await ids(
      client,
      `select id from bank_transaction
       where company_id = $1 and customer_id is null and payment_date < $2::date
         and (payer_name is not null or payer_address is not null or payer_org_nr is not null or information is not null)`,
      [companyId, unmatchedCutoff(p.today, p.settings.bookkeepingYears)],
    );
    await client.query(
      `update bank_transaction set payer_name = null, payer_address = null, payer_org_nr = null, information = null,
         extra_references = '[]' where id = any($1::uuid[])`,
      [txIds],
    );
    await scrub(client, companyId, 'bank_transaction', txIds, ['payer_name', 'payer_address', 'payer_org_nr', 'information', 'extra_references']);
    bankTransactions = txIds.length;
    log.push({ kind: 'accounting', details: { unmatchedBankTransactions: bankTransactions } });
  }

  if (!opts.customerId && p.workOrders) {
    const woIds = await ids(client, WORK_ORDERS_DUE_SQL, [companyId, p.settings.retentionMonths]);
    const wo = await purgeWorkOrders(client, companyId, woIds);
    log.push({ kind: 'anonymize', details: { workOrdersWithoutCustomer: wo.workOrders, messages: wo.messages, auditRows: wo.auditRows } });
  }

  if (trigger === 'auto') {
    await client.query(
      `insert into gdpr_setting (company_id, last_auto_run_at) values ($1, now())
       on conflict (company_id) do update set last_auto_run_at = now()`,
      [companyId],
    );
  }
  const result: RunResult = {
    runId: null,
    runNr: null,
    anonymized: p.anonymize.length,
    accounting: p.accounting.length,
    imports: p.imports.length,
    bankTransactions,
  };
  if (!log.length) return result;

  const nr = (await client.query('select coalesce(max(run_nr), 0) + 1 as nr from gdpr_run where company_id = $1', [companyId])).rows[0].nr;
  const runId = (
    await client.query(
      `insert into gdpr_run (company_id, run_nr, trigger, anonymized_count, accounting_count, import_count)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [companyId, nr, trigger, result.anonymized, result.accounting, result.imports],
    )
  ).rows[0].id;
  for (const e of log) {
    await client.query(
      `insert into gdpr_log (company_id, run_id, kind, customer_id, customer_nr, import_batch_id, details)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, runId, e.kind, e.customerId ?? null, e.customerNr ?? null, e.importBatchId ?? null, JSON.stringify(e.details)],
    );
  }
  return { ...result, runId, runNr: nr };
}
