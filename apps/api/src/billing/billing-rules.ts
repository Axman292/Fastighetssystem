/**
 * Regler för avisering som går att testa utan databas:
 * perioder, periodisering av månadsbelopp, förfallodagar, OCR och avrundning.
 */
import { addDays, addMonths, lastDayOfMonth } from '../contracts/contract-rules';

export interface Period {
  from: string;
  to: string;
}

function ymd(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function monthStart(iso: string): string {
  const [y, m] = ymd(iso);
  return fmt(y, m, 1);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Månaden eller kvartalet som innehåller datumet. */
export function periodContaining(iso: string, interval: 'month' | 'quarter'): Period {
  const [y, m] = ymd(iso);
  if (interval === 'month') {
    const from = fmt(y, m, 1);
    return { from, to: lastDayOfMonth(from) };
  }
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  const from = fmt(y, qm, 1);
  return { from, to: lastDayOfMonth(addMonths(from, 2)) };
}

/**
 * Perioden som ska aviseras i en körning för en given månad.
 * Förskott: perioden som innehåller månaden. Efterskott: perioden före den.
 */
export function billingPeriod(runMonth: string, interval: 'month' | 'quarter', inAdvance: boolean): Period {
  const current = periodContaining(runMonth, interval);
  if (inAdvance) return current;
  return periodContaining(addDays(current.from, -1), interval);
}

/** Perioden närmast före. */
export function previousPeriod(p: Period, interval: 'month' | 'quarter'): Period {
  return periodContaining(addDays(p.from, -1), interval);
}

/**
 * Belopp för en period av ett månadsbelopp som gäller [validFrom, validTo].
 * Varje kalendermånad räknas för sig: hela månaden ger hela beloppet,
 * en del av månaden ger beloppet gånger andelen dagar. Avrundas till öre en gång.
 */
export function periodAmount(monthlyOre: number, validFrom: string, validTo: string | null, p: Period): number {
  const from = validFrom > p.from ? validFrom : p.from;
  const to = validTo && validTo < p.to ? validTo : p.to;
  if (from > to) return 0;
  let total = 0;
  let cursor = monthStart(from);
  while (cursor <= to) {
    const mEnd = lastDayOfMonth(cursor);
    const a = from > cursor ? from : cursor;
    const b = to < mEnd ? to : mEnd;
    if (a <= b) {
      const days = daysBetween(a, b) + 1;
      const inMonth = daysBetween(cursor, mEnd) + 1;
      total += days === inMonth ? monthlyOre : (monthlyOre * days) / inMonth;
    }
    cursor = addMonths(cursor, 1);
  }
  return Math.round(total);
}

/** Den del av perioden som raden gäller, eller null om ingen. */
export function overlap(validFrom: string, validTo: string | null, p: Period): Period | null {
  const from = validFrom > p.from ? validFrom : p.from;
  const to = validTo && validTo < p.to ? validTo : p.to;
  return from <= to ? { from, to } : null;
}

/** Moms i öre för ett nettobelopp och en momssats i baspunkter (2500 = 25 %). */
export function vatFor(netOre: number, rateBp: number): number {
  return Math.round((netOre * rateBp) / 10000);
}

/** Öresavrundning till hela kronor. Ger avrundningen i öre (kan vara negativ). */
export function roundingFor(totalOre: number): number {
  const rounded = Math.sign(totalOre) * Math.round(Math.abs(totalOre) / 100) * 100;
  return rounded - totalOre;
}

// ---------------------------------------------------------------------
// Bankdagar och svenska helgdagar
// ---------------------------------------------------------------------

function easterSunday(year: number): string {
  // Anonym gregoriansk algoritm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fmt(year, month, day);
}

function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = söndag
}

/** Dagar då Bankgirot inte gör betalningar, utöver lördagar och söndagar. */
export function swedishBankHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const days = [
    fmt(year, 1, 1), // nyårsdagen
    fmt(year, 1, 6), // trettondedag jul
    addDays(easter, -2), // långfredagen
    addDays(easter, 1), // annandag påsk
    fmt(year, 5, 1), // första maj
    addDays(easter, 39), // Kristi himmelsfärds dag
    fmt(year, 6, 6), // nationaldagen
    fmt(year, 12, 24), // julafton
    fmt(year, 12, 25), // juldagen
    fmt(year, 12, 26), // annandag jul
    fmt(year, 12, 31), // nyårsafton
  ];
  // Midsommarafton: fredagen mellan 19 och 25 juni
  for (let d = 19; d <= 25; d++) {
    const iso = fmt(year, 6, d);
    if (weekday(iso) === 5) days.push(iso);
  }
  return new Set(days);
}

export function isBankDay(iso: string): boolean {
  const w = weekday(iso);
  if (w === 0 || w === 6) return false;
  return !swedishBankHolidays(ymd(iso)[0]).has(iso);
}

/** Sista bankdagen före ett datum (hyra i förskott förfaller sista vardagen före perioden). */
export function lastBankDayBefore(iso: string): string {
  let d = addDays(iso, -1);
  while (!isBankDay(d)) d = addDays(d, -1);
  return d;
}

/** Första bankdagen på eller efter ett datum. */
export function bankDayOnOrAfter(iso: string): string {
  let d = iso;
  while (!isBankDay(d)) d = addDays(d, 1);
  return d;
}

// ---------------------------------------------------------------------
// OCR-nummer
// ---------------------------------------------------------------------

/** Luhn-kontrollsiffra (modulus 10) för en sifferföljd. */
export function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * OCR-nummer med längdsiffra och kontrollsiffra (Bankgirots "hård kontroll"):
 * referensen, därefter en siffra för totala längden (entalssiffran) och sist
 * en kontrollsiffra enligt modulus 10.
 */
export function ocrFor(reference: string | number): string {
  const base = String(reference).replace(/\D/g, '');
  const length = (base.length + 2) % 10;
  const withLength = base + String(length);
  return withLength + String(luhnDigit(withLength));
}

export function ocrValid(ocr: string): boolean {
  if (!/^\d{3,25}$/.test(ocr)) return false;
  if (Number(ocr[ocr.length - 2]) !== ocr.length % 10) return false;
  return luhnDigit(ocr.slice(0, -1)) === Number(ocr[ocr.length - 1]);
}

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

/** "januari 2027", "kvartal 1 2027" eller "2027-01-15 – 2027-01-31". */
export function periodLabel(p: Period): string {
  const [y, m, d] = ymd(p.from);
  const full = d === 1 && p.to === lastDayOfMonth(p.from);
  if (full) return `${MONTHS[m - 1]} ${y}`;
  if (d === 1 && (m - 1) % 3 === 0 && p.to === lastDayOfMonth(addMonths(p.from, 2))) {
    return `kvartal ${(m - 1) / 3 + 1} ${y}`;
  }
  if (d === 1 && p.to === lastDayOfMonth(addMonths(p.from, 2))) {
    return `${MONTHS[m - 1]}–${MONTHS[ymd(p.to)[1] - 1]} ${y}`;
  }
  return `${p.from} – ${p.to}`;
}

export function monthLabel(iso: string): string {
  const [y, m] = ymd(iso);
  return `${MONTHS[m - 1]} ${y}`;
}
