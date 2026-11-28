import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isoDate, kronorToOre, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany, requireGroupAdmin } from '../auth/request-context';
import { sendQueued } from '../billing/delivery';
import { chargeInterest, interestCandidates, interestSettings, pct, rateOn, referenceRates } from './late-interest';
import { closePlan, createPlan, loadPlan, loadPlans } from './payment-plans';
import { CASE_STATUS, collectionReady, createCase, exportCsv, exportXlsx, listCases, loadCase, setStatus, writeOff } from './collection';
import { renderCasesPdf, renderPlanPdf } from './collection-pdf';

const PERMISSION = 'collection.manage';
const dateParam = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today());
const uuidList = (v?: string) => (v ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));

function send(res: Response, body: Buffer, type: string, filename: string, inline = false) {
  res.setHeader('content-type', type);
  res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.end(body);
}

// ---------------------------------------------------------------------
// Dröjsmålsränta
// ---------------------------------------------------------------------

const chargeSchema = z.object({
  date: isoDate.optional(),
  invoiceIds: z.array(z.string().uuid()).min(1, 'Välj minst en faktura').max(2000),
  method: z.enum(['next_notice', 'invoice']).optional(),
  includeBelowMinimum: z.boolean().default(false),
});

@Controller('late-interest')
export class LateInterestController {
  /** Fakturor med ränta som kan debiteras per ett datum, och bolagets inställningar. */
  @Get('suggestion')
  suggestion(@Ctx() ctx: RequestContext, @Query('date') date?: string) {
    const d = dateParam(date);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (!ctx.activeCompanyId) return { date: d, settings: null, currentRate: null, candidates: [] };
      const s = await interestSettings(client, ctx.activeCompanyId);
      const refs = await referenceRates(client);
      const current = rateOn(d, { useReference: s.useReference, marginBp: s.marginBp, fixedBp: s.fixedBp, contractBp: null, referenceRates: refs });
      return {
        date: d,
        settings: s,
        currentRate: pct(current),
        referenceRate: refs.filter((r) => r.validFrom <= d).at(-1) ?? null,
        candidates: await interestCandidates(client, ctx.activeCompanyId, d),
      };
    });
  }

  /** Debiterar räntan: på nästa avi eller som räntefaktura. Räntefakturor med e-post skickas direkt. */
  @Post()
  charge(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const data = parse(chargeSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const res = await chargeInterest(client, companyId, { ...data, date: data.date ?? today() });
      const deliveries = res.interestInvoiceIds.length
        ? (await client.query(`select id from invoice_delivery where invoice_id = any($1) and status = 'queued'`, [res.interestInvoiceIds])).rows.map((r) => r.id)
        : [];
      const delivery = await sendQueued(client, deliveries);
      return { ...res, delivery };
    });
  }

  /** Debiterad ränta. */
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('invoiceId') invoiceId?: string) {
    if (invoiceId && !/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new BadRequestException('Ogiltigt id');
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select c.id, c.invoice_id as "invoiceId", i.invoice_nr::float as "invoiceNr", c.customer_id as "customerId", cu.name as "customerName",
                  c.from_date::text as "fromDate", c.to_date::text as "toDate", c.amount_ore::float as "amountOre", c.rate_text as "rateText",
                  c.method, c.interest_invoice_id as "interestInvoiceId", ii.invoice_nr::float as "interestInvoiceNr",
                  c.contract_charge_id as "contractChargeId", k.contract_nr as "contractNr", k.id as "contractId",
                  (select bi.invoice_nr::float from invoice_line l join invoice bi on bi.id = l.invoice_id
                   where l.contract_charge_id = c.contract_charge_id and bi.status = 'issued' limit 1) as "noticeNr",
                  c.run_date::text as "runDate"
           from late_interest_charge c
           join invoice i on i.id = c.invoice_id
           join customer cu on cu.id = c.customer_id
           left join invoice ii on ii.id = c.interest_invoice_id
           left join contract_charge ch on ch.id = c.contract_charge_id
           left join contract k on k.id = ch.contract_id
           where ($1::uuid is null or c.invoice_id = $1)
           order by c.created_at desc limit 1000`,
          [invoiceId || null],
        )
      ).rows,
    );
  }
}

// ---------------------------------------------------------------------
// Referensränta
// ---------------------------------------------------------------------

const rateSchema = z.object({
  validFrom: isoDate.refine((d) => /-(01|07)-01$/.test(d), 'Referensräntan gäller från 1 januari eller 1 juli'),
  rate: z.number().finite().min(-10).max(50),
});

@Controller('reference-rates')
export class ReferenceRatesController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (_db, client) => referenceRates(client));
  }

  /** Lägger till eller rättar referensräntan för ett halvår (koncernadministratör). */
  @Put()
  upsert(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireGroupAdmin(ctx);
    const data = parse(rateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(
        `insert into reference_rate (valid_from, rate_bp) values ($1, $2) on conflict (valid_from) do update set rate_bp = excluded.rate_bp`,
        [data.validFrom, Math.round(data.rate * 100)],
      );
      return referenceRates(client);
    });
  }
}

// ---------------------------------------------------------------------
// Avbetalningsplaner
// ---------------------------------------------------------------------

const planSchema = z
  .object({
    customerId: z.string().uuid('Välj en hyresgäst'),
    invoiceIds: z.array(z.string().uuid()).min(1, 'Välj minst en faktura').max(200),
    agreedDate: isoDate.optional(),
    firstDueDate: isoDate,
    installments: z.number().int().min(1).max(60).optional(),
    monthlyAmount: z.number().finite().positive().max(1e9).transform(kronorToOre).optional(),
    chargeInterest: z.boolean().default(true),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => v.installments || v.monthlyAmount, { message: 'Ange antal delbetalningar eller belopp per månad', path: ['installments'] });

const closeSchema = z.object({
  status: z.enum(['completed', 'broken', 'cancelled']),
  date: isoDate.optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

@Controller('payment-plans')
export class PaymentPlansController {
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('customerId') customerId?: string) {
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new BadRequestException('Ogiltigt id');
    return withContext(dbContext(ctx), (_db, client) =>
      loadPlans(client, 'where ($1::uuid is null or p.customer_id = $1)', [customerId || null], today()),
    );
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), (_db, client) => loadPlan(client, id, today()));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const d = parse(planSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const id = await createPlan(client, companyId, {
        customerId: d.customerId,
        invoiceIds: d.invoiceIds,
        agreedDate: d.agreedDate ?? today(),
        firstDueDate: d.firstDueDate,
        installments: d.installments,
        monthlyAmountOre: d.monthlyAmount,
        chargeInterest: d.chargeInterest,
        note: d.note,
      });
      return loadPlan(client, id, today());
    });
  }

  @Post(':id/close')
  close(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, PERMISSION);
    const d = parse(closeSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await closePlan(client, id, d.status, d.date ?? today(), d.reason ?? null);
      return loadPlan(client, id, today());
    });
  }

  @Get(':id/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const p = await withContext(dbContext(ctx), (_db, client) => loadPlan(client, id, today()));
    send(res, await renderPlanPdf(p), 'application/pdf', `avbetalningsplan-${p.planNr}.pdf`, true);
  }
}

// ---------------------------------------------------------------------
// Inkasso
// ---------------------------------------------------------------------

const caseSchema = z.object({
  customerId: z.string().uuid('Välj en hyresgäst'),
  invoiceIds: z.array(z.string().uuid()).min(1, 'Välj minst en faktura').max(500),
  date: isoDate.optional(),
  agency: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

const statusSchema = z.object({
  status: z.enum(CASE_STATUS),
  date: isoDate.optional(),
  agency: z.string().trim().max(200).nullable().optional(),
  agencyReference: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const writeOffSchema = z.object({
  date: isoDate.optional(),
  reason: z.string().trim().min(2, 'Ange orsak, till exempel att Kronofogden inte hittat tillgångar').max(250),
});

@Controller('collection-cases')
export class CollectionCasesController {
  /** Fakturor som är redo för inkasso: båda påminnelserna obetalda. */
  @Get('ready')
  ready(@Ctx() ctx: RequestContext, @Query('date') date?: string) {
    return withContext(dbContext(ctx), (_db, client) => collectionReady(client, dateParam(date)));
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return withContext(dbContext(ctx), (_db, client) => listCases(client, status));
  }

  /** Ärendefil för inkassobolaget (Excel eller CSV) för valda ärenden, eller alla förberedda. */
  @Get('export.:format')
  async export(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('format') format: string, @Query('ids') ids?: string) {
    if (!['xlsx', 'csv', 'pdf'].includes(format)) throw new BadRequestException('Okänt format');
    const cases = await withContext(dbContext(ctx), async (_db, client) => {
      const wanted = uuidList(ids);
      const found = wanted.length ? wanted : (await client.query(`select id from collection_case where status = 'prepared' order by case_nr`)).rows.map((r) => r.id as string);
      const out = [];
      for (const id of found) out.push(await loadCase(client, id));
      return out;
    });
    if (!cases.length) throw new BadRequestException('Det finns inga ärenden att exportera');
    const name = cases.length === 1 ? `inkasso-${cases[0].caseNr}` : `inkasso-${today()}`;
    if (format === 'xlsx') send(res, await exportXlsx(cases), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${name}.xlsx`);
    else if (format === 'csv') send(res, exportCsv(cases), 'text/csv; charset=utf-8', `${name}.csv`);
    else send(res, await renderCasesPdf(cases), 'application/pdf', `${name}.pdf`, true);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), (_db, client) => loadCase(client, id));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const d = parse(caseSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const id = await createCase(client, companyId, { ...d, date: d.date ?? today() });
      return loadCase(client, id);
    });
  }

  @Post(':id/status')
  status(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const d = parse(statusSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await setStatus(client, companyId, id, { ...d, date: d.date ?? today() });
      return loadCase(client, id);
    });
  }

  /** Skriver av det obetalda som kundförlust. Kräver behörighet att utfärda fakturor. */
  @Post(':id/write-off')
  writeOff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    requireCompany(ctx, 'invoice.issue');
    const d = parse(writeOffSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await writeOff(client, companyId, id, { date: d.date ?? today(), reason: d.reason });
      return loadCase(client, id);
    });
  }

  @Get(':id/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const c = await withContext(dbContext(ctx), (_db, client) => loadCase(client, id));
    send(res, await renderCasesPdf([c]), 'application/pdf', `inkasso-${c.caseNr}.pdf`, true);
  }
}
