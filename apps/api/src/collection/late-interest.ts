import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { addDays } from '../contracts/contract-rules';
import { bankDayOnOrAfter, monthStart } from '../billing/billing-rules';
import { billToFor, insertLines, issueInvoices, recalcInvoice } from '../billing/invoice-store';
import { daysBetween } from '../payments/reminders';

/**
 * Dröjsmålsränta enligt räntelagen.
 *
 *  * Räntan löper från dagen efter förfallodagen på det som är obetalt varje dag.
 *    En betalning eller kreditering minskar underlaget från och med sin dag.
 *  * Räntesatsen är referensräntan för kalenderhalvåret + 8 procentenheter (6 §),
 *    eller bolagets fasta ränta, eller den ränta som står i avtalet.
 *  * Ränta beräknas per dag med 365 dagar per år och avrundas till öre per faktura.
 *  * Samma dag räntedebiteras aldrig två gånger. Nästa debitering börjar dagen efter förra.
 *  * Ränta tas inte på påminnelseavgifter eller på ränta (ingen ränta på ränta).
 */

export interface RateSettings {
  useReference: boolean;
  marginBp: number;
  fixedBp: number;
  /** Avtalad ränta ersätter bolagets */
  contractBp: number | null;
  referenceRates: { validFrom: string; rateBp: number }[];
}

/** Räntesats i baspunkter för en viss dag. */
export function rateOn(day: string, s: RateSettings): number {
  if (s.contractBp != null) return s.contractBp;
  if (!s.useReference) return s.fixedBp;
  // Referensräntan som gäller för kalenderhalvåret är den som fastställdes vid halvårets början
  let ref: number | null = null;
  for (const r of s.referenceRates) if (r.validFrom <= day) ref = r.rateBp;
  return Math.max(0, (ref ?? 0) + s.marginBp);
}

export const pct = (bp: number) => `${(bp / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} %`;

export interface InterestResult {
  amountOre: number;
  days: number;
  rates: number[];
  rateText: string;
}

/**
 * Ränta för dagarna from..to (båda inklusive) på en faktura.
 * `reductions` är betalningar och krediteringar med datum. Underlaget för en dag är
 * fakturabeloppet minus allt som kommit in till och med den dagen.
 */
export function interestFor(
  totalOre: number,
  reductions: { date: string; amountOre: number }[],
  from: string,
  to: string,
  s: RateSettings,
): InterestResult {
  const sorted = [...reductions].sort((a, b) => a.date.localeCompare(b.date));
  let paid = 0;
  let idx = 0;
  let sum = 0;
  let days = 0;
  const rates = new Set<number>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (idx < sorted.length && sorted[idx].date <= d) paid += sorted[idx++].amountOre;
    const base = totalOre - paid;
    if (base <= 0) continue;
    const bp = rateOn(d, s);
    if (bp <= 0) continue;
    sum += (base * bp) / (10_000 * 365);
    days += 1;
    rates.add(bp);
  }
  const list = [...rates];
  return { amountOre: Math.round(sum), days, rates: list, rateText: list.map(pct).join(' / ') || pct(0) };
}

export async function referenceRates(client: PoolClient): Promise<{ validFrom: string; rateBp: number }[]> {
  return (await client.query(`select valid_from::text as "validFrom", rate_bp as "rateBp" from reference_rate order by valid_from`)).rows;
}

export interface InterestCompanySettings {
  useReference: boolean;
  marginBp: number;
  fixedBp: number;
  minOre: number;
  method: 'next_notice' | 'invoice';
  fromDate: string;
  dueDays: number;
}

export async function interestSettings(client: PoolClient, companyId: string): Promise<InterestCompanySettings> {
  const { rows } = await client.query(
    `select late_interest_reference as "useReference", late_interest_margin_bp as "marginBp", late_interest_bp as "fixedBp",
            late_interest_min_ore::float as "minOre", late_interest_method as method, late_interest_from::text as "fromDate",
            reminder_due_days as "dueDays"
     from company where id = $1`,
    [companyId],
  );
  if (!rows[0]) throw new BadRequestException('Bolaget finns inte');
  return rows[0];
}

export interface InterestCandidate {
  invoiceId: string;
  companyId: string;
  invoiceNr: number;
  kind: string;
  ocr: string | null;
  dueDate: string;
  totalOre: number;
  balanceOre: number;
  customerId: string;
  customerName: string;
  contractId: string | null;
  contractNr: number | null;
  contractStatus: string | null;
  contractType: string | null;
  objectId: string | null;
  propertyId: string | null;
  costCenterId: string | null;
  fromDate: string;
  toDate: string;
  days: number;
  amountOre: number;
  rateText: string;
  /** Under bolagets lägsta belopp: väntar till nästa gång */
  belowMinimum: boolean;
  /** Kan läggas på nästa avi (aktivt eller uppsagt avtal) */
  canUseNotice: boolean;
  paidInFull: boolean;
  inPlan: boolean;
}

/**
 * Fakturor med ränta som inte debiterats, till och med ett datum.
 * Gäller också fakturor som redan är betalda men betalades för sent.
 */
export async function interestCandidates(client: PoolClient, companyId: string, asOf: string, invoiceIds?: string[]): Promise<InterestCandidate[]> {
  const s = await interestSettings(client, companyId);
  const refs = await referenceRates(client);
  const { rows } = await client.query(
    `select i.id as "invoiceId", i.company_id as "companyId", i.invoice_nr::float as "invoiceNr", i.kind, i.ocr,
            i.due_date::text as "dueDate", i.total_ore::float as "totalOre", b.balance_ore::float as "balanceOre",
            i.customer_id as "customerId", cu.name as "customerName", i.contract_id as "contractId", k.contract_nr as "contractNr",
            k.status as "contractStatus", k.type as "contractType", k.late_interest_bp as "contractBp",
            (select max(c.to_date)::text from late_interest_charge c where c.invoice_id = i.id) as "chargedTo",
            exists (select 1 from payment_plan_invoice pi join payment_plan pp on pp.id = pi.plan_id
                    where pi.invoice_id = i.id and pi.active and pp.status = 'active') as "inPlan",
            first.object_id as "objectId", first.property_id as "propertyId", first.cost_center_id as "costCenterId"
     from invoice i
     join invoice_balance b on b.invoice_id = i.id
     join customer cu on cu.id = i.customer_id
     left join contract k on k.id = i.contract_id
     left join lateral (select l.object_id, l.property_id, l.cost_center_id from invoice_line l
                        where l.invoice_id = i.id order by l.position limit 1) first on true
     where i.company_id = $1 and i.status = 'issued' and i.kind <> 'credit_note' and i.due_date < $2::date
       and ($3::uuid[] is null or i.id = any($3))
       -- ingen ränta på påminnelseavgifter eller på ränta
       and not exists (select 1 from reminder r where r.fee_invoice_id = i.id)
       and not exists (select 1 from late_interest_charge c where c.interest_invoice_id = i.id)
       -- hos inkassobolaget räknar inkassobolaget räntan
       and not exists (select 1 from collection_case_invoice ci join collection_case cc on cc.id = ci.case_id
                       where ci.invoice_id = i.id and ci.active and cc.status in ('sent', 'enforcement'))
       -- avbetalningsplan utan ränta
       and not exists (select 1 from payment_plan_invoice pi join payment_plan pp on pp.id = pi.plan_id
                       where pi.invoice_id = i.id and pi.active and pp.status = 'active' and not pp.charge_interest)
       and (b.balance_ore > 0 or exists (
             select 1 from payment_allocation a join payment p on p.id = a.payment_id
             where a.invoice_id = i.id and p.payment_date > i.due_date and p.payment_date >= $4::date))
     order by cu.name, i.due_date, i.invoice_nr`,
    [companyId, asOf, invoiceIds ?? null, s.fromDate],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.invoiceId);
  const red = (
    await client.query(
      `select a.invoice_id as id, p.payment_date::text as date, a.amount_ore::float as amount
       from payment_allocation a join payment p on p.id = a.payment_id where a.invoice_id = any($1)
       union all
       select c.credits_invoice_id, c.invoice_date::text, -c.total_ore::float
       from invoice c where c.credits_invoice_id = any($1) and c.status = 'issued'`,
      [ids],
    )
  ).rows;
  const byInvoice = new Map<string, { date: string; amountOre: number }[]>();
  for (const r of red) byInvoice.set(r.id, [...(byInvoice.get(r.id) ?? []), { date: r.date, amountOre: r.amount }]);

  const out: InterestCandidate[] = [];
  for (const r of rows) {
    const reductions = byInvoice.get(r.invoiceId) ?? [];
    let from = addDays(r.dueDate, 1);
    if (r.chargedTo && addDays(r.chargedTo, 1) > from) from = addDays(r.chargedTo, 1);
    if (s.fromDate > from) from = s.fromDate;
    // Betald faktura: räntan slutar dagen före sista betalningen
    let to = asOf;
    if (r.balanceOre <= 0) {
      const last = reductions.map((x) => x.date).sort().at(-1);
      if (last && last < to) to = addDays(last, -1);
    }
    if (from > to) continue;
    const res = interestFor(r.totalOre, reductions, from, to, {
      useReference: s.useReference,
      marginBp: s.marginBp,
      fixedBp: s.fixedBp,
      contractBp: r.contractBp,
      referenceRates: refs,
    });
    if (res.amountOre <= 0) continue;
    out.push({
      invoiceId: r.invoiceId,
      companyId: r.companyId,
      invoiceNr: r.invoiceNr,
      kind: r.kind,
      ocr: r.ocr,
      dueDate: r.dueDate,
      totalOre: r.totalOre,
      balanceOre: r.balanceOre,
      customerId: r.customerId,
      customerName: r.customerName,
      contractId: r.contractId,
      contractNr: r.contractNr,
      contractStatus: r.contractStatus,
      contractType: r.contractType,
      objectId: r.objectId,
      propertyId: r.propertyId,
      costCenterId: r.costCenterId,
      fromDate: from,
      toDate: to,
      days: res.days,
      amountOre: res.amountOre,
      rateText: res.rateText,
      belowMinimum: res.amountOre < s.minOre,
      canUseNotice: !!r.contractId && ['active', 'terminated'].includes(r.contractStatus),
      paidInFull: r.balanceOre <= 0,
      inPlan: r.inPlan,
    });
  }
  return out;
}

/** Upplupen ränta som inte debiterats för en faktura, till och med ett datum (0 om ingen). */
export async function accruedInterest(client: PoolClient, companyId: string, invoiceId: string, asOf: string): Promise<{ amountOre: number; fromDate: string | null; rateText: string | null }> {
  const [c] = await interestCandidates(client, companyId, asOf, [invoiceId]);
  return c ? { amountOre: c.amountOre, fromDate: c.fromDate, rateText: c.rateText } : { amountOre: 0, fromDate: null, rateText: null };
}

const describe = (c: InterestCandidate) =>
  `Dröjsmålsränta ${c.rateText} faktura ${c.invoiceNr}, ${c.fromDate}–${c.toDate} (${c.days} dagar)`;

/**
 * Debiterar räntan för valda fakturor.
 *  * next_notice: en extra debitering på avtalet, som kommer med nästa hyresavi.
 *  * invoice: en räntefaktura per kund, som utfärdas och skickas som vanligt.
 * Fakturor utan avtal som kan aviseras får alltid räntefaktura.
 */
export async function chargeInterest(
  client: PoolClient,
  companyId: string,
  opts: { date: string; invoiceIds: string[]; method?: 'next_notice' | 'invoice'; includeBelowMinimum?: boolean },
): Promise<{ charged: number; amountOre: number; onNotice: number; interestInvoiceIds: string[]; skipped: { invoiceId: string; reason: string }[] }> {
  const s = await interestSettings(client, companyId);
  const method = opts.method ?? s.method;
  const list = await interestCandidates(client, companyId, opts.date, opts.invoiceIds);
  const byId = new Map(list.map((c) => [c.invoiceId, c]));
  const skipped: { invoiceId: string; reason: string }[] = [];
  const notice: InterestCandidate[] = [];
  const invoiceGroups = new Map<string, InterestCandidate[]>();
  for (const id of opts.invoiceIds) {
    const c = byId.get(id);
    if (!c) {
      skipped.push({ invoiceId: id, reason: 'Ingen ränta att debitera' });
      continue;
    }
    if (c.belowMinimum && !opts.includeBelowMinimum) {
      skipped.push({ invoiceId: id, reason: 'Räntan är under lägsta belopp' });
      continue;
    }
    if (method === 'next_notice' && c.canUseNotice) notice.push(c);
    else invoiceGroups.set(c.customerId, [...(invoiceGroups.get(c.customerId) ?? []), c]);
  }

  let charged = 0;
  let amountOre = 0;
  for (const c of notice) {
    const { rows } = await client.query(
      `insert into contract_charge (company_id, contract_id, object_id, article, description, amount_ore, vat_rate_bp, bill_from, note)
       values ($1, $2, $3, 'interest', $4, $5, 0, $6, $7) returning id`,
      [companyId, c.contractId, c.objectId, describe(c), c.amountOre, monthStart(opts.date), `Dröjsmålsränta på faktura ${c.invoiceNr}`],
    );
    await client.query(
      `insert into late_interest_charge (company_id, invoice_id, customer_id, from_date, to_date, amount_ore, rate_text, method, contract_charge_id, run_date)
       values ($1, $2, $3, $4, $5, $6, $7, 'next_notice', $8, $9)`,
      [companyId, c.invoiceId, c.customerId, c.fromDate, c.toDate, c.amountOre, c.rateText, rows[0].id, opts.date],
    );
    await client.query(`insert into contract_event (company_id, contract_id, kind, description) values ($1, $2, 'charge', $3)`, [
      companyId,
      c.contractId,
      `Dröjsmålsränta på faktura ${c.invoiceNr} läggs på nästa avi: ${(c.amountOre / 100).toLocaleString('sv-SE')} kr`,
    ]);
    charged += 1;
    amountOre += c.amountOre;
  }

  const interestInvoiceIds: string[] = [];
  const dueDate = bankDayOnOrAfter(addDays(opts.date, s.dueDays));
  for (const [customerId, group] of invoiceGroups) {
    const { billTo, deliveryMethod } = await billToFor(client, customerId);
    const { rows } = await client.query(
      `insert into invoice (company_id, kind, customer_id, contract_id, invoice_date, due_date, bill_to, delivery_method, message)
       values ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        companyId,
        customerId,
        group.length === 1 ? group[0].contractId : null,
        opts.date,
        dueDate,
        JSON.stringify(billTo),
        deliveryMethod,
        'Dröjsmålsränta enligt räntelagen på fakturor som betalats efter förfallodagen. Räntan är momsfri.',
      ],
    );
    const invoiceId = rows[0].id as string;
    await insertLines(
      client,
      companyId,
      invoiceId,
      group.map((c) => ({
        lineKind: 'manual' as const,
        contractId: c.contractId,
        objectId: c.objectId,
        propertyId: c.propertyId,
        costCenterId: c.costCenterId,
        article: 'interest',
        description: describe(c),
        periodFrom: c.fromDate,
        periodTo: c.toDate,
        quantity: 1,
        unitPriceOre: c.amountOre,
        netOre: c.amountOre,
        vatRateBp: 0,
        vatOre: 0,
      })),
    );
    await recalcInvoice(client, invoiceId);
    await issueInvoices(client, companyId, [invoiceId], true);
    for (const c of group) {
      await client.query(
        `insert into late_interest_charge (company_id, invoice_id, customer_id, from_date, to_date, amount_ore, rate_text, method, interest_invoice_id, run_date)
         values ($1, $2, $3, $4, $5, $6, $7, 'invoice', $8, $9)`,
        [companyId, c.invoiceId, c.customerId, c.fromDate, c.toDate, c.amountOre, c.rateText, invoiceId, opts.date],
      );
      charged += 1;
      amountOre += c.amountOre;
    }
    interestInvoiceIds.push(invoiceId);
  }
  return { charged, amountOre, onNotice: notice.length, interestInvoiceIds, skipped };
}

export { daysBetween };
