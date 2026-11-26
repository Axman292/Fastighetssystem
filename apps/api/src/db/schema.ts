import {
  boolean,
  date,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  bigint,
  jsonb,
  primaryKey,
  numeric,
  integer,
  pgView,
} from 'drizzle-orm/pg-core';

const audit = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
};

export const companyGroup = pgTable('company_group', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const company = pgTable('company', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull(),
  name: text('name').notNull(),
  orgNr: text('org_nr').notNull(),
  vatNr: text('vat_nr'),
  addressLine: text('address_line'),
  postalCode: text('postal_code'),
  city: text('city'),
  bankgiro: text('bankgiro'),
  plusgiro: text('plusgiro'),
  fiscalYearStart: smallint('fiscal_year_start').notNull().default(1),
  hogiaClientId: text('hogia_client_id'),
  active: boolean('active').notNull().default(true),
  ...audit,
});

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  personalIdHash: text('personal_id_hash'),
  isGroupAdmin: boolean('is_group_admin').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const role = pgTable('role', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
});

export const rolePermission = pgTable(
  'role_permission',
  { roleId: uuid('role_id').notNull(), permission: text('permission').notNull() },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const membership = pgTable('membership', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  validUntil: date('valid_until'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const userSession = pgTable('user_session', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const bankAccount = pgTable('bank_account', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  purpose: text('purpose').notNull(),
  bankName: text('bank_name'),
  clearingNr: text('clearing_nr'),
  accountNr: text('account_nr'),
  iban: text('iban'),
  bic: text('bic'),
  ...audit,
});

export const costCenter = pgTable('cost_center', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  ...audit,
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  userId: uuid('user_id'),
  companyId: uuid('company_id'),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  action: text('action').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  requestId: text('request_id'),
});

// ---------------------------------------------------------------------
// Fas 2: fastigheter och hyresobjekt
// ---------------------------------------------------------------------

const num = (name: string) => numeric(name, { mode: 'number' });
const sek = (name: string) => bigint(name, { mode: 'number' });

export const property = pgTable('property', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  designation: text('designation').notNull(),
  municipality: text('municipality'),
  addressLine: text('address_line'),
  postalCode: text('postal_code'),
  city: text('city'),
  category: text('category').notNull(),
  constructionYear: smallint('construction_year'),
  areaBoaM2: num('area_boa_m2'),
  areaLoaM2: num('area_loa_m2'),
  areaBtaM2: num('area_bta_m2'),
  siteAreaM2: num('site_area_m2'),
  costCenterId: uuid('cost_center_id'),
  acquiredDate: date('acquired_date'),
  acquisitionPriceSek: sek('acquisition_price_sek'),
  soldDate: date('sold_date'),
  notes: text('notes'),
  ...audit,
});

const child = {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  propertyId: uuid('property_id').notNull(),
};

export const building = pgTable('building', {
  ...child,
  name: text('name').notNull(),
  addressLine: text('address_line'),
  constructionYear: smallint('construction_year'),
  energyClass: text('energy_class'),
  floors: smallint('floors'),
  ...audit,
});

export const propertyTaxAssessment = pgTable('property_tax_assessment', {
  ...child,
  assessmentYear: smallint('assessment_year').notNull(),
  typeCode: text('type_code'),
  landValueSek: sek('land_value_sek'),
  buildingValueSek: sek('building_value_sek'),
  propertyTaxOre: sek('property_tax_ore'),
  ...audit,
});

export const propertyInsurance = pgTable('property_insurance', {
  ...child,
  insurer: text('insurer').notNull(),
  policyNr: text('policy_nr'),
  sumInsuredSek: sek('sum_insured_sek'),
  premiumOre: sek('premium_ore'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  ...audit,
});

export const propertyValuation = pgTable('property_valuation', {
  ...child,
  valuationDate: date('valuation_date').notNull(),
  valueSek: sek('value_sek').notNull(),
  valuer: text('valuer'),
  method: text('method'),
  ...audit,
});

export const propertyLoan = pgTable('property_loan', {
  ...child,
  lender: text('lender').notNull(),
  loanNr: text('loan_nr'),
  principalOre: sek('principal_ore').notNull(),
  interestBp: integer('interest_bp'),
  fixedUntil: date('fixed_until'),
  amortizationOrePerYear: sek('amortization_ore_per_year'),
  ...audit,
});

export const propertyTechnical = pgTable('property_technical', {
  ...child,
  heating: text('heating'),
  ventilation: text('ventilation'),
  elevators: smallint('elevators'),
  ovkDate: date('ovk_date'),
  energyDeclarationDate: date('energy_declaration_date'),
  energyUseKwhM2: num('energy_use_kwh_m2'),
  notes: text('notes'),
  ...audit,
});

export const maintenancePlanItem = pgTable('maintenance_plan_item', {
  ...child,
  component: text('component').notNull(),
  plannedYear: smallint('planned_year').notNull(),
  estimatedCostOre: sek('estimated_cost_ore'),
  status: text('status').notNull().default('planned'),
  notes: text('notes'),
  ...audit,
});

export const rentalObject = pgTable('rental_object', {
  ...child,
  buildingId: uuid('building_id'),
  objectNr: text('object_nr').notNull(),
  type: text('type').notNull(),
  areaM2: num('area_m2'),
  rooms: num('rooms'),
  floor: smallint('floor'),
  apartmentNr: text('apartment_nr'),
  addressLine: text('address_line'),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  ...audit,
});

export const rentalObjectPrice = pgTable('rental_object_price', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  objectId: uuid('object_id').notNull(),
  monthlyRentOre: sek('monthly_rent_ore').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const rentalObjectVat = pgTable('rental_object_vat', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  objectId: uuid('object_id').notNull(),
  vatLiable: boolean('vat_liable').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const rentalObjectCurrent = pgView('rental_object_current', {
  objectId: uuid('object_id').notNull(),
  companyId: uuid('company_id').notNull(),
  monthlyRentOre: sek('monthly_rent_ore'),
  vatLiable: boolean('vat_liable'),
}).existing();
