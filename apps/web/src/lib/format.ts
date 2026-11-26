const kr = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 });
const krExact = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });

/** Öre till kronor, avrundat till hela kronor. */
export function fmtOre(ore: number | null | undefined, exact = false): string {
  if (ore === null || ore === undefined) return '–';
  return (exact ? krExact : kr).format(ore / 100);
}

export function fmtSek(sek: number | null | undefined): string {
  if (sek === null || sek === undefined) return '–';
  return kr.format(sek);
}

/** Stora belopp kort: 32,5 mnkr */
export function fmtMsek(sek: number | null | undefined): string {
  if (sek === null || sek === undefined) return '–';
  if (Math.abs(sek) >= 1_000_000) return `${num.format(sek / 1_000_000)} mnkr`;
  return kr.format(sek);
}

export function fmtM2(m2: number | null | undefined): string {
  if (m2 === null || m2 === undefined) return '–';
  return `${num.format(m2)} m²`;
}

/** Heltal med tusentalsavgränsare, t.ex. kr per m². */
export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('sv-SE');
}

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : num.format(n);
}

export function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '–' : `${num.format(n * 100)} %`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  residential: 'Bostad',
  commercial: 'Kommersiell',
  mixed: 'Blandad',
  parking: 'Parkering',
  hotel: 'Hotell',
  industrial: 'Industri',
  land: 'Mark',
  other: 'Övrigt',
};

export const OBJECT_TYPE_LABEL: Record<string, string> = {
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

export const RESIDENTIAL_TYPES = new Set(['apartment', 'hotel_apartment']);

export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  residential: 'Bostad',
  commercial: 'Lokal',
  parking: 'Parkering',
  storage: 'Förråd',
  other: 'Övrigt',
};

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

/** Status som visas för ett avtal, med hänsyn till datum. */
export function contractStatus(c: { status: string; startDate: string; endDate: string | null }): { label: string; tone: Tone } {
  const today = new Date().toISOString().slice(0, 10);
  if (c.status === 'draft') return { label: 'Utkast', tone: 'neutral' };
  if (c.status === 'cancelled') return { label: 'Makulerat', tone: 'neutral' };
  if (c.endDate && c.endDate < today) return { label: 'Avslutat', tone: 'neutral' };
  if (c.startDate > today) return { label: 'Kommande', tone: 'accent' };
  if (c.status === 'terminated') return { label: 'Uppsagt', tone: 'warn' };
  return { label: 'Aktivt', tone: 'good' };
}

export const OBJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  occupied: { label: 'Uthyrd', tone: 'good' },
  notice: { label: 'Uppsagd', tone: 'warn' },
  upcoming: { label: 'Kommande', tone: 'accent' },
  vacant: { label: 'Vakant', tone: 'bad' },
  inactive: { label: 'Inaktiv', tone: 'neutral' },
};

export const ARTICLE_LABEL: Record<string, string> = {
  rent: 'Hyra',
  heating: 'Värme',
  electricity: 'El',
  water: 'Vatten',
  parking: 'Parkering',
  storage: 'Förråd',
  service: 'Tjänst',
  index: 'Indextillägg',
  discount: 'Rabatt',
  other: 'Övrigt',
};

/** Artiklar på fakturor och extra debiteringar (avgift finns inte på avtalsrader). */
export const INVOICE_ARTICLE_LABEL: Record<string, string> = { ...ARTICLE_LABEL, fee: 'Avgift' };

export const VAT_LABEL: Record<string, string> = { '0': 'Momsfri', '600': '6 %', '1200': '12 %', '2500': '25 %' };

export const DEPOSIT_LABEL: Record<string, string> = {
  deposit: 'Deposition',
  bank_guarantee: 'Bankgaranti',
  surety: 'Borgen',
  other: 'Annan säkerhet',
};

export const DELIVERY_LABEL: Record<string, string> = { email: 'E-post', post: 'Brev', e_invoice: 'E-faktura (Peppol)' };

export const MONTH_LABEL = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const INVOICE_KIND_LABEL: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

export const INVOICE_STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Utkast', tone: 'neutral' },
  unpaid: { label: 'Obetald', tone: 'accent' },
  partially_paid: { label: 'Delbetald', tone: 'warn' },
  overdue: { label: 'Förfallen', tone: 'bad' },
  paid: { label: 'Betald', tone: 'good' },
  overpaid: { label: 'Överbetald', tone: 'warn' },
  credited: { label: 'Krediterad', tone: 'neutral' },
  credit_note: { label: 'Kredit', tone: 'neutral' },
};

export const DELIVERY_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Ej skickad', tone: 'neutral' },
  sent: { label: 'Skickad', tone: 'good' },
  test: { label: 'Testläge', tone: 'accent' },
  failed: { label: 'Misslyckades', tone: 'bad' },
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  bankgiro: 'Bankgiro',
  autogiro: 'Autogiro',
  swish: 'Swish',
  cash: 'Kontant',
  other: 'Annat',
};

export const LINE_KIND_LABEL: Record<string, string> = {
  regular: 'Hyra',
  retroactive: 'Justering',
  charge: 'Extra debitering',
  manual: 'Manuell',
  credit: 'Kredit',
};

/** "januari 2027" från ÅÅÅÅ-MM-DD eller ÅÅÅÅ-MM */
export function fmtMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTH_LABEL[m - 1]} ${y}`;
}

export function fmtPeriod(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const end = new Date(Date.UTC(ty, tm, 0)).toISOString().slice(0, 10);
  if (fd === 1 && to === end) {
    if (fy === ty && fm === tm) return fmtMonth(from);
    if (fy === ty && (fm - 1) % 3 === 0 && tm === fm + 2) return `kvartal ${(fm - 1) / 3 + 1} ${fy}`;
    if (fy === ty) return `${MONTH_LABEL[fm - 1]}–${MONTH_LABEL[tm - 1]} ${fy}`;
  }
  return `${from} – ${to}`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short' }).format(new Date(iso));
}

export const BANK_TX_STATUS: Record<string, { label: string; tone: Tone }> = {
  matched: { label: 'Matchad', tone: 'accent' },
  unmatched: { label: 'Att hantera', tone: 'warn' },
  ignored: { label: 'Hanterad utanför', tone: 'neutral' },
  booked: { label: 'Bokförd', tone: 'good' },
  duplicate: { label: 'Redan inläst', tone: 'neutral' },
};

export const MATCH_RULE_LABEL: Record<string, string> = { ocr: 'OCR', invoice_nr: 'Fakturanummer', name_amount: 'Namn och belopp', manual: 'Manuellt' };

export const REMINDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Ska skrivas ut', tone: 'warn' },
  sent: { label: 'Skickad', tone: 'good' },
  test: { label: 'Testläge', tone: 'accent' },
  failed: { label: 'Misslyckades', tone: 'bad' },
  printed: { label: 'Utskriven', tone: 'good' },
};

export const REMINDER_LEVEL_LABEL = ['', 'Påminnelse 1', 'Påminnelse 2'];

export const SUPPLIER_INVOICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  registered: { label: 'Att attestera', tone: 'accent' },
  approved: { label: 'Attesterad', tone: 'warn' },
  paid: { label: 'Betald', tone: 'good' },
  cancelled: { label: 'Makulerad', tone: 'neutral' },
};

export const SUPPLIER_PAYMENT_METHOD_LABEL: Record<string, string> = {
  bankgiro: 'Bankgiro',
  plusgiro: 'Plusgiro',
  bank_transfer: 'Banköverföring',
  autogiro: 'Autogiro',
  card: 'Kort',
  offset: 'Kvittning',
  other: 'Annat',
};

export const REPORT_GROUP_LABEL: Record<string, string> = {
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

export const INCOME_GROUPS = ['rent_income', 'other_income'];

/** Perioder att välja bland i ekonomiska rapporter. */
export function periodOptions(year: number): { key: string; label: string; from: string; to: string }[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = (m: number) => new Date(Date.UTC(year, m, 0)).getUTCDate();
  const out = [{ key: 'year', label: `Helår ${year}`, from: `${year}-01-01`, to: `${year}-12-31` }];
  for (let q = 1; q <= 4; q++) {
    out.push({ key: `q${q}`, label: `Kvartal ${q}`, from: `${year}-${pad(q * 3 - 2)}-01`, to: `${year}-${pad(q * 3)}-${last(q * 3)}` });
  }
  for (let m = 1; m <= 12; m++) {
    const name = MONTH_LABEL[m - 1];
    out.push({ key: `m${m}`, label: name[0].toUpperCase() + name.slice(1), from: `${year}-${pad(m)}-01`, to: `${year}-${pad(m)}-${last(m)}` });
  }
  return out;
}
