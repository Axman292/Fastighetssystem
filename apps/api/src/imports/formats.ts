import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/**
 * Filformat som importcentralen läser. Varje fil blir en eller flera tabeller
 * med rubriker och rader, oavsett om den kom som Excel, CSV, XML eller SIE.
 * PDF och andra dokument tolkas inte utan sparas som bilagor.
 */

export type Cell = string | number | boolean | null;

export interface ParsedTable {
  name: string;
  headers: string[];
  rows: Cell[][];
  /** Tips till adaptern om vad tabellen innehåller, t.ex. från SIE-poster. */
  hint?: string;
}

export interface ParsedFile {
  format: 'xlsx' | 'csv' | 'xml' | 'sie' | 'pdf' | 'document';
  tables: ParsedTable[];
  note?: string;
}

const DOCUMENT_EXT = /\.(pdf|docx?|odt|rtf|txt|jpe?g|png|tiff?|heic|msg|eml)$/i;

export class FormatError extends Error {}

export async function parseFile(fileName: string, buf: Buffer): Promise<ParsedFile> {
  const name = fileName.toLowerCase();
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (name.endsWith('.xls') && !isZip) {
    throw new FormatError('Gamla .xls-filer kan inte läsas. Öppna filen i Excel och spara som .xlsx.');
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || (isZip && name.endsWith('.xls'))) {
    return { format: 'xlsx', tables: await parseXlsx(buf) };
  }
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.skv')) {
    return { format: 'csv', tables: [parseCsv(decodeText(buf), baseName(fileName))] };
  }
  if (name.endsWith('.xml')) return { format: 'xml', tables: parseXml(decodeText(buf), baseName(fileName)) };
  if (/\.(se|si|sie)$/.test(name) || startsWithSie(buf)) return { format: 'sie', tables: parseSie(decodeSie(buf)) };
  if (name.endsWith('.pdf') || buf.subarray(0, 4).toString('latin1') === '%PDF') return { format: 'pdf', tables: [] };
  if (DOCUMENT_EXT.test(name)) return { format: 'document', tables: [] };
  if (name.endsWith('.txt')) return { format: 'csv', tables: [parseCsv(decodeText(buf), baseName(fileName))] };
  throw new FormatError(`Filtypen för ${fileName} stöds inte. Använd xlsx, csv, xml, sie eller pdf.`);
}

function baseName(f: string) {
  return f.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------
// Textkodning
// ---------------------------------------------------------------------

/** UTF-8 om filen är giltig UTF-8, annars Windows-1252 (vanligt i svenska exportfiler). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// SIE-filer är enligt standarden kodade i IBM PC 8 (CP437).
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function startsWithSie(buf: Buffer) {
  return buf.subarray(0, 64).toString('latin1').replace(/^﻿/, '').trimStart().startsWith('#FLAGGA');
}

export function decodeSie(buf: Buffer): string {
  const head = buf.subarray(0, 2000).toString('latin1');
  // #FORMAT PC8 = CP437. Saknas posten men filen är giltig UTF-8 används den.
  if (!/#FORMAT\s+PC8/i.test(head)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      /* fall igenom till CP437 */
    }
  }
  let out = '';
  for (const b of buf) out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
  return out;
}

// ---------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------

async function parseXlsx(buf: Buffer): Promise<ParsedTable[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    // Vissa system (bl.a. DinHyresvärd) skriver en avskalad xlsx som exceljs inte klarar
    try {
      return await parseXlsxRaw(buf);
    } catch {
      throw new FormatError('Excel-filen kunde inte läsas. Öppna den i Excel och spara som .xlsx.');
    }
  }
  const tables: ParsedTable[] = [];
  wb.eachSheet((ws) => {
    const all: Cell[][] = [];
    let width = 0;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: true }, (cell, i) => {
        cells[i - 1] = cellValue(cell.value);
      });
      all[n - 1] = cells;
      width = Math.max(width, cells.length);
    });
    // Rubrikraden är första raden med minst två ifyllda celler
    const headerIdx = all.findIndex((r) => r && r.filter((c) => c !== null && c !== '').length >= 2);
    if (headerIdx < 0) return;
    const headers = uniqueHeaders(Array.from({ length: width }, (_, i) => all[headerIdx][i]));
    const rows = all
      .slice(headerIdx + 1)
      .map((r) => Array.from({ length: headers.length }, (_, i) => (r ? (r[i] ?? null) : null)))
      .filter((r) => r.some((c) => c !== null && c !== ''));
    tables.push({ name: ws.name, headers, rows });
  });
  return tables;
}

/** Enkel läsare direkt ur xlsx-filens XML, för filer som exceljs inte kan öppna. */
async function parseXlsxRaw(buf: Buffer): Promise<ParsedTable[]> {
  const zip = await JSZip.loadAsync(buf);
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: false });
  const read = async (path: string) => {
    const f = zip.file(path.replace(/^\//, ''));
    return f ? xml.parse(await f.async('string')) : null;
  };
  const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const textOf = (n: any): string => {
    if (n === undefined || n === null) return '';
    if (typeof n === 'string' || typeof n === 'number') return String(n);
    if (n['#text'] !== undefined) return String(n['#text']);
    if (n.t !== undefined) return arr(n.t).map(textOf).join('');
    if (n.r !== undefined) return arr(n.r).map((r: any) => textOf(r.t)).join('');
    return '';
  };
  const wbx = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const sst = await read('xl/sharedStrings.xml');
  const strings = arr(sst?.sst?.si).map(textOf);
  const relMap = new Map(arr(rels?.Relationships?.Relationship).map((r: any) => [r['@Id'], String(r['@Target'])]));
  const tables: ParsedTable[] = [];
  for (const sh of arr(wbx?.workbook?.sheets?.sheet)) {
    const target = relMap.get(sh['@r:id'] ?? sh['@id']) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const ws = await read(path);
    const all: Cell[][] = [];
    for (const row of arr(ws?.worksheet?.sheetData?.row)) {
      const cells: Cell[] = [];
      let col = 0;
      for (const c of arr(row.c)) {
        const ref = c['@r'] as string | undefined;
        if (ref) {
          const letters = ref.replace(/\d+$/, '');
          col = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        }
        const t = c['@t'];
        const v = c.v === undefined ? undefined : textOf(c.v);
        let val: Cell = null;
        if (t === 's') val = strings[Number(v)] ?? null;
        else if (t === 'inlineStr') val = textOf(c.is);
        else if (t === 'b') val = v === '1';
        else if (t === 'str' || t === 'e') val = v ?? null;
        else if (v !== undefined && v !== '') val = Number.isFinite(Number(v)) ? Number(v) : v;
        if (typeof val === 'string') val = val.trim() === '' ? null : val.trim();
        cells[col++] = val;
      }
      all[Number(row['@r'] ?? all.length + 1) - 1] = cells;
    }
    const headerIdx = all.findIndex((r) => r && r.filter((c) => c !== null && c !== undefined).length >= 2);
    if (headerIdx < 0) continue;
    const width = Math.max(...all.filter(Boolean).map((r) => r.length));
    const headers = uniqueHeaders(Array.from({ length: width }, (_, i) => all[headerIdx][i] ?? null));
    const rows = all
      .slice(headerIdx + 1)
      .filter(Boolean)
      .map((r) => Array.from({ length: headers.length }, (_, i) => r[i] ?? null))
      .filter((r) => r.some((c) => c !== null && c !== ''));
    tables.push({ name: String(sh['@name'] ?? 'Blad'), headers, rows });
  }
  if (!tables.length) throw new Error('inga blad');
  return tables;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text).trim() || null;
    if ('error' in v) return null;
    return null;
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v as Cell;
}

function uniqueHeaders(raw: Cell[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h === null || h === undefined || String(h).trim() === '' ? `Kolumn ${i + 1}` : String(h).replace(/\s+/g, ' ').trim();
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

export function parseCsv(text: string, name: string): ParsedTable {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = ([';', '\t', ',', '|'] as const)
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) throw new FormatError('Filen är tom');
  const headers = uniqueHeaders(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map((r) => headers.map((_, i) => csvValue(r[i])));
  return { name, headers, rows };
}

function csvValue(v: string | undefined): Cell {
  if (v === undefined) return null;
  const s = v.trim();
  return s === '' ? null : s;
}

// ---------------------------------------------------------------------
// XML: den upprepade posten med flest förekomster blir en tabell
// ---------------------------------------------------------------------

export function parseXml(text: string, name: string): ParsedTable[] {
  let doc: unknown;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true }).parse(text);
  } catch {
    throw new FormatError('XML-filen kunde inte läsas');
  }
  const lists: { path: string; items: Record<string, unknown>[] }[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object')) {
        lists.push({ path: `${path}/${k}`, items: v as Record<string, unknown>[] });
        v.forEach((x) => walk(x, `${path}/${k}`));
      } else if (v && typeof v === 'object') walk(v, `${path}/${k}`);
    }
  };
  walk(doc, '');
  if (!lists.length) {
    // En enda post blir en tabell med en rad
    const root = doc && typeof doc === 'object' ? Object.values(doc as object).find((v) => v && typeof v === 'object') : null;
    const only = root && typeof root === 'object' ? Object.values(root).find((v) => v && typeof v === 'object') : null;
    if (only && typeof only === 'object') lists.push({ path: name, items: [only as Record<string, unknown>] });
  }
  return lists
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 5)
    .map(({ path, items }) => {
      const flat = items.map((i) => flatten(i));
      const headers = [...new Set(flat.flatMap((f) => Object.keys(f)))];
      return {
        name: path.split('/').filter(Boolean).slice(-1)[0] ?? name,
        headers,
        rows: flat.map((f) => headers.map((h) => f[h] ?? null)),
      };
    });
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) out[key] = null;
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    else if (typeof v === 'object') {
      const t = (v as Record<string, unknown>)['#text'];
      if (t !== undefined && Object.keys(v).every((x) => x === '#text' || x.startsWith('@'))) out[key] = String(t);
      else Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else out[key] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------
// SIE 4: kontoplan, verifikationer och balanser
// ---------------------------------------------------------------------

/** Delar en SIE-rad i fält: citattecken, klammerlistor {} och escape med \. */
export function sieTokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        s += line[i++];
      }
      i++;
      out.push(s);
    } else if (c === '{') {
      const end = line.indexOf('}', i);
      out.push(line.slice(i, end < 0 ? line.length : end + 1));
      i = end < 0 ? line.length : end + 1;
    } else {
      let s = '';
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t') s += line[i++];
      out.push(s);
    }
  }
  return out;
}

function sieDate(s: string | undefined): string | null {
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function sieObjects(list: string | undefined): { costCenter: string | null; object: string | null } {
  // {1 "100" 6 "P1"}: dimension 1 = kostnadsställe, övriga = objekt/projekt
  const toks = list ? sieTokens(list.replace(/^\{|\}$/g, '')) : [];
  let costCenter: string | null = null;
  const objects: string[] = [];
  for (let i = 0; i + 1 < toks.length; i += 2) {
    if (toks[i] === '1') costCenter = toks[i + 1];
    else objects.push(`${toks[i]}:${toks[i + 1]}`);
  }
  return { costCenter, object: objects.join(', ') || null };
}

export function parseSie(text: string): ParsedTable[] {
  const accounts = new Map<string, { name: string; type: string | null; sru: string | null; vat: string | null }>();
  const vouchers: Cell[][] = [];
  const balances: Cell[][] = [];
  const meta: Record<string, string> = {};
  let current: { series: string; nr: string; date: string | null; text: string } | null = null;
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith('#') && t !== '{' && t !== '}') continue;
    if (t === '{') continue;
    if (t === '}') {
      current = null;
      continue;
    }
    const [tag, ...f] = sieTokens(t);
    switch (tag.toUpperCase()) {
      case '#FNAMN':
        meta.company = f[0];
        break;
      case '#ORGNR':
        meta.orgNr = f[0];
        break;
      case '#PROGRAM':
        meta.program = f.join(' ');
        break;
      case '#RAR':
        if (f[0] === '0') meta.fiscalYear = `${sieDate(f[1])} – ${sieDate(f[2])}`;
        break;
      case '#KONTO':
        accounts.set(f[0], { ...(accounts.get(f[0]) ?? { type: null, sru: null, vat: null }), name: f[1] ?? '' });
        break;
      case '#KTYP':
        accounts.set(f[0], { ...(accounts.get(f[0]) ?? { name: '', sru: null, vat: null }), type: f[1] ?? null });
        break;
      case '#SRU':
        accounts.set(f[0], { ...(accounts.get(f[0]) ?? { name: '', type: null, vat: null }), sru: f[1] ?? null });
        break;
      case '#MOMSKOD':
        accounts.set(f[0], { ...(accounts.get(f[0]) ?? { name: '', type: null, sru: null }), vat: f[1] ?? null });
        break;
      case '#IB':
      case '#UB':
        if (f[0] === '0') balances.push([tag.slice(1).toUpperCase(), f[1], Number(f[2])]);
        break;
      case '#VER':
        current = { series: f[0] || 'A', nr: f[1] ?? '', date: sieDate(f[2]), text: f[3] ?? '' };
        line = 0;
        break;
      case '#TRANS':
      case '#BTRANS':
      case '#RTRANS':
        if (!current || tag.toUpperCase() !== '#TRANS') break; // borttagna/tillagda rader följer #TRANS-raden
        line++;
        {
          const { costCenter, object } = sieObjects(f[1]);
          vouchers.push([
            current.series,
            current.nr,
            current.date,
            current.text,
            line,
            f[0],
            Number(f[2]),
            costCenter,
            object,
            f[4] ?? null,
            sieDate(f[3]),
          ]);
        }
        break;
    }
  }
  const tables: ParsedTable[] = [];
  if (accounts.size) {
    tables.push({
      name: 'Kontoplan',
      hint: 'sie_accounts',
      headers: ['Konto', 'Kontonamn', 'Kontotyp', 'SRU', 'Momskod'],
      rows: [...accounts.entries()].sort().map(([nr, a]) => [nr, a.name, a.type, a.sru, a.vat]),
    });
  }
  if (vouchers.length) {
    tables.push({
      name: 'Verifikationer',
      hint: 'sie_vouchers',
      headers: ['Serie', 'Verifikationsnummer', 'Datum', 'Text', 'Rad', 'Konto', 'Belopp', 'Kostnadsställe', 'Objekt', 'Radtext', 'Transaktionsdatum'],
      rows: vouchers,
    });
  }
  if (balances.length) {
    tables.push({ name: 'Balanser', hint: 'sie_balances', headers: ['Typ', 'Konto', 'Belopp'], rows: balances });
  }
  if (!tables.length) throw new FormatError('SIE-filen innehåller varken konton eller verifikationer');
  if (meta.company) tables[0].name = `${tables[0].name}`;
  return tables;
}
