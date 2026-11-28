import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { addDays } from '../contracts/contract-rules';
import { bankDayOnOrAfter } from '../billing/billing-rules';
import { billToFor, BillTo, companyInfo, CompanyInfo } from '../billing/invoice-store';

/**
 * Avbetalningsplan: hyresgästen betalar en skuld (en eller flera obetalda fakturor) i delbetalningar.
 *
 *  * Planen skapar inga nya fordringar. Fakturorna ligger kvar och delbetalningarna
 *    fördelas på dem, äldst först. Hyresgästen betalar med OCR-numret på planens första faktura.
 *  * Fakturor i en aktiv plan påminns inte och lämnas inte till inkasso.
 *  * En delbetalning räknas som betald när det som betalats sedan planen gjordes
 *    täcker alla delbetalningar fram till och med den.
 */

/** Dela upp ett belopp i delbetalningar: lika stora, den sista tar resten. Hela kronor. */
export function splitInstallments(totalOre: number, count: number, firstDue: string, intervalMonths = 1): { nr: number; dueDate: string; amountOre: number }[] {
  if (count < 1) throw new BadRequestException('Minst en delbetalning');
  const each = Math.floor(totalOre / count / 100) * 100;
  const out: { nr: number; dueDate: string; amountOre: number }[] = [];
  let rest = totalOre;
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? rest : each;
    if (amount <= 0) throw new BadRequestException('För många delbetalningar för beloppet');
    rest -= amount;
    out.push({ nr: i + 1, dueDate: bankDayOnOrAfter(addMonths(firstDue, i * intervalMonths)), amountOre: amount });
  }
  return out;
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export interface PlanInstallment {
  nr: number;
  dueDate: string;
  amountOre: number;
  coveredOre: number;
  state: 'paid' | 'partial' | 'due' | 'overdue';
}

export interface PlanDetail {
  id: string;
  companyId: string;
  planNr: number;
  customerId: string;
  customerName: string;
  customerNr: number;
  status: string;
  /** active, completed, broken, cancelled eller behind (aktiv men en delbetalning är försenad) */
  state: string;
  agreedDate: string;
  totalOre: number;
  paidOre: number;
  remainingOre: number;
  chargeInterest: boolean;
  note: string | null;
  closedDate: string | null;
  closedReason: string | null;
  ocr: string | null;
  invoices: { invoiceId: string; invoiceNr: number; kind: string; dueDate: string; startBalanceOre: number; balanceOre: number; ocr: string | null }[];
  installments: PlanInstallment[];
  nextDue: PlanInstallment | null;
  overdueOre: number;
  billTo: BillTo;
  company: CompanyInfo;
}

/** Delbetalningarnas status utifrån hur mycket som betalats sedan planen gjordes. */
export function installmentStates(list: { nr: number; dueDate: string; amountOre: number }[], paidOre: number, today: string): PlanInstallment[] {
  let left = paidOre;
  return list.map((i) => {
    const covered = Math.max(0, Math.min(i.amountOre, left));
    left -= covered;
    const state: PlanInstallment['state'] = covered >= i.amountOre ? 'paid' : i.dueDate < today ? 'overdue' : covered > 0 ? 'partial' : 'due';
    return { ...i, coveredOre: covered, state };
  });
}

const PLAN_SQL = `
  select p.id, p.company_id as "companyId", p.plan_nr as "planNr", p.customer_id as "customerId", cu.name as "customerName",
         cu.customer_nr as "customerNr", p.status, p.agreed_date::text as "agreedDate", p.total_ore::float as "totalOre",
         p.charge_interest as "chargeInterest", p.note, p.closed_date::text as "closedDate", p.closed_reason as "closedReason"
  from payment_plan p join customer cu on cu.id = p.customer_id`;

export async function loadPlans(client: PoolClient, where: string, params: unknown[], today: string, withParties = false): Promise<PlanDetail[]> {
  const { rows } = await client.query(`${PLAN_SQL} ${where} order by p.plan_nr desc`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const invoices = (
    await client.query(
      `select pi.plan_id as "planId", i.id as "invoiceId", i.invoice_nr::float as "invoiceNr", i.kind, i.due_date::text as "dueDate",
              pi.balance_ore::float as "startBalanceOre", b.balance_ore::float as "balanceOre", i.ocr
       from payment_plan_invoice pi join invoice i on i.id = pi.invoice_id join invoice_balance b on b.invoice_id = i.id
       where pi.plan_id = any($1) order by i.due_date, i.invoice_nr`,
      [ids],
    )
  ).rows;
  const inst = (
    await client.query(
      `select plan_id as "planId", nr, due_date::text as "dueDate", amount_ore::float as "amountOre"
       from payment_plan_installment where plan_id = any($1) order by nr`,
      [ids],
    )
  ).rows;
  const out: PlanDetail[] = [];
  for (const r of rows) {
    const inv = invoices.filter((i) => i.planId === r.id).map(({ planId: _p, ...i }) => i);
    const remaining = inv.reduce((a, i) => a + Math.max(0, i.balanceOre), 0);
    const paid = Math.max(0, r.totalOre - remaining);
    const installments = installmentStates(
      inst.filter((i) => i.planId === r.id),
      paid,
      today,
    );
    const overdue = installments.filter((i) => i.state === 'overdue');
    let state = r.status;
    if (r.status === 'active' && remaining <= 0) state = 'completed';
    else if (r.status === 'active' && overdue.length) state = 'behind';
    const detail: PlanDetail = {
      ...r,
      state,
      paidOre: paid,
      remainingOre: remaining,
      ocr: inv[0]?.ocr ?? null,
      invoices: inv,
      installments,
      nextDue: installments.find((i) => i.state !== 'paid') ?? null,
      overdueOre: overdue.reduce((a, i) => a + i.amountOre - i.coveredOre, 0),
      billTo: undefined as unknown as BillTo,
      company: undefined as unknown as CompanyInfo,
    };
    if (withParties) {
      detail.billTo = (await billToFor(client, r.customerId)).billTo;
      detail.company = await companyInfo(client, r.companyId);
    }
    out.push(detail);
  }
  return out;
}

export async function loadPlan(client: PoolClient, id: string, today: string): Promise<PlanDetail> {
  const [p] = await loadPlans(client, 'where p.id = $1', [id], today, true);
  if (!p) throw new NotFoundException('Avbetalningsplanen finns inte');
  return p;
}

export async function createPlan(
  client: PoolClient,
  companyId: string,
  d: {
    customerId: string;
    invoiceIds: string[];
    agreedDate: string;
    firstDueDate: string;
    installments?: number;
    monthlyAmountOre?: number;
    chargeInterest: boolean;
    note?: string | null;
  },
): Promise<string> {
  const { rows: inv } = await client.query(
    `select i.id, i.customer_id as "customerId", i.status, i.kind, b.balance_ore::float as balance, i.invoice_nr::float as nr,
            exists (select 1 from payment_plan_invoice pi join payment_plan pp on pp.id = pi.plan_id
                    where pi.invoice_id = i.id and pi.active and pp.status = 'active') as "inPlan",
            exists (select 1 from collection_case_invoice ci join collection_case cc on cc.id = ci.case_id
                    where ci.invoice_id = i.id and ci.active and cc.status in ('sent', 'enforcement')) as "atAgency"
     from invoice i join invoice_balance b on b.invoice_id = i.id where i.id = any($1)
     order by i.due_date, i.invoice_nr`,
    [d.invoiceIds],
  );
  if (inv.length !== new Set(d.invoiceIds).size) throw new BadRequestException('En faktura finns inte i valt bolag');
  for (const i of inv) {
    if (i.customerId !== d.customerId) throw new BadRequestException(`Faktura ${i.nr} tillhör en annan kund`);
    if (i.status !== 'issued' || i.kind === 'credit_note' || i.balance <= 0) throw new ConflictException(`Faktura ${i.nr} har inget obetalt belopp`);
    if (i.inPlan) throw new ConflictException(`Faktura ${i.nr} ingår redan i en avbetalningsplan`);
    if (i.atAgency) throw new ConflictException(`Faktura ${i.nr} ligger hos inkassobolaget. Återkalla ärendet först.`);
  }
  const total = inv.reduce((a, i) => a + i.balance, 0);
  let count = d.installments;
  if (!count && d.monthlyAmountOre) count = Math.ceil(total / d.monthlyAmountOre);
  if (!count || count < 1) throw new BadRequestException('Ange antal delbetalningar eller belopp per månad');
  if (count > 60) throw new BadRequestException('Högst 60 delbetalningar');
  const parts = d.monthlyAmountOre && !d.installments
    ? Array.from({ length: count }, (_, i) => ({
        nr: i + 1,
        dueDate: bankDayOnOrAfter(addMonths(d.firstDueDate, i)),
        amountOre: i === count! - 1 ? total - d.monthlyAmountOre! * (count! - 1) : d.monthlyAmountOre!,
      }))
    : splitInstallments(total, count, d.firstDueDate);
  if (d.firstDueDate < d.agreedDate) throw new BadRequestException('Första delbetalningen kan inte vara före avtalsdagen');

  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`payment_plan:${companyId}`]);
  const nr = (await client.query('select coalesce(max(plan_nr), 0) + 1 as nr from payment_plan where company_id = $1', [companyId])).rows[0].nr;
  const { rows } = await client.query(
    `insert into payment_plan (company_id, plan_nr, customer_id, agreed_date, total_ore, charge_interest, note)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [companyId, nr, d.customerId, d.agreedDate, total, d.chargeInterest, d.note ?? null],
  );
  const planId = rows[0].id;
  for (const i of inv) {
    await client.query(`insert into payment_plan_invoice (company_id, plan_id, invoice_id, balance_ore) values ($1, $2, $3, $4)`, [companyId, planId, i.id, i.balance]);
  }
  for (const p of parts) {
    await client.query(`insert into payment_plan_installment (company_id, plan_id, nr, due_date, amount_ore) values ($1, $2, $3, $4, $5)`, [
      companyId,
      planId,
      p.nr,
      p.dueDate,
      p.amountOre,
    ]);
  }
  // Ett förberett inkassoärende för samma fakturor behövs inte längre
  await client.query(
    `update collection_case_invoice ci set active = false from collection_case cc
     where cc.id = ci.case_id and cc.status = 'prepared' and ci.invoice_id = any($1) and ci.active`,
    [d.invoiceIds],
  );
  return planId;
}

/** Avslutar en plan: klar, bruten (hyresgästen följer den inte) eller makulerad. Fakturorna kan då påminnas och lämnas till inkasso igen. */
export async function closePlan(client: PoolClient, id: string, status: 'completed' | 'broken' | 'cancelled', date: string, reason: string | null) {
  const { rowCount } = await client.query(
    `update payment_plan set status = $2, closed_date = $3, closed_reason = $4 where id = $1 and status = 'active'`,
    [id, status, date, reason],
  );
  if (!rowCount) throw new ConflictException('Planen är inte aktiv');
  await client.query(`update payment_plan_invoice set active = false where plan_id = $1`, [id]);
}
