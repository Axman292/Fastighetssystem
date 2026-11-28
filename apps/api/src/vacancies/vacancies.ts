import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isoDate } from '../common/money';

/**
 * Lediga objekt och intresselista.
 *
 * Vakanser räknas fram ur avtalen: ett objekt är ledigt i dag när inget avtal
 * gäller, och blir ledigt när det nuvarande avtalet har ett slutdatum (uppsägning
 * eller tidsbestämt avtal) utan att ett nytt avtal tar vid dagen efter.
 * Förlorad hyra är objektets hyra per dag (månadshyra × 12 / 365) gånger antal
 * lediga dagar.
 */

export const OBJECT_TYPES = ['apartment', 'commercial', 'office', 'restaurant', 'parking', 'storage', 'hotel_room', 'hotel_apartment', 'other'] as const;
export const ACTIVE_STATUSES = ['new', 'contacted', 'offered'];
export const INTEREST_STATUSES = ['new', 'contacted', 'offered', 'converted', 'declined', 'withdrawn'] as const;

/** Det som gör att en intressent passar ett objekt. o = rental_object, cur = rental_object_current, r = interest_registration. */
export const MATCH_SQL = `
  r.company_id = o.company_id and r.status in ('new','contacted','offered')
  and (cardinality(r.object_types) = 0 or o.type = any (r.object_types))
  and (cardinality(r.property_ids) = 0 or o.property_id = any (r.property_ids))
  and (r.min_rooms is null or o.rooms is null or o.rooms >= r.min_rooms)
  and (r.min_area_m2 is null or o.area_m2 is null or o.area_m2 >= r.min_area_m2)
  and (r.max_rent_ore is null or cur.monthly_rent_ore is null or cur.monthly_rent_ore <= r.max_rent_ore)`;

/** Alla aktiva objekt som är lediga nu eller får ett slutdatum, med datum för vakansen. */
const VACANCY_SQL = `
  with base as (
    select o.id, o.company_id, co.name as company_name, o.property_id, p.name as property_name, o.object_nr, o.type,
           o.area_m2, o.rooms, o.address_line, o.created_at::date as created,
           cur.monthly_rent_ore, st.status, st.current_contract_id, st.current_until, st.next_contract_id, st.next_from,
           (select max(x.valid_to) from contract_object x join contract k on k.id = x.contract_id
             where x.object_id = o.id and k.status in ('active','terminated') and x.valid_to < current_date) as last_end
    from rental_object o
    join property p on p.id = o.property_id
    join company co on co.id = o.company_id
    left join rental_object_current cur on cur.object_id = o.id
    left join rental_object_status st on st.object_id = o.id
    where o.active and ($1::uuid is null or o.property_id = $1)
  ), v as (
    select b.*,
      case when b.status in ('vacant','upcoming') then 'now' else 'coming' end as kind,
      case when b.status in ('vacant','upcoming') then coalesce(b.last_end + 1, b.created)
           else b.current_until + 1 end as vacant_from,
      case when b.next_from is not null then b.next_from - 1 end as vacant_until
    from base b
    where b.status in ('vacant','upcoming')
       or (b.status in ('occupied','notice') and b.current_until is not null
           and (b.next_from is null or b.next_from > b.current_until + 1))
  )
  select v.id as "objectId", v.company_id as "companyId", v.company_name as "companyName", v.property_id as "propertyId",
         v.property_name as "propertyName", v.object_nr as "objectNr", v.type, v.area_m2::float as "areaM2",
         v.rooms::float as rooms, v.address_line as "addressLine", v.monthly_rent_ore::float as "monthlyRentOre",
         v.kind, v.status, v.vacant_from::text as "vacantFrom", v.vacant_until::text as "vacantUntil",
         v.current_contract_id as "currentContractId", v.next_contract_id as "nextContractId",
         (select cu.name from contract k join customer cu on cu.id = k.customer_id where k.id = v.current_contract_id) as "leavingTenant",
         (select cu.name from contract k join customer cu on cu.id = k.customer_id where k.id = v.next_contract_id) as "nextTenant",
         (select count(*) from interest_registration r join rental_object o on o.id = v.id
            left join rental_object_current cur on cur.object_id = o.id where ${MATCH_SQL})::int as "interested",
         (select count(*) from interest_offer f where f.object_id = v.id and f.status <> 'declined')::int as "offers"
  from v
  order by v.vacant_from, v.property_name, v.object_nr`;

export interface VacancyRow {
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
  leavingTenant: string | null;
  nextTenant: string | null;
  interested: number;
  offers: number;
  /** Dagar ledigt hittills (lediga nu) eller dagar kvar tills det blir ledigt (kommande). */
  daysVacant: number;
  daysUntilVacant: number;
  lostOre: number;
  lostThisYearOre: number;
}

const DAY = 86_400_000;
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}
export function dailyRentOre(monthlyOre: number | null): number {
  return monthlyOre ? (monthlyOre * 12) / 365 : 0;
}

/** Förlorad hyra från ett datum till och med i går (eller till vakansens slut). */
export function lostRent(monthlyOre: number | null, from: string, today: string, until: string | null): number {
  const end = until && until < today ? until : null;
  const days = end ? daysBetween(from, end) + 1 : daysBetween(from, today);
  return Math.max(0, Math.round(days * dailyRentOre(monthlyOre)));
}

export async function vacancies(client: PoolClient, today: string, propertyId?: string | null) {
  const { rows } = await client.query(VACANCY_SQL, [propertyId ?? null]);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const list: VacancyRow[] = rows.map((r) => {
    const now = r.kind === 'now';
    const from: string = r.vacantFrom;
    return {
      ...r,
      daysVacant: now ? Math.max(0, daysBetween(from, today)) : 0,
      daysUntilVacant: now ? 0 : Math.max(0, daysBetween(today, from)),
      lostOre: now ? lostRent(r.monthlyRentOre, from, today, r.vacantUntil) : 0,
      lostThisYearOre: now ? lostRent(r.monthlyRentOre, from > yearStart ? from : yearStart, today, r.vacantUntil) : 0,
    };
  });
  const vacantNow = list.filter((v) => v.kind === 'now');
  const coming = list.filter((v) => v.kind === 'coming');
  const { rows: totals } = await client.query(
    `select count(*)::int as total from rental_object o where o.active and ($1::uuid is null or o.property_id = $1)`,
    [propertyId ?? null],
  );
  const total = totals[0].total as number;
  return {
    today,
    summary: {
      totalObjects: total,
      vacantNow: vacantNow.length,
      coming: coming.length,
      occupancyPct: total ? Math.round(((total - vacantNow.length) / total) * 1000) / 10 : null,
      monthlyLostOre: vacantNow.reduce((s, v) => s + (v.monthlyRentOre ?? 0), 0),
      lostThisYearOre: vacantNow.reduce((s, v) => s + v.lostThisYearOre, 0),
      comingMonthlyOre: coming.reduce((s, v) => s + (v.monthlyRentOre ?? 0), 0),
      interested: (
        await client.query(`select count(*)::int as n from interest_registration where status = any ($1)`, [ACTIVE_STATUSES])
      ).rows[0].n as number,
    },
    vacantNow,
    coming,
  };
}

// ---------------------------------------------------------------------
// Intresseanmälningar
// ---------------------------------------------------------------------

const optText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const wishes = {
  objectTypes: z.array(z.enum(OBJECT_TYPES)).max(9).default([]),
  propertyIds: z.array(z.string().uuid()).max(100).default([]),
  minRooms: z.number().min(0).max(50).nullable().optional(),
  minAreaM2: z.number().min(0).max(100000).nullable().optional(),
  /** Högsta hyra per månad i kronor. */
  maxRent: z.number().min(0).max(1e8).nullable().optional(),
  desiredFrom: isoDate.nullable().optional(),
  householdSize: z.number().int().min(1).max(50).nullable().optional(),
};

const contactFields = {
  kind: z.enum(['person', 'organization']).default('person'),
  name: z.string().trim().min(1, 'Ange namn').max(200),
  contactPerson: optText(),
  email: z
    .string()
    .trim()
    .email('Ogiltig e-postadress')
    .max(200)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optText(40),
  addressLine: optText(),
  postalCode: optText(20),
  city: optText(100),
};

const needContact = (v: { email?: string | null; phone?: string | null }) => !!(v.email || v.phone);
const contactIssue = { path: ['email'], message: 'Ange e-post eller telefon' };

export const registrationSchema = z
  .object({
    ...contactFields,
    ...wishes,
    message: optText(5000),
    notes: optText(5000),
    status: z.enum(INTEREST_STATUSES).optional(),
  })
  .refine(needContact, contactIssue);

export const updateRegistrationSchema = z
  .object({
    ...contactFields,
    ...wishes,
    message: optText(5000),
    notes: optText(5000),
    status: z.enum(INTEREST_STATUSES),
  })
  .partial();

export const publicRegistrationSchema = z
  .object({
    ...contactFields,
    ...wishes,
    message: optText(3000),
    consent: z.literal(true, { errorMap: () => ({ message: 'Du behöver godkänna att uppgifterna sparas' }) }),
    /** Fält som bara robotar fyller i. */
    website: z.string().max(500).optional(),
  })
  .refine(needContact, contactIssue);

export const settingsSchema = z.object({
  formEnabled: z.boolean(),
  introText: optText(3000),
  consentText: z.string().trim().min(20, 'Skriv en samtyckestext').max(3000),
  retentionMonths: z.number().int().min(1).max(120),
});

export const offerSchema = z.object({ objectId: z.string().uuid(), note: optText(1000) });
export const offerUpdateSchema = z.object({ status: z.enum(['offered', 'accepted', 'declined']), note: optText(1000) });

export const convertSchema = z.object({
  objectId: z.string().uuid('Välj ett objekt'),
  startDate: isoDate,
  /** Personnummer eller organisationsnummer, valfritt. */
  nationalId: z.string().trim().max(20).nullable().optional(),
  /** Befintlig hyresgäst i stället för en ny. */
  customerId: z.string().uuid().nullable().optional(),
});

export type RegistrationInput = z.output<typeof registrationSchema>;

/** Kolumnnamn för fälten i schemat. */
const COLUMNS: Record<string, string> = {
  kind: 'kind',
  name: 'name',
  contactPerson: 'contact_person',
  email: 'email',
  phone: 'phone',
  addressLine: 'address_line',
  postalCode: 'postal_code',
  city: 'city',
  objectTypes: 'object_types',
  propertyIds: 'property_ids',
  minRooms: 'min_rooms',
  minAreaM2: 'min_area_m2',
  maxRent: 'max_rent_ore',
  desiredFrom: 'desired_from',
  householdSize: 'household_size',
  message: 'message',
  notes: 'notes',
  status: 'status',
};

/** Personuppgifter som maskas i revisionsloggen när en anmälan tas bort. */
export const PERSONAL_KEYS = ['name', 'contact_person', 'email', 'phone', 'address_line', 'postal_code', 'city', 'message', 'notes', 'consent_text'];

function columnValue(key: string, v: unknown): unknown {
  if (key === 'maxRent') return v == null ? null : Math.round(Number(v) * 100);
  return v ?? null;
}

export function toColumns(data: Record<string, unknown>): { cols: string[]; vals: unknown[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    const col = COLUMNS[k];
    if (!col || v === undefined) continue;
    cols.push(col);
    vals.push(columnValue(k, v));
  }
  return { cols, vals };
}

export async function insertRegistration(
  client: PoolClient,
  companyId: string,
  data: Record<string, unknown>,
  extra: { source: 'form' | 'manual'; consentText?: string | null },
): Promise<{ id: string; registrationNr: number }> {
  await client.query(`select pg_advisory_xact_lock(hashtext('interest_nr:' || $1))`, [companyId]);
  const nr = (
    await client.query('select coalesce(max(registration_nr), 0) + 1 as nr from interest_registration where company_id = $1', [companyId])
  ).rows[0].nr as number;
  const { cols, vals } = toColumns(data);
  cols.push('company_id', 'registration_nr', 'source');
  vals.push(companyId, nr, extra.source);
  if (extra.source === 'form') {
    cols.push('consent_text', 'consent_at');
    vals.push(extra.consentText ?? null, new Date());
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(`insert into interest_registration (${cols.join(', ')}) values (${ph}) returning id`, vals);
  return { id: rows[0].id, registrationNr: nr };
}

export const REGISTRATION_SELECT = `
  r.id, r.company_id as "companyId", co.name as "companyName", r.registration_nr as "registrationNr", r.kind, r.name,
  r.contact_person as "contactPerson", r.email, r.phone, r.address_line as "addressLine", r.postal_code as "postalCode",
  r.city, r.object_types as "objectTypes", r.property_ids as "propertyIds", r.min_rooms::float as "minRooms",
  r.min_area_m2::float as "minAreaM2", r.max_rent_ore::float as "maxRentOre", r.desired_from::text as "desiredFrom",
  r.household_size as "householdSize", r.message, r.notes, r.source, r.status, r.consent_at as "consentAt",
  r.consent_text as "consentText", r.customer_id as "customerId", r.contract_id as "contractId",
  r.last_activity_at as "lastActivityAt", r.created_at as "createdAt"`;

/** Kontraktstyp utifrån objekttyp. */
export function contractTypeFor(objectType: string): 'residential' | 'commercial' | 'parking' | 'storage' | 'other' {
  if (objectType === 'apartment' || objectType === 'hotel_apartment') return 'residential';
  if (objectType === 'parking') return 'parking';
  if (objectType === 'storage') return 'storage';
  if (objectType === 'commercial' || objectType === 'office' || objectType === 'restaurant') return 'commercial';
  return 'other';
}

/** Tar bort anmälningar och maskar personuppgifterna i revisionsloggen. */
export async function deleteRegistrations(client: PoolClient, companyId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const offerIds = (await client.query('select id from interest_offer where registration_id = any ($1::uuid[])', [ids])).rows.map(
    (r) => r.id as string,
  );
  const n = (await client.query('delete from interest_registration where id = any ($1::uuid[]) and company_id = $2', [ids, companyId]))
    .rowCount ?? 0;
  await client.query('select app.gdpr_scrub_audit($1, $2, $3, $4)', [companyId, 'interest_registration', ids, PERSONAL_KEYS]);
  if (offerIds.length) await client.query('select app.gdpr_scrub_audit($1, $2, $3, $4)', [companyId, 'interest_offer', offerIds, ['note']]);
  return n;
}
