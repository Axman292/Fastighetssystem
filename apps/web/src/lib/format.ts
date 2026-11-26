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
