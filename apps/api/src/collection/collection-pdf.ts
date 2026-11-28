import { Doc, ink, kr, L, muted, rule } from '../billing/invoice-pdf';
import type { BillTo } from '../billing/invoice-store';
import { header, pdf } from '../payments/letters-pdf';
import type { CaseDetail } from './collection';
import type { PlanDetail } from './payment-plans';

function table(doc: Doc, y: number, cols: { label: string; x: number; w: number; right?: boolean }[], rows: string[][], bold = new Set<number>()) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted);
  for (const c of cols) doc.text(c.label.toUpperCase(), c.x, y, { width: c.w, align: c.right ? 'right' : 'left' });
  y += 13;
  const width = doc.page.width - 2 * L;
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).lineWidth(0.6).stroke();
  y += 6;
  rows.forEach((r, ri) => {
    if (y > doc.page.height - 120) {
      doc.addPage();
      y = 60;
    }
    doc.font(bold.has(ri) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(ink);
    let bottom = y;
    r.forEach((v, i) => {
      doc.text(v, cols[i].x, y, { width: cols[i].w, align: cols[i].right ? 'right' : 'left' });
      bottom = Math.max(bottom, doc.y);
    });
    y = bottom + 4;
  });
  doc.moveTo(L, y).lineTo(L + width, y).strokeColor(rule).stroke();
  return y + 10;
}

/** Avbetalningsplanen som brev till hyresgästen. */
export function renderPlanPdf(p: PlanDetail): Promise<Buffer> {
  return pdf(`Avbetalningsplan ${p.planNr}`, (doc) => {
    const width = doc.page.width - 2 * L;
    const c = p.company;
    let y = header(doc, c, 'Avbetalningsplan', p.billTo as BillTo, [
      ['Datum', p.agreedDate],
      ['Plan', String(p.planNr)],
      ['Kundnummer', String(p.customerNr)],
      ['OCR', p.ocr],
    ]);
    doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
      `Vi har kommit överens om att skulden nedan, sammanlagt ${kr(p.totalOre)}, betalas i ${p.installments.length} delbetalningar. ` +
        'Betala varje delbetalning senast på förfallodagen med OCR-numret nedan. Så länge planen följs skickas inga påminnelser ' +
        'och skulden lämnas inte till inkasso. Om en delbetalning inte betalas i tid kan hela det återstående beloppet förfalla till betalning.' +
        (p.chargeInterest ? ' Dröjsmålsränta enligt räntelagen löper på det obetalda beloppet tills skulden är betald.' : ''),
      L,
      y,
      { width, lineGap: 2 },
    );
    y = doc.y + 16;
    doc.font('Helvetica-Bold').fontSize(10).text('Skulden', L, y);
    y = doc.y + 6;
    y = table(
      doc,
      y,
      [
        { label: 'Faktura', x: L, w: 160 },
        { label: 'Förföll', x: L + 170, w: 90 },
        { label: 'Obetalt', x: L + width - 110, w: 110, right: true },
      ],
      [...p.invoices.map((i) => [`Faktura ${i.invoiceNr}`, i.dueDate, kr(i.startBalanceOre)]), ['Summa', '', kr(p.totalOre)]],
      new Set([p.invoices.length]),
    );
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text('Delbetalningar', L, y);
    y = doc.y + 6;
    y = table(
      doc,
      y,
      [
        { label: 'Nr', x: L, w: 40 },
        { label: 'Betala senast', x: L + 50, w: 120 },
        { label: 'Belopp', x: L + width - 110, w: 110, right: true },
      ],
      p.installments.map((i) => [String(i.nr), i.dueDate, kr(i.amountOre)]),
    );
    const cells: [string, string][] = [
      [c.bankgiro ? 'Bankgiro' : 'Plusgiro', c.bankgiro ?? c.plusgiro ?? 'saknas'],
      ['OCR-nummer', p.ocr ?? ''],
      ['Första betalning', p.installments[0]?.dueDate ?? ''],
      ['Per månad', kr(p.installments[0]?.amountOre ?? 0)],
    ];
    const by = Math.max(y + 10, doc.page.height - 190);
    doc.roundedRect(L, by, width, 60, 6).fillColor('#f9fafb').fill();
    doc.roundedRect(L, by, width, 60, 6).strokeColor(rule).lineWidth(0.6).stroke();
    const cw = (width - 32) / 4;
    cells.forEach(([label, value], i) => {
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, L + 16 + i * cw, by + 16, { width: cw - 8 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(value, L + 16 + i * cw, by + 30, { width: cw - 8 });
    });
    return [p];
  });
}

/** Kravsammanställning för ett eller flera inkassoärenden, till inkassobolaget. */
export function renderCasesPdf(list: CaseDetail[]): Promise<Buffer> {
  return pdf(list.length === 1 ? `Inkassoärende ${list[0].caseNr}` : 'Inkassoärenden', (doc) => {
    list.forEach((c, n) => {
      if (n > 0) doc.addPage();
      const width = doc.page.width - 2 * L;
      const billTo = {
        customerNr: c.customerNr,
        kind: c.customerKind,
        name: c.customerName,
        nationalId: c.nationalId,
        vatNr: null,
        careOf: c.careOf,
        addressLine: c.addressLine,
        postalCode: c.postalCode,
        city: c.city,
        country: c.country,
        reference: null,
        email: c.email,
        peppolId: null,
      };
      let y = header(doc, c.company, 'Kravsammanställning', billTo, [
        ['Ärende', String(c.caseNr)],
        ['Kundnummer', String(c.customerNr)],
        [c.customerKind === 'company' ? 'Org.nr' : 'Personnummer', c.nationalId],
        ['Inkassobolag', c.agency],
        ['Deras ärende', c.agencyReference],
      ]);
      doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
        `Fordringar som lämnas för inkasso. Gäldenären har fått två betalningspåminnelser utan att betala. ` +
          `Dröjsmålsränta: ${c.rateText} från dagen efter förfallodagen.` +
          (c.phone || c.email ? ` Kontakt: ${[c.phone, c.email].filter(Boolean).join(', ')}.` : ''),
        L,
        y,
        { width, lineGap: 2 },
      );
      y = doc.y + 14;
      const open = c.claims.filter((x) => x.active && x.balanceOre > 0);
      const capital = open.reduce((a, x) => a + x.balanceOre, 0);
      const interest = open.reduce((a, x) => a + x.interestOre, 0);
      y = table(
        doc,
        y,
        [
          { label: 'Avser', x: L, w: 150 },
          { label: 'Fakturadatum', x: L + 155, w: 70 },
          { label: 'Förföll', x: L + 228, w: 70 },
          { label: 'Kapital', x: L + width - 190, w: 90, right: true },
          { label: 'Upplupen ränta', x: L + width - 95, w: 95, right: true },
        ],
        [
          ...open.map((x) => [
            `${x.isFee ? 'Påminnelseavgift' : x.isInterest ? 'Dröjsmålsränta' : x.kind === 'rent_notice' ? 'Hyresavi' : 'Faktura'} ${x.invoiceNr}${
              x.periodFrom && x.periodTo ? `\n${x.periodFrom}–${x.periodTo}` : ''
            }`,
            x.invoiceDate,
            x.dueDate,
            kr(x.balanceOre),
            x.interestOre ? kr(x.interestOre) : '–',
          ]),
          ['Summa', '', '', kr(capital), kr(interest)],
        ],
        new Set([open.length]),
      );
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(
        `Betalningar till ${c.company.name}${c.company.bankgiro ? `, bankgiro ${c.company.bankgiro}` : ''}. ` +
          'Upplupen ränta är beräknad till och med dagen då ärendet skapades.',
        L,
        y,
        { width },
      );
    });
    return list.map((c) => ({ company: c.company }));
  });
}
