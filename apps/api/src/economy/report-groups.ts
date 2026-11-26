/**
 * Rapportgrupper för fastighetens resultaträkning.
 *
 * Varje BAS-konto hör till en grupp. Gruppen bestäms av kontonumret om
 * kontot inte har en egen grupp angiven i kontoplanen.
 * Driftnetto = intäkter − drift − underhåll − fastighetsskatt − försäkring − administration.
 * Räntor dras av efter driftnettot. Investeringar ingår inte i resultatet.
 */
export const REPORT_GROUPS = [
  'rent_income',
  'other_income',
  'operating',
  'maintenance',
  'property_tax',
  'insurance',
  'admin',
  'interest',
  'investment',
  'none',
] as const;

export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const REPORT_GROUP_LABEL: Record<ReportGroup, string> = {
  rent_income: 'Hyresintäkter',
  other_income: 'Övriga intäkter',
  operating: 'Driftkostnader',
  maintenance: 'Underhåll',
  property_tax: 'Fastighetsskatt',
  insurance: 'Försäkringar',
  admin: 'Administration och förvaltning',
  interest: 'Räntekostnader',
  investment: 'Investeringar',
  none: 'Ingår inte i fastighetens resultat',
};

export const INCOME_GROUPS: ReportGroup[] = ['rent_income', 'other_income'];
export const OPEX_GROUPS: ReportGroup[] = ['operating', 'maintenance', 'property_tax', 'insurance', 'admin'];

/** Grupp utifrån BAS-kontonumret. */
export function defaultReportGroup(accountNumber: string): ReportGroup {
  const n = Number(accountNumber);
  if (!Number.isInteger(n)) return 'none';
  if (n >= 3910 && n <= 3919) return 'rent_income';
  if (n === 3740) return 'none';
  if (n >= 3000 && n <= 3999) return 'other_income';
  if ((n >= 5170 && n <= 5179) || (n >= 5070 && n <= 5079)) return 'maintenance';
  if (n === 5191) return 'property_tax';
  if (n === 5192 || (n >= 6310 && n <= 6319)) return 'insurance';
  if (n === 5193 || (n >= 6000 && n <= 6999)) return 'admin';
  if (n >= 4000 && n <= 5999) return 'operating';
  if (n >= 8400 && n <= 8499) return 'interest';
  if (n >= 1000 && n <= 1299) return 'investment';
  return 'none';
}

export function reportGroupOf(accountNumber: string, override?: string | null): ReportGroup {
  return override && (REPORT_GROUPS as readonly string[]).includes(override) ? (override as ReportGroup) : defaultReportGroup(accountNumber);
}

/** Artiklar på kundfakturor som räknas som hyra. Övriga (värme, el, avgifter ...) blir övriga intäkter. */
export const RENT_ARTICLES = ['rent', 'index', 'discount', 'parking', 'storage'];
