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
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isoDate, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { generateRun, RunRow } from './billing-run';
import { lastDayOfMonth } from '../contracts/contract-rules';
import { addDays } from '../contracts/contract-rules';
import { INVOICE_LIST_SQL, issueInvoices, loadInvoice } from './invoice-store';
import { sendQueued } from './delivery';
import { renderInvoicesPdf } from './invoice-pdf';
import { periodLabel } from './billing-rules';

const month = z.string().regex(/^\d{4}-\d{2}$/, 'Ange månad som ÅÅÅÅ-MM');
const uuids = z.array(z.string().uuid()).min(1).nullable().optional();

const createSchema = z.object({
  periodMonth: month,
  invoiceDate: isoDate.optional(),
  dueDate: isoDate.nullable().optional(),
  propertyIds: uuids,
  objectIds: uuids,
  note: z.string().trim().max(500).nullable().optional(),
});
const updateSchema = createSchema.omit({ periodMonth: true }).partial();

const RUN_SQL = `
  select r.id, r.company_id as "companyId", co.name as "companyName", r.run_nr as "runNr",
         r.period_month::text as "periodMonth", r.invoice_date::text as "invoiceDate", r.due_date::text as "dueDate",
         r.property_ids as "propertyIds", r.object_ids as "objectIds", r.excluded_contract_ids as "excludedContractIds",
         r.status, r.note, r.fingerprint, r.generated_at as "generatedAt", r.issued_at as "issuedAt",
         (select name from app_user u where u.id = r.issued_by) as "issuedByName",
         r.created_at as "createdAt", (select name from app_user u where u.id = r.created_by) as "createdByName",
         (select count(*) from invoice i where i.billing_run_id = r.id)::int as "invoiceCount",
         (select coalesce(sum(i.net_ore), 0) from invoice i where i.billing_run_id = r.id)::float as "netOre",
         (select coalesce(sum(i.vat_ore), 0) from invoice i where i.billing_run_id = r.id)::float as "vatOre",
         (select coalesce(sum(i.total_ore), 0) from invoice i where i.billing_run_id = r.id)::float as "totalOre",
         (select count(*) from billing_run_issue x where x.billing_run_id = r.id and x.severity = 'blocking')::int as "blockingCount",
         (select count(*) from billing_run_issue x where x.billing_run_id = r.id and x.severity = 'warning')::int as "warningCount",
         (select count(*) from invoice_delivery d join invoice i on i.id = d.invoice_id where i.billing_run_id = r.id and d.status = 'queued')::int as "queuedCount",
         (select count(*) from invoice_delivery d join invoice i on i.id = d.invoice_id where i.billing_run_id = r.id and d.status = 'queued' and d.channel = 'post')::int as "queuedPostCount",
         (select count(distinct d.invoice_id) from invoice_delivery d join invoice i on i.id = d.invoice_id where i.billing_run_id = r.id and d.status in ('sent','test'))::int as "sentCount",
         (select count(*) from invoice_delivery d join invoice i on i.id = d.invoice_id where i.billing_run_id = r.id and d.status = 'failed')::int as "failedCount"
  from billing_run r join company co on co.id = r.company_id`;

@Controller('billing-runs')
export class BillingRunsController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(`${RUN_SQL} where r.status <> 'cancelled' or r.created_at > now() - interval '30 days' order by r.period_month desc, r.run_nr desc`)).rows,
    );
  }

  /** Förslag till nästa körning: månaden efter den senast aviserade, fakturadatum i dag. */
  @Get('suggestion')
  suggestion(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select max(period_month)::text as last from billing_run where status = 'issued'`,
      );
      const next = rows[0]?.last ? addDays(lastDayOfMonth(rows[0].last), 1) : addDays(lastDayOfMonth(today()), 1);
      return { periodMonth: next.slice(0, 7), invoiceDate: today(), lastIssued: rows[0]?.last ?? null };
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'billing.run');
    const data = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('billing:' || $1))`, [companyId]);
      const draft = (await client.query(`select id from billing_run where company_id = $1 and status = 'draft'`, [companyId])).rows[0];
      if (draft) {
        throw new ConflictException({ message: 'Det finns redan en aviseringskörning under arbete. Godkänn eller makulera den först.', runId: draft.id });
      }
      const nr = (await client.query('select coalesce(max(run_nr), 0) + 1 as nr from billing_run where company_id = $1', [companyId])).rows[0].nr;
      const { rows } = await client.query(
        `insert into billing_run (company_id, run_nr, period_month, invoice_date, due_date, property_ids, object_ids, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [companyId, nr, `${data.periodMonth}-01`, data.invoiceDate ?? today(), data.dueDate ?? null, data.propertyIds ?? null, data.objectIds ?? null, data.note ?? null],
      );
      const run = await loadRun(client, rows[0].id);
      checkDates(run);
      await generateRun(client, run);
      return loadRun(client, run.id);
    });
  }

  /** Förhandsgranskning: summor, kontroller och alla avier med rader. */
  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const run = await loadRun(client, id);
      const issues = (
        await client.query(
          `select x.id, x.kind, x.severity, x.message, x.contract_id as "contractId", x.object_id as "objectId",
                  x.customer_id as "customerId", x.invoice_id as "invoiceId", k.contract_nr as "contractNr"
           from billing_run_issue x left join contract k on k.id = x.contract_id
           where x.billing_run_id = $1
           order by case x.severity when 'blocking' then 0 when 'warning' then 1 else 2 end, k.contract_nr nulls first`,
          [id],
        )
      ).rows;
      const invoices = (await client.query(`${INVOICE_LIST_SQL} where i.billing_run_id = $1 order by cu.customer_nr, k.contract_nr`, [id])).rows;
      const lines = (
        await client.query(
          `select l.invoice_id as "invoiceId", l.line_kind as "lineKind", l.description, l.article, o.object_nr as "objectNr",
                  l.period_from::text as "periodFrom", l.period_to::text as "periodTo", l.net_ore::float as "netOre",
                  l.vat_rate_bp as "vatRateBp", l.vat_ore::float as "vatOre"
           from invoice_line l join invoice i on i.id = l.invoice_id left join rental_object o on o.id = l.object_id
           where i.billing_run_id = $1 order by l.position`,
          [id],
        )
      ).rows;
      const excluded = run.excludedContractIds.length
        ? (
            await client.query(
              `select k.id, k.contract_nr as "contractNr", c.name as "customerName" from contract k join customer c on c.id = k.customer_id where k.id = any($1)`,
              [run.excludedContractIds],
            )
          ).rows
        : [];
      const properties = run.propertyIds
        ? (await client.query('select id, name from property where id = any($1) order by name', [run.propertyIds])).rows
        : [];
      return {
        ...run,
        periodLabel: periodLabel({ from: run.periodMonth, to: lastDayOfMonth(run.periodMonth) }),
        issues,
        invoices: invoices.map((inv) => ({ ...inv, lines: lines.filter((l) => l.invoiceId === inv.id) })),
        excluded,
        properties,
      };
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'billing.run');
    const data = parse(updateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await draftRun(client, id);
      await client.query(
        `update billing_run set
           invoice_date = coalesce($2, invoice_date),
           due_date = case when $3::boolean then $4::date else due_date end,
           property_ids = case when $5::boolean then $6::uuid[] else property_ids end,
           object_ids = case when $7::boolean then $8::uuid[] else object_ids end,
           note = case when $9::boolean then $10 else note end
         where id = $1`,
        [
          id,
          data.invoiceDate ?? null,
          data.dueDate !== undefined,
          data.dueDate ?? null,
          data.propertyIds !== undefined,
          data.propertyIds ?? null,
          data.objectIds !== undefined,
          data.objectIds ?? null,
          data.note !== undefined,
          data.note ?? null,
        ],
      );
      const run = await loadRun(client, id);
      checkDates(run);
      await generateRun(client, run);
      return loadRun(client, id);
    });
  }

  /** Bygger om underlaget, till exempel efter att ett avtal rättats. */
  @Post(':id/regenerate')
  regenerate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'billing.run');
    return withContext(dbContext(ctx), async (_db, client) => {
      const run = await draftRun(client, id);
      await generateRun(client, run);
      return loadRun(client, id);
    });
  }

  /** Tar bort ett avtal ur körningen, eller tar med det igen. */
  @Post(':id/exclude')
  exclude(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'billing.run');
    const { contractId, include } = parse(z.object({ contractId: z.string().uuid(), include: z.boolean().default(false) }), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await draftRun(client, id);
      await client.query(
        include
          ? 'update billing_run set excluded_contract_ids = array_remove(excluded_contract_ids, $2) where id = $1'
          : 'update billing_run set excluded_contract_ids = array_append(array_remove(excluded_contract_ids, $2), $2) where id = $1',
        [id, contractId],
      );
      const run = await loadRun(client, id);
      await generateRun(client, run);
      return loadRun(client, id);
    });
  }

  /**
   * Godkänner körningen. Underlaget byggs om och jämförs med det som granskades;
   * har något ändrats sedan dess måste körningen granskas igen. Avierna får
   * fakturanummer och OCR och låses.
   */
  @Post(':id/approve')
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.issue');
    const { fingerprint, acknowledgeWarnings } = parse(
      z.object({ fingerprint: z.string().min(1), acknowledgeWarnings: z.boolean().default(false) }),
      body,
    );
    return withContext(dbContext(ctx), async (_db, client) => {
      const run = await draftRun(client, id);
      const fresh = await generateRun(client, run);
      if (fresh.fingerprint !== fingerprint) {
        return { ok: false, changed: true, message: 'Underlaget har ändrats sedan du granskade det. Granska körningen igen.' };
      }
      const counts = (
        await client.query(
          `select count(*) filter (where severity = 'blocking')::int as blocking, count(*) filter (where severity = 'warning')::int as warnings
           from billing_run_issue where billing_run_id = $1`,
          [id],
        )
      ).rows[0];
      if (counts.blocking) throw new BadRequestException(`Körningen har ${counts.blocking} fel som måste rättas innan den kan godkännas`);
      if (counts.warnings && !acknowledgeWarnings) throw new BadRequestException('Bekräfta att du har gått igenom varningarna');
      const ids = (await client.query(`select id from invoice where billing_run_id = $1 and status = 'draft'`, [id])).rows.map((r) => r.id);
      if (!ids.length) throw new BadRequestException('Körningen innehåller inga avier');
      await issueInvoices(client, companyId, ids);
      await client.query(`update billing_run set status = 'issued', issued_at = now(), issued_by = app.current_user_id() where id = $1`, [id]);
      return { ok: true, run: await loadRun(client, id) };
    });
  }

  /** Skickar avier med e-post och e-faktura. Brev skrivs ut separat. */
  @Post(':id/send')
  send(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'invoice.issue');
    return withContext(dbContext(ctx), async (_db, client) => {
      const run = await loadRun(client, id);
      if (run.status !== 'issued') throw new ConflictException('Körningen är inte godkänd');
      const ids = (
        await client.query(
          `select d.id from invoice_delivery d join invoice i on i.id = d.invoice_id where i.billing_run_id = $1 and d.status = 'queued'`,
          [id],
        )
      ).rows.map((r) => r.id);
      return sendQueued(client, ids);
    });
  }

  /** PDF med alla avier som ska skickas med brev (eller alla med ?all=1). */
  @Get(':id/print.pdf')
  async print(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('all') all: string, @Res() res: Response) {
    const list = await withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const ids = (
        await client.query(
          all
            ? `select i.id from invoice i join customer c on c.id = i.customer_id where i.billing_run_id = $1 order by i.invoice_nr nulls last, c.customer_nr`
            : `select distinct i.id, i.invoice_nr from invoice i join invoice_delivery d on d.invoice_id = i.id
               where i.billing_run_id = $1 and d.channel = 'post' and d.status = 'queued' order by i.invoice_nr`,
          [id],
        )
      ).rows.map((r) => r.id);
      const out = [];
      for (const i of ids) out.push(await loadInvoice(client, i));
      return out;
    });
    if (!list.length) throw new NotFoundException('Det finns inga avier att skriva ut');
    const buf = await renderInvoicesPdf(list);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="avier-${id.slice(0, 8)}.pdf"`);
    res.send(buf);
  }

  @Post(':id/mark-printed')
  markPrinted(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'invoice.issue');
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rowCount } = await client.query(
        `update invoice_delivery d set status = 'sent', sent_at = now() from invoice i
         where i.id = d.invoice_id and i.billing_run_id = $1 and d.channel = 'post' and d.status = 'queued'`,
        [id],
      );
      return { marked: rowCount };
    });
  }

  /** Makulerar en körning som inte godkänts. Utkasten tas bort. */
  @Delete(':id')
  @HttpCode(204)
  async cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'billing.run');
    await withContext(dbContext(ctx), async (_db, client) => {
      await draftRun(client, id);
      await client.query(`delete from invoice where billing_run_id = $1 and status = 'draft'`, [id]);
      await client.query(`delete from billing_run_issue where billing_run_id = $1`, [id]);
      await client.query(`update billing_run set status = 'cancelled' where id = $1`, [id]);
    });
  }
}

async function loadRun(client: PoolClient, id: string): Promise<RunRow & Record<string, unknown>> {
  const { rows } = await client.query(`${RUN_SQL} where r.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundException('Körningen finns inte');
  return rows[0];
}

async function draftRun(client: PoolClient, id: string) {
  const { rows } = await client.query(`select id from billing_run where id = $1 for update`, [id]);
  if (!rows[0]) throw new NotFoundException('Körningen finns inte');
  const run = await loadRun(client, id);
  if (run.status !== 'draft') throw new ConflictException(run.status === 'issued' ? 'Körningen är redan godkänd' : 'Körningen är makulerad');
  return run;
}

function checkDates(run: RunRow) {
  if (run.dueDate && run.dueDate < run.invoiceDate) {
    throw new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path: 'dueDate', message: 'Förfallodagen är före fakturadatum' }] });
  }
}
