import type { PoolClient } from 'pg';

/**
 * Bokföringshändelser som räknas fram ur systemets egna data.
 *
 *  Avi, faktura, kreditfaktura  D kundfordran / K intäktskonto per rad, utgående moms per sats, öresavrundning
 *  Inbetalning                  D bank / K kundfordran (det som fördelats direkt) och förskott från kunder (resten)
 *  Senare fördelning            D förskott från kunder / K kundfordran (ej fördelat belopp som fördelas en annan dag)
 *  Återbetalning                D förskott från kunder / K bank
 *  Leverantörsfaktura           D kostnadskonto (ej avdragsgill moms ingår) och ingående moms / K leverantörsskuld
 *  Betalning till leverantör    D leverantörsskuld / K bank
 *
 * Påminnelseavgifter är egna fakturor och följer med som fakturor.
 * Leverantörsfakturor tas med när de är attesterade (konteringen är då låst).
 */

export type EventKind = 'customer_invoice' | 'payment' | 'allocation' | 'refund' | 'supplier_invoice' | 'supplier_payment';

export const KIND_LABEL: Record<EventKind, string> = {
  customer_invoice: 'Avier och fakturor',
  payment: 'Inbetalningar',
  allocation: 'Fördelning av förskott',
  refund: 'Återbetalningar',
  supplier_invoice: 'Leverantörsfakturor',
  supplier_payment: 'Betalningar till leverantörer',
};

export interface PostingRow {
  account: string;
  amountOre: number; // debet positivt, kredit negativt
  costCenter: string | null;
  project: string | null;
}

export interface AccountingEvent {
  key: string;
  kind: EventKind;
  date: string;
  text: string;
  rows: PostingRow[];
  /** Länk i systemet, t.ex. /fakturor/<id> */
  href: string | null;
}

export interface AccountingSettings {
  series: string;
  startDate: string | null;
  bankAccount: string;
  receivableAccount: string;
  prepaymentAccount: string;
  payableAccount: string;
  inputVatAccount: string;
  outputVat25Account: string;
  outputVat12Account: string;
  outputVat6Account: string;
  roundingAccount: string;
  includeDimensions: boolean;
}

export const DEFAULT_SETTINGS: AccountingSettings = {
  series: 'A',
  startDate: null,
  bankAccount: '1930',
  receivableAccount: '1510',
  prepaymentAccount: '2420',
  payableAccount: '2440',
  inputVatAccount: '2640',
  outputVat25Account: '2610',
  outputVat12Account: '2620',
  outputVat6Account: '2630',
  roundingAccount: '3740',
  includeDimensions: false,
};

export async function loadSettings(client: PoolClient, companyId: string): Promise<AccountingSettings> {
  const r = (
    await client.query(
      `select series, start_date::text as "startDate", bank_account as "bankAccount", receivable_account as "receivableAccount",
              prepayment_account as "prepaymentAccount", payable_account as "payableAccount", input_vat_account as "inputVatAccount",
              output_vat_25_account as "outputVat25Account", output_vat_12_account as "outputVat12Account",
              output_vat_6_account as "outputVat6Account", rounding_account as "roundingAccount", include_dimensions as "includeDimensions"
       from accounting_setting where company_id = $1`,
      [companyId],
    )
  ).rows[0];
  return r ? { ...DEFAULT_SETTINGS, ...r } : { ...DEFAULT_SETTINGS };
}

/** Slår ihop rader med samma konto och objekt, tar bort nollor och sorterar. Debet före kredit. */
export function normalizeRows(rows: PostingRow[]): PostingRow[] {
  const map = new Map<string, PostingRow>();
  for (const r of rows) {
    if (!r.amountOre) continue;
    const k = `${r.account}|${r.costCenter ?? ''}|${r.project ?? ''}`;
    const cur = map.get(k);
    if (cur) cur.amountOre += r.amountOre;
    else map.set(k, { account: r.account, amountOre: r.amountOre, costCenter: r.costCenter ?? null, project: r.project ?? null });
  }
  return [...map.values()]
    .filter((r) => r.amountOre !== 0)
    .sort((a, b) => (b.amountOre > 0 ? 1 : 0) - (a.amountOre > 0 ? 1 : 0) || a.account.localeCompare(b.account) ||
      (a.costCenter ?? '').localeCompare(b.costCenter ?? '') || (a.project ?? '').localeCompare(b.project ?? ''));
}

export const sameRows = (a: PostingRow[], b: PostingRow[]) => JSON.stringify(normalizeRows(a)) === JSON.stringify(normalizeRows(b));

const INVOICE_KIND: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

const row = (account: string, amountOre: number, costCenter: string | null = null, project: string | null = null): PostingRow => ({
  account,
  amountOre,
  costCenter,
  project,
});

/**
 * Alla händelser i bolaget med bokföringsdag från och med `from` till och med `to`.
 * Varningar om saknade konton läggs i `issues`.
 */
export async function collectEvents(
  client: PoolClient,
  companyId: string,
  s: AccountingSettings,
  from: string,
  to: string,
  issues: { severity: 'blocking' | 'warning' | 'info'; message: string; href?: string }[],
): Promise<AccountingEvent[]> {
  const events: AccountingEvent[] = [];
  const dims = s.includeDimensions;
  const vatAccount = (bp: number) => (bp === 2500 ? s.outputVat25Account : bp === 1200 ? s.outputVat12Account : bp === 600 ? s.outputVat6Account : null);

  // ---------- Avier, fakturor och kreditfakturor ----------
  const invoices = (
    await client.query(
      `select i.id, i.kind, i.invoice_nr::text as nr, i.invoice_date::text as date, i.total_ore::float as total,
              i.rounding_ore::float as rounding, c.customer_nr as "customerNr", c.name as "customerName"
       from invoice i join customer c on c.id = i.customer_id
       where i.company_id = $1 and i.status = 'issued' and i.invoice_date between $2::date and $3::date
       order by i.invoice_date, i.invoice_nr`,
      [companyId, from, to],
    )
  ).rows;
  if (invoices.length) {
    const lines = (
      await client.query(
        `select l.invoice_id as "invoiceId", coalesce(l.account_number, a.account_number) as account, l.net_ore::float as net,
                l.vat_ore::float as vat, l.vat_rate_bp as bp, cc.code as cc, pr.designation as project
         from invoice_line l
         left join article a on a.company_id = l.company_id and a.code = l.article
         left join cost_center cc on cc.id = l.cost_center_id
         left join property pr on pr.id = l.property_id
         where l.invoice_id = any($1::uuid[])`,
        [invoices.map((i) => i.id)],
      )
    ).rows;
    const byInvoice = new Map<string, typeof lines>();
    for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
    for (const i of invoices) {
      const label = `${INVOICE_KIND[i.kind] ?? 'Faktura'} ${i.nr}`;
      const rows: PostingRow[] = [row(s.receivableAccount, i.total)];
      for (const l of byInvoice.get(i.id) ?? []) {
        if (!l.account) {
          issues.push({ severity: 'blocking', message: `${label} har en rad utan intäktskonto. Ange konto på artikeln.`, href: `/fakturor/${i.id}` });
        }
        rows.push(row(l.account ?? '0000', -l.net, dims ? l.cc : null, dims ? l.project : null));
        if (l.vat) {
          const acc = vatAccount(l.bp);
          if (!acc) issues.push({ severity: 'blocking', message: `${label} har moms med okänd momssats`, href: `/fakturor/${i.id}` });
          rows.push(row(acc ?? '0000', -l.vat));
        }
      }
      rows.push(row(s.roundingAccount, -i.rounding));
      events.push({
        key: `invoice:${i.id}`,
        kind: 'customer_invoice',
        date: i.date,
        text: `${label}, kund ${i.customerNr} ${i.customerName}`,
        rows,
        href: `/fakturor/${i.id}`,
      });
    }
  }

  // ---------- Inbetalningar ----------
  // Fördelning som gjordes samtidigt som betalningen registrerades räknas till betalningen.
  const payments = (
    await client.query(
      `select p.id, p.payment_date::text as date, p.amount_ore::float as amount, p.reference, c.id as "customerId", c.customer_nr as "customerNr", c.name as "customerName",
              coalesce((select sum(a.amount_ore) from payment_allocation a
                         where a.payment_id = p.id and a.created_at <= p.created_at + interval '2 minutes'), 0)::float as "allocatedAtOnce"
       from payment p join customer c on c.id = p.customer_id
       where p.company_id = $1 and p.payment_date between $2::date and $3::date
       order by p.payment_date, p.created_at`,
      [companyId, from, to],
    )
  ).rows;
  for (const p of payments) {
    events.push({
      key: `payment:${p.id}`,
      kind: 'payment',
      date: p.date,
      text: `Inbetalning, kund ${p.customerNr} ${p.customerName}${p.reference ? `, ref ${p.reference}` : ''}`,
      rows: [row(s.bankAccount, p.amount), row(s.receivableAccount, -p.allocatedAtOnce), row(s.prepaymentAccount, -(p.amount - p.allocatedAtOnce))],
      href: `/kunder/${p.customerId}`,
    });
  }

  // ---------- Senare fördelning av ej fördelat belopp ----------
  const allocations = (
    await client.query(
      `select a.id, (a.created_at at time zone 'Europe/Stockholm')::date::text as date, a.amount_ore::float as amount,
              i.invoice_nr::text as nr, i.id as "invoiceId", c.customer_nr as "customerNr", c.name as "customerName"
       from payment_allocation a
       join payment p on p.id = a.payment_id
       join invoice i on i.id = a.invoice_id
       join customer c on c.id = p.customer_id
       where a.company_id = $1 and a.created_at > p.created_at + interval '2 minutes'
         and (a.created_at at time zone 'Europe/Stockholm')::date between $2::date and $3::date
       order by a.created_at`,
      [companyId, from, to],
    )
  ).rows;
  for (const a of allocations) {
    events.push({
      key: `allocation:${a.id}`,
      kind: 'allocation',
      date: a.date,
      text: `Förskott fördelat på faktura ${a.nr}, kund ${a.customerNr} ${a.customerName}`,
      rows: [row(s.prepaymentAccount, a.amount), row(s.receivableAccount, -a.amount)],
      href: `/fakturor/${a.invoiceId}`,
    });
  }

  // ---------- Återbetalningar ----------
  const refunds = (
    await client.query(
      `select r.id, r.refund_date::text as date, r.amount_ore::float as amount, c.customer_nr as "customerNr", c.name as "customerName", c.id as "customerId"
       from payment_refund r join payment p on p.id = r.payment_id join customer c on c.id = p.customer_id
       where r.company_id = $1 and r.refund_date between $2::date and $3::date
       order by r.refund_date, r.created_at`,
      [companyId, from, to],
    )
  ).rows;
  for (const r of refunds) {
    events.push({
      key: `refund:${r.id}`,
      kind: 'refund',
      date: r.date,
      text: `Återbetalning, kund ${r.customerNr} ${r.customerName}`,
      rows: [row(s.prepaymentAccount, r.amount), row(s.bankAccount, -r.amount)],
      href: `/kunder/${r.customerId}`,
    });
  }

  // ---------- Leverantörsfakturor ----------
  const sinvs = (
    await client.query(
      `select i.id, i.entry_nr as "entryNr", i.kind, i.invoice_nr as nr, i.invoice_date::text as date, i.total_ore::float as total,
              i.rounding_ore::float as rounding, s.name as supplier
       from supplier_invoice i join supplier s on s.id = i.supplier_id
       where i.company_id = $1 and i.status in ('approved','paid') and i.invoice_date between $2::date and $3::date
       order by i.invoice_date, i.entry_nr`,
      [companyId, from, to],
    )
  ).rows;
  if (sinvs.length) {
    const lines = (
      await client.query(
        `select l.supplier_invoice_id as "invoiceId", l.account_number as account, l.net_ore::float as net, l.vat_ore::float as vat,
                l.vat_deductible as deductible, cc.code as cc, pr.designation as project
         from supplier_invoice_line l left join cost_center cc on cc.id = l.cost_center_id
         left join property pr on pr.id = l.property_id
         where l.supplier_invoice_id = any($1::uuid[])`,
        [sinvs.map((i) => i.id)],
      )
    ).rows;
    const byInvoice = new Map<string, typeof lines>();
    for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
    for (const i of sinvs) {
      const rows: PostingRow[] = [];
      let vat = 0;
      for (const l of byInvoice.get(i.id) ?? []) {
        rows.push(row(l.account, l.net + (l.deductible ? 0 : l.vat), dims ? l.cc : null, dims ? l.project : null));
        if (l.deductible) vat += l.vat;
      }
      rows.push(row(s.inputVatAccount, vat), row(s.roundingAccount, i.rounding), row(s.payableAccount, -i.total));
      events.push({
        key: `supplier_invoice:${i.id}`,
        kind: 'supplier_invoice',
        date: i.date,
        text: `${i.kind === 'credit_note' ? 'Leverantörskredit' : 'Leverantörsfaktura'} ${i.entryNr}, ${i.supplier}, fakturanr ${i.nr}`,
        rows,
        href: `/leverantorsfakturor/${i.id}`,
      });
    }
  }

  // ---------- Betalningar till leverantörer ----------
  const spays = (
    await client.query(
      `select p.id, p.paid_date::text as date, p.amount_ore::float as amount, i.entry_nr as "entryNr", i.id as "invoiceId", s.name as supplier
       from supplier_invoice_payment p join supplier_invoice i on i.id = p.supplier_invoice_id join supplier s on s.id = i.supplier_id
       where p.company_id = $1 and p.paid_date between $2::date and $3::date
       order by p.paid_date, p.created_at`,
      [companyId, from, to],
    )
  ).rows;
  for (const p of spays) {
    events.push({
      key: `supplier_payment:${p.id}`,
      kind: 'supplier_payment',
      date: p.date,
      text: `Betalning leverantörsfaktura ${p.entryNr}, ${p.supplier}`,
      rows: [row(s.payableAccount, p.amount), row(s.bankAccount, -p.amount)],
      href: `/leverantorsfakturor/${p.invoiceId}`,
    });
  }

  for (const e of events) e.rows = normalizeRows(e.rows);
  return events;
}
