import { z } from 'zod';
import { isoDate, kronor } from '../common/money';
import { text } from '../common/validation';

export const PROPERTY_CATEGORIES = ['residential', 'commercial', 'mixed', 'parking', 'hotel', 'industrial', 'land', 'other'] as const;
export const OBJECT_TYPES = [
  'apartment',
  'commercial',
  'office',
  'restaurant',
  'parking',
  'storage',
  'hotel_room',
  'hotel_apartment',
  'other',
] as const;
/** Objekttyper som är bostäder och därför alltid momsfria. */
export const RESIDENTIAL_TYPES = new Set(['apartment', 'hotel_apartment']);

const area = z.number().min(0).max(10_000_000).nullable().optional();
const year = z.number().int().min(1000).max(2200).nullable().optional();
const optDate = isoDate.nullable().optional();
const optKronor = kronor.nullable().optional();
const optSek = z.number().int().min(0).max(1e13).nullable().optional();

export const propertySchema = z.object({
  name: z.string().trim().min(1, 'Ange fastighetens namn').max(200),
  designation: z.string().trim().min(3, 'Ange fastighetsbeteckning, t.ex. Lund Hästen 12').max(200),
  municipality: text.optional,
  addressLine: text.optional,
  postalCode: text.optional,
  city: text.optional,
  category: z.enum(PROPERTY_CATEGORIES),
  constructionYear: year,
  areaBoaM2: area,
  areaLoaM2: area,
  areaBtaM2: area,
  siteAreaM2: area,
  costCenterId: z.string().uuid().nullable().optional(),
  acquiredDate: optDate,
  acquisitionPriceSek: optSek,
  soldDate: optDate,
  notes: z.string().max(5000).nullable().optional(),
});

export const objectSchema = z.object({
  propertyId: z.string().uuid(),
  buildingId: z.string().uuid().nullable().optional(),
  objectNr: z.string().trim().min(1, 'Ange objektsnummer').max(50),
  type: z.enum(OBJECT_TYPES),
  areaM2: area,
  rooms: z.number().min(0).max(100).nullable().optional(),
  floor: z.number().int().min(-10).max(200).nullable().optional(),
  apartmentNr: text.optional,
  addressLine: text.optional,
  description: z.string().max(2000).nullable().optional(),
});

export const newObjectSchema = objectSchema.extend({
  monthlyRent: kronor.optional(),
  rentValidFrom: isoDate.optional(),
  vatLiable: z.boolean().optional(),
});

export const priceSchema = z.object({
  monthlyRent: kronor,
  validFrom: isoDate,
  reason: text.optional,
});

export const vatSchema = z.object({
  vatLiable: z.boolean(),
  validFrom: isoDate,
  note: text.optional,
});

/** Underregister till en fastighet: schema per typ. Belopp i kronor omvandlas till öre. */
export const childSchemas = {
  buildings: z.object({
    name: z.string().trim().min(1).max(200),
    addressLine: text.optional,
    constructionYear: year,
    energyClass: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']).nullable().optional(),
    floors: z.number().int().min(0).max(200).nullable().optional(),
  }),
  'tax-assessments': z.object({
    assessmentYear: z.number().int().min(1990).max(2200),
    typeCode: text.optional,
    landValueSek: optSek,
    buildingValueSek: optSek,
    propertyTaxOre: optKronor,
  }),
  insurances: z.object({
    insurer: z.string().trim().min(1).max(200),
    policyNr: text.optional,
    sumInsuredSek: optSek,
    premiumOre: optKronor,
    validFrom: isoDate,
    validTo: optDate,
  }),
  valuations: z.object({
    valuationDate: isoDate,
    valueSek: z.number().int().min(0).max(1e13),
    valuer: text.optional,
    method: text.optional,
  }),
  loans: z.object({
    lender: z.string().trim().min(1).max(200),
    loanNr: text.optional,
    principalOre: kronor,
    interestBp: z.number().int().min(0).max(10000).nullable().optional(),
    fixedUntil: optDate,
    amortizationOrePerYear: optKronor,
  }),
  maintenance: z.object({
    component: z.string().trim().min(1).max(200),
    plannedYear: z.number().int().min(1990).max(2200),
    estimatedCostOre: optKronor,
    status: z.enum(['planned', 'ordered', 'done', 'postponed']).optional(),
    notes: z.string().max(2000).nullable().optional(),
  }),
} as const;

export type ChildKind = keyof typeof childSchemas;

export const technicalSchema = z.object({
  heating: text.optional,
  ventilation: text.optional,
  elevators: z.number().int().min(0).max(100).nullable().optional(),
  ovkDate: optDate,
  energyDeclarationDate: optDate,
  energyUseKwhM2: z.number().min(0).max(10000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
