import type { PoolClient } from 'pg';
import { addDays } from '../contracts/contract-rules';
import { bankDayOnOrAfter } from '../billing/billing-rules';
import { BillTo, billToFor, companyInfo, CompanyInfo, insertLines, issueInvoices, recalcInvoice } from '../billing/invoice-store';
import { sendOrSave } from '../billing/delivery';
import { kr } from '../billing/invoice-pdf';
import { renderRemindersPdf } from './letters-pdf';

/** Dagar mellan två ISO-datum. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Upplupen dröjsmålsränta från förfallodagen till och med ett datum, avrundad till öre. */
export function lateInterest(balanceOre: number, rateBp: number, dueDate: string, asOf: string): number {
  const days = daysBetween(dueDate, asOf);
  if (days <= 0 || balanceOre <= 0 || rateBp <= 0) return 0;
  return Math.round((balanceOre * rateBp * days) / (10_000 * 365));
}

export interface ReminderCandidate {
  invoiceId: string;
  companyId: string;
  invoiceNr: number;
  ocr: string | null;
  kind: string;
  invoiceDate: string;
  dueDate: string;
  totalOre: number;
  balanceOre: number;
  customerId: string;
  customerName: string;
  customerNr: number;
  contractId: string | null;
  contractNr: number | null;
  daysOverdue: number;
  lastLevel: number;
  lastReminderDate: string | null;
  lastDueDate: string | null;
  /** remind = påminnelse kan skickas, wait = inom frist, collection = båda påminnelserna obetalda */
  action: 'remind' | 'wait' | 'collection';
  nextLevel: number | null;
  feeOre: number;
  interestOre: number;
  channel: 'email' | 'post';
  recipient: string | null;
  warnings: string[];
}

const CANDIDATE_SQL = `
  select i.id as "invoiceId", i.company_id as "companyId", i.invoice_nr::float as "invoiceNr", i.ocr, i.kind,
         i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate", i.total_ore::float as "totalOre",
         b.balance_ore::float as "balanceOre", i.customer_id as "customerId", cu.name as "customerName", cu.customer_nr as "customerNr",
         i.contract_id as "contractId", k.contract_nr as "contractNr",
         coalesce((select max(r.level) from reminder r where r.invoice_id = i.id), 0) as "lastLevel",
         (select r.reminder_date::text from reminder r where r.invoice_id = i.id order by r.level desc limit 1) as "lastReminderDate",
         (select r.due_date::text from reminder r where r.invoice_id = i.id order by r.level desc limit 1) as "lastDueDate",
         co.reminder_fee_ore::float as "companyFeeOre", co.reminder_grace_days as "graceDays", co.late_interest_bp as "interestBp",
         coalesce((select sum(pb.unallocated_ore) from payment_balance pb where pb.customer_id = i.customer_id), 0)::float as "unallocatedOre",
         cu.delivery_method as "deliveryMethod", cu.email,
         coalesce(cu.invoice_address_line, cu.address_line) as "addressLine"
  from invoice i
  join invoice_balance b on b.invoice_id = i.id
  join customer cu on cu.id = i.customer_id
  join company co on co.id = i.company_id
  left join contract k on k.id = i.contract_id
  where i.status = 'issued' and i.kind <> 'credit_note' and b.balance_ore > 0 and i.due_date < $1
    -- påminnelseavgifter påminns inte i sin tur
    and not exists (select 1 from reminder f where f.fee_invoice_id = i.id)`;

/** Förfallna fakturor och vad som ska hända med dem per ett datum. */
export async function reminderCandidates(client: PoolClient, date: string, invoiceIds?: string[]): Promise<ReminderCandidate[]> {
  const { rows } = await client.query(
    `${CANDIDATE_SQL} and ($2::uuid[] is null or i.id = any($2)) order by cu.name, i.due_date, i.invoice_nr`,
    [date, invoiceIds ?? null],
  );
  return rows.map((r) => {
    const last = Number(r.lastLevel);
    let action: ReminderCandidate['action'];
    if (last === 0) action = addDays(r.dueDate, r.graceDays) < date ? 'remind' : 'wait';
    else if (r.lastDueDate && r.lastDueDate < date) action = last >= 2 ? 'collection' : 'remind';
    else action = 'wait';
    const nextLevel = action === 'remind' ? last + 1 : null;
    const channel: 'email' | 'post' = r.deliveryMethod !== 'post' && r.email ? 'email' : 'post';
    const warnings: string[] = [];
    if (r.unallocatedOre > 0) warnings.push(`Kunden har ${kr(r.unallocatedOre)} inbetalt som inte är fördelat. Fördela det först.`);
    if (channel === 'post' && !r.addressLine) warnings.push('Kunden saknar postadress');
    if (r.deliveryMethod !== 'post' && !r.email) warnings.push('Kunden saknar e-post, påminnelsen skickas som brev');
    return {
      invoiceId: r.invoiceId,
      companyId: r.companyId,
      invoiceNr: r.invoiceNr,
      ocr: r.ocr,
      kind: r.kind,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      totalOre: r.totalOre,
      balanceOre: r.balanceOre,
      customerId: r.customerId,
      customerName: r.customerName,
      customerNr: r.customerNr,
      contractId: r.contractId,
      contractNr: r.contractNr,
      daysOverdue: daysBetween(r.dueDate, date),
      lastLevel: last,
      lastReminderDate: r.lastReminderDate,
      lastDueDate: r.lastDueDate,
      action,
      nextLevel,
      // Påminnelseavgift tas bara ut en gång per faktura, på första påminnelsen
      feeOre: nextLevel === 1 ? r.companyFeeOre : 0,
      interestOre: lateInterest(r.balanceOre, r.interestBp, r.dueDate, date),
      channel,
      recipient: channel === 'email' ? r.email : null,
      warnings,
    };
  });
}

/** Skapar en utfärdad faktura för påminnelseavgiften. Avgiften är momsfri. */
async function createFeeInvoice(client: PoolClient, companyId: string, c: ReminderCandidate, reminderDate: string, dueDate: string): Promise<string> {
  const { billTo, deliveryMethod } = await billToFor(client, c.customerId);
  const first = (
    await client.query(`select object_id, property_id, cost_center_id from invoice_line where invoice_id = $1 order by position limit 1`, [c.invoiceId])
  ).rows[0];
  const { rows } = await client.query(
    `insert into invoice (company_id, kind, customer_id, contract_id, invoice_date, due_date, bill_to, delivery_method, message)
     values ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8) returning id`,
    [companyId, c.customerId, c.contractId, reminderDate, dueDate, JSON.stringify(billTo), deliveryMethod, `Påminnelseavgift för faktura ${c.invoiceNr}`],
  );
  const id = rows[0].id;
  await insertLines(client, companyId, id, [
    {
      lineKind: 'manual',
      contractId: c.contractId,
      objectId: first?.object_id ?? null,
      propertyId: first?.property_id ?? null,
      costCenterId: first?.cost_center_id ?? null,
      article: 'fee',
      description: `Påminnelseavgift faktura ${c.invoiceNr}`,
      quantity: 1,
      unitPriceOre: c.feeOre,
      netOre: c.feeOre,
      vatRateBp: 0,
      vatOre: 0,
    },
  ]);
  await recalcInvoice(client, id);
  // Avgiften står på påminnelsen och skickas inte som en egen faktura
  await issueInvoices(client, companyId, [id], false);
  return id;
}

/** Skapar påminnelser för valda fakturor. Fakturor som inte längre ska påminnas hoppas över. */
export async function createReminders(
  client: PoolClient,
  companyId: string,
  opts: { reminderDate: string; invoiceIds: string[]; chargeFee: boolean },
): Promise<{ created: string[]; skipped: { invoiceId: string; reason: string }[] }> {
  const company = (await client.query('select reminder_due_days from company where id = $1', [companyId])).rows[0];
  const dueDate = bankDayOnOrAfter(addDays(opts.reminderDate, company.reminder_due_days));
  const candidates = await reminderCandidates(client, opts.reminderDate, opts.invoiceIds);
  const byId = new Map(candidates.map((c) => [c.invoiceId, c]));
  const created: string[] = [];
  const skipped: { invoiceId: string; reason: string }[] = [];
  for (const invoiceId of opts.invoiceIds) {
    const c = byId.get(invoiceId);
    if (!c || c.companyId !== companyId) {
      skipped.push({ invoiceId, reason: 'Fakturan är betald eller inte förfallen' });
      continue;
    }
    if (c.action !== 'remind' || !c.nextLevel) {
      skipped.push({ invoiceId, reason: c.action === 'collection' ? 'Båda påminnelserna är skickade' : 'Fristen har inte gått ut' });
      continue;
    }
    const fee = opts.chargeFee ? c.feeOre : 0;
    const feeInvoiceId = fee > 0 ? await createFeeInvoice(client, companyId, { ...c, feeOre: fee }, opts.reminderDate, dueDate) : null;
    const { billTo } = await billToFor(client, c.customerId);
    const { rows } = await client.query(
      `insert into reminder (company_id, invoice_id, customer_id, level, reminder_date, due_date, balance_ore, fee_ore, interest_ore,
                             fee_invoice_id, bill_to, channel, recipient)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [companyId, c.invoiceId, c.customerId, c.nextLevel, opts.reminderDate, dueDate, c.balanceOre, fee, c.interestOre, feeInvoiceId,
       JSON.stringify(billTo), c.channel, c.recipient],
    );
    created.push(rows[0].id);
  }
  return { created, skipped };
}

export interface ReminderDetail {
  id: string;
  companyId: string;
  level: number;
  reminderDate: string;
  dueDate: string;
  balanceOre: number;
  feeOre: number;
  interestOre: number;
  channel: string;
  recipient: string | null;
  status: string;
  sentAt: string | null;
  error: string | null;
  billTo: BillTo;
  invoiceId: string;
  invoiceNr: number;
  invoiceKind: string;
  ocr: string | null;
  invoiceDate: string;
  invoiceDueDate: string;
  invoiceTotalOre: number;
  periodFrom: string | null;
  periodTo: string | null;
  contractNr: number | null;
  customerId: string;
  customerName: string;
  customerNr: number;
  feeInvoiceId: string | null;
  feeInvoiceNr: number | null;
  feeOcr: string | null;
  interestBp: number;
  company: CompanyInfo;
}

export const REMINDER_SQL = `
  select r.id, r.company_id as "companyId", r.level, r.reminder_date::text as "reminderDate", r.due_date::text as "dueDate",
         r.balance_ore::float as "balanceOre", r.fee_ore::float as "feeOre", r.interest_ore::float as "interestOre",
         r.channel, r.recipient, r.status, r.sent_at as "sentAt", r.error, r.bill_to as "billTo", r.created_at as "createdAt",
         i.id as "invoiceId", i.invoice_nr::float as "invoiceNr", i.kind as "invoiceKind", i.ocr, i.invoice_date::text as "invoiceDate",
         i.due_date::text as "invoiceDueDate", i.total_ore::float as "invoiceTotalOre", i.period_from::text as "periodFrom", i.period_to::text as "periodTo",
         k.contract_nr as "contractNr", r.customer_id as "customerId", cu.name as "customerName", cu.customer_nr as "customerNr",
         r.fee_invoice_id as "feeInvoiceId", f.invoice_nr::float as "feeInvoiceNr", f.ocr as "feeOcr",
         co.name as "companyName", co.late_interest_bp as "interestBp",
         ib.balance_ore::float as "currentBalanceOre"
  from reminder r
  join invoice i on i.id = r.invoice_id
  join invoice_balance ib on ib.invoice_id = i.id
  join customer cu on cu.id = r.customer_id
  join company co on co.id = r.company_id
  left join contract k on k.id = i.contract_id
  left join invoice f on f.id = r.fee_invoice_id`;

export async function loadReminders(client: PoolClient, ids: string[]): Promise<ReminderDetail[]> {
  const { rows } = await client.query(`${REMINDER_SQL} where r.id = any($1) order by cu.name, i.invoice_nr`, [ids]);
  const companies = new Map<string, CompanyInfo>();
  for (const r of rows) {
    if (!companies.has(r.companyId)) companies.set(r.companyId, await companyInfo(client, r.companyId));
    r.company = companies.get(r.companyId);
  }
  return rows;
}

const LEVEL_TITLE = ['', 'Betalningspåminnelse', 'Andra betalningspåminnelse'];

/** Skickar påminnelser som väntar på e-post. Brev ligger kvar tills de skrivits ut. */
export async function sendReminders(client: PoolClient, ids: string[]): Promise<{ sent: number; test: number; failed: number; post: number }> {
  const result = { sent: 0, test: 0, failed: 0, post: 0 };
  if (!ids.length) return result;
  const list = await loadReminders(client, ids);
  for (const r of list) {
    if (r.status !== 'queued' && r.status !== 'failed') continue;
    if (r.channel === 'post') {
      result.post += 1;
      continue;
    }
    try {
      if (!r.recipient) throw new Error('E-postadress saknas');
      const pdf = await renderRemindersPdf([r]);
      const c = r.company;
      const title = LEVEL_TITLE[r.level];
      const total = r.balanceOre + r.feeOre;
      const text =
        `Hej,\n\nVi har inte fått betalt för faktura ${r.invoiceNr} som förföll ${r.invoiceDueDate}. ` +
        `Om du redan har betalat kan du bortse från detta meddelande.\n\n` +
        `Att betala: ${kr(total)}${r.feeOre ? ` (varav påminnelseavgift ${kr(r.feeOre)})` : ''}\n` +
        `Betala senast: ${r.dueDate}\n` +
        (c.bankgiro ? `Bankgiro: ${c.bankgiro}\n` : '') +
        `OCR-nummer: ${r.ocr}\n\nPåminnelsen finns bifogad.\n\nVänliga hälsningar\n${c.name}` +
        (c.invoiceEmail ? `\n${c.invoiceEmail}` : '');
      const from = process.env.SMTP_FROM ?? c.invoiceEmail ?? 'no-reply@example.se';
      const status = await sendOrSave(
        {
          from: `"${c.name.replace(/"/g, '')}" <${from}>`,
          replyTo: c.invoiceEmail ?? undefined,
          to: r.recipient,
          subject: `${title}: faktura ${r.invoiceNr} från ${c.name}`,
          text,
          attachments: [{ filename: `paminnelse-${r.invoiceNr}-${r.level}.pdf`, content: pdf, contentType: 'application/pdf' }],
        },
        `${r.companyId}-paminnelse-${r.invoiceNr}-${r.level}`,
      );
      await client.query(`update reminder set status = $2, sent_at = now(), error = null where id = $1`, [r.id, status]);
      result[status] += 1;
    } catch (err) {
      await client.query(`update reminder set status = 'failed', error = $2 where id = $1`, [r.id, (err as Error).message.slice(0, 500)]);
      result.failed += 1;
    }
  }
  return result;
}
