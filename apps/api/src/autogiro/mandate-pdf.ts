import PDFDocument from 'pdfkit';
import { ink, L, muted, rule } from '../billing/invoice-pdf';

export interface MandateFormData {
  company: { name: string; orgNr: string; addressLine: string | null; postalCode: string | null; city: string | null; bankgiro: string | null };
  customer: { name: string; customerNr: number; nationalId: string | null; addressLine: string | null; postalCode: string | null; city: string | null } | null;
}

/**
 * Medgivandeblankett för Autogiro som hyresgästen fyller i och skriver under.
 * Texten följer Bankgirots medgivandevillkor i sak. Kontrollera mot den senaste
 * versionen från Bankgirot innan blanketten används skarpt.
 */
export function renderMandateForm(d: MandateFormData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: L, right: L }, info: { Title: 'Medgivande till Autogiro' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - 2 * L;

  doc.font('Helvetica-Bold').fontSize(18).fillColor(ink).text('Medgivande till Autogiro', L, 48);
  doc.font('Helvetica').fontSize(10).fillColor(muted).text('Betala hyran automatiskt från ditt bankkonto på förfallodagen.', L, 74);

  let y = 108;
  const box = (title: string, rows: [string, string | null][]) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(title, L, y);
    y += 16;
    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, L, y);
      doc.moveTo(L, y + 24).lineTo(L + width, y + 24).strokeColor(rule).lineWidth(0.8).stroke();
      if (value) doc.font('Helvetica').fontSize(10).fillColor(ink).text(value, L, y + 10, { width });
      y += 32;
    }
    y += 6;
  };

  const c = d.company;
  box('Betalningsmottagare', [
    ['Namn', c.name],
    ['Organisationsnummer', c.orgNr],
    ['Bankgironummer', c.bankgiro],
  ]);
  const cu = d.customer;
  box('Betalare (hyresgäst)', [
    ['Namn', cu?.name ?? null],
    ['Adress', cu ? [cu.addressLine, [cu.postalCode, cu.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null],
    ['Betalarnummer (ditt kundnummer)', cu ? String(cu.customerNr) : null],
  ]);
  box('Konto som pengarna dras från', [
    ['Kontohavarens namn', null],
    ['Kontohavarens personnummer eller organisationsnummer', cu?.nationalId ?? null],
    ['Bank', null],
    ['Clearingnummer (4 eller 5 siffror)                                        Kontonummer', null],
  ]);

  doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text('Villkor', L, y);
  y += 14;
  const terms = [
    'Jag medger att betalning får göras genom uttag från angivet konto, eller ett konto som jag senare anger, på begäran av angiven betalningsmottagare för överföring till betalningsmottagaren via Bankgirots Autogiro. Betalning sker på förfallodagen och beloppet framgår av hyresavin, som skickas i god tid före förfallodagen.',
    'Jag ser till att det finns tillräckligt med pengar på kontot senast bankdagen före förfallodagen. Saknas täckning kan betalningsmottagaren försöka dra beloppet igen. Går dragningen inte igenom får jag avin att betala på vanligt sätt.',
    'Medgivandet gäller tills vidare. Jag kan återkalla det genom att meddela betalningsmottagaren eller min bank. Vill jag stoppa en enskild dragning ska jag meddela betalningsmottagaren senast två bankdagar före förfallodagen, eller min bank senast bankdagen före.',
    'Banken är inte skyldig att pröva behörigheten av eller meddela mig i förväg om uttag. Uttagen framgår av mitt kontoutdrag. Banken och betalningsmottagaren får behandla mina personuppgifter för att hantera medgivandet.',
  ];
  for (const t of terms) {
    doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(t, L, y, { width });
    y = doc.y + 6;
  }

  y += 18;
  const half = (width - 24) / 2;
  for (const [i, label] of ['Ort och datum', 'Kontohavarens underskrift'].entries()) {
    const x = L + i * (half + 24);
    doc.moveTo(x, y + 22).lineTo(x + half, y + 22).strokeColor(ink).lineWidth(0.8).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, x, y + 26);
  }
  y += 52;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(muted)
    .text(
      `Skicka blanketten till ${c.name}${c.addressLine ? `, ${c.addressLine}, ${[c.postalCode, c.city].filter(Boolean).join(' ')}` : ''}. Du kan också anmäla autogiro i din internetbank med betalarnumret ovan.`,
      L,
      y,
      { width },
    );
  doc.end();
  return done;
}
