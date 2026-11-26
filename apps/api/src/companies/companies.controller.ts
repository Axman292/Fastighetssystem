import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { orgNrSchema, parse, text } from '../common/validation';
import { setCompanyIds, withContext } from '../db/db';
import { company } from '../db/schema';
import {
  Ctx,
  dbContext,
  readableCompanyIds,
  RequestContext,
  requireGroupAdmin,
  requirePermission,
} from '../auth/request-context';

const companyFields = {
  name: z.string().trim().min(2, 'Ange bolagets namn').max(200),
  orgNr: orgNrSchema,
  vatNr: text.optional,
  addressLine: text.optional,
  postalCode: text.optional,
  city: text.optional,
  bankgiro: text.optional,
  plusgiro: text.optional,
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  hogiaClientId: text.optional,
  invoiceEmail: z.string().trim().email('Ogiltig e-postadress').nullable().optional().or(z.literal('').transform(() => null)),
  fTax: z.boolean().optional(),
  invoiceFooter: z.string().trim().max(500).nullable().optional(),
  roundToKrona: z.boolean().optional(),
};
const createSchema = z.object(companyFields);
const updateSchema = z.object(companyFields).partial().extend({ active: z.boolean().optional() });

@Controller('companies')
export class CompaniesController {
  /** Bolag som användaren ser: valt bolag, eller alla i koncernvyn. */
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (db) => db.select().from(company).orderBy(asc(company.name)));
  }

  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    // Ett enskilt bolag får läsas om användaren har tillgång till det, oavsett valt bolag.
    const ids = ctx.access.map((a) => a.companyId);
    const [row] = await withContext(dbContext(ctx, ids), (db) => db.select().from(company).where(eq(company.id, id)));
    if (!row) throw new NotFoundException('Bolaget finns inte');
    return row;
  }

  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireGroupAdmin(ctx);
    const data = parse(createSchema, body);
    const id = randomUUID();
    return withContext(dbContext(ctx), async (db, client) => {
      // Det nya bolaget släpps in i kontexten så att det kan läsas tillbaka.
      await setCompanyIds(client, [...readableCompanyIds(ctx), id]);
      const [row] = await db
        .insert(company)
        .values({ ...data, id, groupId: ctx.groupId })
        .returning();
      return row;
    });
  }

  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requirePermission(ctx, id, 'company.write');
    const data = parse(updateSchema, body);
    const [row] = await withContext(dbContext(ctx, [id]), (db) =>
      db.update(company).set(data).where(eq(company.id, id)).returning(),
    );
    if (!row) throw new NotFoundException('Bolaget finns inte');
    return row;
  }
}
