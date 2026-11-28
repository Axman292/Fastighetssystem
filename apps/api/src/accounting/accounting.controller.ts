import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isoDate } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { KIND_LABEL, loadSettings } from './accounting-events';
import { exportFileName, ExportPlan, planExport, planToFile, summarize } from './sie-export';

const account = z.string().regex(/^\d{4}$/, 'Ange ett fyrsiffrigt konto');

const settingsSchema = z.object({
  series: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'Ange serien med bokstäver eller siffror, t.ex. A'),
  startDate: isoDate.nullable().optional(),
  bankAccount: account,
  receivableAccount: account,
  prepaymentAccount: account,
  payableAccount: account,
  inputVatAccount: account,
  outputVat25Account: account,
  outputVat12Account: account,
  outputVat6Account: account,
  roundingAccount: account,
  includeDimensions: z.boolean().default(false),
});

const periodSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((p) => p.to >= p.from, { path: ['to'], message: 'Perioden slutar före den börjar' })
  .refine((p) => (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 <= 366, { path: ['to'], message: 'Välj en period på högst ett år' });

function stockholmToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
}

function previewBody(plan: ExportPlan) {
  const names = plan.accountNames;
  return {
    from: plan.from,
    to: plan.to,
    lowerBound: plan.lowerBound,
    settings: plan.settings,
    issues: plan.issues,
    blocked: plan.issues.some((i) => i.severity === 'blocking'),
    overlapping: plan.overlapping,
    summary: summarize(plan),
    vouchers: plan.vouchers.map((v) => ({
      key: v.key,
      kind: v.kind,
      kindLabel: KIND_LABEL[v.kind],
      date: v.date,
      eventDate: v.eventDate,
      text: v.text,
      correction: v.correction,
      late: v.late,
      href: v.href,
      rows: v.rows.map((r) => ({
        account: r.account,
        accountName: names.get(r.account) ?? null,
        debitOre: r.amountOre > 0 ? r.amountOre : 0,
        creditOre: r.amountOre < 0 ? -r.amountOre : 0,
        costCenter: r.costCenter,
        project: r.project,
      })),
    })),
  };
}

const EXPORT_LIST_SQL = `
  select e.id, e.export_nr as "exportNr", e.period_from::text as "from", e.period_to::text as "to", e.series,
         e.voucher_count as "voucherCount", e.correction_count as "correctionCount", e.debit_ore::float as "debitOre",
         e.filename, e.created_at as "createdAt", u.name as "createdBy",
         e.export_nr = (select max(x.export_nr) from sie_export x where x.company_id = e.company_id) as latest
  from sie_export e left join app_user u on u.id = e.created_by`;

/**
 * Export till bokföringen (Hogia eller annat ekonomiprogram) med SIE-fil.
 * Exporten görs per bolag och för valfri period. Varje händelse exporteras en gång;
 * ändras den efteråt kommer en rättelse med nästa export.
 */
@Controller('accounting')
export class AccountingController {
  @Get('settings')
  settings(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'accounting.export');
    return withContext(dbContext(ctx), (_db, client) => loadSettings(client, companyId));
  }

  @Put('settings')
  saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'accounting.export');
    const d = parse(settingsSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(
        `insert into accounting_setting (company_id, series, start_date, bank_account, receivable_account, prepayment_account, payable_account,
           input_vat_account, output_vat_25_account, output_vat_12_account, output_vat_6_account, rounding_account, include_dimensions)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (company_id) do update set series = excluded.series, start_date = excluded.start_date, bank_account = excluded.bank_account,
           receivable_account = excluded.receivable_account, prepayment_account = excluded.prepayment_account,
           payable_account = excluded.payable_account, input_vat_account = excluded.input_vat_account,
           output_vat_25_account = excluded.output_vat_25_account, output_vat_12_account = excluded.output_vat_12_account,
           output_vat_6_account = excluded.output_vat_6_account, rounding_account = excluded.rounding_account,
           include_dimensions = excluded.include_dimensions`,
        [companyId, d.series.toUpperCase(), d.startDate ?? null, d.bankAccount, d.receivableAccount, d.prepaymentAccount, d.payableAccount,
         d.inputVatAccount, d.outputVat25Account, d.outputVat12Account, d.outputVat6Account, d.roundingAccount, d.includeDimensions],
      );
      return loadSettings(client, companyId);
    });
  }

  /** Förhandsgranskning: vilka verifikationer en export för perioden skulle innehålla. Ändrar ingenting. */
  @Get('sie/preview')
  preview(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string) {
    const companyId = requireCompany(ctx, 'accounting.export');
    const p = parse(periodSchema, { from, to });
    return withContext(dbContext(ctx), async (_db, client) => previewBody(await planExport(client, companyId, p.from, p.to)));
  }

  @Get('sie/exports')
  list(@Ctx() ctx: RequestContext) {
    requireCompany(ctx, 'accounting.export');
    return withContext(dbContext(ctx), async (_db, client) => (await client.query(`${EXPORT_LIST_SQL} order by e.export_nr desc`)).rows);
  }

  /** Gör exporten: sparar vad som exporterats och returnerar exporten. Filen hämtas med /file. */
  @Post('sie/exports')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'accounting.export');
    const p = parse(periodSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      // En export i taget per bolag, så att två exporter aldrig tar med samma händelse
      await client.query(`select pg_advisory_xact_lock(hashtext('sie_export:' || $1))`, [companyId]);
      const plan = await planExport(client, companyId, p.from, p.to);
      const blocking = plan.issues.filter((i) => i.severity === 'blocking');
      if (blocking.length) throw new BadRequestException(`Exporten kan inte göras: ${blocking[0].message}`);
      if (!plan.vouchers.length) throw new BadRequestException('Det finns inget nytt att exportera för perioden');

      const company = (await client.query('select fiscal_year_start as fys from company where id = $1', [companyId])).rows[0];
      const file = planToFile(plan, company.fys, ctx.name, stockholmToday());
      const filename = exportFileName(plan.companyName, p.from, p.to);
      const nr = (await client.query('select coalesce(max(export_nr), 0) + 1 as nr from sie_export where company_id = $1', [companyId])).rows[0].nr;
      const debit = plan.vouchers.reduce((s, v) => s + v.rows.filter((r) => r.amountOre > 0).reduce((a, r) => a + r.amountOre, 0), 0);
      const exp = (
        await client.query(
          `insert into sie_export (company_id, export_nr, period_from, period_to, series, voucher_count, correction_count, debit_ore, filename, file)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [companyId, nr, p.from, p.to, plan.settings.series, plan.vouchers.length, plan.vouchers.filter((v) => v.correction).length, debit, filename, file],
        )
      ).rows[0];
      for (const v of plan.vouchers) {
        await client.query(
          `insert into sie_export_item (company_id, sie_export_id, source_key, kind, event_date, voucher_date, correction, text, rows)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [companyId, exp.id, v.key, v.kind, v.eventDate, v.date, v.correction, v.text, JSON.stringify(v.newRows)],
        );
      }
      return (await client.query(`${EXPORT_LIST_SQL} where e.id = $1`, [exp.id])).rows[0];
    });
  }

  @Get('sie/exports/:id')
  show(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'accounting.export');
    return withContext(dbContext(ctx), async (_db, client) => {
      const exp = (await client.query(`${EXPORT_LIST_SQL} where e.id = $1`, [id])).rows[0];
      if (!exp) throw new NotFoundException('Exporten finns inte');
      const items = (
        await client.query(
          `select source_key as key, kind, voucher_date::text as date, event_date::text as "eventDate", correction, text
           from sie_export_item where sie_export_id = $1 order by voucher_date, kind, text`,
          [id],
        )
      ).rows.map((r) => ({ ...r, kindLabel: KIND_LABEL[r.kind as keyof typeof KIND_LABEL] }));
      return { ...exp, items };
    });
  }

  /** Filen exakt som den skapades vid exporten */
  @Get('sie/exports/:id/file')
  async file(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'accounting.export');
    const f = await withContext(dbContext(ctx), async (_db, client) => (await client.query('select filename, file from sie_export where id = $1', [id])).rows[0]);
    if (!f) throw new NotFoundException('Exporten finns inte');
    res.setHeader('content-type', 'text/plain; charset=IBM437');
    res.setHeader('content-disposition', `attachment; filename="${f.filename}"`);
    res.end(f.file);
  }

  /**
   * Ångrar den senaste exporten, till exempel om filen inte gick att läsa in.
   * Händelserna kommer då med i nästa export igen. Har filen redan lästs in i
   * bokföringen ska verifikationerna tas bort där också.
   */
  @Delete('sie/exports/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'accounting.export');
    await withContext(dbContext(ctx), async (_db, client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('sie_export:' || $1))`, [companyId]);
      const exp = (await client.query(`${EXPORT_LIST_SQL} where e.id = $1`, [id])).rows[0];
      if (!exp) throw new NotFoundException('Exporten finns inte');
      if (!exp.latest) throw new ConflictException('Bara den senaste exporten kan ångras');
      await client.query('delete from sie_export where id = $1', [id]);
    });
  }
}
