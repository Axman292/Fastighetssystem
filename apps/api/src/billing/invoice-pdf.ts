import PDFDocument from 'pdfkit';
import type { CompanyInfo, InvoiceDetail } from './invoice-store';
import { periodLabel } from './billing-rules';

export type Doc = InstanceType<typeof PDFDocument>;

const TITLE: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

export const kr = (ore: number) =>
  `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-')} kr`;

export const ink = '#111827';
export const muted = '#6b7280';
export const rule = '#e5e7eb';
export const L = 56;

/** En faktura som PDF. */
export function renderInvoicePdf(d: InvoiceDetail): Promise<Buffer> {
  return renderInvoicesPdf([d]);
}

/** Flera fakturor i en PDF, var och en på egna sidor (för utskrift av brevavier). */
export function renderInvoicesPdf(list: InvoiceDetail[]): Promise<Buffer> {
  const first = list[0];
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: 48, bottom: 48, left: L, right: L },
    info: { Title: list.length === 1 && first ? `${TITLE[first.kind]} ${first.invoiceNr ?? 'utkast'}` : 'Hyresavier' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const starts: number[] = [];
  list.forEach((d, i) => {
    if (i > 0) doc.addPage();
    starts.push(doc.bufferedPageRange().count - 1);
    drawInvoice(doc, d);
  });
  // Sidfot per faktura med sidnummer
  const range = doc.bufferedPageRange();
  list.forEach((d, i) => {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : range.count - 1;
    for (let p = from; p <= to; p++) {
      doc.switchToPage(p);
      footer(doc, d, p - from + 1, to - from + 1);
    }
  });
  doc.end();
  return done;
}

export function footer(doc: Doc, d: { company: CompanyInfo }, page: number, pages: number) {
  const c = d.company;
  const width = doc.page.width - 2 * L;
  const y = doc.page.height - 78;
  doc.page.margins.bottom = 0;
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
  const cols = [
    [c.name, c.addressLine, [c.postalCode, c.city].filter(Boolean).join(' ')],
    [`Org.nr ${c.orgNr}`, c.vatNr ? `Momsreg.nr ${c.vatNr}` : null, c.fTax ? 'Godkänd för F-skatt' : null],
    [c.bankgiro ? `Bankgiro ${c.bankgiro}` : null, c.plusgiro ? `Plusgiro ${c.plusgiro}` : null, c.iban ? `IBAN ${c.iban}${c.bic ? ` · BIC ${c.bic}` : ''}` : null],
    [c.invoiceEmail, pages > 1 ? `Sida ${page} av ${pages}` : null],
  ];
  const cw = width / 4;
  cols.forEach((col, i) => {
    doc.font('Helvetica').fontSize(7.5).fillColor(muted).text(col.filter(Boolean).join('\n'), L + i * cw, y + 8, { width: cw - 8, lineGap: 1.5 });
  });
  if (c.invoiceFooter) {
    doc.fontSize(7).text(c.invoiceFooter, L, doc.page.height - 26, { width, align: 'center', lineBreak: false });
  }
}

function drawInvoice(doc: Doc, d: InvoiceDetail) {
  const width = doc.page.width - 2 * L;
  const c = d.company;
  const credit = d.kind === 'credit_note';
  const draft = d.status === 'draft';

  // Avsändare
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ink).text(c.name, L, 48, { width: width / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text([c.addressLine, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join('\n'), { width: width / 2 });

  // Rubrik
  const rx = L + width / 2;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(TITLE[d.kind] ?? 'Faktura', rx, 46, { width: width / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(draft ? '#b45309' : muted).text(draft ? 'UTKAST, inte utfärdad' : `Nummer ${d.invoiceNr}`, rx, doc.y + 1, { width: width / 2, align: 'right' });

  // Mottagare i fönsterkuvertets läge
  const b = d.billTo;
  const recipient = [b.name, b.careOf ? `c/o ${b.careOf}` : null, b.addressLine, [b.postalCode, b.city].filter(Boolean).join(' '), b.country && b.country !== 'SE' ? b.country : null]
    .filter(Boolean)
    .join('\n');
  doc.font('Helvetica').fontSize(10).fillColor(ink).text(recipient, L + 10, 132, { width: 230, lineGap: 1.5 });

  // Fakturauppgifter
  const facts: [string, string | null | undefined][] = [
    [credit ? 'Datum' : 'Fakturadatum', d.invoiceDate],
    ['Förfallodatum', credit ? null : d.dueDate],
    ['Kundnummer', String(b.customerNr ?? d.customerNr)],
    ['Avtal', d.contractNr ? String(d.contractNr) : null],
    ['Period', d.periodFrom && d.periodTo ? periodLabel({ from: d.periodFrom, to: d.periodTo }) : null],
    ['Er referens', d.yourReference ?? b.reference],
    ['Vår referens', d.ourReference],
    ['OCR', credit ? null : d.ocr],
    ['Krediterar', credit && d.credited ? `${TITLE[d.credited.kind]?.toLowerCase() ?? 'faktura'} ${d.credited.invoiceNr}` : null],
  ];
  let fy = 128;
  for (const [label, value] of facts) {
    if (!label || !value) continue;
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(label, rx + 20, fy, { width: 90 });
    doc.font(label === 'OCR' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(ink).text(value, rx + 110, fy - 0.5, { width: width / 2 - 110, align: 'right' });
    fy += 14;
  }

  // Rader
  let y = Math.max(fy, 220) + 20;
  const col = { desc: L, period: L + width - 250, vat: L + width - 120, amount: L + width - 90 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted);
  doc.text('BESKRIVNING', col.desc, y);
  doc.text('PERIOD', col.period, y, { width: 120 });
  doc.text('MOMS', col.vat, y, { width: 30, align: 'right' });
  doc.text('BELOPP', col.amount, y, { width: 90, align: 'right' });
  y += 13;
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
  y += 6;

  let lastObject: string | null | undefined = undefined;
  for (const l of d.lines) {
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 60;
    }
    if (l.objectNr !== lastObject && l.objectNr) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text(`${l.objectNr}${l.propertyName ? ` · ${l.propertyName}` : ''}`, col.desc, y + 2);
      y = doc.y + 3;
    }
    lastObject = l.objectNr;
    const desc = l.quantity !== 1 ? `${l.description} (${l.quantity.toLocaleString('sv-SE')} à ${kr(l.unitPriceOre)})` : l.description;
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(desc, col.desc + (l.objectNr ? 8 : 0), y, { width: col.period - col.desc - 12 });
    const rowBottom = doc.y;
    const period = l.periodFrom && l.periodTo ? (l.periodFrom === l.periodTo ? l.periodFrom : `${l.periodFrom} – ${l.periodTo}`) : '';
    doc.fillColor(muted).fontSize(8.5).text(period, col.period, y + 0.5, { width: 125 });
    doc.text(l.vatRateBp ? `${l.vatRateBp / 100} %` : '–', col.vat, y + 0.5, { width: 30, align: 'right' });
    doc.fillColor(ink).fontSize(9).text(kr(l.netOre), col.amount, y, { width: 90, align: 'right' });
    y = Math.max(rowBottom, doc.y) + 4;
  }
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).stroke();
  y += 8;

  // Summor
  const sum = (label: string, ore: number, bold = false, size = 9) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(ink);
    doc.text(label, L + width - 260, y, { width: 160 });
    doc.text(kr(ore), L + width - 110, y, { width: 110, align: 'right' });
    y = doc.y + 3;
  };
  sum('Summa exkl. moms', d.netOre);
  const rates = new Map<number, { net: number; vat: number }>();
  for (const l of d.lines) {
    const r = rates.get(l.vatRateBp) ?? { net: 0, vat: 0 };
    r.net += l.netOre;
    r.vat += l.vatOre;
    rates.set(l.vatRateBp, r);
  }
  for (const [rate, r] of [...rates.entries()].sort((a, b) => b[0] - a[0])) {
    if (rate > 0) sum(`Moms ${rate / 100} % på ${kr(r.net)}`, r.vat);
  }
  if (![...rates.keys()].some((r) => r > 0)) sum('Moms', 0);
  if (d.roundingOre) sum('Öresavrundning', d.roundingOre);
  y += 2;
  sum(credit ? 'Att kreditera' : 'Att betala', credit ? -d.totalOre : d.totalOre, true, 11.5);

  if ([...rates.keys()].every((r) => r === 0) && d.lines.some((l) => ['rent'].includes(l.article))) {
    y += 4;
    doc.font('Helvetica').fontSize(8).fillColor(muted).text('Uthyrning av fastighet är undantagen från moms enligt 3 kap. 2 § mervärdesskattelagen.', L, y, { width });
    y = doc.y;
  }

  if (d.message) {
    y += 12;
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(d.message, L, y, { width });
    y = doc.y;
  }

  // Betalningsuppgifter
  const boxY = Math.max(y + 24, doc.page.height - 190);
  if (boxY + 90 > doc.page.height - 82) doc.addPage();
  const by = boxY + 90 > doc.page.height - 82 ? 60 : boxY;
  doc.roundedRect(L, by, width, 74, 6).fillColor('#f9fafb').fill();
  doc.roundedRect(L, by, width, 74, 6).strokeColor(rule).lineWidth(0.6).stroke();
  if (credit) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text('Kreditfaktura', L + 16, by + 14);
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(
      `Beloppet ${kr(-d.totalOre)} dras av från ${d.credited ? `${TITLE[d.credited.kind]?.toLowerCase()} ${d.credited.invoiceNr}` : 'tidigare faktura'}. ` +
        'Har ni redan betalat återbetalas mellanskillnaden eller räknas av mot nästa avi.' +
        (d.creditReason ? `\nOrsak: ${d.creditReason}` : ''),
      L + 16,
      by + 30,
      { width: width - 32 },
    );
  } else {
    const cells: [string, string][] = [
      [c.bankgiro ? 'Bankgiro' : 'Plusgiro', c.bankgiro ?? c.plusgiro ?? 'saknas'],
      ['OCR-nummer', d.ocr ?? 'tilldelas vid utfärdande'],
      ['Förfallodatum', d.dueDate],
      ['Att betala', kr(d.totalOre)],
    ];
    const cw = (width - 32) / 4;
    cells.forEach(([label, value], i) => {
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, L + 16 + i * cw, by + 16, { width: cw - 8 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(value, L + 16 + i * cw, by + 30, { width: cw - 8 });
    });
    doc.font('Helvetica').fontSize(8).fillColor(muted).text('Ange OCR-numret vid betalning så registreras betalningen automatiskt.', L + 16, by + 54, { width: width - 32 });
  }
}
