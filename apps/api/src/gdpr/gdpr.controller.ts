import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany, requirePermission } from '../auth/request-context';
import { getSettings, plan, run, saveSettings, settingsSchema } from './gdpr';
import { buildExtract, renderExtractPdf } from './extract';

/** Dataskydd: gallring av tidigare hyresgäster, logg och registerutdrag. */
@Controller('gdpr')
export class GdprController {
  @Get('settings')
  settings(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'gdpr.manage');
    return withContext(dbContext(ctx), (_db, client) => getSettings(client, companyId));
  }

  @Put('settings')
  save(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'gdpr.manage');
    const data = parse(settingsSchema, body);
    return withContext(dbContext(ctx), (_db, client) => saveSettings(client, companyId, data));
  }

  /** Visar vad som skulle gallras nu, vad som stoppas och vad som står på tur. Inget ändras. */
  @Get('preview')
  preview(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'gdpr.manage');
    return withContext(dbContext(ctx), (_db, client) => plan(client, companyId));
  }

  /** Gallra nu: gör det som förhandsgranskningen visar. */
  @Post('run')
  @HttpCode(200)
  runNow(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'gdpr.manage');
    return withContext(dbContext(ctx), (_db, client) => run(client, companyId, 'manual'));
  }

  @Get('log')
  log(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'gdpr.manage');
    return withContext(dbContext(ctx), async (_db, client) => {
      const runs = (
        await client.query(
          `select r.id, r.run_nr as "runNr", r.trigger, r.anonymized_count as "anonymized", r.accounting_count as "accounting",
                  r.import_count as "imports", r.interest_count as "interests", r.created_at as "createdAt", u.name as "createdByName"
           from gdpr_run r left join app_user u on u.id = r.created_by
           where r.company_id = $1 order by r.created_at desc limit 200`,
          [companyId],
        )
      ).rows;
      const items = (
        await client.query(
          `select l.id, l.run_id as "runId", l.kind, l.customer_id as "customerId", l.customer_nr as "customerNr",
                  l.import_batch_id as "importBatchId", l.details, l.created_at as "createdAt", u.name as "createdByName"
           from gdpr_log l left join app_user u on u.id = l.created_by
           where l.company_id = $1 order by l.created_at desc limit 2000`,
          [companyId],
        )
      ).rows;
      return {
        runs: runs.map((r) => ({ ...r, items: items.filter((i) => i.runId === r.id) })),
        extracts: items.filter((i) => i.kind === 'extract').slice(0, 200),
      };
    });
  }

  /** Läget för en kund: anonymiserad eller inte, och vad som hindrar en anonymisering på begäran. */
  @Get('customers/:id/status')
  status(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const c = await customerCompany(client, id);
      const p = await plan(client, c.companyId, { customerId: id, request: true });
      const blocked = p.blocked.find((b) => b.id === id);
      const s = (await client.query(`select anonymized_at as "anonymizedAt", accounting_purged_at as "accountingPurgedAt" from customer where id = $1`, [id])).rows[0];
      const keep = p.accounting.find((a) => a.id === id);
      return {
        ...s,
        retentionMonths: p.settings.retentionMonths,
        canAnonymize: !s.anonymizedAt && p.anonymize.some((a) => a.id === id),
        blockers: blocked?.blockers ?? [],
        mode: p.anonymize.find((a) => a.id === id)?.mode ?? null,
        accountingDue: !!keep,
      };
    });
  }

  /** Anonymisera en kund på begäran (rätten att bli raderad). Hindren gäller, men inte lagringstiden. */
  @Post('customers/:id/anonymize')
  @HttpCode(200)
  anonymize(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const c = await customerCompany(client, id);
      requirePermission(ctx, c.companyId, 'gdpr.manage');
      if (c.anonymizedAt) throw new BadRequestException('Kunden är redan anonymiserad');
      const p = await plan(client, c.companyId, { customerId: id, request: true });
      const blocked = p.blocked.find((b) => b.id === id);
      if (blocked) throw new BadRequestException(`Kunden kan inte anonymiseras än: ${blocked.blockers.join(', ')}`);
      if (!p.anonymize.some((a) => a.id === id)) throw new BadRequestException('Kunden har ett gällande avtal och kan inte anonymiseras');
      return run(client, c.companyId, 'request', { customerId: id });
    });
  }

  @Get('customers/:id/extract.pdf')
  async extractPdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const e = await this.extract(ctx, id, 'pdf');
    const pdf = await renderExtractPdf(e);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="registerutdrag-${e.customer.customerNr}.pdf"`);
    res.end(pdf);
  }

  @Get('customers/:id/extract.json')
  async extractJson(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const e = await this.extract(ctx, id, 'json');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="registerutdrag-${e.customer.customerNr}.json"`);
    res.end(JSON.stringify(e, null, 2));
  }

  private extract(ctx: RequestContext, id: string, format: 'pdf' | 'json') {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const c = await customerCompany(client, id);
      requirePermission(ctx, c.companyId, 'gdpr.extract');
      const e = await buildExtract(client, id);
      if (!e) throw new NotFoundException('Kunden finns inte');
      await client.query(
        `insert into gdpr_log (company_id, kind, customer_id, customer_nr, details) values ($1, 'extract', $2, $3, $4)`,
        [c.companyId, id, e.customer.customerNr, JSON.stringify({ format })],
      );
      return e;
    });
  }
}

async function customerCompany(client: PoolClient, id: string): Promise<{ companyId: string; anonymizedAt: string | null }> {
  const c = (await client.query('select company_id as "companyId", anonymized_at as "anonymizedAt" from customer where id = $1', [id])).rows[0];
  if (!c) throw new NotFoundException('Kunden finns inte');
  return c;
}

