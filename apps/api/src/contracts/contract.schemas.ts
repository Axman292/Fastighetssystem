import { z } from 'zod';
import { isoDate, kronorToOre } from '../common/money';

export const CONTRACT_TYPES = ['residential', 'commercial', 'parking', 'storage', 'other'] as const;
export const ARTICLES = [
  'rent',
  'heating',
  'electricity',
  'water',
  'parking',
  'storage',
  'service',
  'index',
  'discount',
  'other',
] as const;
export const VAT_RATES = [0, 600, 1200, 2500] as const;

const nullableText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const optDate = isoDate.nullable().optional();

/** Belopp i kronor som får vara negativt (rabatt). Ger öre. */
export const signedKronor = z
  .number({ invalid_type_error: 'Ange ett belopp' })
  .finite()
  .min(-1e10)
  .max(1e10)
  .transform(kronorToOre);

export const lineSchema = z.object({
  objectId: z.string().uuid().nullable().optional(),
  article: z.enum(ARTICLES),
  description: z.string().trim().min(1, 'Ange en beskrivning').max(200),
  amount: signedKronor,
  vatRateBp: z.coerce
    .number()
    .int()
    .refine((v) => (VAT_RATES as readonly number[]).includes(v), 'Ogiltig momssats')
    .default(0),
  indexed: z.boolean().default(false),
  validFrom: isoDate.nullable().optional(),
  validTo: optDate,
  reason: nullableText(500),
});

export const indexClauseSchema = z.object({
  baseYear: z.number().int().min(1980).max(2200),
  baseMonth: z.number().int().min(1).max(12).default(10),
  /** Utelämnas för att hämta värdet ur KPI-tabellen. */
  baseValue: z.number().positive().max(100000).optional(),
  sharePct: z.number().min(0).max(100).default(100),
  floorAtBase: z.boolean().default(true),
  adjustMonth: z.number().int().min(1).max(12).default(1),
});

const contractFields = {
  type: z.enum(CONTRACT_TYPES),
  customerId: z.string().uuid('Välj en hyresgäst'),
  startDate: isoDate,
  endDate: optDate,
  noticeMonths: z.number().int().min(0).max(60).default(3),
  extensionMonths: z.number().int().min(0).max(120).nullable().optional(),
  billingInterval: z.enum(['month', 'quarter']).default('month'),
  billingInAdvance: z.boolean().default(true),
  paymentTermsDays: z.number().int().min(0).max(120).nullable().optional(),
  renegotiateBy: optDate,
  signedDate: optDate,
  specialTerms: nullableText(10000),
  notes: nullableText(5000),
};

export const createContractSchema = z
  .object({
    ...contractFields,
    objectIds: z.array(z.string().uuid()).max(50).default([]),
    /** Utelämnas för att fylla i hyresrader från objektens aktuella hyra. */
    lines: z.array(lineSchema).max(100).optional(),
    indexClause: indexClauseSchema.nullable().optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { path: ['endDate'], message: 'Slutdatum är före startdatum' });

export const updateContractSchema = z.object(contractFields).partial();

export const terminateSchema = z.object({
  terminationReceived: isoDate,
  terminatedBy: z.enum(['tenant', 'landlord', 'mutual']),
  /** Utelämnas för att räkna fram slutdatum ur uppsägningstiden. */
  endDate: isoDate.optional(),
  reason: nullableText(2000),
});

export const changeLineSchema = z.object({
  amount: signedKronor,
  validFrom: isoDate,
  reason: nullableText(500),
  /** För indexerade rader: om den nya hyran också blir ny bashyra (standard ja). */
  newBase: z.boolean().default(true),
});

export const depositSchema = z.object({
  kind: z.enum(['deposit', 'bank_guarantee', 'surety', 'other']),
  amount: z.number().finite().min(0).max(1e10).transform(kronorToOre),
  dueDate: optDate,
  receivedDate: optDate,
  returnedDate: optDate,
  note: nullableText(1000),
});

export const eventSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  eventDate: isoDate.optional(),
});

export const kpiSchema = z.object({ value: z.number().positive().max(100000) });

export const indexRunSchema = z.object({
  year: z.number().int().min(1990).max(2200),
  contractIds: z.array(z.string().uuid()).optional(),
});
