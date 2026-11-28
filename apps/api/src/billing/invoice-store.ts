import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ocrFor, roundingFor } from './billing-rules';

export interface BillTo {
  customerNr: number;
  kind: string;
  name: string;
  nationalId: string | null;
  vatNr: string | null;
  careOf: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  reference: string | null;
  email: string | null;
  peppolId: string | null;
}

export interface NewLine {
  lineKind: 'regular' | 'retroactive' | 'charge' | 'manual' | 'credit';
  contractId?: string | null;
  contractLineId?: string | null;
  contractChargeId?: string | null;
  objectId?: string | null;
  propertyId?: string | null;
  costCenterId?: string | null;
  article: string;
  /** Intäktskonto. Tomt = artikelns konto när raden skapas. */
  accountNumber?: string | null;
  description: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  quantity?: number;
  unitPriceOre?: number;
  netOre: number;
  vatRateBp: number;
  vatOre: number;
  creditsLineId?: string | null;
  rebill?: boolean;
}

/** Kunduppgifter som fakturan ska bära med sig. Fakturaadress används om den finns. */
export async function billToFor(client: PoolClient, customerId: string): Promise<{ billTo: BillTo; deliveryMethod: string; termsDays: number }> {
  const { rows } = await client.query(
    `select customer_nr, kind, name, national_id, vat_nr, email, peppol_id, country, delivery_method, payment_terms_days,
            invoice_reference, address_line, care_of, postal_code, city,
            invoice_address_line, invoice_care_of, invoice_postal_code, invoice_city
     from customer where id = $1`,
    [customerId],
  );
  const c = rows[0];
  if (!c) throw new BadRequestException('Kunden finns inte i valt bolag');
  const own = !!c.invoice_address_line;
  return {
    billTo: {
      customerNr: c.customer_nr,
      kind: c.kind,
      name: c.name,
      nationalId: c.national_id,
      vatNr: c.vat_nr,
      careOf: own ? c.invoice_care_of : c.care_of,
      addressLine: own ? c.invoice_address_line : c.address_line,
      postalCode: own ? c.invoice_postal_code : c.postal_code,
      city: own ? c.invoice_city : c.city,
      country: c.country,
      reference: c.invoice_reference,
      email: c.email,
      peppolId: c.peppol_id,
    },
    deliveryMethod: c.delivery_method,
    termsDays: c.payment_terms_days,
  };
}

export async function insertLines(client: PoolClient, companyId: string, invoiceId: string, lines: NewLine[], startPos = 0) {
  let pos = startPos;
  for (const l of lines) {
    pos += 1;
    await client.query(
      `insert into invoice_line (company_id, invoice_id, position, line_kind, contract_id, contract_line_id, contract_charge_id,
         object_id, property_id, cost_center_id, article, description, period_from, period_to, quantity, unit_price_ore,
         net_ore, vat_rate_bp, vat_ore, credits_line_id, rebill, account_number)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        companyId,
        invoiceId,
        pos,
        l.lineKind,
        l.contractId ?? null,
        l.contractLineId ?? null,
        l.contractChargeId ?? null,
        l.objectId ?? null,
        l.propertyId ?? null,
        l.costCenterId ?? null,
        l.article,
        l.description,
        l.periodFrom ?? null,
        l.periodTo ?? null,
        l.quantity ?? 1,
        l.unitPriceOre ?? l.netOre,
        l.netOre,
        l.vatRateBp,
        l.vatOre,
        l.creditsLineId ?? null,
        l.rebill ?? false,
        l.accountNumber ?? null,
      ],
    );
  }
}

/** Räknar om fakturans summor ur raderna, med öresavrundning om bolaget vill det. */
export async function recalcInvoice(client: PoolClient, invoiceId: string): Promise<{ netOre: number; vatOre: number; totalOre: number }> {
  const { rows } = await client.query(
    `select coalesce(sum(l.net_ore), 0)::float as net, coalesce(sum(l.vat_ore), 0)::float as vat, c.round_to_krona as round
     from invoice i join company c on c.id = i.company_id left join invoice_line l on l.invoice_id = i.id
     where i.id = $1 group by c.round_to_krona`,
    [invoiceId],
  );
  const r = rows[0];
  const sum = r.net + r.vat;
  const rounding = r.round ? roundingFor(sum) : 0;
  await client.query('update invoice set net_ore = $2, vat_ore = $3, rounding_ore = $4, total_ore = $5 where id = $1', [
    invoiceId,
    r.net,
    r.vat,
    rounding,
    sum + rounding,
  ]);
  return { netOre: r.net, vatOre: r.vat, totalOre: sum + rounding };
}

/** Tar nästa fakturanummer i bolagets serie. Raden låses, så två utfärdanden kan inte få samma nummer. */
async function takeNumbers(client: PoolClient, companyId: string, count: number): Promise<number> {
  await client.query('insert into invoice_series (company_id) values ($1) on conflict do nothing', [companyId]);
  const { rows } = await client.query(
    'update invoice_series set next_nr = next_nr + $2 where company_id = $1 returning (next_nr - $2)::float as first',
    [companyId, count],
  );
  return rows[0].first;
}

/** Leveranssätt som faktiskt fungerar för kunden. Faller tillbaka till e-post eller brev. */
export function resolveChannel(method: string, b: BillTo): { channel: 'email' | 'post' | 'e_invoice'; recipient: string | null } {
  if (method === 'e_invoice' && b.peppolId) return { channel: 'e_invoice', recipient: b.peppolId };
  if ((method === 'email' || method === 'e_invoice') && b.email) return { channel: 'email', recipient: b.email };
  return { channel: 'post', recipient: [b.addressLine, b.postalCode, b.city].filter(Boolean).join(', ') || null };
}

/**
 * Utfärdar utkast: fakturanummer i följd, OCR, aktuella kunduppgifter och låsning.
 * Därefter går fakturan inte att ändra (databasen stoppar det).
 */
export async function issueInvoices(client: PoolClient, companyId: string, invoiceIds: string[], queueDelivery = true): Promise<void> {
  if (!invoiceIds.length) return;
  const { rows } = await client.query(
    `select i.id, i.customer_id, i.kind, i.total_ore::float as total, i.status
     from invoice i join customer c on c.id = i.customer_id
     where i.id = any($1) and i.company_id = $2
     order by i.kind, c.customer_nr, i.contract_id nulls last, i.created_at
     for update of i`,
    [invoiceIds, companyId],
  );
  if (rows.length !== invoiceIds.length) throw new NotFoundException('Fakturan finns inte');
  if (rows.some((r) => r.status !== 'draft')) throw new BadRequestException('Fakturan är redan utfärdad');
  const first = await takeNumbers(client, companyId, rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const nr = first + i;
    const { billTo, deliveryMethod } = await billToFor(client, r.customer_id);
    const kept = (await client.query('select delivery_method from invoice where id = $1', [r.id])).rows[0].delivery_method;
    await client.query(
      `update invoice set status = 'issued', invoice_nr = $2, ocr = $3, bill_to = $4, delivery_method = $5,
              issued_at = now(), issued_by = app.current_user_id()
       where id = $1`,
      [r.id, nr, r.kind === 'credit_note' ? null : ocrFor(nr), JSON.stringify(billTo), kept ?? deliveryMethod],
    );
    if (queueDelivery) {
      const { channel, recipient } = resolveChannel(kept ?? deliveryMethod, billTo);
      await client.query(
        `insert into invoice_delivery (company_id, invoice_id, channel, status, recipient) values ($1, $2, $3, 'queued', $4)`,
        [companyId, r.id, channel, recipient],
      );
    }
  }
}

export const INVOICE_LIST_SQL = `
  select i.id, i.company_id as "companyId", co.name as "companyName", i.kind, i.status,
         i.invoice_nr::float as "invoiceNr", i.ocr, i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate",
         i.period_from::text as "periodFrom", i.period_to::text as "periodTo",
         i.customer_id as "customerId", cu.name as "customerName", cu.customer_nr as "customerNr",
         i.contract_id as "contractId", k.contract_nr as "contractNr", i.billing_run_id as "billingRunId",
         i.net_ore::float as "netOre", i.vat_ore::float as "vatOre", i.total_ore::float as "totalOre",
         b.paid_ore::float as "paidOre", b.credited_ore::float as "creditedOre", b.balance_ore::float as "balanceOre",
         i.credits_invoice_id as "creditsInvoiceId", i.delivery_method as "deliveryMethod",
         (select d.status from invoice_delivery d where d.invoice_id = i.id order by d.created_at desc limit 1) as "deliveryStatus",
         coalesce((select string_agg(distinct o.object_nr, ', ') from invoice_line l join rental_object o on o.id = l.object_id
                   where l.invoice_id = i.id), '') as objects,
         coalesce((select max(r.level) from reminder r where r.invoice_id = i.id), 0) as "reminderLevel"
  from invoice i
  join company co on co.id = i.company_id
  join customer cu on cu.id = i.customer_id
  left join contract k on k.id = i.contract_id
  join invoice_balance b on b.invoice_id = i.id`;

/** Betalstatus som visas för en faktura. */
export function paymentState(r: { kind: string; status: string; totalOre: number; balanceOre: number; paidOre: number; creditedOre: number; dueDate: string }, today: string): string {
  if (r.status === 'draft') return 'draft';
  if (r.kind === 'credit_note') return 'credit_note';
  if (r.creditedOre !== 0 && r.creditedOre >= r.totalOre) return 'credited';
  if (r.balanceOre <= 0) return r.balanceOre < 0 ? 'overpaid' : 'paid';
  if (r.dueDate < today) return 'overdue';
  if (r.paidOre > 0 || r.creditedOre > 0) return 'partially_paid';
  return 'unpaid';
}

export interface InvoiceListRow {
  id: string;
  companyId: string;
  companyName: string;
  kind: string;
  status: string;
  invoiceNr: number | null;
  ocr: string | null;
  invoiceDate: string;
  dueDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  customerId: string;
  customerName: string;
  customerNr: number;
  contractId: string | null;
  contractNr: number | null;
  billingRunId: string | null;
  netOre: number;
  vatOre: number;
  totalOre: number;
  paidOre: number;
  creditedOre: number;
  balanceOre: number;
  creditsInvoiceId: string | null;
  deliveryMethod: string;
  deliveryStatus: string | null;
  objects: string;
}

export interface InvoiceLineRow {
  id: string;
  position: number;
  lineKind: string;
  contractId: string | null;
  contractLineId: string | null;
  objectId: string | null;
  objectNr: string | null;
  propertyId: string | null;
  propertyName: string | null;
  costCenterId: string | null;
  costCenterCode: string | null;
  article: string;
  articleName: string | null;
  accountNumber: string | null;
  description: string;
  periodFrom: string | null;
  periodTo: string | null;
  quantity: number;
  unitPriceOre: number;
  netOre: number;
  vatRateBp: number;
  vatOre: number;
  creditsLineId: string | null;
  rebill: boolean;
  creditedNetOre: number;
}

export async function loadInvoice(client: PoolClient, id: string) {
  const { rows } = await client.query(`${INVOICE_LIST_SQL} where i.id = $1`, [id]);
  const inv = rows[0] as InvoiceListRow | undefined;
  if (!inv) throw new NotFoundException('Fakturan finns inte');
  const extra = (
    await client.query(
      `select bill_to as "billTo", our_reference as "ourReference", your_reference as "yourReference", message,
              rounding_ore::float as "roundingOre", credit_reason as "creditReason", issued_at as "issuedAt",
              (select name from app_user u where u.id = invoice.issued_by) as "issuedByName", created_at as "createdAt"
       from invoice where id = $1`,
      [id],
    )
  ).rows[0] as {
    billTo: BillTo;
    ourReference: string | null;
    yourReference: string | null;
    message: string | null;
    roundingOre: number;
    creditReason: string | null;
    issuedAt: string | null;
    issuedByName: string | null;
    createdAt: string;
  };
  const lines = (
    await client.query(
      `select l.id, l.position, l.line_kind as "lineKind", l.contract_id as "contractId", l.contract_line_id as "contractLineId",
              l.object_id as "objectId", o.object_nr as "objectNr", l.property_id as "propertyId", p.name as "propertyName",
              l.cost_center_id as "costCenterId", cc.code as "costCenterCode",
              l.article, ar.name as "articleName", l.account_number as "accountNumber",
              l.description, l.period_from::text as "periodFrom", l.period_to::text as "periodTo",
              l.quantity::float as quantity, l.unit_price_ore::float as "unitPriceOre", l.net_ore::float as "netOre",
              l.vat_rate_bp as "vatRateBp", l.vat_ore::float as "vatOre", l.credits_line_id as "creditsLineId", l.rebill,
              coalesce((select -sum(x.net_ore) from invoice_line x join invoice xi on xi.id = x.invoice_id
                        where x.credits_line_id = l.id and xi.status = 'issued'), 0)::float as "creditedNetOre"
       from invoice_line l
       left join rental_object o on o.id = l.object_id
       left join property p on p.id = l.property_id
       left join cost_center cc on cc.id = l.cost_center_id
       left join article ar on ar.company_id = l.company_id and ar.code = l.article
       where l.invoice_id = $1 order by l.position, l.created_at`,
      [id],
    )
  ).rows as InvoiceLineRow[];
  const payments = (
    await client.query(
      `select a.id, a.payment_id as "paymentId", a.amount_ore::float as "amountOre", p.amount_ore::float as "paymentAmountOre",
              p.payment_date::text as "paymentDate", p.method, p.reference, p.note
       from payment_allocation a join payment p on p.id = a.payment_id
       where a.invoice_id = $1 order by p.payment_date, a.created_at`,
      [id],
    )
  ).rows;
  const credits = (await client.query(`${INVOICE_LIST_SQL} where i.credits_invoice_id = $1 order by i.created_at`, [id])).rows as InvoiceListRow[];
  const credited: InvoiceListRow | null = inv.creditsInvoiceId
    ? (await client.query(`${INVOICE_LIST_SQL} where i.id = $1`, [inv.creditsInvoiceId])).rows[0]
    : null;
  const deliveries = (
    await client.query(
      `select id, channel, status, recipient, sent_at as "sentAt", error, created_at as "createdAt"
       from invoice_delivery where invoice_id = $1 order by created_at`,
      [id],
    )
  ).rows;
  const company = await companyInfo(client, inv.companyId);
  // Senaste autogirodragningen för avin, så att avin kan säga att den dras eller att dragningen misslyckades
  const autogiro = ((
    await client.query(
      `select status, payment_date::text as "paymentDate", message from autogiro_payment where invoice_id = $1 order by created_at desc limit 1`,
      [id],
    )
  ).rows[0] ?? null) as { status: 'planned' | 'sent' | 'paid' | 'failed' | 'cancelled'; paymentDate: string; message: string | null } | null;
  const live = inv.status === 'draft' ? (await billToFor(client, inv.customerId)).billTo : null;
  return {
    ...inv,
    ...extra,
    billTo: (live ?? extra.billTo) as BillTo,
    lines,
    payments,
    credits,
    credited,
    deliveries,
    company,
    autogiro,
  };
}

/** Bolagsuppgifter som visas på fakturor, påminnelser och kontoutdrag. */
export async function companyInfo(client: PoolClient, companyId: string): Promise<CompanyInfo> {
  return (
    await client.query(
      `select name, org_nr as "orgNr", vat_nr as "vatNr", address_line as "addressLine", postal_code as "postalCode", city,
              bankgiro, plusgiro, invoice_email as "invoiceEmail", f_tax as "fTax", invoice_footer as "invoiceFooter",
              round_to_krona as "roundToKrona",
              (select iban from bank_account b where b.company_id = company.id and b.purpose = 'rent' and b.iban is not null limit 1) as iban,
              (select bic from bank_account b where b.company_id = company.id and b.purpose = 'rent' and b.iban is not null limit 1) as bic
       from company where id = $1`,
      [companyId],
    )
  ).rows[0];
}

export interface CompanyInfo {
  name: string;
  orgNr: string;
  vatNr: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  invoiceEmail: string | null;
  fTax: boolean;
  invoiceFooter: string | null;
  roundToKrona: boolean;
  iban: string | null;
  bic: string | null;
}

export type InvoiceDetail = Awaited<ReturnType<typeof loadInvoice>>;
