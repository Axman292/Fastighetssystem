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
  // Påminnelseavgift i kronor, högst 60 kr enligt förordningen om ersättning för inkassokostnader
  reminderFee: z.number().finite().min(0, 'Kan inte vara negativ').max(60, 'Högst 60 kr är tillåtet').optional(),
  reminderGraceDays: z.number().int().min(0).max(90).optional(),
  reminderDueDays: z.number().int().min(1).max(60).optional(),
  // Dröjsmålsränta i procent per år
  lateInterestRate: z.number().finite().min(0).max(50).optional(),
  // true = referensräntan + marginal enligt räntelagen, false = fast ränta ovan
  lateInterestReference: z.boolean().optional(),
  lateInterestMargin: z.number().finite().min(0).max(50).optional(),
  lateInterestMin: z.number().finite().min(0).max(1000).optional(),
  lateInterestMethod: z.enum(['next_notice', 'invoice']).optional(),
  lateInterestFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ogiltigt datum').optional(),
  badDebtAccount: z.string().regex(/^\d{4}$/, 'Ange ett kontonummer med fyra siffror').optional(),
};
/** Kronor och procent från formuläret till öre och baspunkter i databasen. */
function toColumns<T extends { reminderFee?: number; lateInterestRate?: number; lateInterestMargin?: number; lateInterestMin?: number }>(d: T) {
  const { reminderFee, lateInterestRate, lateInterestMargin, lateInterestMin, ...rest } = d;
  return {
    ...rest,
    ...(lateInterestMargin !== undefined ? { lateInterestMarginBp: Math.round(lateInterestMargin * 100) } : {}),
    ...(lateInterestMin !== undefined ? { lateInterestMinOre: Math.round(lateInterestMin * 100) } : {}),
    ...(reminderFee !== undefined ? { reminderFeeOre: Math.round(reminderFee * 100) } : {}),
    ...(lateInterestRate !== undefined ? { lateInterestBp: Math.round(lateInterestRate * 100) } : {}),
  };
}
const createSchema = z.object(companyFields).transform(toColumns);
const updateSchema = z.object(companyFields).partial().extend({ active: z.boolean().optional() }).transform(toColumns);

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
