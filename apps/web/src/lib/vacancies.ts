type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export interface Vacancy {
  objectId: string;
  companyId: string;
  companyName: string;
  propertyId: string;
  propertyName: string;
  objectNr: string;
  type: string;
  areaM2: number | null;
  rooms: number | null;
  addressLine: string | null;
  monthlyRentOre: number | null;
  kind: 'now' | 'coming';
  status: string;
  vacantFrom: string;
  vacantUntil: string | null;
  currentContractId: string | null;
  nextContractId: string | null;
  leavingTenant: string | null;
  nextTenant: string | null;
  interested: number;
  offers: number;
  daysVacant: number;
  daysUntilVacant: number;
  lostOre: number;
  lostThisYearOre: number;
}

export interface VacancyOverview {
  today: string;
  summary: {
    totalObjects: number;
    vacantNow: number;
    coming: number;
    occupancyPct: number | null;
    monthlyLostOre: number;
    lostThisYearOre: number;
    comingMonthlyOre: number;
    interested: number;
  };
  vacantNow: Vacancy[];
  coming: Vacancy[];
}

export interface Registration {
  id: string;
  companyId: string;
  companyName: string;
  registrationNr: number;
  kind: 'person' | 'organization';
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  objectTypes: string[];
  propertyIds: string[];
  minRooms: number | null;
  minAreaM2: number | null;
  maxRentOre: number | null;
  desiredFrom: string | null;
  householdSize: number | null;
  message: string | null;
  notes: string | null;
  source: 'form' | 'manual';
  status: string;
  consentAt: string | null;
  consentText: string | null;
  customerId: string | null;
  contractId: string | null;
  lastActivityAt: string;
  createdAt: string;
  matchingObjects?: number;
  offerCount?: number;
}

export interface Offer {
  id: string;
  status: 'offered' | 'accepted' | 'declined';
  note: string | null;
  createdAt: string;
  objectId: string;
  objectNr: string;
  type: string;
  propertyName: string;
  monthlyRentOre: number | null;
}

export interface RegistrationDetail extends Registration {
  customerName: string | null;
  contractNr: number | null;
  properties: { id: string; name: string }[];
  offers: Offer[];
  matching: Vacancy[];
}

export interface InterestSettings {
  formEnabled: boolean;
  publicKey: string;
  introText: string | null;
  consentText: string;
  retentionMonths: number;
}

export const INTEREST_STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'Ny', tone: 'accent' },
  contacted: { label: 'Kontaktad', tone: 'neutral' },
  offered: { label: 'Erbjuden', tone: 'warn' },
  converted: { label: 'Blev hyresgäst', tone: 'good' },
  declined: { label: 'Tackade nej', tone: 'neutral' },
  withdrawn: { label: 'Återkallad', tone: 'neutral' },
};

export const OFFER_STATUS: Record<string, { label: string; tone: Tone }> = {
  offered: { label: 'Erbjuden', tone: 'warn' },
  accepted: { label: 'Tackade ja', tone: 'good' },
  declined: { label: 'Tackade nej', tone: 'neutral' },
};

/** Kort sammanfattning av vad intressenten söker. */
export function describeWishes(r: Pick<Registration, 'objectTypes' | 'minRooms' | 'minAreaM2' | 'maxRentOre' | 'desiredFrom'>, typeLabel: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(r.objectTypes.length ? r.objectTypes.map((t) => typeLabel[t] ?? t).join(', ') : 'Alla typer');
  if (r.minRooms) parts.push(`minst ${r.minRooms} rum`);
  if (r.minAreaM2) parts.push(`minst ${r.minAreaM2} m²`);
  if (r.maxRentOre) parts.push(`högst ${Math.round(r.maxRentOre / 100).toLocaleString('sv-SE')} kr/mån`);
  if (r.desiredFrom) parts.push(`från ${r.desiredFrom}`);
  return parts.join(' · ');
}

export function publicFormUrl(key: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/intresseanmalan/${key}`;
}
