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
