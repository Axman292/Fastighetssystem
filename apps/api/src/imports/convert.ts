import type { Cell } from './formats';
import type { FieldType } from './entities';
import { norm } from './adapters';

/** Omvandlar ett värde från filen till rätt typ. Ger fel som text i stället för att kasta. */
export function convert(type: FieldType, v: Cell): { value: string | number | boolean | null; error?: string } {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { value: null };
  switch (type) {
    case 'text':
    case 'id':
      return { value: typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v).trim() };
    case 'number': {
      const n = toNumber(v);
      return n === null ? { value: null, error: `"${v}" är inte ett tal` } : { value: n };
    }
    case 'money': {
      const n = toNumber(v);
      return n === null ? { value: null, error: `"${v}" är inte ett belopp` } : { value: Math.round(n * 100) };
    }
    case 'date': {
      const d = toDate(v);
      return d === null ? { value: null, error: `"${v}" är inte ett datum` } : { value: d };
    }
    case 'bool': {
      const s = norm(String(v));
      if (['ja', 'j', 'x', 'yes', 'true', '1', 'sant'].includes(s)) return { value: true };
      if (['nej', 'n', 'no', 'false', '0', 'falskt'].includes(s)) return { value: false };
      return { value: null, error: `"${v}" ska vara Ja eller Nej` };
    }
  }
}

export function toNumber(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return null;
  let s = String(v).replace(/\s| /g, '').replace(/(kr|sek|:-)$/i, '');
  // 1.234,50 och 1,234.50
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (/^-?\d+(\.\d+)?-$/.test(s)) s = `-${s.slice(0, -1)}`; // 100- (minus efter, förekommer i ekonomisystem)
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
}

export function toDate(v: Cell): string | null {
  if (typeof v === 'number') {
    if (v > 19000101 && v < 22001231) return toDate(String(v));
    if (v > 20000 && v < 80000) {
      // Excel-serienummer
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T].*)?$/) ?? s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export const PROPERTY_CATEGORY: Record<string, string> = {
  bostad: 'residential',
  bostader: 'residential',
  flerbostadshus: 'residential',
  hyreshus: 'residential',
  kommersiell: 'commercial',
  lokal: 'commercial',
  lokaler: 'commercial',
  blandad: 'mixed',
  parkering: 'parking',
  hotell: 'hotel',
  industri: 'industrial',
  mark: 'land',
  ovrigt: 'other',
};

export const OBJECT_TYPE: Record<string, string> = {
  lagenhet: 'apartment',
  bostad: 'apartment',
  bostadslagenhet: 'apartment',
  lokal: 'commercial',
  butik: 'commercial',
  kontor: 'office',
  restaurang: 'restaurant',
  parkering: 'parking',
  'p plats': 'parking',
  bilplats: 'parking',
  garage: 'parking',
  forrad: 'storage',
  lager: 'storage',
  hotellrum: 'hotel_room',
  hotellagenhet: 'hotel_apartment',
  ovrigt: 'other',
  apartment: 'apartment',
  commercial: 'commercial',
  office: 'office',
  restaurant: 'restaurant',
  parking: 'parking',
  storage: 'storage',
  hotel_room: 'hotel_room',
  hotel_apartment: 'hotel_apartment',
  other: 'other',
};

export const CONTRACT_TYPE: Record<string, string> = {
  bostad: 'residential',
  bostadsavtal: 'residential',
  lokal: 'commercial',
  lokalavtal: 'commercial',
  kommersiell: 'commercial',
  parkering: 'parking',
  bilplats: 'parking',
  forrad: 'storage',
  ovrigt: 'other',
};

/** Kontotyp ur BAS-kontonumret, eller SIE:s T/S/K/I. */
export function accountType(number: string, given?: string | null): string {
  const g = given?.trim().toUpperCase();
  if (g === 'T') return 'asset';
  if (g === 'S') return Number(number) >= 2000 && Number(number) < 2100 ? 'equity' : 'liability';
  if (g === 'K') return 'expense';
  if (g === 'I') return 'revenue';
  const n = Number(number);
  if (n < 2000) return 'asset';
  if (n < 2100) return 'equity';
  if (n < 3000) return 'liability';
  if (n < 4000) return 'revenue';
  if (n >= 8000 && n < 8400) return 'revenue';
  return 'expense';
}
