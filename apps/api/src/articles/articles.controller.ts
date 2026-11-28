import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';

/** Artikelkod på avtalsrader, extra debiteringar och fakturarader. */
export const articleCode = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'Välj en artikel');

/** Artiklar som systemet självt använder och som därför alltid måste vara aktiva. */
const ALWAYS_ACTIVE = ['rent', 'index', 'discount', 'fee', 'other'];

const vatRate = z.coerce
  .number()
  .int()
  .refine((v) => [0, 600, 1200, 2500].includes(v), 'Ogiltig momssats');

const articleSchema = z.object({
  name: z.string().trim().min(1, 'Ange ett namn').max(100),
  accountNumber: z.string().trim().regex(/^\d{4}$/, 'Välj ett konto'),
  // Tomt = följer avtalet och objektet
  vatRateBp: z.preprocess((v) => (v === '' ? null : v), vatRate.nullable().optional()),
  position: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

/** Kod av namnet: "Kabel-TV" blir kabel_tv. */
export function codeFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || 'artikel';
}

async function checkAccount(client: PoolClient, companyId: string, number: string) {
  const { rows } = await client.query(`select type, active from account where company_id = $1 and number = $2`, [companyId, number]);
  if (!rows[0]) throw new BadRequestException(`Konto ${number} finns inte i bolagets kontoplan`);
  if (rows[0].type !== 'revenue') throw new BadRequestException(`Konto ${number} är inte ett intäktskonto (3000–3999)`);
}

export const ARTICLE_LIST_SQL = `
  select a.id, a.company_id as "companyId", co.name as "companyName", a.code, a.name, a.account_number as "accountNumber",
         acc.name as "accountName", a.vat_rate_bp as "vatRateBp", a.system, a.active, a.position,
         (select count(*)::int from contract_line l where l.company_id = a.company_id and l.article = a.code)
       + (select count(*)::int from contract_charge c where c.company_id = a.company_id and c.article = a.code)
       + (select count(*)::int from invoice_line i where i.company_id = a.company_id and i.article = a.code) as "useCount"
  from article a
  join company co on co.id = a.company_id
  left join account acc on acc.company_id = a.company_id and acc.number = a.account_number`;

const articleAccountSchema = z.object({
  article: articleCode,
  propertyId: z.string().uuid('Välj en fastighet'),
  vat: z.enum(['any', 'taxable', 'exempt']).default('any'),
  accountNumber: z.string().trim().regex(/^\d{4}$/, 'Välj ett konto'),
});

const ARTICLE_ACCOUNT_SQL = `
  select x.id, x.company_id as "companyId", x.article, ar.name as "articleName", x.property_id as "propertyId",
         p.designation as "propertyDesignation", p.name as "propertyName", x.vat, x.account_number as "accountNumber", acc.name as "accountName"
  from article_account x
  join article ar on ar.company_id = x.company_id and ar.code = x.article
  join property p on p.id = x.property_id
  left join account acc on acc.company_id = x.company_id and acc.number = x.account_number`;

/** Artikelregister per bolag. */
@Controller('articles')
export class ArticlesController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(`${ARTICLE_LIST_SQL} order by co.name, a.position, a.name`)).rows.map((r) => ({
        ...r,
        alwaysActive: ALWAYS_ACTIVE.includes(r.code),
      })),
    );
  }

  /** Intäktskonto per fastighet: går före artikelns konto på nya fakturarader. */
  @Get('accounts')
  listAccounts(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(`${ARTICLE_ACCOUNT_SQL} order by p.designation, ar.position, ar.name, x.vat`)).rows,
    );
  }

  @Post('accounts')
  createAccount(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'article.write');
    const data = parse(articleAccountSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await checkAccount(client, companyId, data.accountNumber);
      const article = (await client.query(`select 1 from article where company_id = $1 and code = $2`, [companyId, data.article])).rows[0];
      if (!article) throw new BadRequestException('Artikeln finns inte i valt bolag');
      const property = (await client.query(`select 1 from property where id = $1 and company_id = $2`, [data.propertyId, companyId])).rows[0];
      if (!property) throw new BadRequestException('Fastigheten finns inte i valt bolag');
      const { rows } = await client.query(
        `insert into article_account (company_id, article, property_id, vat, account_number) values ($1,$2,$3,$4,$5)
         on conflict (company_id, article, property_id, vat) do update set account_number = excluded.account_number
         returning id`,
        [companyId, data.article, data.propertyId, data.vat, data.accountNumber],
      );
      return rows[0];
    });
  }

  @Delete('accounts/:id')
  @HttpCode(204)
  async removeAccount(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'article.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const { rowCount } = await client.query(`delete from article_account where id = $1 and company_id = $2`, [id, companyId]);
      if (!rowCount) throw new NotFoundException('Kontot finns inte i valt bolag');
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'article.write');
    const data = parse(articleSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await checkAccount(client, companyId, data.accountNumber);
      const taken = new Set(
        (await client.query(`select code from article where company_id = $1`, [companyId])).rows.map((r) => r.code as string),
      );
      const base = codeFromName(data.name);
      let code = base;
      for (let i = 2; taken.has(code); i++) code = `${base}_${i}`;
      const position =
        data.position ?? (await client.query(`select coalesce(max(position), 0) + 10 as p from article where company_id = $1`, [companyId])).rows[0].p;
      const { rows } = await client.query(
        `insert into article (company_id, code, name, account_number, vat_rate_bp, position, active)
         values ($1,$2,$3,$4,$5,$6,$7) returning id, code`,
        [companyId, code, data.name, data.accountNumber, data.vatRateBp, position, data.active ?? true],
      );
      return rows[0];
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'article.write');
    const data = parse(articleSchema.partial(), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query(`select code from article where id = $1 and company_id = $2`, [id, companyId])).rows[0];
      if (!cur) throw new NotFoundException('Artikeln finns inte i valt bolag');
      if (data.active === false && ALWAYS_ACTIVE.includes(cur.code)) {
        throw new BadRequestException('Artikeln används av systemet och kan inte göras inaktiv');
      }
      if (data.accountNumber) await checkAccount(client, companyId, data.accountNumber);
      const { rows } = await client.query(
        `update article set name = coalesce($2, name), account_number = coalesce($3, account_number),
                vat_rate_bp = case when $4::boolean then $5 else vat_rate_bp end,
                position = coalesce($6, position), active = coalesce($7, active)
         where id = $1 returning id, code`,
        [id, data.name ?? null, data.accountNumber ?? null, data.vatRateBp !== undefined, data.vatRateBp ?? null, data.position ?? null, data.active ?? null],
      );
      return rows[0];
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'article.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const a = (await client.query(`${ARTICLE_LIST_SQL} where a.id = $1 and a.company_id = $2`, [id, companyId])).rows[0];
      if (!a) throw new NotFoundException('Artikeln finns inte i valt bolag');
      if (a.system) throw new BadRequestException('Standardartiklar kan inte tas bort, men de kan döpas om');
      if (a.useCount > 0) throw new BadRequestException('Artikeln används på avtal eller fakturor. Gör den inaktiv i stället.');
      await client.query(`delete from article where id = $1`, [id]);
    });
  }
}
