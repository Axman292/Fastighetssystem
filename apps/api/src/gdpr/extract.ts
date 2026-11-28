import PDFDocument from 'pdfkit';
import type { PoolClient } from 'pg';
import { Doc, footer, ink, kr, L, muted, rule } from '../billing/invoice-pdf';
import { companyInfo, type CompanyInfo } from '../billing/invoice-store';
import { getSettings, todayIso } from './gdpr';

/**
 * Registerutdrag (GDPR artikel 15): allt systemet har sparat om en hyresgäst,
 * varför, hur länge och vem som får del av det. Finns som PDF att skicka till
 * hyresgästen och som JSON (dataportabilitet, artikel 20).
 */

export interface Extract {
  createdAt: string;
  company: CompanyInfo;
  customer: Record<string, unknown> & { customerNr: number; kind: string; name: string; anonymizedAt: string | null };
  contacts: Record<string, unknown>[];
  contracts: Record<string, unknown>[];
  deposits: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  reminders: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
  bankPayments: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  purposes: { purpose: string; legalBasis: string; data: string }[];
  retention: string[];
  recipients: string[];
  rights: string[];
}

export async function buildExtract(client: PoolClient, customerId: string): Promise<Extract | null> {
  const c = (
    await client.query(
      `select id, company_id as "companyId", customer_nr as "customerNr", kind, name, national_id as "nationalId", vat_nr as "vatNr",
              email, phone, address_line as "addressLine", care_of as "careOf", postal_code as "postalCode", city, country,
              invoice_address_line as "invoiceAddressLine", invoice_care_of as "invoiceCareOf", invoice_postal_code as "invoicePostalCode",
              invoice_city as "invoiceCity", invoice_reference as "invoiceReference", delivery_method as "deliveryMethod",
              peppol_id as "peppolId", notes, created_at::date::text as "createdAt", anonymized_at::date::text as "anonymizedAt",
              accounting_purged_at::date::text as "accountingPurgedAt"
       from customer where id = $1`,
      [customerId],
    )
  ).rows[0];
  if (!c) return null;
  const q = async (sql: string) => (await client.query(sql, [customerId])).rows;
  const contacts = await q(`select name, role, email, phone from customer_contact where customer_id = $1 order by name`);
  const contracts = await q(
    `select k.contract_nr as "contractNr", k.type, k.status, k.start_date::text as "startDate", k.end_date::text as "endDate",
            k.signed_date::text as "signedDate", k.termination_received::text as "terminationReceived", k.special_terms as "specialTerms",
            k.notes,
            coalesce((select string_agg(o.object_nr || ' ' || p.name || coalesce(', ' || nullif(concat_ws(' ', p.address_line, p.city), ''), ''), '; ' order by o.object_nr)
               from contract_object co join rental_object o on o.id = co.object_id join property p on p.id = o.property_id
               where co.contract_id = k.id), '') as objects
     from contract k where k.customer_id = $1 order by k.start_date`,
  );
  const deposits = await q(
    `select k.contract_nr as "contractNr", d.kind, d.amount_ore::float as "amountOre", d.received_date::text as "receivedDate",
            d.returned_date::text as "returnedDate", d.note
     from contract_deposit d join contract k on k.id = d.contract_id where k.customer_id = $1 order by k.contract_nr`,
  );
  const invoices = await q(
    `select i.invoice_nr as "invoiceNr", i.kind, i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate",
            i.total_ore::float as "totalOre", b.balance_ore::float as "balanceOre", i.bill_to as "billTo"
     from invoice i join invoice_balance b on b.invoice_id = i.id
     where i.customer_id = $1 and i.status = 'issued' order by i.invoice_date, i.invoice_nr`,
  );
  const payments = await q(
    `select payment_date::text as "paymentDate", amount_ore::float as "amountOre", method, reference, note
     from payment where customer_id = $1 order by payment_date`,
  );
  const reminders = await q(
    `select r.reminder_date::text as "reminderDate", r.level, i.invoice_nr as "invoiceNr", r.channel, r.recipient
     from reminder r join invoice i on i.id = r.invoice_id where r.customer_id = $1 order by r.reminder_date`,
  );
  const deliveries = await q(
    `select d.channel, d.status, d.recipient, d.sent_at as "sentAt", i.invoice_nr as "invoiceNr"
     from invoice_delivery d join invoice i on i.id = d.invoice_id where i.customer_id = $1 order by d.created_at`,
  );
  const bankPayments = await q(
    `select payment_date::text as "paymentDate", amount_ore::float as "amountOre", payer_name as "payerName",
            payer_address as "payerAddress", payer_org_nr as "payerOrgNr", information
     from bank_transaction where customer_id = $1 and (payer_name is not null or payer_address is not null or information is not null)
     order by payment_date`,
  );
  const documents = await q(
    `select d.file_name as "fileName", d.kind, d.created_at::date::text as "createdAt", d.retain_until::text as "retainUntil"
     from document d join customer c on c.id = $1
     where d.company_id = c.company_id
       and ((d.entity_type = 'customer' and d.entity_id = c.id)
         or (d.entity_type = 'contract' and d.entity_id in (select id from contract where customer_id = c.id)))
     order by d.created_at`,
  );
  const s = await getSettings(client, c.companyId);
  const company = await companyInfo(client, c.companyId);
  const { companyId: _companyId, id: _id, ...customer } = c;
  return {
    createdAt: todayIso(),
    company,
    customer,
    contacts,
    contracts,
    deposits,
    invoices,
    payments,
    reminders,
    deliveries,
    bankPayments,
    documents,
    purposes: [
      {
        purpose: 'Administrera hyresförhållandet (avtal, objekt, in- och avflyttning, kontakt)',
        legalBasis: 'Avtal (artikel 6.1 b)',
        data: 'Namn, person- eller organisationsnummer, adress, e-post, telefon, avtal och kontaktpersoner',
      },
      {
        purpose: 'Avisera hyra, fakturera, ta emot och följa upp betalningar och påminnelser',
        legalBasis: 'Avtal (artikel 6.1 b)',
        data: 'Namn, adress, fakturaadress, e-post, fakturor, inbetalningar och påminnelser',
      },
      {
        purpose: 'Bokföring',
        legalBasis: 'Rättslig förpliktelse enligt bokföringslagen (artikel 6.1 c)',
        data: 'Fakturor, kreditfakturor, inbetalningar och återbetalningar med namn och adress',
      },
    ],
    retention: [
      `Uppgifterna i kundregistret anonymiseras ${s.retentionMonths} månader efter att hyresförhållandet upphört och allt är betalt.`,
      `Fakturor och betalningar sparas i ${s.bookkeepingYears} år efter utgången av det kalenderår då räkenskapsåret avslutades, enligt bokföringslagen. Därefter tas namn och adress bort även där.`,
      'Uppgifter som behövs för ett pågående ärende, till exempel en obetald skuld eller en deposition, sparas tills ärendet är avslutat.',
    ],
    recipients: [
      'Bolagets ekonomiprogram och redovisningskonsult (bokföring).',
      'Bank och Bankgirot (inbetalningar).',
      'E-posttjänst som skickar avier och påminnelser för bolagets räkning (personuppgiftsbiträde).',
      'Leverantör av drift och lagring av systemet inom EU (personuppgiftsbiträde).',
      'Inkasso- eller kronofogdemyndighet om en skuld inte betalas.',
    ],
    rights: [
      'Du har rätt att få rättat uppgifter som är fel.',
      'Du har rätt att få dina uppgifter raderade när de inte längre behövs, utom sådant som lagen kräver att vi sparar.',
      'Du har rätt att invända mot behandlingen och att begära begränsning.',
      'Du har rätt att få dina uppgifter i ett maskinläsbart format.',
      'Du kan klaga till Integritetsskyddsmyndigheten (IMY), www.imy.se.',
    ],
  };
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

const KIND: Record<string, string> = { person: 'Privatperson', organization: 'Företag' };
const CONTRACT_TYPE: Record<string, string> = {
  residential: 'Bostad',
  commercial: 'Lokal',
  parking: 'Parkering',
  storage: 'Förråd',
  other: 'Övrigt',
};
const CONTRACT_STATUS: Record<string, string> = { draft: 'Utkast', active: 'Aktivt', terminated: 'Uppsagt', cancelled: 'Makulerat' };
const INVOICE_KIND: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };
const DELIVERY: Record<string, string> = { email: 'E-post', post: 'Brev', e_invoice: 'E-faktura' };
const DEPOSIT: Record<string, string> = { deposit: 'Deposition', bank_guarantee: 'Bankgaranti', surety: 'Borgen', other: 'Övrigt' };

export function renderExtractPdf(e: Extract): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 48, bottom: 90, left: L, right: L }, info: { Title: 'Registerutdrag' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  draw(doc, e);
  const range = doc.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(p);
    footer(doc, e, p + 1, range.count);
  }
  doc.end();
  return done;
}

function draw(doc: Doc, e: Extract) {
  const width = doc.page.width - 2 * L;
  const c = e.customer;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ink).text(e.company.name, L, 48, { width: width / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(`Org.nr ${e.company.orgNr}`, { width: width / 2 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text('Registerutdrag', L + width / 2, 46, { width: width / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(muted).text(`Datum ${e.createdAt}`, L + width / 2, doc.y + 2, { width: width / 2, align: 'right' });
  let y = 120;

  const ensure = (h = 40) => {
    if (y + h > doc.page.height - 100) {
      doc.addPage();
      y = 56;
    }
  };
  const para = (t: string, opts: { color?: string; size?: number } = {}) => {
    ensure(24);
    doc.font('Helvetica').fontSize(opts.size ?? 9).fillColor(opts.color ?? ink).text(t, L, y, { width, lineGap: 1.5 });
    y = doc.y + 6;
  };
  const section = (t: string) => {
    ensure(50);
    y += 8;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(t, L, y);
    y = doc.y + 3;
    doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
    y += 6;
  };
  const kv = (rows: [string, unknown][]) => {
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      ensure(16);
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(k, L, y, { width: 150 });
      doc.font('Helvetica').fontSize(9).fillColor(ink).text(String(v), L + 155, y, { width: width - 155 });
      y = Math.max(doc.y, y + 12) + 3;
    }
  };
  const table = (cols: { t: string; w: number; right?: boolean }[], rows: string[][], empty: string) => {
    if (!rows.length) return para(empty, { color: muted });
    ensure(30);
    let x = L;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(muted);
    for (const col of cols) {
      doc.text(col.t.toUpperCase(), x, y, { width: col.w - 6, align: col.right ? 'right' : 'left' });
      x += col.w;
    }
    y += 12;
    for (const r of rows) {
      ensure(16);
      x = L;
      let h = 0;
      doc.font('Helvetica').fontSize(8.5).fillColor(ink);
      r.forEach((v, i) => {
        doc.text(v ?? '', x, y, { width: cols[i].w - 6, align: cols[i].right ? 'right' : 'left' });
        h = Math.max(h, doc.y - y);
        x += cols[i].w;
      });
      y += Math.max(h, 11) + 3;
    }
    y += 2;
  };
  const w = (f: number) => width * f;

  para(
    'Här är de personuppgifter som vi har registrerade om dig, varför vi behandlar dem, hur länge de sparas och vem som får del av dem. Utdraget lämnas enligt artikel 15 i dataskyddsförordningen (GDPR).',
    { color: muted },
  );
  if (c.anonymizedAt) para(`Uppgifterna i kundregistret anonymiserades ${String(c.anonymizedAt).slice(0, 10)}.`);

  section('Dina uppgifter');
  kv([
    ['Kundnummer', c.customerNr],
    ['Typ', KIND[c.kind] ?? c.kind],
    ['Namn', c.name],
    [c.kind === 'person' ? 'Personnummer' : 'Organisationsnummer', c.nationalId],
    ['Momsregistreringsnummer', c.vatNr],
    ['E-post', c.email],
    ['Telefon', c.phone],
    ['Adress', [c.careOf ? `c/o ${c.careOf}` : null, c.addressLine, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
    [
      'Fakturaadress',
      [c.invoiceCareOf ? `c/o ${c.invoiceCareOf}` : null, c.invoiceAddressLine, [c.invoicePostalCode, c.invoiceCity].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', '),
    ],
    ['Fakturareferens', c.invoiceReference],
    ['Fakturor skickas med', DELIVERY[c.deliveryMethod as string]],
    ['Peppol-id', c.peppolId],
    ['Anteckningar', c.notes],
    ['Registrerad', String(c.createdAt).slice(0, 10)],
  ]);

  if (e.contacts.length) {
    section('Kontaktpersoner');
    table(
      [{ t: 'Namn', w: w(0.3) }, { t: 'Roll', w: w(0.2) }, { t: 'E-post', w: w(0.3) }, { t: 'Telefon', w: w(0.2) }],
      e.contacts.map((x) => [String(x.name ?? ''), String(x.role ?? ''), String(x.email ?? ''), String(x.phone ?? '')]),
      '',
    );
  }

  section('Avtal');
  table(
    [{ t: 'Avtal', w: w(0.1) }, { t: 'Typ', w: w(0.13) }, { t: 'Objekt', w: w(0.42) }, { t: 'Period', w: w(0.23) }, { t: 'Status', w: w(0.12) }],
    e.contracts.map((k) => [
      String(k.contractNr),
      CONTRACT_TYPE[k.type as string] ?? String(k.type),
      String(k.objects ?? ''),
      `${k.startDate} – ${k.endDate ?? 'tills vidare'}`,
      CONTRACT_STATUS[k.status as string] ?? String(k.status),
    ]),
    'Inga avtal.',
  );
  for (const k of e.contracts) {
    if (k.specialTerms || k.notes) kv([[`Avtal ${k.contractNr}`, [k.specialTerms, k.notes].filter(Boolean).join('\n')]]);
  }
  if (e.deposits.length) {
    section('Säkerheter');
    table(
      [{ t: 'Avtal', w: w(0.12) }, { t: 'Typ', w: w(0.2) }, { t: 'Belopp', w: w(0.18), right: true }, { t: 'Mottagen', w: w(0.17) }, { t: 'Återbetald', w: w(0.17) }, { t: 'Notering', w: w(0.16) }],
      e.deposits.map((d) => [
        String(d.contractNr),
        DEPOSIT[d.kind as string] ?? String(d.kind),
        kr(Number(d.amountOre)),
        String(d.receivedDate ?? '–'),
        String(d.returnedDate ?? '–'),
        String(d.note ?? ''),
      ]),
      '',
    );
  }

  section('Fakturor och avier');
  table(
    [{ t: 'Nummer', w: w(0.14) }, { t: 'Typ', w: w(0.2) }, { t: 'Datum', w: w(0.16) }, { t: 'Förfaller', w: w(0.16) }, { t: 'Belopp', w: w(0.17), right: true }, { t: 'Kvar', w: w(0.17), right: true }],
    e.invoices.map((i) => [
      String(i.invoiceNr),
      INVOICE_KIND[i.kind as string] ?? String(i.kind),
      String(i.invoiceDate),
      String(i.dueDate),
      kr(Number(i.totalOre)),
      kr(Number(i.balanceOre)),
    ]),
    'Inga fakturor.',
  );

  section('Inbetalningar');
  table(
    [{ t: 'Datum', w: w(0.2) }, { t: 'Belopp', w: w(0.2), right: true }, { t: 'Sätt', w: w(0.15) }, { t: 'Referens', w: w(0.45) }],
    e.payments.map((p) => [String(p.paymentDate), kr(Number(p.amountOre)), String(p.method), String(p.reference ?? '')]),
    'Inga inbetalningar.',
  );
  if (e.bankPayments.length) {
    para('Uppgifter om betalaren från Bankgirot:', { color: muted });
    table(
      [{ t: 'Datum', w: w(0.15) }, { t: 'Belopp', w: w(0.15), right: true }, { t: 'Betalare', w: w(0.35) }, { t: 'Meddelande', w: w(0.35) }],
      e.bankPayments.map((b) => [
        String(b.paymentDate),
        kr(Number(b.amountOre)),
        [b.payerName, b.payerAddress, b.payerOrgNr].filter(Boolean).join(', '),
        String(b.information ?? ''),
      ]),
      '',
    );
  }

  if (e.reminders.length) {
    section('Påminnelser');
    table(
      [{ t: 'Datum', w: w(0.2) }, { t: 'Påminnelse', w: w(0.15) }, { t: 'Faktura', w: w(0.15) }, { t: 'Skickad till', w: w(0.5) }],
      e.reminders.map((r) => [String(r.reminderDate), String(r.level), String(r.invoiceNr), [DELIVERY[r.channel as string], r.recipient].filter(Boolean).join(' ')]),
      '',
    );
  }
  if (e.deliveries.length) {
    section('Utskick av fakturor');
    table(
      [{ t: 'Faktura', w: w(0.15) }, { t: 'Sätt', w: w(0.15) }, { t: 'Mottagare', w: w(0.45) }, { t: 'Skickad', w: w(0.25) }],
      e.deliveries.map((d) => [String(d.invoiceNr), DELIVERY[d.channel as string] ?? String(d.channel), String(d.recipient ?? ''), d.sentAt ? new Date(String(d.sentAt)).toISOString().slice(0, 10) : '–']),
      '',
    );
  }
  if (e.documents.length) {
    section('Dokument');
    table(
      [{ t: 'Fil', w: w(0.6) }, { t: 'Sparad', w: w(0.2) }, { t: 'Sparas till', w: w(0.2) }],
      e.documents.map((d) => [String(d.fileName), String(d.createdAt), String(d.retainUntil ?? '')]),
      '',
    );
  }

  section('Varför vi behandlar uppgifterna');
  for (const p of e.purposes) {
    kv([[p.purpose, `${p.data}.\nRättslig grund: ${p.legalBasis}.`]]);
  }
  section('Hur länge uppgifterna sparas');
  for (const t of e.retention) para(`• ${t}`);
  section('Vem som får del av uppgifterna');
  for (const t of e.recipients) para(`• ${t}`);
  section('Dina rättigheter');
  for (const t of e.rights) para(`• ${t}`);
  if (e.company.invoiceEmail) para(`Kontakta oss på ${e.company.invoiceEmail} om du har frågor.`);
}
