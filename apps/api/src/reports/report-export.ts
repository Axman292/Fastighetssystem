import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Column, Report, Row, Section } from './report';

const nf2 = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const clean = (s: string) => s.replace(/[  ]/g, ' ').replace(/−/g, '-');

/** Ett värde som text, som i PDF:en. Belopp i hela kronor. */
export function formatCell(c: Column, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  switch (c.type) {
    case 'money':
      return clean(nf0.format((v as number) / 100));
    case 'area':
      return clean(nf1.format(v as number));
    case 'int':
      return clean(String(v));
    case 'number':
      return clean(nf2.format(v as number)).replace(/,00$/, '');
    case 'pct':
      return `${clean(nf1.format((v as number) * 100))} %`;
    default:
      return String(v);
  }
}

const isNumeric = (c: Column) => c.type !== 'text' && c.type !== 'date';

export function fileName(r: Report, ext: string): string {
  const base = r.title
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const period = r.filters.find((x) => x.label === 'Period' || x.label === 'Per datum')?.value.replace(/\s/g, '') ?? '';
  return `${base}${period ? `-${period.replace(/[^0-9-]/g, '')}` : ''}.${ext}`;
}

// ---------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------

export async function reportToXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fastighetssystem';
  wb.created = new Date();
  const ws = wb.addWorksheet(r.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 0 }] });
  const widest = Math.max(...r.sections.map((s) => s.columns.length));

  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([r.scope]);
  for (const f of r.filters) ws.addRow([`${f.label}: ${f.value}`]);
  ws.addRow([`Utskriven ${r.generatedAt}`]).font = { color: { argb: 'FF6B7280' } };

  const widths: number[] = Array(widest).fill(10);
  for (const s of r.sections) {
    ws.addRow([]);
    if (s.title) ws.addRow([s.title]).font = { bold: true, size: 12 };
    if (s.description) ws.addRow([s.description]).font = { italic: true, color: { argb: 'FF6B7280' } };
    const head = ws.addRow(s.columns.map((c) => c.label));
    head.font = { bold: true };
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
    });
    s.columns.forEach((c, i) => {
      if (isNumeric(c)) head.getCell(i + 1).alignment = { horizontal: 'right' };
      widths[i] = Math.max(widths[i], Math.min(40, c.label.length + 2));
    });
    if (!s.rows.length) ws.addRow([s.empty ?? 'Inga rader']).font = { italic: true, color: { argb: 'FF6B7280' } };
    for (const row of s.rows) addDataRow(ws, s, row, widths);
    if (s.totals) {
      const t = addDataRow(ws, s, s.totals, widths);
      t.font = { bold: true };
      t.eachCell((cell) => (cell.border = { top: { style: 'thin', color: { argb: 'FF9CA3AF' } } }));
    }
  }
  if (r.notes?.length) {
    ws.addRow([]);
    for (const n of r.notes) ws.addRow([n]).font = { color: { argb: 'FF6B7280' } };
  }
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addDataRow(ws: ExcelJS.Worksheet, s: Section, row: Row, widths: number[]) {
  const values = s.columns.map((c) => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return null;
    if (c.type === 'money') return (v as number) / 100;
    if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return new Date(`${v}T00:00:00Z`);
    return v;
  });
  const xr = ws.addRow(values);
  s.columns.forEach((c, i) => {
    const cell = xr.getCell(i + 1);
    if (c.type === 'money') cell.numFmt = '#,##0.00';
    else if (c.type === 'area') cell.numFmt = '#,##0.0';
    else if (c.type === 'pct') cell.numFmt = '0.0%';
    else if (c.type === 'date') cell.numFmt = 'yyyy-mm-dd';
    const len = formatCell(c, row[c.key]).length + 2;
    widths[i] = Math.max(widths[i], Math.min(c.type === 'text' ? 50 : 18, len));
  });
  return xr;
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const M = 36;

/** Kortar texten med … så att den ryms på en rad. */
function fit(doc: InstanceType<typeof PDFDocument>, text: string, width: number): string {
  if (!text || doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export function reportToPdf(r: Report): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', bufferPages: true, margins: { top: M, bottom: M, left: M, right: M }, info: { Title: r.title } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - 2 * M;
  const bottom = () => doc.page.height - M - 22;

  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(r.title, M, M);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([r.scope, ...r.filters.map((f) => `${f.label}: ${f.value}`)].join('   ·   '), M, doc.y + 2, { width });
  doc.moveDown(0.6);

  for (const s of r.sections) {
    const fs = s.columns.length > 12 ? 6.5 : s.columns.length > 9 ? 7.2 : 8;
    const weights = s.columns.map((c) => c.width ?? (c.type === 'text' ? 2 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / total) * width);
    const rowH = fs + 5.5;

    const needed = (s.title ? 18 : 0) + rowH * Math.min(3, s.rows.length + 2);
    if (doc.y + needed > bottom()) doc.addPage();
    if (s.title) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(s.title, M, doc.y + 6, { width });
    }
    if (s.description) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(s.description, M, doc.y + 1, { width });
    doc.y += 4;

    const drawHead = () => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(fs).fillColor(MUTED);
      let x = M;
      s.columns.forEach((c, i) => {
        doc.text(fit(doc, c.label, colW[i] - 4), x + 2, y, { width: colW[i] - 4, align: isNumeric(c) ? 'right' : 'left', lineBreak: false });
        x += colW[i];
      });
      doc.moveTo(M, y + rowH - 2).lineTo(M + width, y + rowH - 2).strokeColor(RULE).lineWidth(0.6).stroke();
      doc.y = y + rowH;
    };
    const drawRow = (row: Row, bold: boolean) => {
      if (doc.y + rowH > bottom()) {
        doc.addPage();
        drawHead();
      }
      const y = doc.y;
      if (bold) doc.moveTo(M, y - 1.5).lineTo(M + width, y - 1.5).strokeColor('#9ca3af').lineWidth(0.6).stroke();
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(INK);
      let x = M;
      s.columns.forEach((c, i) => {
        doc.text(fit(doc, formatCell(c, row[c.key]), colW[i] - 4), x + 2, y, { width: colW[i] - 4, align: isNumeric(c) ? 'right' : 'left', lineBreak: false });
        x += colW[i];
      });
      doc.y = y + rowH;
    };

    drawHead();
    if (!s.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(fs).fillColor(MUTED).text(s.empty ?? 'Inga rader', M + 2, doc.y, { width });
      doc.y += 2;
    }
    for (const row of s.rows) drawRow(row, false);
    if (s.totals) drawRow(s.totals, true);
    doc.y += 8;
  }

  if (r.notes?.length) {
    if (doc.y + 40 > bottom()) doc.addPage();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    for (const n of r.notes) doc.text(n, M, doc.y + 2, { width });
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`${r.title} · ${r.scope} · utskriven ${r.generatedAt}`, M, doc.page.height - M - 8, { width: width - 80, lineBreak: false })
      .text(`Sida ${i + 1} av ${range.count}`, M + width - 80, doc.page.height - M - 8, { width: 80, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
