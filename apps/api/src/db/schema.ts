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
