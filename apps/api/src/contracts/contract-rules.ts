/**
 * Regler för avtal som går att testa utan databas:
 * datumräkning för uppsägning och förlängning, samt indexuppräkning.
 */

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Lägger till månader. Dag 31 blir sista dagen i en kortare månad. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function lastDayOfMonth(iso: string): string {
  const [y, m] = parts(iso);
  return fmt(y, m, daysInMonth(y, m));
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Sista dag då en uppsägning måste ha kommit fram för att ett tidsbestämt avtal
 * ska upphöra vid avtalstidens slut. Null för avtal som löper tills vidare.
 */
export function noticeDeadline(endDate: string | null, noticeMonths: number): string | null {
  if (!endDate) return null;
  return addDays(addMonths(addDays(endDate, 1), -noticeMonths), -1);
}

export interface TerminationInput {
  endDate: string | null;
  noticeMonths: number;
  extensionMonths: number | null;
  received: string;
}

/**
 * Räknar fram när avtalet upphör efter en uppsägning.
 *
 * Tills vidare: uppsägningstiden räknas från närmaste månadsskifte efter att
 * uppsägningen kom fram (12 kap. 4 § jordabalken), så avtalet upphör den sista
 * dagen i den månad som infaller uppsägningstiden efter mottagandet.
 *
 * Tidsbestämt: upphör vid avtalstidens slut om uppsägningen kom i tid. Annars
 * förlängs avtalet med förlängningstiden, så många gånger som behövs.
 * Utan förlängningsklausul upphör avtalet vid avtalstidens slut ändå.
 */
export function terminationEndDate(c: TerminationInput): string {
  if (!c.endDate) return lastDayOfMonth(addMonths(c.received, c.noticeMonths));
  let end = c.endDate;
  if (!c.extensionMonths) return end;
  for (let i = 0; i < 100; i++) {
    const deadline = noticeDeadline(end, c.noticeMonths)!;
    if (c.received <= deadline) return end;
    end = addDays(addMonths(addDays(end, 1), c.extensionMonths), -1);
  }
  return end;
}

/** Nästa avtalsslut vid förlängning: förlängningstiden räknas från dagen efter nuvarande slutdatum. */
export function extendedEndDate(endDate: string, months: number): string {
  return addDays(addMonths(addDays(endDate, 1), months), -1);
}

export interface IndexInput {
  baseValue: number;
  newValue: number;
  /** Andel av förändringen som räknas upp, i procent. */
  sharePct: number;
  floorAtBase: boolean;
  /** Bashyra per månad i öre för de rader som omfattas av indexklausulen. */
  baseAmountOre: number;
}

/**
 * Indextillägg per månad i öre: bashyran gånger andelen av KPI-förändringen.
 * Med golv blir tillägget aldrig negativt, så hyran sjunker inte under bashyran.
 */
export function indexSupplement(i: IndexInput): number {
  const change = (i.newValue - i.baseValue) / i.baseValue;
  const amount = Math.round(i.baseAmountOre * change * (i.sharePct / 100));
  return i.floorAtBase ? Math.max(0, amount) : amount;
}
