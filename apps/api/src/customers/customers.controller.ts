import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { luhnValid, normalizeOrgNr, parse, text } from '../common/validation';
import { withContext } from '../db/db';
import { customer, customerContact } from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';

/** Personnummer till ÅÅÅÅMMDD-NNNN. Tio siffror tolkas som under 100 år om inte "+" används. */
export function normalizePersonalId(input: string): string | null {
  const plus = input.includes('+');
  const digits = input.replace(/\D/g, '');
  let full: string;
  if (digits.length === 12) full = digits;
  else if (digits.length === 10) {
    const yy = Number(digits.slice(0, 2));
    const now = new Date().getFullYear();
    let century = Math.floor(now / 100) * 100;
    if (century + yy > now) century -= 100;
    if (plus) century -= 100;
    full = String(century + yy) + digits.slice(2);
  } else return null;
  if (!luhnValid(full.slice(2))) return null;
  const month = Number(full.slice(4, 6));
  const day = Number(full.slice(6, 8)) % 60; // samordningsnummer har dag + 60
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${full.slice(0, 8)}-${full.slice(8)}`;
}

const customerSchema = z
  .object({
    kind: z.enum(['person', 'organization']),
    name: z.string().trim().min(1, 'Ange namn').max(200),
    nationalId: z.string().trim().max(20).nullable().optional(),
    vatNr: text.optional,
    email: z.string().trim().email('Ogiltig e-postadress').nullable().optional().or(z.literal('').transform(() => null)),
    phone: text.optional,
    addressLine: text.optional,
    careOf: text.optional,
    postalCode: text.optional,
    city: text.optional,
    invoiceAddressLine: text.optional,
    invoiceCareOf: text.optional,
    invoicePostalCode: text.optional,
    invoiceCity: text.optional,
    invoiceReference: text.optional,
    deliveryMethod: z.enum(['email', 'post', 'e_invoice']).optional(),
    peppolId: text.optional,
    paymentTermsDays: z.number().int().min(0).max(120).optional(),
    notes: z.string().max(5000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.nationalId) {
      const n = v.kind === 'person' ? normalizePersonalId(v.nationalId) : normalizeOrgNr(v.nationalId);
      if (!n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nationalId'],
          message: v.kind === 'person' ? 'Ogiltigt personnummer' : 'Ogiltigt organisationsnummer',
        });
      } else v.nationalId = n;
    }
    if ((v.deliveryMethod ?? 'email') === 'email' && !v.email) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'E-post krävs när fakturor skickas med e-post' });
    }
    if (v.deliveryMethod === 'e_invoice' && !v.peppolId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peppolId'], message: 'Peppol-id krävs för e-faktura' });
    }
  });

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: text.optional,
  email: z.string().trim().email('Ogiltig e-postadress').nullable().optional(),
  phone: text.optional,
});

const LIST_SQL = `
  select c.id, c.company_id as "companyId", co.name as "companyName", c.customer_nr as "customerNr", c.kind, c.name,
         c.national_id as "nationalId", c.email, c.phone, c.city, c.active,
         count(k.id) filter (where k.status in ('active','terminated') and (k.end_date is null or k.end_date >= current_date))::int as "activeContracts",
         coalesce(sum(l.amount_ore) filter (where k.status in ('active','terminated')), 0)::bigint::float as "monthlyOre"
  from customer c
  join company co on co.id = c.company_id
  left join contract k on k.customer_id = c.id
  left join contract_line l on l.contract_id = k.id and l.valid_from <= current_date and (l.valid_to is null or l.valid_to >= current_date)
  where ($1::text is null or c.name ilike '%' || $1 || '%' or c.national_id like '%' || $1 || '%' or c.customer_nr::text = $1
         or c.email ilike '%' || $1 || '%')
  group by c.id, co.name
  order by c.name`;

@Controller('customers')
export class CustomersController {
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('q') q?: string) {
    return withContext(dbContext(ctx), async (_db, client) => (await client.query(LIST_SQL, [q?.trim() || null])).rows);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'customer.write');
    const data = parse(customerSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      // Kundnummer löpande per bolag; låset hindrar två samtidiga att få samma nummer
      await client.query(`select pg_advisory_xact_lock(hashtext('customer_nr:' || $1))`, [companyId]);
      const { rows } = await client.query(
        'select coalesce(max(customer_nr), 1000) + 1 as nr from customer where company_id = $1',
        [companyId],
      );
      const [row] = await db
        .insert(customer)
        .values({ ...data, companyId, customerNr: rows[0].nr })
        .returning();
      return row;
    });
  }

  /** Samlad kundvy: uppgifter, kontakter och avtal (fakturor och betalningar tillkommer i fas 4–5). */
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (db, client) => {
      const [c] = await db.select().from(customer).where(eq(customer.id, id));
      if (!c) throw new NotFoundException('Kunden finns inte');
      const contacts = await db
        .select()
        .from(customerContact)
        .where(eq(customerContact.customerId, id))
        .orderBy(asc(customerContact.name));
      const contracts = (
        await client.query(
          `select k.id, k.contract_nr as "contractNr", k.type, k.status, k.start_date::text as "startDate", k.end_date::text as "endDate",
                  coalesce((select sum(amount_ore) from contract_line l where l.contract_id = k.id
                     and l.valid_from <= greatest(current_date, k.start_date) and (l.valid_to is null or l.valid_to >= greatest(current_date, k.start_date))), 0)::bigint::float as "monthlyOre",
                  coalesce((select string_agg(o.object_nr || ' ' || p.name, ', ' order by o.object_nr)
                     from contract_object co join rental_object o on o.id = co.object_id join property p on p.id = o.property_id
                     where co.contract_id = k.id), '') as objects
           from contract k where k.customer_id = $1 order by k.start_date desc`,
          [id],
        )
      ).rows;
      const companyName = (await client.query('select name from company where id = $1', [c.companyId])).rows[0]?.name;
      return { ...c, companyName, contacts, contracts };
    });
  }

  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'customer.write');
    const data = parse(customerSchema, body);
    const [row] = await withContext(dbContext(ctx), (db) =>
      db.update(customer).set(data).where(eq(customer.id, id)).returning(),
    );
    if (!row) throw new NotFoundException('Kunden finns inte i valt bolag');
    return row;
  }

  @Post(':id/contacts')
  addContact(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'customer.write');
    const data = parse(contactSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await db.insert(customerContact).values({ ...data, customerId: id, companyId }).returning();
      return row;
    });
  }

  @Patch(':id/contacts/:contactId')
  async updateContact(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, 'customer.write');
    const data = parse(contactSchema.partial(), body);
    const [row] = await withContext(dbContext(ctx), (db) =>
      db
        .update(customerContact)
        .set(data)
        .where(and(eq(customerContact.id, contactId), eq(customerContact.customerId, id)))
        .returning(),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(204)
  async deleteContact(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    requireCompany(ctx, 'customer.write');
    await withContext(dbContext(ctx), (db) =>
      db.delete(customerContact).where(and(eq(customerContact.id, contactId), eq(customerContact.customerId, id))),
    );
  }
}
