/**
 * Gemensam form för alla rapporter. En rapport består av en eller flera
 * sektioner med kolumner och rader, så att samma kod kan visa den på
 * skärmen och exportera den till Excel och PDF.
 *
 * Belopp är alltid i öre, datum som ÅÅÅÅ-MM-DD och areor i m².
 */

export type ColumnType = 'text' | 'date' | 'money' | 'int' | 'number' | 'area' | 'pct';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Relativ bredd i PDF och Excel. Standard: 1, text 2. */
  width?: number;
}

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Section {
  title?: string;
  description?: string;
  columns: Column[];
  rows: Row[];
  /** Summarad längst ned. Tomma kolumner lämnas tomma. */
  totals?: Row;
  /** Text som visas när sektionen saknar rader. */
  empty?: string;
}

export interface ReportFilters {
  from: string;
  to: string;
  propertyId: string | null;
}

export interface Report {
  key: string;
  title: string;
  description: string;
  mode: ReportMode;
  /** Bolaget eller "Hela koncernen". */
  scope: string;
  /** Filter som rapporten tagits fram med, för rubriken i exporten. */
  filters: { label: string; value: string }[];
  generatedAt: string;
  sections: Section[];
  notes?: string[];
}

/** Rapporttyp: en period (från–till) eller ett datum (per). */
export type ReportMode = 'period' | 'date';

export interface ReportInfo {
  key: string;
  title: string;
  description: string;
  mode: ReportMode;
}

export function sumBy(rows: Row[], keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) out[k] = rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  return out;
}

export function dateText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export const OBJECT_TYPE: Record<string, string> = {
  apartment: 'Lägenhet',
  commercial: 'Lokal',
  office: 'Kontor',
  restaurant: 'Restaurang',
  parking: 'Parkering',
  storage: 'Förråd',
  hotel_room: 'Hotellrum',
  hotel_apartment: 'Hotellägenhet',
  other: 'Övrigt',
};

export const CONTRACT_TYPE: Record<string, string> = {
  residential: 'Bostad',
  commercial: 'Lokal',
  parking: 'Parkering',
  storage: 'Förråd',
  other: 'Övrigt',
};

export const INVOICE_KIND: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

export const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Månaderna (ÅÅÅÅ-MM) som perioden berör. */
export function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const end = to.slice(0, 7);
  while (out.length < 120) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > end) break;
    out.push(ym);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
