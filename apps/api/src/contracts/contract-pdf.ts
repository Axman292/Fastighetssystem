import PDFDocument from 'pdfkit';

/** Det PDF:en behöver, i samma form som GET /contracts/:id ger. */
export interface ContractPdfData {
  contractNr: number;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  noticeMonths: number;
  extensionMonths: number | null;
  billingInterval: string;
  billingInAdvance: boolean;
  paymentTermsDays: number | null;
  specialTerms: string | null;
  company: { name: string; orgNr: string; addressLine: string | null; postalCode: string | null; city: string | null; bankgiro: string | null } | undefined;
  customer: { name: string; kind: string; nationalId: string | null; addressLine: string | null; postalCode: string | null; city: string | null; email: string | null; phone: string | null };
  objects: { objectNr: string; type: string; areaM2: number | null; rooms: number | null; addressLine: string | null; apartmentNr: string | null; propertyName: string; designation: string }[];
  lines: { description: string; amountOre: number; vatRateBp: number; validFrom: string; validTo: string | null; article: string }[];
  indexClause: { baseYear: number; baseMonth: number; baseValue: number; sharePct: number; floorAtBase: boolean; adjustMonth: number } | null;
  deposits: { kind: string; amountOre: number; dueDate: string | null }[];
}

interface Template {
  title: string;
  objectHeading: string;
  /** Fasta villkor för avtalstypen. */
  clauses: [string, string][];
}

/**
 * Avtalsmallar. Texterna är utgångspunkter och bör granskas mot bolagets egna
 * villkor innan de används skarpt. Särskilda villkor skrivs in per avtal.
 */
export const TEMPLATES: Record<string, Template> = {
  residential: {
    title: 'Hyreskontrakt för bostad',
    objectHeading: 'Lägenhet',
    clauses: [
      ['Lägenhetens skick', 'Lägenheten upplåts i befintligt skick som hyresgästen har tagit del av. Hyresvärden svarar för underhåll enligt 12 kap. jordabalken.'],
      ['Användning', 'Lägenheten får endast användas som bostad för hyresgästen och dennes hushåll. Andrahandsuthyrning kräver hyresvärdens skriftliga samtycke eller hyresnämndens tillstånd.'],
      ['Vård och ordning', 'Hyresgästen ska vårda lägenheten väl och följa de ordningsregler som gäller i fastigheten. Skador ska anmälas till hyresvärden utan dröjsmål.'],
      ['Tillträde', 'Hyresvärden har rätt att få tillträde till lägenheten för tillsyn och nödvändiga arbeten enligt 12 kap. 26 § jordabalken.'],
      ['Hemförsäkring', 'Hyresgästen ska ha hemförsäkring under hela hyrestiden.'],
    ],
  },
  commercial: {
    title: 'Hyresavtal för lokal',
    objectHeading: 'Lokal',
    clauses: [
      ['Verksamhet', 'Lokalen får användas för den verksamhet som anges under särskilda villkor. Ändrad användning kräver hyresvärdens skriftliga medgivande.'],
      ['Skick och underhåll', 'Lokalen upplåts i befintligt skick. Hyresgästen svarar för underhåll av lokalens ytskikt och för egna installationer.'],
      ['Myndighetskrav', 'Hyresgästen ansvarar för tillstånd och myndighetskrav som följer av den egna verksamheten.'],
      ['Försäkring', 'Hyresgästen ska ha företagsförsäkring som omfattar verksamheten och egen egendom i lokalen.'],
      ['Överlåtelse', 'Hyresrätten får inte överlåtas eller lokalen upplåtas i andra hand utan hyresvärdens skriftliga samtycke.'],
    ],
  },
  parking: {
    title: 'Avtal om parkeringsplats',
    objectHeading: 'Parkeringsplats',
    clauses: [
      ['Användning', 'Platsen får endast användas för parkering av registrerat fordon i trafik. Förvaring av annat är inte tillåtet.'],
      ['Ansvar', 'Hyresvärden ansvarar inte för skada på eller stöld av fordon eller egendom på platsen.'],
    ],
  },
  storage: {
    title: 'Avtal om förråd',
    objectHeading: 'Förråd',
    clauses: [
      ['Användning', 'Förrådet får användas för förvaring. Brandfarligt, miljöfarligt eller stöldbegärligt gods av betydande värde får inte förvaras.'],
      ['Ansvar', 'Hyresvärden ansvarar inte för skada på eller förlust av förvarad egendom.'],
    ],
  },
  other: {
    title: 'Hyresavtal',
    objectHeading: 'Hyresobjekt',
    clauses: [['Användning', 'Hyresobjektet får användas för det ändamål som anges under särskilda villkor.']],
  },
};

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const DEPOSIT_LABEL: Record<string, string> = {
  deposit: 'Deposition',
  bank_guarantee: 'Bankgaranti',
  surety: 'Borgen',
  other: 'Annan säkerhet',
};

const kr = (ore: number) =>
  `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ')} kr`;

function lines(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join('\n');
}

export function renderContractPdf(d: ContractPdfData): Promise<Buffer> {
  const t = TEMPLATES[d.type] ?? TEMPLATES.other;
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 56, bottom: 56, left: 60, right: 60 }, info: { Title: `${t.title} ${d.contractNr}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const width = doc.page.width - 120;
  const ink = '#111827';
  const muted = '#6b7280';
  let section = 0;

  const heading = (text: string) => {
    section += 1;
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.9).font('Helvetica-Bold').fontSize(10.5).fillColor(ink).text(`${section}. ${text}`);
    doc.moveDown(0.3).font('Helvetica').fontSize(9.5);
  };
  const para = (text: string) => doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(text, { width, lineGap: 2 });

  // Rubrik
  doc.font('Helvetica-Bold').fontSize(17).fillColor(ink).text(t.title);
  doc.font('Helvetica').fontSize(9).fillColor(muted).text(`Avtalsnummer ${d.contractNr}${d.status === 'draft' ? ' · UTKAST' : ''}`);

  // Parter
  heading('Parter');
  const top = doc.y;
  const col = width / 2 - 10;
  const c = d.company;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('HYRESVÄRD', 60, top);
  doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
    lines(c?.name, c ? `Org.nr ${c.orgNr}` : null, c?.addressLine, [c?.postalCode, c?.city].filter(Boolean).join(' ')),
    60,
    doc.y + 2,
    { width: col },
  );
  const leftBottom = doc.y;
  const cu = d.customer;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('HYRESGÄST', 60 + col + 20, top);
  doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
    lines(
      cu.name,
      cu.nationalId ? `${cu.kind === 'person' ? 'Personnr' : 'Org.nr'} ${cu.nationalId}` : null,
      cu.addressLine,
      [cu.postalCode, cu.city].filter(Boolean).join(' '),
      cu.email,
      cu.phone,
    ),
    60 + col + 20,
    top + 12,
    { width: col },
  );
  doc.x = 60;
  doc.y = Math.max(leftBottom, doc.y);

  // Objekt
  heading(t.objectHeading);
  for (const o of d.objects) {
    const facts = [
      o.areaM2 ? `${o.areaM2.toLocaleString('sv-SE')} m²` : null,
      o.rooms ? `${o.rooms.toLocaleString('sv-SE')} rum` : null,
      o.apartmentNr ? `lägenhetsnummer ${o.apartmentNr}` : null,
    ].filter(Boolean);
    para(`${o.objectNr}${o.addressLine ? `, ${o.addressLine}` : ''}${facts.length ? ` (${facts.join(', ')})` : ''}`);
    doc.fillColor(muted).fontSize(8.5).text(`Fastighet ${o.designation}, ${o.propertyName}`, { width });
    doc.moveDown(0.3);
  }
  if (!d.objects.length) para('Inga objekt angivna.');

  // Hyrestid
  heading('Hyrestid');
  if (d.endDate) {
    para(
      `Avtalet gäller från ${d.startDate} till ${d.endDate}. ` +
        (d.extensionMonths
          ? `Sägs avtalet inte upp senast ${d.noticeMonths} månader före hyrestidens utgång förlängs det med ${d.extensionMonths} månader i taget, med samma uppsägningstid.`
          : `Avtalet upphör vid hyrestidens utgång.`),
    );
  } else {
    para(
      `Avtalet gäller från ${d.startDate} och löper tills vidare med en ömsesidig uppsägningstid om ${d.noticeMonths} månader, räknat från närmaste månadsskifte efter uppsägningen.`,
    );
  }

  // Hyra
  heading('Hyra');
  const atStart = d.lines.filter((l) => l.validFrom <= d.startDate && (!l.validTo || l.validTo >= d.startDate));
  const shown = atStart.length ? atStart : d.lines.filter((l) => !l.validTo);
  let net = 0;
  let vat = 0;
  for (const l of shown) {
    const v = Math.round((l.amountOre * l.vatRateBp) / 10000);
    net += l.amountOre;
    vat += v;
    const y = doc.y;
    doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(l.description, 60, y, { width: width - 200 });
    doc.text(l.vatRateBp ? `moms ${l.vatRateBp / 100} %` : 'momsfri', 60 + width - 200, y, { width: 90, align: 'right' });
    doc.text(kr(l.amountOre), 60 + width - 110, y, { width: 110, align: 'right' });
  }
  doc.x = 60;
  doc.moveTo(60, doc.y + 3).lineTo(60 + width, doc.y + 3).strokeColor('#e5e7eb').stroke();
  doc.moveDown(0.5);
  const sumRow = (label: string, ore: number, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(ink).text(label, 60, y, { width: width - 110 });
    doc.text(kr(ore), 60 + width - 110, y, { width: 110, align: 'right' });
  };
  sumRow('Hyra per månad exkl. moms', net);
  if (vat) sumRow('Moms', vat);
  sumRow('Att betala per månad', net + vat, true);
  doc.x = 60;
  doc.moveDown(0.6);
  const interval = d.billingInterval === 'quarter' ? 'kvartalsvis' : 'månadsvis';
  para(
    `Hyran betalas ${interval} ${d.billingInAdvance ? 'i förskott' : 'i efterskott'}` +
      (d.paymentTermsDays !== null && d.paymentTermsDays !== undefined ? `, senast ${d.paymentTermsDays} dagar efter fakturadatum` : '') +
      (c?.bankgiro ? `, till bankgiro ${c.bankgiro}` : '') +
      '.',
  );

  // Index
  if (d.indexClause) {
    const ic = d.indexClause;
    heading('Indexklausul');
    para(
      `Hyran är knuten till konsumentprisindex (KPI, 1980 = 100). Basmånad är ${MONTHS[ic.baseMonth - 1]} ${ic.baseYear} med indextal ${ic.baseValue.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}. ` +
        `Hyran räknas om den 1 ${MONTHS[ic.adjustMonth - 1]} varje år med ${ic.sharePct.toLocaleString('sv-SE')} % av förändringen mellan basmånadens indextal och indextalet för ${MONTHS[ic.baseMonth - 1]} året före omräkningen. ` +
        (ic.floorAtBase ? 'Hyran blir aldrig lägre än bashyran.' : ''),
    );
  }

  // Säkerhet
  if (d.deposits.length) {
    heading('Säkerhet');
    for (const dep of d.deposits) {
      para(`${DEPOSIT_LABEL[dep.kind] ?? dep.kind} om ${kr(dep.amountOre)}${dep.dueDate ? ` ska lämnas senast ${dep.dueDate}` : ''}.`);
    }
  }

  // Fasta villkor
  for (const [h, body] of t.clauses) {
    heading(h);
    para(body);
  }

  if (d.specialTerms) {
    heading('Särskilda villkor');
    para(d.specialTerms);
  }

  // Underskrifter
  if (doc.y > doc.page.height - 190) doc.addPage();
  doc.moveDown(1.5).font('Helvetica').fontSize(9.5).fillColor(ink).text('Detta avtal har upprättats i två likalydande exemplar, av vilka parterna tagit var sitt.', 60, doc.y, { width });
  doc.moveDown(2.2);
  const sigY = doc.y;
  const sig = (x: number, role: string, name: string | undefined) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text('Ort och datum', x, sigY);
    doc.moveTo(x, sigY + 32).lineTo(x + col, sigY + 32).strokeColor('#9ca3af').stroke();
    doc.text(role, x, sigY + 52);
    doc.moveTo(x, sigY + 86).lineTo(x + col, sigY + 86).stroke();
    doc.fillColor(ink).text(name ?? '', x, sigY + 90, { width: col });
  };
  sig(60, 'För hyresvärden', c?.name);
  sig(60 + col + 20, 'Hyresgäst', cu.name);

  // Sidfot
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(muted);
    doc.text(`${t.title} ${d.contractNr} · sida ${i + 1} av ${range.count}`, 60, doc.page.height - 40, {
      width,
      align: 'center',
      lineBreak: false,
    });
  }
  doc.end();
  return done;
}
