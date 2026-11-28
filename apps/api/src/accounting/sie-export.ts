import type { PoolClient } from 'pg';
import {
  AccountingEvent,
  AccountingSettings,
  collectEvents,
  EventKind,
  KIND_LABEL,
  loadSettings,
  normalizeRows,
  PostingRow,
  sameRows,
} from './accounting-events';
import { buildSieFile, SieFile } from './sie';

export interface PlanIssue {
  severity: 'blocking' | 'warning' | 'info';
  message: string;
  href?: string;
}

export interface PlannedVoucher {
  key: string;
  kind: EventKind;
  eventDate: string;
  date: string;
  text: string;
  correction: boolean;
  /** Bokföringsdag före perioden: händelsen registrerades efter förra exporten */
  late: boolean;
  href: string | null;
  /** Raderna i filen (för rättelser: skillnaden mot det som exporterats tidigare) */
  rows: PostingRow[];
  /** Händelsens kontering efter exporten */
  newRows: PostingRow[];
}

export interface ExportPlan {
  companyId: string;
  companyName: string;
  orgNr: string;
  from: string;
  to: string;
  lowerBound: string;
  settings: AccountingSettings;
  vouchers: PlannedVoucher[];
  issues: PlanIssue[];
  accountNames: Map<string, string>;
  /** Exporter som redan omfattar en del av perioden */
  overlapping: { exportNr: number; from: string; to: string; createdAt: string }[];
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Räkenskapsåret som innehåller datumet. */
export function fiscalYear(date: string, startMonth: number): { from: string; to: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const startYear = m >= startMonth ? y : y - 1;
  const from = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const next = `${startYear + 1}-${String(startMonth).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}

/**
 * Tar fram vad en export för perioden skulle innehålla:
 *  * händelser med bokföringsdag i perioden som inte exporterats,
 *  * händelser före perioden (men efter startdatumet) som registrerats i efterhand,
 *  * rättelser för händelser som ändrats eller tagits bort efter att de exporterades.
 */
export async function planExport(client: PoolClient, companyId: string, from: string, to: string): Promise<ExportPlan> {
  const company = (
    await client.query('select name, org_nr as "orgNr" from company where id = $1', [companyId])
  ).rows[0];
  const settings = await loadSettings(client, companyId);
  const issues: PlanIssue[] = [];

  const firstExport = (await client.query('select min(period_from)::text as d from sie_export where company_id = $1', [companyId])).rows[0].d as
    | string
    | null;
  // Undre gräns för händelser som kan komma med: startdatumet, annars den första exporterade perioden
  let lowerBound = firstExport && firstExport < from ? firstExport : from;
  if (settings.startDate) lowerBound = settings.startDate;
  if (settings.startDate && settings.startDate > from) {
    issues.push({ severity: 'warning', message: `Händelser före startdatumet ${settings.startDate} exporteras inte.` });
  }
  const current = lowerBound > to ? [] : await collectEvents(client, companyId, settings, lowerBound, to, issues);
  const currentByKey = new Map(current.map((e) => [e.key, e]));

  // Senast exporterade konteringen för varje händelse
  const exported = (
    await client.query(
      `select distinct on (source_key) source_key as key, kind, event_date::text as "eventDate", text, rows
       from sie_export_item where company_id = $1
       order by source_key, created_at desc, id`,
      [companyId],
    )
  ).rows as { key: string; kind: EventKind; eventDate: string; text: string; rows: PostingRow[] }[];
  const exportedByKey = new Map(exported.map((e) => [e.key, e]));

  const vouchers: PlannedVoucher[] = [];
  for (const e of current) {
    const prev = exportedByKey.get(e.key);
    if (!prev) {
      if (!e.rows.length) continue;
      vouchers.push({ key: e.key, kind: e.kind, eventDate: e.date, date: e.date, text: e.text, correction: false, late: e.date < from, href: e.href, rows: e.rows, newRows: e.rows });
    } else if (!sameRows(prev.rows, e.rows)) {
      vouchers.push(correction(e.key, e.kind, prev.eventDate, from, e.text, prev.rows, e.rows, e.href));
    }
  }
  // Exporterade händelser som inte längre finns (borttagen betalning, makulerad faktura ...)
  for (const prev of exported) {
    if (currentByKey.has(prev.key) || !prev.rows.length) continue;
    if (prev.eventDate > to) continue; // hör till en senare period och har inte räknats fram här
    vouchers.push(correction(prev.key, prev.kind, prev.eventDate, from, prev.text, prev.rows, [], null));
  }
  vouchers.sort((a, b) => a.date.localeCompare(b.date) || kindOrder(a.kind) - kindOrder(b.kind) || a.text.localeCompare(b.text, 'sv'));

  // Konton och kontroller
  const accountNames = new Map<string, string>(
    (await client.query('select number, name from account where company_id = $1', [companyId])).rows.map((r) => [r.number, r.name]),
  );
  const missing = new Set<string>();
  for (const v of vouchers) {
    const sum = v.rows.reduce((s, r) => s + r.amountOre, 0);
    if (sum !== 0) issues.push({ severity: 'blocking', message: `${v.text} går inte jämnt ut (${sum / 100} kr)`, href: v.href ?? undefined });
    for (const r of v.rows) if (!accountNames.has(r.account) && r.account !== '0000') missing.add(r.account);
  }
  for (const a of missing) {
    issues.push({ severity: 'warning', message: `Konto ${a} finns inte i kontoplanen. Kontrollera att kontot finns i Hogia, annars stoppas inläsningen.` });
  }
  const late = vouchers.filter((v) => v.late && !v.correction).length;
  if (late) {
    issues.push({
      severity: 'warning',
      message: `${late} händelser har bokföringsdag före perioden (de registrerades efter förra exporten). De får sitt eget datum, så den perioden måste vara öppen i Hogia.`,
    });
  }
  const corrections = vouchers.filter((v) => v.correction).length;
  if (corrections) {
    issues.push({
      severity: 'info',
      message: `${corrections} rättelser: händelser som ändrats eller tagits bort efter att de exporterades. Rättelsen bokförs i den här perioden.`,
    });
  }

  // Sådant i perioden som inte kommer med
  const pending = (
    await client.query(
      `select
         (select count(*)::int from billing_run where company_id = $1 and status = 'draft' and invoice_date between $2::date and $3::date) as runs,
         (select count(*)::int from invoice where company_id = $1 and status = 'draft' and billing_run_id is null and invoice_date between $2::date and $3::date) as drafts,
         (select count(*)::int from bank_file where company_id = $1 and status = 'draft') as files,
         (select count(*)::int from supplier_invoice where company_id = $1 and status = 'registered' and invoice_date between $2::date and $3::date) as unapproved`,
      [companyId, from, to],
    )
  ).rows[0];
  if (pending.runs) issues.push({ severity: 'warning', message: `${pending.runs} aviseringskörning i perioden är inte godkänd. Avierna kommer inte med förrän den är godkänd.`, href: '/avisering' });
  if (pending.drafts) issues.push({ severity: 'warning', message: `${pending.drafts} fakturor i perioden är utkast och kommer inte med.`, href: '/fakturor' });
  if (pending.files) issues.push({ severity: 'warning', message: `${pending.files} inlästa bankfiler är inte bokförda. Betalningarna kommer med först när filen är bokförd.`, href: '/inbetalningar' });
  if (pending.unapproved) {
    issues.push({
      severity: 'warning',
      message: `${pending.unapproved} leverantörsfakturor i perioden är inte attesterade och kommer inte med förrän de attesterats.`,
      href: '/leverantorsfakturor?status=to_approve',
    });
  }

  const overlapping = (
    await client.query(
      `select export_nr as "exportNr", period_from::text as "from", period_to::text as "to", created_at as "createdAt"
       from sie_export where company_id = $1 and period_from <= $3::date and period_to >= $2::date order by export_nr`,
      [companyId, from, to],
    )
  ).rows;
  if (overlapping.length) {
    issues.push({
      severity: 'info',
      message: `Perioden är redan exporterad (export ${overlapping.map((o) => o.exportNr).join(', ')}). Bara det som tillkommit eller ändrats sedan dess kommer med, så inget bokförs två gånger.`,
    });
  }

  return { companyId, companyName: company.name, orgNr: company.orgNr, from, to, lowerBound, settings, vouchers, issues, accountNames, overlapping };
}

const KIND_ORDER: EventKind[] = ['customer_invoice', 'payment', 'allocation', 'refund', 'supplier_invoice', 'supplier_payment'];
const kindOrder = (k: EventKind) => KIND_ORDER.indexOf(k);

function correction(
  key: string,
  kind: EventKind,
  eventDate: string,
  from: string,
  text: string,
  oldRows: PostingRow[],
  newRows: PostingRow[],
  href: string | null,
): PlannedVoucher {
  const diff = normalizeRows([...oldRows.map((r) => ({ ...r, amountOre: -r.amountOre })), ...newRows]);
  return {
    key,
    kind,
    eventDate,
    date: eventDate < from ? from : eventDate,
    text: `Rättelse: ${text}${newRows.length ? '' : ' (borttagen)'}`,
    correction: true,
    late: false,
    href,
    rows: diff,
    newRows,
  };
}

/** Sammanfattning per slag och summor per konto, för förhandsgranskningen. */
export function summarize(plan: ExportPlan) {
  const byKind = KIND_ORDER.map((kind) => {
    const v = plan.vouchers.filter((x) => x.kind === kind);
    return { kind, label: KIND_LABEL[kind], count: v.length, debitOre: v.reduce((s, x) => s + x.rows.filter((r) => r.amountOre > 0).reduce((a, r) => a + r.amountOre, 0), 0) };
  }).filter((k) => k.count > 0);
  const acc = new Map<string, { debitOre: number; creditOre: number }>();
  for (const v of plan.vouchers) {
    for (const r of v.rows) {
      const a = acc.get(r.account) ?? { debitOre: 0, creditOre: 0 };
      if (r.amountOre > 0) a.debitOre += r.amountOre;
      else a.creditOre -= r.amountOre;
      acc.set(r.account, a);
    }
  }
  const accounts = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, v]) => ({ account, name: plan.accountNames.get(account) ?? '', ...v, netOre: v.debitOre - v.creditOre }));
  return { byKind, accounts, debitOre: accounts.reduce((s, a) => s + a.debitOre, 0) };
}

export function planToFile(plan: ExportPlan, fiscalYearStart: number, generatedBy: string, generatedAt: string): Buffer {
  const used = new Set<string>();
  const cc = new Set<string>();
  const projects = new Set<string>();
  for (const v of plan.vouchers) {
    for (const r of v.rows) {
      used.add(r.account);
      if (r.costCenter) cc.add(r.costCenter);
      if (r.project) projects.add(r.project);
    }
  }
  const fy = fiscalYear(plan.to, fiscalYearStart);
  const prev = fiscalYear(addDays(fy.from, -1), fiscalYearStart);
  const file: SieFile = {
    program: 'Fastighetssystem',
    version: '1.0',
    generatedAt,
    generatedBy,
    companyName: plan.companyName,
    orgNr: plan.orgNr,
    fiscalYears: [
      { index: 0, ...fy },
      { index: -1, ...prev },
    ],
    series: plan.settings.series,
    accounts: [...used].sort().map((n) => ({ number: n, name: plan.accountNames.get(n) ?? `Konto ${n}` })),
    costCenters: [...cc].sort().map((c) => ({ code: c, name: c })),
    projects: [...projects].sort().map((p) => ({ code: p, name: p })),
    vouchers: plan.vouchers.map((v) => ({ date: v.date, text: v.text, rows: v.rows })),
  };
  return buildSieFile(file);
}

export function exportFileName(companyName: string, from: string, to: string): string {
  const safe = companyName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `SIE-${safe}-${from}${from === to ? '' : `-${to}`}.se`;
}
