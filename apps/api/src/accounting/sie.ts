/**
 * Skriver SIE-filer (SIE typ 4, verifikationer) enligt SIE-gruppens
 * filformat version 4C. Filen kodas i PC8 (IBM-teckentabell 437) med
 * CRLF som radslut, som formatet kräver.
 *
 * Verifikationsnumret lämnas tomt (""), så att ekonomiprogrammet ger
 * verifikationerna nästa lediga nummer i serien vid inläsningen.
 * #KSUMMA är frivillig och skrivs inte.
 */

export interface SieRow {
  account: string;
  /** Debet positivt, kredit negativt, i öre */
  amountOre: number;
  costCenter?: string | null;
  project?: string | null;
  text?: string | null;
}

export interface SieVoucher {
  date: string; // ÅÅÅÅ-MM-DD
  text: string;
  rows: SieRow[];
}

export interface SieFile {
  program: string;
  version: string;
  generatedAt: string; // ÅÅÅÅ-MM-DD
  generatedBy: string;
  companyName: string;
  orgNr: string;
  /** Räkenskapsår: index 0 = innevarande, -1 = föregående */
  fiscalYears: { index: number; from: string; to: string }[];
  series: string;
  accounts: { number: string; name: string }[];
  costCenters?: { code: string; name: string }[];
  projects?: { code: string; name: string }[];
  vouchers: SieVoucher[];
}

// Tecken 128–255 i teckentabell 437
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const ENCODE = new Map<string, number>();
for (let i = 0; i < CP437_HIGH.length; i++) ENCODE.set(CP437_HIGH[i], 128 + i);

/** Vanliga tecken som saknas i teckentabell 437 */
const FALLBACK: Record<string, string> = { '–': '-', '—': '-', '’': "'", '‘': "'", '”': '"', '“': '"', '…': '...', '€': 'EUR', 'Ø': 'O', 'ø': 'o', 'Ë': 'E', 'Ê': 'E', 'È': 'E', 'Á': 'A', 'À': 'A', 'Ó': 'O', 'Ú': 'U', 'Í': 'I' };

export function encodeCp437(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (code < 128) {
      out.push(code);
      continue;
    }
    const mapped = ENCODE.get(ch);
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    const fb = FALLBACK[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const c of fb) {
      const cc = c.codePointAt(0)!;
      out.push(cc < 128 ? cc : (ENCODE.get(c) ?? 63));
    }
  }
  return Buffer.from(out);
}

export function decodeCp437(buf: Buffer): string {
  let s = '';
  for (const b of buf) s += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
  return s;
}

/** Text inom citattecken. Citattecken och omvända snedstreck skyddas, styrtecken tas bort. */
export function quote(s: string | null | undefined): string {
  const clean = (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const sieDate = (iso: string) => iso.replace(/-/g, '');

/** Öre till belopp med punkt och två decimaler, t.ex. -1250.50 */
export function sieAmount(ore: number): string {
  const sign = ore < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ore));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function buildSieText(f: SieFile): string {
  const lines: string[] = [];
  lines.push('#FLAGGA 0');
  lines.push(`#PROGRAM ${quote(f.program)} ${quote(f.version)}`);
  lines.push('#FORMAT PC8');
  lines.push(`#GEN ${sieDate(f.generatedAt)} ${quote(f.generatedBy)}`);
  lines.push('#SIETYP 4');
  lines.push(`#FNAMN ${quote(f.companyName)}`);
  lines.push(`#ORGNR ${f.orgNr}`);
  for (const y of f.fiscalYears) lines.push(`#RAR ${y.index} ${sieDate(y.from)} ${sieDate(y.to)}`);
  for (const a of f.accounts) lines.push(`#KONTO ${a.number} ${quote(a.name)}`);
  if (f.costCenters?.length) {
    lines.push(`#DIM 1 ${quote('Kostnadsställe')}`);
    for (const c of f.costCenters) lines.push(`#OBJEKT 1 ${quote(c.code)} ${quote(c.name)}`);
  }
  if (f.projects?.length) {
    lines.push(`#DIM 6 ${quote('Projekt')}`);
    for (const p of f.projects) lines.push(`#OBJEKT 6 ${quote(p.code)} ${quote(p.name)}`);
  }
  for (const v of f.vouchers) {
    lines.push(`#VER ${quote(f.series)} "" ${sieDate(v.date)} ${quote(v.text)} ${sieDate(f.generatedAt)}`);
    lines.push('{');
    for (const r of v.rows) {
      const objects: string[] = [];
      if (r.costCenter) objects.push(`1 ${quote(r.costCenter)}`);
      if (r.project) objects.push(`6 ${quote(r.project)}`);
      lines.push(`   #TRANS ${r.account} {${objects.join(' ')}} ${sieAmount(r.amountOre)}${r.text ? ` "" ${quote(r.text)}` : ''}`);
    }
    lines.push('}');
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildSieFile(f: SieFile): Buffer {
  return encodeCp437(buildSieText(f));
}
