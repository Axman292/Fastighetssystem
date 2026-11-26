import PDFDocument from 'pdfkit';
import { periodLabel } from '../billing/billing-rules';
import { Doc, footer, ink, kr, L, muted, rule } from '../billing/invoice-pdf';
import type { BillTo, CompanyInfo } from '../billing/invoice-store';
import type { ReminderDetail } from './reminders';

const KIND: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

function pdf(title: string, draw: (doc: Doc) => { company: CompanyInfo }[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 48, bottom: 48, left: L, right: L }, info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const pages = draw(doc);
  const range = doc.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(p);
    footer(doc, pages[Math.min(p, pages.length - 1)], 1, 1);
  }
  doc.end();
  return done;
}

function header(doc: Doc, c: CompanyInfo, title: string, b: BillTo, facts: [string, string | null | undefined][]) {
  const width = doc.page.width - 2 * L;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ink).text(c.name, L, 48, { width: width / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text([c.addressLine, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join('\n'), { width: width / 2 });
  const rx = L + width / 2;
  doc.font('Helvetica-Bold').fontSize(title.length > 22 ? 16 : 20).fillColor(ink).text(title, rx, 46, { width: width / 2, align: 'right' });
  const recipient = [b.name, b.careOf ? `c/o ${b.careOf}` : null, b.addressLine, [b.postalCode, b.city].filter(Boolean).join(' '), b.country && b.country !== 'SE' ? b.country : null]
    .filter(Boolean)
    .join('\n');
  doc.font('Helvetica').fontSize(10).fillColor(ink).text(recipient, L + 10, 132, { width: 230, lineGap: 1.5 });
  let fy = 128;
  for (const [label, value] of facts) {
    if (!value) continue;
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(label, rx + 20, fy, { width: 90 });
    doc.font(label === 'OCR' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(ink).text(value, rx + 110, fy - 0.5, { width: width / 2 - 110, align: 'right' });
    fy += 14;
  }
  return Math.max(fy, 220) + 20;
}

/** Påminnelser som PDF, en per sida. */
export function renderRemindersPdf(list: ReminderDetail[]): Promise<Buffer> {
  return pdf(list.length === 1 ? `Påminnelse ${list[0].invoiceNr}` : 'Påminnelser', (doc) => {
    list.forEach((r, i) => {
      if (i > 0) doc.addPage();
      drawReminder(doc, r);
    });
    return list.flatMap((r) => [r]);
  });
}

function drawReminder(doc: Doc, r: ReminderDetail) {
  const width = doc.page.width - 2 * L;
  const c = r.company;
  const title = r.level === 1 ? 'Betalningspåminnelse' : 'Andra påminnelse';
  let y = header(doc, c, title, r.billTo, [
    ['Datum', r.reminderDate],
    ['Kundnummer', String(r.billTo.customerNr ?? r.customerNr)],
    ['Avtal', r.contractNr ? String(r.contractNr) : null],
    ['OCR', r.ocr],
  ]);

  const intro =
    r.level === 1
      ? 'Enligt våra noteringar har vi inte fått betalt för fakturan nedan. Det kan ha blivit ett förbiseende. ' +
        'Betala gärna så snart som möjligt, senast det datum som står nedan. Har du redan betalat kan du bortse från påminnelsen.'
      : 'Vi har tidigare påmint om fakturan nedan men har fortfarande inte fått betalt. ' +
        'Betala senast det datum som står nedan. Om betalning uteblir kan skulden komma att lämnas till inkasso. ' +
        'Kontakta oss om något är oklart eller om du vill göra upp en betalningsplan.';
  doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(intro, L, y, { width, lineGap: 2 });
  y = doc.y + 18;

  const cols = { desc: L, date: L + 190, due: L + 270, total: L + width - 190, open: L + width - 90 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted);
  doc.text('AVSER', cols.desc, y);
  doc.text('DATUM', cols.date, y);
  doc.text('FÖRFALLEN', cols.due, y);
  doc.text('BELOPP', cols.total, y, { width: 90, align: 'right' });
  doc.text('OBETALT', cols.open, y, { width: 90, align: 'right' });
  y += 13;
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
  y += 6;
  const period = r.periodFrom && r.periodTo ? `, ${periodLabel({ from: r.periodFrom, to: r.periodTo })}` : '';
  doc.font('Helvetica').fontSize(9).fillColor(ink);
  doc.text(`${KIND[r.invoiceKind] ?? 'Faktura'} ${r.invoiceNr}${period}`, cols.desc, y, { width: 185 });
  const rowBottom = doc.y;
  doc.text(r.invoiceDate, cols.date, y);
  doc.text(r.invoiceDueDate, cols.due, y);
  doc.text(kr(r.invoiceTotalOre), cols.total, y, { width: 90, align: 'right' });
  doc.text(kr(r.balanceOre), cols.open, y, { width: 90, align: 'right' });
  y = Math.max(rowBottom, doc.y) + 4;
  if (r.feeOre) {
    doc.text(`Påminnelseavgift${r.feeInvoiceNr ? ` (faktura ${r.feeInvoiceNr})` : ''}`, cols.desc, y, { width: 260 });
    doc.text(kr(r.feeOre), cols.open, y, { width: 90, align: 'right' });
    y = doc.y + 4;
  }
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(11.5).text('Att betala', L + width - 260, y, { width: 160 });
  doc.text(kr(r.balanceOre + r.feeOre), L + width - 110, y, { width: 110, align: 'right' });
  y = doc.y + 14;

  const rate = (r.interestBp / 100).toLocaleString('sv-SE');
  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(
    `Vid försenad betalning har vi rätt till dröjsmålsränta enligt räntelagen (för närvarande ${rate} % per år) från förfallodagen. ` +
      (r.interestOre ? `Upplupen ränta fram till i dag är ${kr(r.interestOre)}. Räntan debiteras inte på denna påminnelse. ` : '') +
      (r.feeOre ? 'Påminnelseavgiften tas ut enligt lagen om ersättning för inkassokostnader.' : ''),
    L,
    y,
    { width, lineGap: 1.5 },
  );

  const by = doc.page.height - 190;
  doc.roundedRect(L, by, width, 74, 6).fillColor('#f9fafb').fill();
  doc.roundedRect(L, by, width, 74, 6).strokeColor(rule).lineWidth(0.6).stroke();
  const cells: [string, string][] = [
    [c.bankgiro ? 'Bankgiro' : 'Plusgiro', c.bankgiro ?? c.plusgiro ?? 'saknas'],
    ['OCR-nummer', r.ocr ?? ''],
    ['Betala senast', r.dueDate],
    ['Att betala', kr(r.balanceOre + r.feeOre)],
  ];
  const cw = (width - 32) / 4;
  cells.forEach(([label, value], i) => {
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, L + 16 + i * cw, by + 16, { width: cw - 8 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(value, L + 16 + i * cw, by + 30, { width: cw - 8 });
  });
  doc.font('Helvetica').fontSize(8).fillColor(muted).text(
    'Betala hela beloppet med OCR-numret ovan, så registreras både fakturan och avgiften automatiskt.',
    L + 16,
    by + 54,
    { width: width - 32 },
  );
}

export interface StatementEntry {
  date: string;
  type: 'invoice' | 'credit_note' | 'payment' | 'refund';
  text: string;
  amountOre: number;
  balanceOre: number;
  dueDate?: string | null;
}

export interface Statement {
  company: CompanyInfo;
  billTo: BillTo;
  asOf: string;
  entries: StatementEntry[];
  open: { invoiceNr: number; kind: string; invoiceDate: string; dueDate: string; totalOre: number; balanceOre: number; ocr: string | null }[];
  unallocatedOre: number;
  balanceOre: number;
  overdueOre: number;
}

/** Kontoutdrag för en kund: händelser med löpande saldo och öppna poster. */
export function renderStatementPdf(s: Statement): Promise<Buffer> {
  return pdf('Kontoutdrag', (doc) => {
    const width = doc.page.width - 2 * L;
    let y = header(doc, s.company, 'Kontoutdrag', s.billTo, [
      ['Datum', s.asOf],
      ['Kundnummer', String(s.billTo.customerNr)],
    ]);

    const box = (label: string, value: string, x: number) => {
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, x, y);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(value, x, y + 12);
    };
    box('Att betala totalt', kr(Math.max(s.balanceOre, 0)), L);
    box('Varav förfallet', kr(s.overdueOre), L + width / 3);
    box(s.balanceOre < 0 ? 'Tillgodo' : 'Ej fördelade inbetalningar', kr(s.balanceOre < 0 ? -s.balanceOre : s.unallocatedOre), L + (2 * width) / 3);
    y += 44;

    const section = (title: string) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(title, L, y);
      y = doc.y + 6;
    };
    const head = (cols: [string, number, number, 'left' | 'right'][]) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(muted);
      for (const [t, x, w, align] of cols) doc.text(t, x, y, { width: w, align });
      y += 13;
      doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
      y += 5;
    };
    const ensure = () => {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 60;
      }
    };

    section('Öppna poster');
    const oc: [string, number, number, 'left' | 'right'][] = [
      ['FAKTURA', L, 110, 'left'],
      ['DATUM', L + 115, 62, 'left'],
      ['FÖRFALLER', L + 180, 62, 'left'],
      ['OCR', L + 245, 60, 'left'],
      ['BELOPP', L + width - 175, 80, 'right'],
      ['KVAR', L + width - 90, 90, 'right'],
    ];
    head(oc);
    if (!s.open.length) {
      doc.font('Helvetica').fontSize(9).fillColor(muted).text('Inga obetalda fakturor.', L, y);
      y = doc.y + 4;
    }
    for (const o of s.open) {
      ensure();
      const overdue = o.dueDate < s.asOf;
      doc.font('Helvetica').fontSize(9).fillColor(ink);
      doc.text(`${KIND[o.kind] ?? 'Faktura'} ${o.invoiceNr}`, oc[0][1], y, { width: oc[0][2] });
      doc.text(o.invoiceDate, oc[1][1], y);
      doc.fillColor(overdue ? '#b91c1c' : ink).text(o.dueDate, oc[2][1], y);
      doc.fillColor(ink).text(o.ocr ?? '', oc[3][1], y, { width: oc[3][2] });
      doc.text(kr(o.totalOre), oc[4][1], y, { width: oc[4][2], align: 'right' });
      doc.text(kr(o.balanceOre), oc[5][1], y, { width: oc[5][2], align: 'right' });
      y = doc.y + 3;
    }
    y += 16;

    section('Händelser');
    const ec: [string, number, number, 'left' | 'right'][] = [
      ['DATUM', L, 70, 'left'],
      ['HÄNDELSE', L + 75, 230, 'left'],
      ['BELOPP', L + width - 180, 85, 'right'],
      ['SALDO', L + width - 90, 90, 'right'],
    ];
    head(ec);
    for (const e of s.entries) {
      ensure();
      doc.font('Helvetica').fontSize(9).fillColor(ink);
      doc.text(e.date, ec[0][1], y);
      doc.text(e.text, ec[1][1], y, { width: ec[1][2] });
      const bottom = doc.y;
      doc.text(kr(e.amountOre), ec[2][1], y, { width: ec[2][2], align: 'right' });
      doc.text(kr(e.balanceOre), ec[3][1], y, { width: ec[3][2], align: 'right' });
      y = Math.max(bottom, doc.y) + 3;
    }
    y += 12;
    ensure();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(
      'Positivt belopp är det du ska betala, negativt är inbetalt eller krediterat. Hör av dig om något inte stämmer med dina anteckningar.',
      L,
      y,
      { width },
    );
    return [s];
  });
}
