import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { parse, text } from '../common/validation';
import { withContext } from '../db/db';
import { bankAccount, company, costCenter } from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';

const bankAccountSchema = z.object({
  purpose: z.enum(['rent', 'operations', 'loan', 'deposit', 'other']),
  bankName: text.optional,
  clearingNr: z.string().regex(/^\d{4,5}$/, 'Clearingnummer ska vara 4–5 siffror').optional().nullable(),
  accountNr: z.string().regex(/^[\d -]{5,20}$/, 'Ogiltigt kontonummer').optional().nullable(),
  iban: z
    .string()
    .transform((v) => v.replace(/\s/g, '').toUpperCase())
    .pipe(z.string().regex(/^SE\d{22}$/, 'Ogiltigt svenskt IBAN'))
    .optional()
    .nullable(),
  bic: text.optional,
});

const costCenterSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
});

/** Bankkonton och kostnadsställen per bolag. */
@Controller()
export class RegisterController {
  @Get('bank-accounts')
  listBankAccounts(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (db) =>
      db
        .select({ account: bankAccount, companyName: company.name })
        .from(bankAccount)
        .innerJoin(company, eq(company.id, bankAccount.companyId))
        .orderBy(asc(company.name), asc(bankAccount.purpose))
        .then((rows) => rows.map((r) => ({ ...r.account, companyName: r.companyName }))),
    );
  }

  @Post('bank-accounts')
  createBankAccount(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'bank_account.write');
    const data = parse(bankAccountSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await db.insert(bankAccount).values({ ...data, companyId }).returning();
      return row;
    });
  }

  @Delete('bank-accounts/:id')
  @HttpCode(204)
  async deleteBankAccount(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'bank_account.write');
    const rows = await withContext(dbContext(ctx), (db) =>
      db.delete(bankAccount).where(eq(bankAccount.id, id)).returning({ id: bankAccount.id }),
    );
    if (!rows.length) throw new NotFoundException();
  }

  @Get('cost-centers')
  listCostCenters(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (db) =>
      db
        .select({ cc: costCenter, companyName: company.name })
        .from(costCenter)
        .innerJoin(company, eq(company.id, costCenter.companyId))
        .orderBy(asc(company.name), asc(costCenter.code))
        .then((rows) => rows.map((r) => ({ ...r.cc, companyName: r.companyName }))),
    );
  }

  @Post('cost-centers')
  createCostCenter(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'cost_center.write');
    const data = parse(costCenterSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await db.insert(costCenter).values({ ...data, companyId }).returning();
      return row;
    });
  }
}
