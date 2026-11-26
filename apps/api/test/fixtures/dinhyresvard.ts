import ExcelJS from 'exceljs';

/**
 * Påhittade exporter i samma format som Hogia DinHyresvärd (rapporterna
 * Bostäder, Lokaler och Bilplatser). Kolumnrubrikerna är exportens riktiga,
 * alla namn, nummer och adresser är påhittade.
 */

export const BOSTADER_HEADERS = [
  'Objektnummer', 'Adress', 'Objekttyp', 'Våningsplan', 'Månadshyra november 2026', 'Byggnad', 'Byggnad Nummer', 'Entré', 'Fastighet',
  'Fastighetsnummer', 'Företag', 'Företag nummer', 'Lägenhetsnummer', 'Årshyra kr/kvm', 'Årshyra, förhandling kr/kvm',
  'Årshyra, förhandling  2026-11-01 -- 2027-10-31', 'Årshyra 2026-11-01 -- 2027-10-31', 'Vindsutrymme nummer', 'Uthyrningsspärr t.o.m.',
  'Uthyrningsspärr fr.o.m.', 'Upplåtelseform', 'Spärranledning', 'Notering', 'Normhyra', 'Möblerad', 'Månadshyra 2026-12',
  'Källarutrymme nummer', 'Kontrakt, startdatum', 'Kontrakt, slutdatum', 'Hyra kontrakt 2026-12', 'Hyra kontrakt november 2026',
  'Hyresgäst 2, telefon', 'Hyresgäst 2, person/orgnr', 'Hyresgäst 2', 'Hyresgäst 2, e-post', 'Hyresgäst 1, telefon', 'Hyresgäst 1',
  'Hyresgäst 1, e-post', 'Hyresgäst 1, person/orgnr', 'Hyresbortfall 2026', 'Hyresbortfall 2025', 'Hyresbortfall 2026-12',
  'Hyresbortfall november 2026', 'Hiss', 'Garage/parkering som ingår i hyran', 'Förhandlingsorganisation', 'Förhandlingsklausul',
  'BVKHyra', 'Storlek', 'Antal rum', 'Annat förråd, nummer',
];

export interface FakeApartment {
  nr: string;
  address: string;
  type?: string;
  rent: number;
  property: string;
  company: string;
  tenant?: string;
  tenantId?: string;
  email?: string;
  phone?: string;
  cotenant?: string;
  start?: string;
  end?: string;
  contractRent?: number;
  size?: number;
  rooms?: number;
}

export async function bostader(rows: FakeApartment[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bostäder');
  ws.addRow(BOSTADER_HEADERS);
  for (const r of rows) {
    const v: Record<string, unknown> = {
      Objektnummer: r.nr,
      Adress: r.address,
      Objekttyp: r.type ?? '2 rum och kök',
      Våningsplan: 1,
      'Månadshyra november 2026': r.rent,
      Fastighet: r.property,
      Fastighetsnummer: '1',
      Företag: r.company,
      'Företag nummer': 2,
      Lägenhetsnummer: r.nr.slice(-4),
      Upplåtelseform: 'Hyresrätt',
      Notering: 'Testnotering',
      Möblerad: 'Nej',
      'Kontrakt, startdatum': r.start ?? '',
      'Kontrakt, slutdatum': r.end ?? '',
      'Hyra kontrakt november 2026': r.contractRent ?? 0,
      'Hyresgäst 1': r.tenant ?? '',
      'Hyresgäst 1, e-post': r.email ?? '',
      'Hyresgäst 1, telefon': r.phone ?? '',
      'Hyresgäst 1, person/orgnr': r.tenantId ?? '',
      'Hyresgäst 2': r.cotenant ?? '',
      Storlek: r.size ?? 60,
      'Antal rum': r.rooms ?? 2,
    };
    ws.addRow(BOSTADER_HEADERS.map((h) => v[h] ?? ''));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function lokaler(rows: { nr: string; address: string; size: number; type: string; rent: number; year: number; yearVat: number }[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Lokaler');
  ws.addRow(['Objektnummer', 'Adress', 'Storlek', 'Våningsplan', 'Objekttyp', 'Månadshyra november 2026', 'Årshyra', 'Årshyra inkl. moms']);
  for (const r of rows) ws.addRow([r.nr, r.address, r.size, 1, r.type, r.rent, r.year, r.yearVat]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function bilplatser(rows: { nr: string; address: string; place: string; rent: number }[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bilplatser');
  ws.addRow(['Objektnummer', 'Adress', 'Bilplatsnummer', 'Objekttyp', 'Månadshyra november 2026']);
  for (const r of rows) ws.addRow([r.nr, r.address, r.place, 'Öppen plats med elanslutning', r.rent]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Liten SIE 4-fil i CP437 med kontoplan och två verifikationer. */
export function sieFile(): Buffer {
  const text = [
    '#FLAGGA 0',
    '#FORMAT PC8',
    '#SIETYP 4',
    '#PROGRAM "Testprogram" 1.0',
    '#FNAMN "Påhittat Bolag AB"',
    '#RAR 0 20260101 20261231',
    '#KONTO 1930 "Företagskonto"',
    '#KONTO 1510 "Kundfordringar"',
    '#KONTO 3010 "Hyresintäkter bostäder"',
    '#KONTO 3011 "Hyresintäkter lokaler momspliktiga"',
    '#KONTO 2611 "Utgående moms 25 %"',
    '#KTYP 1930 T',
    '#IB 0 1930 10000.00',
    '#VER A 1 20261101 "Hyresavi november"',
    '{',
    '#TRANS 1510 {} 12500.00',
    '#TRANS 3011 {1 "100"} -10000.00',
    '#TRANS 2611 {} -2500.00',
    '}',
    '#VER A 2 20261115 "Inbetalning"',
    '{',
    '#TRANS 1930 {} 12500.00 20261115 "Bg"',
    '#TRANS 1510 {} -12500.00',
    '}',
  ].join('\r\n');
  // Koda till CP437: å=0x86, ä=0x84, ö=0x94, Å=0x8F, Ä=0x8E, Ö=0x99, %=0x25
  const map: Record<string, number> = { å: 0x86, ä: 0x84, ö: 0x94, Å: 0x8f, Ä: 0x8e, Ö: 0x99 };
  return Buffer.from([...text].map((c) => map[c] ?? c.charCodeAt(0)));
}
