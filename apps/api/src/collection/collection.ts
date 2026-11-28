import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { reminderCandidates } from '../payments/reminders';
import { companyInfo, CompanyInfo, insertLines, issueInvoices, NewLine, loadInvoice, recalcInvoice } from '../billing/invoice-store';
import { addDays } from '../contracts/contract-rules';
import { accruedInterest, interestSettings, pct, rateOn, referenceRates } from './late-interest';

/**
 * Inkasso.
 *
 *  * Ett ärende samlar en kunds obetalda fakturor (och deras påminnelseavgifter och räntefakturor).
 *  * Förberett → skickat till inkassobolaget → betalningsföreläggande/Kronofogden → betalt, återkallat eller avskrivet.
 *  * Ärendefilen (Excel eller CSV) och en kravsammanställning (PDF) lämnas till inkassobolaget.
 *  * Inbetalningar, från hyresgästen eller redovisade av inkassobolaget, registreras som vanligt på fakturorna.
 *  * Avskrivning görs med en kreditfaktura som bokförs på kundförluster (6350). Momsen på
 *    momspliktiga fakturor återförs, eftersom kundförlusten är konstaterad.
 */

export const CASE_STATUS = ['prepared', 'sent', 'enforcement', 'paid', 'withdrawn', 'written_off'] as const;
export type CaseStatus = (typeof CASE_STATUS)[number];
export const STATUS_LABEL: Record<CaseStatus, string> = {
  prepared: 'Förberett',
  sent: 'Skickat till inkasso',
  enforcement: 'Betalningsföreläggande',
  paid: 'Betalt',
  withdrawn: 'Återkallat',
  written_off: 'Avskrivet',
};
const OPEN: CaseStatus[] = ['prepared', 'sent', 'enforcement'];

export interface CaseClaim {
  invoiceId: string;
  invoiceNr: number;
  kind: string;
  ocr: string | null;
  invoiceDate: string;
  dueDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalOre: number;
  capitalOre: number;
  balanceOre: number;
  interestFrom: string;
  interestOre: number;
  isFee: boolean;
  isInterest: boolean;
  active: boolean;
  writeOffInvoiceId: string | null;
  objects: string;
}

export interface CaseDetail {
  id: string;
  companyId: string;
  caseNr: number;
  customerId: string;
  customerName: string;
  customerNr: number;
  customerKind: string;
  nationalId: string | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  careOf: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  status: CaseStatus;
  agency: string | null;
  agencyReference: string | null;
  capitalOre: number;
  interestOre: number;
  remainingOre: number;
  sentDate: string | null;
  closedDate: string | null;
  note: string | null;
  createdAt: string;
  rateText: string;
  claims: CaseClaim[];
  events: { eventDate: string; kind: string; description: string; createdAt: string }[];
  company: CompanyInfo;
}

const CASE_SQL = `
  select c.id, c.company_id as "companyId", c.case_nr as "caseNr", c.customer_id as "customerId", cu.name as "customerName",
         cu.customer_nr as "customerNr", cu.kind as "customerKind", cu.national_id as "nationalId", cu.email, cu.phone,
         coalesce(cu.invoice_address_line, cu.address_line) as "addressLine",
         case when cu.invoice_address_line is not null then cu.invoice_care_of else cu.care_of end as "careOf",
         case when cu.invoice_address_line is not null then cu.invoice_postal_code else cu.postal_code end as "postalCode",
         case when cu.invoice_address_line is not null then cu.invoice_city else cu.city end as "city", cu.country,
         c.status, c.agency, c.agency_reference as "agencyReference", c.capital_ore::float as "capitalOre",
         c.interest_ore::float as "interestOre", c.sent_date::text as "sentDate", c.closed_date::text as "closedDate",
         c.note, c.created_at as "createdAt",
         coalesce((select sum(greatest(b.balance_ore, 0)) from collection_case_invoice ci join invoice_balance b on b.invoice_id = ci.invoice_id
                   where ci.case_id = c.id and ci.active), 0)::float as "remainingOre"
  from collection_case c join customer cu on cu.id = c.customer_id`;

export async function listCases(client: PoolClient, status?: string | null) {
  const { rows } = await client.query(
    `${CASE_SQL} where ($1::text is null or c.status = $1) order by c.case_nr desc limit 1000`,
    [status || null],
  );
  return rows;
}

export async function loadCase(client: PoolClient, id: string): Promise<CaseDetail> {
  const { rows } = await client.query(`${CASE_SQL} where c.id = $1`, [id]);
  const c = rows[0];
  if (!c) throw new NotFoundException('Inkassoärendet finns inte');
  c.claims = (
    await client.query(
      `select i.id as "invoiceId", i.invoice_nr::float as "invoiceNr", i.kind, i.ocr, i.invoice_date::text as "invoiceDate",
              i.due_date::text as "dueDate", i.period_from::text as "periodFrom", i.period_to::text as "periodTo",
              i.total_ore::float as "totalOre", ci.capital_ore::float as "capitalOre", b.balance_ore::float as "balanceOre",
              ci.interest_from::text as "interestFrom", ci.interest_ore::float as "interestOre", ci.active,
              ci.write_off_invoice_id as "writeOffInvoiceId",
              exists (select 1 from reminder r where r.fee_invoice_id = i.id) as "isFee",
              exists (select 1 from late_interest_charge l where l.interest_invoice_id = i.id) as "isInterest",
              coalesce((select string_agg(distinct o.object_nr, ', ') from invoice_line l join rental_object o on o.id = l.object_id
                        where l.invoice_id = i.id), '') as objects
       from collection_case_invoice ci join invoice i on i.id = ci.invoice_id join invoice_balance b on b.invoice_id = i.id
       where ci.case_id = $1 order by i.due_date, i.invoice_nr`,
      [id],
    )
  ).rows;
  c.events = (
    await client.query(
      `select event_date::text as "eventDate", kind, description, created_at as "createdAt"
       from collection_case_event where case_id = $1 order by created_at`,
      [id],
    )
  ).rows;
  c.company = await companyInfo(client, c.companyId);
  const s = await interestSettings(client, c.companyId);
  const refs = await referenceRates(client);
  c.rateText = pct(rateOn(c.sentDate ?? today(), { useReference: s.useReference, marginBp: s.marginBp, fixedBp: s.fixedBp, contractBp: null, referenceRates: refs }));
  if (s.useReference) c.rateText += ' (referensräntan + ' + pct(s.marginBp) + ')';
  return c;
}

async function event(client: PoolClient, companyId: string, caseId: string, date: string, kind: string, description: string) {
  await client.query(
    `insert into collection_case_event (company_id, case_id, event_date, kind, description) values ($1, $2, $3, $4, $5)`,
    [companyId, caseId, date, kind, description],
  );
}

/**
 * Skapar ett inkassoärende för valda fakturor. Fakturornas obetalda påminnelseavgifter och
 * räntefakturor följer med. Ränta som inte debiterats räknas fram och står i ärendet.
 */
export async function createCase(
  client: PoolClient,
  companyId: string,
  d: { customerId: string; invoiceIds: string[]; date: string; agency?: string | null; note?: string | null },
): Promise<string> {
  const { rows: inv } = await client.query(
    `select i.id, i.customer_id as "customerId", i.status, i.kind, i.invoice_nr::float as nr, i.due_date::text as "dueDate",
            b.balance_ore::float as balance,
            exists (select 1 from collection_case_invoice ci join collection_case cc on cc.id = ci.case_id
                    where ci.invoice_id = i.id and ci.active and cc.status in ('prepared', 'sent', 'enforcement')) as "inCase",
            exists (select 1 from payment_plan_invoice pi join payment_plan pp on pp.id = pi.plan_id
                    where pi.invoice_id = i.id and pi.active and pp.status = 'active') as "inPlan"
     from invoice i join invoice_balance b on b.invoice_id = i.id where i.id = any($1)`,
    [d.invoiceIds],
  );
  if (inv.length !== new Set(d.invoiceIds).size) throw new BadRequestException('En faktura finns inte i valt bolag');
  for (const i of inv) {
    if (i.customerId !== d.customerId) throw new BadRequestException(`Faktura ${i.nr} tillhör en annan kund`);
    if (i.status !== 'issued' || i.kind === 'credit_note' || i.balance <= 0) throw new ConflictException(`Faktura ${i.nr} har inget obetalt belopp`);
    if (i.inCase) throw new ConflictException(`Faktura ${i.nr} ingår redan i ett inkassoärende`);
    if (i.inPlan) throw new ConflictException(`Faktura ${i.nr} ingår i en aktiv avbetalningsplan. Avsluta planen först.`);
  }
  // Påminnelseavgifter och räntefakturor som hör till fakturorna
  const extra = (
    await client.query(
      `select distinct f.id, f.due_date::text as "dueDate", b.balance_ore::float as balance
       from invoice f join invoice_balance b on b.invoice_id = f.id
       where b.balance_ore > 0 and f.status = 'issued' and not (f.id = any($1))
         and (f.id in (select r.fee_invoice_id from reminder r where r.invoice_id = any($1))
              or f.id in (select l.interest_invoice_id from late_interest_charge l where l.invoice_id = any($1)))
         and not exists (select 1 from collection_case_invoice ci join collection_case cc on cc.id = ci.case_id
                         where ci.invoice_id = f.id and ci.active and cc.status in ('prepared', 'sent', 'enforcement'))`,
      [d.invoiceIds],
    )
  ).rows;
  const all = [...inv.map((i) => ({ id: i.id, dueDate: i.dueDate, balance: i.balance, fee: false })), ...extra.map((e) => ({ ...e, fee: true }))];

  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`collection_case:${companyId}`]);
  const nr = (await client.query('select coalesce(max(case_nr), 0) + 1 as nr from collection_case where company_id = $1', [companyId])).rows[0].nr;
  const capital = all.reduce((a, i) => a + i.balance, 0);
  const claims: { id: string; balance: number; from: string; interest: number }[] = [];
  let interest = 0;
  for (const i of all) {
    const acc = i.fee ? { amountOre: 0, fromDate: null } : await accruedInterest(client, companyId, i.id, d.date);
    claims.push({ id: i.id, balance: i.balance, from: acc.fromDate ?? addDays(i.dueDate, 1), interest: acc.amountOre });
    interest += acc.amountOre;
  }
  const { rows } = await client.query(
    `insert into collection_case (company_id, case_nr, customer_id, agency, capital_ore, interest_ore, note)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [companyId, nr, d.customerId, d.agency ?? null, capital, interest, d.note ?? null],
  );
  const caseId = rows[0].id;
  for (const c of claims) {
    await client.query(
      `insert into collection_case_invoice (company_id, case_id, invoice_id, capital_ore, interest_from, interest_ore) values ($1, $2, $3, $4, $5, $6)`,
      [companyId, caseId, c.id, c.balance, c.from, c.interest],
    );
  }
  await event(client, companyId, caseId, d.date, 'created', `Ärendet skapades med ${claims.length} fakturor, ${(capital / 100).toLocaleString('sv-SE')} kr`);
  return caseId;
}

/** Byter status på ett ärende. Avslutade ärenden släpper fakturorna, så att de kan påminnas igen. */
export async function setStatus(
  client: PoolClient,
  companyId: string,
  id: string,
  d: { status: CaseStatus; date: string; agency?: string | null; agencyReference?: string | null; note?: string | null },
) {
  const c = (await client.query('select status, agency from collection_case where id = $1 for update', [id])).rows[0];
  if (!c) throw new NotFoundException('Inkassoärendet finns inte');
  if (!OPEN.includes(c.status)) throw new ConflictException('Ärendet är avslutat');
  if (d.status === 'written_off') throw new BadRequestException('Använd avskrivning för att skriva av ärendet');
  if (d.status === 'prepared' && c.status !== 'prepared') throw new ConflictException('Ett skickat ärende kan inte göras till förberett. Återkalla det i stället.');
  const closed = ['paid', 'withdrawn'].includes(d.status);
  await client.query(
    `update collection_case set status = $2,
            agency = coalesce($3, agency), agency_reference = coalesce($4, agency_reference),
            sent_date = case when $2 in ('sent', 'enforcement') then coalesce(sent_date, $5::date) else sent_date end,
            closed_date = case when $6 then $5::date else null end
     where id = $1`,
    [id, d.status, d.agency ?? null, d.agencyReference ?? null, d.date, closed],
  );
  if (closed) await client.query('update collection_case_invoice set active = false where case_id = $1', [id]);
  const agency = d.agency ?? c.agency;
  const text =
    d.status === 'sent'
      ? `Skickat till ${agency ?? 'inkassobolaget'}${d.agencyReference ? `, ärende ${d.agencyReference}` : ''}`
      : STATUS_LABEL[d.status];
  await event(client, companyId, id, d.date, d.status, d.note ? `${text}. ${d.note}` : text);
}

/**
 * Skriver av det som är obetalt i ärendet som konstaterad kundförlust.
 * Varje faktura får en kreditfaktura på det obetalda beloppet. Raderna bokförs på
 * kundförlustkontot och momsen återförs i samma proportion som på fakturan.
 */
export async function writeOff(client: PoolClient, companyId: string, id: string, d: { date: string; reason: string }) {
  const c = await loadCase(client, id);
  if (!OPEN.includes(c.status)) throw new ConflictException('Ärendet är avslutat');
  const account = (await client.query('select bad_debt_account from company where id = $1', [companyId])).rows[0].bad_debt_account as string;
  const exists = (await client.query('select 1 from account where company_id = $1 and number = $2', [companyId, account])).rows.length;
  if (!exists) throw new BadRequestException(`Kontot ${account} för kundförluster finns inte i kontoplanen`);
  let total = 0;
  for (const claim of c.claims.filter((x) => x.active && x.balanceOre > 0)) {
    const creditId = await creditRemaining(client, companyId, claim.invoiceId, claim.balanceOre, account, d.date, `Kundförlust, inkassoärende ${c.caseNr}: ${d.reason}`);
    await client.query('update collection_case_invoice set write_off_invoice_id = $2 where case_id = $1 and invoice_id = $3', [id, creditId, claim.invoiceId]);
    total += claim.balanceOre;
  }
  await client.query(`update collection_case set status = 'written_off', closed_date = $2 where id = $1`, [id, d.date]);
  await client.query('update collection_case_invoice set active = false where case_id = $1', [id]);
  await event(client, companyId, id, d.date, 'written_off', `Avskrivet som kundförlust: ${(total / 100).toLocaleString('sv-SE')} kr. ${d.reason}`);
  return { writtenOffOre: total };
}

/** Kreditfaktura på ett belopp inklusive moms, fördelat på fakturans rader. Bokförs på angivet konto. */
async function creditRemaining(client: PoolClient, companyId: string, invoiceId: string, amountOre: number, account: string, date: string, reason: string): Promise<string> {
  const d = await loadInvoice(client, invoiceId);
  const lines = d.lines.filter((l) => l.netOre - l.creditedNetOre !== 0);
  const gross = lines.reduce((a, l) => a + (l.netOre - l.creditedNetOre) + Math.round(((l.netOre - l.creditedNetOre) * l.vatRateBp) / 10_000), 0);
  if (!lines.length || gross <= 0) throw new ConflictException(`Faktura ${d.invoiceNr} har inget kvar att kreditera`);
  const out: NewLine[] = [];
  let left = Math.min(amountOre, gross);
  lines.forEach((l, idx) => {
    const remainingNet = l.netOre - l.creditedNetOre;
    const lineGross = remainingNet + Math.round((remainingNet * l.vatRateBp) / 10_000);
    let g = idx === lines.length - 1 ? left : Math.round((Math.min(amountOre, gross) * lineGross) / gross);
    g = Math.max(Math.min(g, left), 0);
    left -= g;
    if (!g) return;
    const net = Math.round((g * 10_000) / (10_000 + l.vatRateBp));
    out.push({
      lineKind: 'credit',
      contractId: l.contractId,
      contractLineId: l.contractLineId,
      objectId: l.objectId,
      propertyId: l.propertyId,
      costCenterId: l.costCenterId,
      article: l.article,
      accountNumber: account,
      description: `Kundförlust: ${l.description}`,
      periodFrom: l.periodFrom,
      periodTo: l.periodTo,
      unitPriceOre: -net,
      netOre: -net,
      vatRateBp: l.vatRateBp,
      vatOre: -(g - net),
      creditsLineId: l.id,
      rebill: false,
    });
  });
  const { rows } = await client.query(
    `insert into invoice (company_id, kind, customer_id, contract_id, invoice_date, due_date, period_from, period_to,
                          bill_to, delivery_method, credits_invoice_id, credit_reason)
     select company_id, 'credit_note', customer_id, contract_id, $2, $2, period_from, period_to, bill_to, delivery_method, id, $3
     from invoice where id = $1 returning id`,
    [invoiceId, date, reason.slice(0, 300)],
  );
  const creditId = rows[0].id;
  await insertLines(client, companyId, creditId, out);
  const sums = await recalcInvoice(client, creditId);
  // Kreditfakturan ska ta exakt det obetalda beloppet, även med öresavrundning
  if (sums.totalOre !== -amountOre) {
    await client.query('update invoice set rounding_ore = $2, total_ore = $3 where id = $1', [creditId, -amountOre - (sums.netOre + sums.vatOre), -amountOre]);
  }
  // Avskrivningen skickas inte till hyresgästen
  await issueInvoices(client, companyId, [creditId], false);
  return creditId;
}

// ---------------------------------------------------------------------
// Ärendefil till inkassobolaget
// ---------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura' };

export interface ExportRow {
  [key: string]: string | number | null;
}

const COLUMNS: { key: string; header: string; width: number; money?: boolean }[] = [
  { key: 'caseNr', header: 'Ärende', width: 8 },
  { key: 'customerNr', header: 'Kundnummer', width: 11 },
  { key: 'name', header: 'Gäldenär', width: 26 },
  { key: 'nationalId', header: 'Person-/organisationsnummer', width: 20 },
  { key: 'debtorType', header: 'Typ', width: 10 },
  { key: 'careOf', header: 'c/o', width: 14 },
  { key: 'address', header: 'Adress', width: 24 },
  { key: 'postalCode', header: 'Postnummer', width: 10 },
  { key: 'city', header: 'Ort', width: 14 },
  { key: 'country', header: 'Land', width: 6 },
  { key: 'email', header: 'E-post', width: 24 },
  { key: 'phone', header: 'Telefon', width: 14 },
  { key: 'claimType', header: 'Fordringstyp', width: 18 },
  { key: 'invoiceNr', header: 'Fakturanummer', width: 13 },
  { key: 'ocr', header: 'OCR', width: 14 },
  { key: 'invoiceDate', header: 'Fakturadatum', width: 12 },
  { key: 'dueDate', header: 'Förfallodag', width: 12 },
  { key: 'period', header: 'Avser period', width: 22 },
  { key: 'objects', header: 'Objekt', width: 10 },
  { key: 'invoiceTotal', header: 'Fakturabelopp', width: 13, money: true },
  { key: 'capital', header: 'Obetalt kapital', width: 13, money: true },
  { key: 'interestRate', header: 'Räntesats', width: 22 },
  { key: 'interestFrom', header: 'Ränta från', width: 12 },
  { key: 'interest', header: 'Upplupen ränta', width: 13, money: true },
  { key: 'creditor', header: 'Borgenär', width: 26 },
  { key: 'creditorOrgNr', header: 'Borgenärens orgnr', width: 14 },
  { key: 'creditorBankgiro', header: 'Borgenärens bankgiro', width: 14 },
];

export function exportRows(cases: CaseDetail[]): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const c of cases) {
    for (const cl of c.claims.filter((x) => x.active && x.balanceOre > 0)) {
      rows.push({
        caseNr: c.caseNr,
        customerNr: c.customerNr,
        name: c.customerName,
        nationalId: c.nationalId,
        debtorType: c.customerKind === 'company' ? 'Företag' : 'Privatperson',
        careOf: c.careOf,
        address: c.addressLine,
        postalCode: c.postalCode,
        city: c.city,
        country: c.country,
        email: c.email,
        phone: c.phone,
        claimType: cl.isFee ? 'Påminnelseavgift' : cl.isInterest ? 'Dröjsmålsränta' : cl.kind === 'rent_notice' ? 'Hyra' : KIND_LABEL[cl.kind] ?? 'Faktura',
        invoiceNr: cl.invoiceNr,
        ocr: cl.ocr,
        invoiceDate: cl.invoiceDate,
        dueDate: cl.dueDate,
        period: cl.periodFrom && cl.periodTo ? `${cl.periodFrom}–${cl.periodTo}` : null,
        objects: cl.objects || null,
        invoiceTotal: cl.totalOre / 100,
        capital: cl.balanceOre / 100,
        interestRate: cl.isFee || cl.isInterest ? null : c.rateText,
        interestFrom: cl.isFee || cl.isInterest ? null : cl.interestFrom,
        interest: cl.interestOre / 100,
        creditor: c.company.name,
        creditorOrgNr: c.company.orgNr,
        creditorBankgiro: c.company.bankgiro,
      });
    }
  }
  return rows;
}

export async function exportXlsx(cases: CaseDetail[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fastighetssystem';
  const ws = wb.addWorksheet('Inkassoärenden');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: '#,##0.00' } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of exportRows(cases)) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Semikolonseparerad CSV med UTF-8 och BOM, så att den öppnas rätt i Excel. */
export function exportCsv(cases: CaseDetail[]): Buffer {
  const esc = (v: string | number | null, money?: boolean) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? (money ? v.toFixed(2).replace('.', ',') : String(v)) : v;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map((c) => c.header).join(';')];
  for (const r of exportRows(cases)) lines.push(COLUMNS.map((c) => esc(r[c.key] ?? null, c.money)).join(';'));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

/** Fakturor som har fått båda påminnelserna utan att betalas och inte ingår i något ärende eller någon plan. */
export async function collectionReady(client: PoolClient, date: string) {
  return (await reminderCandidates(client, date)).filter((c) => c.action === 'collection');
}
