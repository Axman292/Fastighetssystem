import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { luhnValid, normalizeOrgNr, parse, text } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { defaultReportGroup, REPORT_GROUP_LABEL, REPORT_GROUPS, reportGroupOf } from '../economy/report-groups';

/** Bankgiro NNN-NNNN eller NNNN-NNNN med kontrollsiffra. */
export function normalizeBankgiro(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length < 7 || d.length > 8 || !luhnValid(d)) return null;
  return `${d.slice(0, d.length - 4)}-${d.slice(-4)}`;
}

/** Plusgiro: 2–8 siffror med kontrollsiffra, skrivs med bindestreck före sista siffran. */
export function normalizePlusgiro(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length < 2 || d.length > 8 || !luhnValid(d)) return null;
  return `${d.slice(0, -1)}-${d.slice(-1)}`;
}

const giro = (fn: (s: string) => string | null, message: string) =>
  z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const n = fn(v);
      if (!n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER;
      }
      return n;
    });

const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Ange namn').max(200),
  orgNr: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const n = normalizeOrgNr(v);
      if (!n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ogiltigt organisationsnummer' });
        return z.NEVER;
      }
      return n;
    }),
  vatNr: text.optional,
  bankgiro: giro(normalizeBankgiro, 'Ogiltigt bankgironummer'),
  plusgiro: giro(normalizePlusgiro, 'Ogiltigt plusgironummer'),
  iban: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ? v.replace(/\s/g, '').toUpperCase() : null))
    .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'Ogiltigt IBAN').nullable()),
  email: z.string().trim().email('Ogiltig e-postadress').nullable().optional().or(z.literal('').transform(() => null)),
  phone: text.optional,
  addressLine: text.optional,
  postalCode: text.optional,
  city: text.optional,
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultAccount: z
    .string()
    .regex(/^\d{4}$/, 'Ange ett fyrsiffrigt konto')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  notes: z.string().max(5000).nullable().optional(),
  active: z.boolean().optional(),
});

const SUPPLIER_COLUMNS: Record<string, string> = {
  name: 'name',
  orgNr: 'org_nr',
  vatNr: 'vat_nr',
  bankgiro: 'bankgiro',
  plusgiro: 'plusgiro',
  iban: 'iban',
  email: 'email',
  phone: 'phone',
  addressLine: 'address_line',
  postalCode: 'postal_code',
  city: 'city',
  paymentTermsDays: 'payment_terms_days',
  defaultAccount: 'default_account',
  notes: 'notes',
  active: 'active',
};

export const SUPPLIER_SELECT = `
  s.id, s.company_id as "companyId", co.name as "companyName", s.supplier_nr as "supplierNr", s.name, s.org_nr as "orgNr",
  s.vat_nr as "vatNr", s.bankgiro, s.plusgiro, s.iban, s.email, s.phone, s.address_line as "addressLine",
  s.postal_code as "postalCode", s.city, s.payment_terms_days as "paymentTermsDays", s.default_account as "defaultAccount",
  s.notes, s.active`;

async function checkAccount(client: PoolClient, companyId: string, number: string | null | undefined) {
  if (!number) return;
  const { rows } = await client.query('select 1 from account where company_id = $1 and number = $2', [companyId, number]);
  if (!rows[0]) throw new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path: 'defaultAccount', message: `Konto ${number} finns inte i kontoplanen` }] });
}

/** Leverantörsregister per bolag. */
@Controller('suppliers')
export class SuppliersController {
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('q') q?: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const params: unknown[] = [];
      let where = '';
      if (q?.trim()) {
        params.push(`%${q.trim()}%`);
        where = `where s.name ilike $1 or s.org_nr ilike $1 or s.supplier_nr::text = trim($1, '%') or s.bankgiro ilike $1`;
      }
      return (
        await client.query(
          `select ${SUPPLIER_SELECT},
             (select count(*)::int from supplier_invoice i where i.supplier_id = s.id and i.status <> 'cancelled') as "invoiceCount",
             (select coalesce(sum(b.balance_ore), 0)::float from supplier_invoice i join supplier_invoice_balance b on b.supplier_invoice_id = i.id
               where i.supplier_id = s.id and i.status in ('registered','approved')) as "unpaidOre",
             (select max(i.invoice_date)::text from supplier_invoice i where i.supplier_id = s.id and i.status <> 'cancelled') as "lastInvoiceDate"
           from supplier s join company co on co.id = s.company_id ${where}
           order by s.name`,
          params,
        )
      ).rows;
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier.write');
    const data = parse(supplierSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await checkAccount(client, companyId, data.defaultAccount);
      await client.query(`select pg_advisory_xact_lock(hashtext('supplier.supplier_nr:' || $1))`, [companyId]);
      const nr = Number((await client.query('select coalesce(max(supplier_nr), 100) + 1 as nr from supplier where company_id = $1', [companyId])).rows[0].nr);
      const keys = Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined);
      const cols = keys.map((k) => SUPPLIER_COLUMNS[k]);
      const { rows } = await client.query(
        `insert into supplier (company_id, supplier_nr, ${cols.join(', ')})
         values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) returning id`,
        [companyId, nr, ...keys.map((k) => data[k as keyof typeof data])],
      );
      return { id: rows[0].id, supplierNr: nr };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const s = (await client.query(`select ${SUPPLIER_SELECT} from supplier s join company co on co.id = s.company_id where s.id = $1`, [id])).rows[0];
      if (!s) throw new NotFoundException('Leverantören finns inte');
      const stats = (
        await client.query(
          `select count(*) filter (where i.status <> 'cancelled')::int as "invoiceCount",
                  coalesce(sum(b.balance_ore) filter (where i.status in ('registered','approved')), 0)::float as "unpaidOre",
                  coalesce(sum(b.balance_ore) filter (where i.status in ('registered','approved') and i.due_date < current_date), 0)::float as "overdueOre",
                  coalesce(sum(i.total_ore) filter (where i.status <> 'cancelled' and i.invoice_date >= date_trunc('year', current_date)), 0)::float as "thisYearOre",
                  coalesce(sum(i.total_ore) filter (where i.status <> 'cancelled' and i.invoice_date >= date_trunc('year', current_date) - interval '1 year'
                                                     and i.invoice_date < date_trunc('year', current_date)), 0)::float as "lastYearOre"
           from supplier_invoice i join supplier_invoice_balance b on b.supplier_invoice_id = i.id where i.supplier_id = $1`,
          [id],
        )
      ).rows[0];
      return { ...s, ...stats };
    });
  }

  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier.write');
    const data = parse(supplierSchema.partial(), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await checkAccount(client, companyId, data.defaultAccount);
      const keys = Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined);
      if (!keys.length) return { id };
      const { rows } = await client.query(
        `update supplier set ${keys.map((k, i) => `${SUPPLIER_COLUMNS[k]} = $${i + 2}`).join(', ')} where id = $1 returning id`,
        [id, ...keys.map((k) => data[k as keyof typeof data])],
      );
      if (!rows[0]) throw new NotFoundException('Leverantören finns inte i valt bolag');
      return rows[0];
    });
  }

  /**
   * Förslag på kontering för en ny faktura: raderna på leverantörens senaste faktura,
   * med beloppens andel så att en ny summa kan fördelas på samma sätt.
   */
  @Get(':id/suggestion')
  suggestion(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const s = (await client.query('select default_account, payment_terms_days from supplier where id = $1', [id])).rows[0];
      if (!s) throw new NotFoundException('Leverantören finns inte i valt bolag');
      const last = (
        await client.query(
          `select id, invoice_date::text as "invoiceDate", net_ore::float as "netOre" from supplier_invoice
           where supplier_id = $1 and status <> 'cancelled' and kind = 'invoice'
             and exists (select 1 from supplier_invoice_line l where l.supplier_invoice_id = supplier_invoice.id)
           order by invoice_date desc, entry_nr desc limit 1`,
          [id],
        )
      ).rows[0];
      const lines = last
        ? (
            await client.query(
              `select account_number as "accountNumber", description, property_id as "propertyId", object_id as "objectId",
                      cost_center_id as "costCenterId", vat_deductible as "vatDeductible", net_ore::float as "netOre"
               from supplier_invoice_line where supplier_invoice_id = $1 order by position`,
              [last.id],
            )
          ).rows.map((l) => ({ ...l, share: last.netOre ? l.netOre / last.netOre : 0 }))
        : [];
      return { paymentTermsDays: s.payment_terms_days, defaultAccount: s.default_account, fromInvoiceDate: last?.invoiceDate ?? null, lines };
    });
  }
}

const accountSchema = z.object({
  number: z.string().regex(/^\d{4}$/, 'Ange ett fyrsiffrigt BAS-konto'),
  name: z.string().trim().min(1, 'Ange namn').max(200),
  reportGroup: z.enum(REPORT_GROUPS).nullable().optional(),
  active: z.boolean().optional(),
});

function accountType(number: string): string {
  const c = number[0];
  if (c === '1') return 'asset';
  if (c === '2') return Number(number) < 2100 ? 'equity' : 'liability';
  if (c === '3') return 'revenue';
  return 'expense';
}

/** Kontoplan per bolag (BAS). */
@Controller('accounts')
export class AccountsController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select a.id, a.company_id as "companyId", co.name as "companyName", a.number, a.name, a.type, a.active, a.source,
                  a.report_group as "reportGroupOverride",
                  (select count(*)::int from supplier_invoice_line l where l.company_id = a.company_id and l.account_number = a.number) as "lineCount"
           from account a join company co on co.id = a.company_id order by co.name, a.number`,
        )
      ).rows.map((r) => {
        const g = reportGroupOf(r.number, r.reportGroupOverride);
        return { ...r, reportGroup: g, reportGroupLabel: REPORT_GROUP_LABEL[g], defaultReportGroup: defaultReportGroup(r.number) };
      }),
    );
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'account.write');
    const data = parse(accountSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `insert into account (company_id, number, name, type, report_group, active, source) values ($1,$2,$3,$4,$5,$6,'local') returning id`,
        [companyId, data.number, data.name, accountType(data.number), data.reportGroup ?? null, data.active ?? true],
      );
      return rows[0];
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'account.write');
    const data = parse(accountSchema.omit({ number: true }).partial(), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `update account set name = coalesce($2, name), active = coalesce($3, active),
                report_group = case when $4::boolean then $5 else report_group end
         where id = $1 returning id`,
        [id, data.name ?? null, data.active ?? null, data.reportGroup !== undefined, data.reportGroup ?? null],
      );
      if (!rows[0]) throw new NotFoundException('Kontot finns inte i valt bolag');
      return rows[0];
    });
  }
}
