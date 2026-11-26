import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isoDate, kronorToOre, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { addDays } from '../contracts/contract-rules';
import { bankDayOnOrAfter, vatFor } from './billing-rules';
import { billToFor, INVOICE_LIST_SQL, insertLines, issueInvoices, loadInvoice, NewLine, paymentState, recalcInvoice, resolveChannel } from './invoice-store';
import { renderInvoicePdf } from './invoice-pdf';
import { peppolXml } from './peppol';
import { sendQueued } from './delivery';

export const ARTICLES = ['rent', 'heating', 'electricity', 'water', 'parking', 'storage', 'service', 'index', 'discount', 'fee', 'other'] as const;

const signedKronor = z
  .number({ invalid_type_error: 'Ange ett belopp' })
  .finite()
  .refine((v) => Math.abs(v) <= 1e10, 'För stort belopp')
  .transform(kronorToOre);

const manualLine = z.object({
  article: z.enum(ARTICLES).default('other'),
  description: z.string().trim().min(1, 'Ange en text').max(300),
  quantity: z.number().finite().positive('Antal måste vara större än noll').max(1e6).default(1),
  unitPrice: signedKronor,
  vatRateBp: z.union([z.literal(0), z.literal(600), z.literal(1200), z.literal(2500)]).default(0),
  objectId: z.string().uuid().nullable().optional(),
  propertyId: z.string().uuid().nullable().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
  periodFrom: isoDate.nullable().optional(),
  periodTo: isoDate.nullable().optional(),
});

const headerSchema = z.object({
  customerId: z.string().uuid(),
  contractId: z.string().uuid().nullable().optional(),
  invoiceDate: isoDate.optional(),
  dueDate: isoDate.nullable().optional(),
  deliveryMethod: z.enum(['email', 'post', 'e_invoice']).nullable().optional(),
  ourReference: z.string().trim().max(100).nullable().optional(),
  yourReference: z.string().trim().max(100).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
});
const createSchema = headerSchema.extend({ lines: z.array(manualLine).max(200).default([]) });

const creditSchema = z.object({
  reason: z.string().trim().min(2, 'Ange orsak').max(300),
  rebill: z.boolean().default(false),
  invoiceDate: isoDate.optional(),
  /** Utelämnat = hela fakturan. Belopp i kronor exkl. moms, positivt. */
  lines: z.array(z.object({ lineId: z.string().uuid(), amount: z.number().finite().positive().optional() })).optional(),
});

const paymentSchema = z.object({
  amount: z.number().finite().positive('Ange ett belopp').max(1e10).transform(kronorToOre),
  paymentDate: isoDate,
  method: z.enum(['bankgiro', 'autogiro', 'swish', 'cash', 'other']).default('bankgiro'),
  reference: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

@Controller('invoices')
export class InvoicesController {
  @Get()
  async list(
    @Ctx() ctx: RequestContext,
    @Query('state') state?: string,
    @Query('kind') kind?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    for (const v of [customerId, contractId]) if (v && !/^[0-9a-f-]{36}$/i.test(v)) throw new BadRequestException('Ogiltigt id');
    const max = Math.min(Number(limit) || 500, 2000);
    const rows = await withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `${INVOICE_LIST_SQL}
           where ($1::uuid is null or i.customer_id = $1) and ($2::uuid is null or i.contract_id = $2)
             and ($3::text is null or i.kind = $3)
             and ($4::text is null or cu.name ilike '%' || $4 || '%' or i.invoice_nr::text = $4 or i.ocr = $4 or k.contract_nr::text = $4)
             and (i.billing_run_id is null or i.status = 'issued' or $1::uuid is not null)
           order by i.status = 'draft' desc, i.invoice_nr desc nulls first, i.created_at desc
           limit ${max}`,
          [customerId || null, contractId || null, kind || null, q?.trim() || null],
        )
      ).rows,
    );
    const t = today();
    const withState = rows.map((r) => ({ ...r, state: paymentState(r, t) }));
    if (!state) return withState;
    if (state === 'open') return withState.filter((r) => ['unpaid', 'partially_paid', 'overdue'].includes(r.state));
    return withState.filter((r) => r.state === state);
  }

  /** Nyckeltal för kundreskontran: obetalt, förfallet och aviserat denna månad. */
  @Get('summary')
  summary(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select
           coalesce(sum(b.balance_ore) filter (where b.balance_ore > 0), 0)::float as "openOre",
           count(*) filter (where b.balance_ore > 0)::int as "openCount",
           coalesce(sum(b.balance_ore) filter (where b.balance_ore > 0 and i.due_date < current_date), 0)::float as "overdueOre",
           count(*) filter (where b.balance_ore > 0 and i.due_date < current_date)::int as "overdueCount",
           coalesce(sum(i.total_ore) filter (where i.kind = 'rent_notice' and date_trunc('month', i.period_from) = date_trunc('month', current_date)), 0)::float as "billedThisMonthOre",
           coalesce(sum(i.net_ore) filter (where i.kind <> 'credit_note' and date_trunc('month', i.invoice_date) = date_trunc('month', current_date)), 0)::float as "invoicedThisMonthNetOre",
           (select count(*) from invoice d where d.status = 'draft' and d.billing_run_id is null)::int as "draftCount"
         from invoice i join invoice_balance b on b.invoice_id = i.id
         where i.status = 'issued'`,
      );
      return rows[0];
    });
  }

  /** Manuell faktura (engångsfaktura) som utkast. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.write');
    const data = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { billTo, deliveryMethod, termsDays } = await billToFor(client, data.customerId);
      await checkContract(client, data.contractId, data.customerId);
      const invoiceDate = data.invoiceDate ?? today();
      const dueDate = data.dueDate ?? bankDayOnOrAfter(addDays(invoiceDate, termsDays));
      if (dueDate < invoiceDate) throw fieldError('dueDate', 'Förfallodagen är före fakturadatum');
      const { rows } = await client.query(
        `insert into invoice (company_id, kind, customer_id, contract_id, invoice_date, due_date, bill_to, delivery_method,
                              our_reference, your_reference, message)
         values ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          companyId,
          data.customerId,
          data.contractId ?? null,
          invoiceDate,
          dueDate,
          JSON.stringify(billTo),
          data.deliveryMethod ?? deliveryMethod,
          data.ourReference ?? null,
          data.yourReference ?? null,
          data.message ?? null,
        ],
      );
      await replaceLines(client, companyId, rows[0].id, data.contractId ?? null, data.lines);
      return loadInvoice(client, rows[0].id);
    });
  }

  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const d = await withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), (_db, client) => loadInvoice(client, id));
    return { ...d, state: paymentState(d, today()) };
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'invoice.write');
    const data = parse(headerSchema.partial(), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const inv = await manualDraft(client, id);
      const customerId = data.customerId ?? inv.customer_id;
      const contractId = data.contractId === undefined ? inv.contract_id : data.contractId;
      await checkContract(client, contractId, customerId);
      const invoiceDate = data.invoiceDate ?? inv.invoice_date;
      const dueDate = data.dueDate ?? inv.due_date;
      if (dueDate < invoiceDate) throw fieldError('dueDate', 'Förfallodagen är före fakturadatum');
      const billTo = customerId !== inv.customer_id ? await billToFor(client, customerId) : null;
      await client.query(
        `update invoice set customer_id = $2, contract_id = $3, invoice_date = $4, due_date = $5,
                delivery_method = coalesce($6, delivery_method), our_reference = $7, your_reference = $8, message = $9,
                bill_to = coalesce($10::jsonb, bill_to)
         where id = $1`,
        [
          id,
          customerId,
          contractId,
          invoiceDate,
          dueDate,
          data.deliveryMethod ?? billTo?.deliveryMethod ?? null,
          data.ourReference === undefined ? inv.our_reference : data.ourReference,
          data.yourReference === undefined ? inv.your_reference : data.yourReference,
          data.message === undefined ? inv.message : data.message,
          billTo ? JSON.stringify(billTo.billTo) : null,
        ],
      );
      return loadInvoice(client, id);
    });
  }

  @Put(':id/lines')
  setLines(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.write');
    const { lines } = parse(z.object({ lines: z.array(manualLine).max(200) }), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const inv = await manualDraft(client, id);
      await replaceLines(client, companyId, id, inv.contract_id, lines);
      return loadInvoice(client, id);
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'invoice.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      await manualDraft(client, id);
      await client.query('delete from invoice where id = $1', [id]);
    });
  }

  /** Utfärdar en manuell faktura: nummer, OCR och låsning. */
  @Post(':id/issue')
  issue(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'invoice.issue');
    return withContext(dbContext(ctx), async (_db, client) => {
      await manualDraft(client, id);
      const { rows } = await client.query('select count(*)::int as n from invoice_line where invoice_id = $1', [id]);
      if (!rows[0].n) throw new BadRequestException('Fakturan har inga rader');
      const d = await loadInvoice(client, id);
      if (d.totalOre <= 0) throw new BadRequestException('Fakturan måste ha ett belopp över noll. Använd kreditering för avdrag.');
      const ch = resolveChannel(d.deliveryMethod, d.billTo);
      if (ch.channel === 'post' && (!d.billTo.addressLine || !d.billTo.postalCode || !d.billTo.city)) {
        throw new BadRequestException('Kunden saknar fullständig postadress och e-post. Komplettera kunduppgifterna först.');
      }
      await issueInvoices(client, companyId, [id]);
      return loadInvoice(client, id);
    });
  }

  @Get(':id/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const d = await this.get(ctx, id);
    const buf = await renderInvoicePdf(d);
    const name = { rent_notice: 'hyresavi', invoice: 'faktura', credit_note: 'kreditfaktura' }[d.kind as string] ?? 'faktura';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}-${d.invoiceNr ?? 'utkast'}.pdf"`);
    res.send(buf);
  }

  @Get(':id/peppol.xml')
  async xml(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const d = await this.get(ctx, id);
    if (d.status !== 'issued') throw new ConflictException('E-faktura skapas när fakturan är utfärdad');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="efaktura-${d.invoiceNr}.xml"`);
    res.send(peppolXml(d));
  }

  /** Skickar fakturan (igen) med kundens leveranssätt, eller med e-post till en angiven adress. */
  @Post(':id/send')
  send(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.issue');
    const { email } = parse(z.object({ email: z.string().trim().email('Ogiltig e-postadress').optional() }), body ?? {});
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await loadInvoice(client, id);
      if (d.status !== 'issued') throw new ConflictException('Fakturan är inte utfärdad');
      let queued = (await client.query(`select id from invoice_delivery where invoice_id = $1 and status = 'queued'`, [id])).rows.map((r) => r.id);
      if (email || !queued.length) {
        const ch = email ? { channel: 'email', recipient: email } : resolveChannel(d.deliveryMethod, d.billTo);
        const { rows } = await client.query(
          `insert into invoice_delivery (company_id, invoice_id, channel, status, recipient) values ($1, $2, $3, 'queued', $4) returning id`,
          [companyId, id, ch.channel, ch.recipient],
        );
        queued = email ? [rows[0].id] : [...queued, rows[0].id];
      }
      return sendQueued(client, queued);
    });
  }

  /**
   * Kreditfaktura för hela eller delar av en utfärdad faktura. Utan rader krediteras allt som återstår.
   * Med rebill aviseras de krediterade perioderna på nytt i nästa körning (till exempel efter fel belopp).
   */
  @Post(':id/credit')
  credit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.issue');
    const data = parse(creditSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await loadInvoice(client, id);
      if (d.status !== 'issued') throw new ConflictException('Bara utfärdade fakturor kan krediteras');
      if (d.kind === 'credit_note') throw new ConflictException('En kreditfaktura kan inte krediteras');
      const wanted = data.lines ?? d.lines.map((l: { id: string }) => ({ lineId: l.id, amount: undefined }));
      const out: NewLine[] = [];
      for (const w of wanted) {
        const l = d.lines.find((x: { id: string }) => x.id === w.lineId);
        if (!l) throw new BadRequestException('Raden finns inte på fakturan');
        const remaining = l.netOre - l.creditedNetOre;
        if (remaining === 0) continue;
        const amount = w.amount === undefined ? remaining : Math.sign(remaining) * kronorToOre(w.amount);
        if (Math.abs(amount) > Math.abs(remaining)) {
          throw new BadRequestException(`Högst ${(Math.abs(remaining) / 100).toLocaleString('sv-SE')} kr kan krediteras på "${l.description}"`);
        }
        out.push({
          lineKind: 'credit',
          contractId: l.contractId,
          contractLineId: l.contractLineId,
          objectId: l.objectId,
          propertyId: l.propertyId,
          costCenterId: l.costCenterId,
          article: l.article,
          description: `Kredit: ${l.description}`,
          periodFrom: l.periodFrom,
          periodTo: l.periodTo,
          unitPriceOre: -amount,
          netOre: -amount,
          vatRateBp: l.vatRateBp,
          vatOre: amount === remaining && amount === l.netOre ? -l.vatOre : -vatFor(amount, l.vatRateBp),
          creditsLineId: l.id,
          rebill: data.rebill && !!l.contractLineId,
        });
      }
      if (!out.length) throw new ConflictException('Fakturan är redan helt krediterad');
      const invoiceDate = data.invoiceDate ?? today();
      const { rows } = await client.query(
        `insert into invoice (company_id, kind, customer_id, contract_id, invoice_date, due_date, period_from, period_to,
                              bill_to, delivery_method, credits_invoice_id, credit_reason)
         select company_id, 'credit_note', customer_id, contract_id, $2, $2, period_from, period_to, bill_to, delivery_method, id, $3
         from invoice where id = $1 returning id`,
        [id, invoiceDate, data.reason],
      );
      const creditId = rows[0].id;
      await insertLines(client, companyId, creditId, out);
      const sums = await recalcInvoice(client, creditId);
      // En helt krediterad faktura ska bli exakt noll, även med öresavrundning
      const fullyCredited = data.lines === undefined && d.creditedOre === 0;
      if (fullyCredited && sums.totalOre !== -d.totalOre) {
        await client.query('update invoice set rounding_ore = $2, total_ore = $3 where id = $1', [
          creditId,
          -d.totalOre - (sums.netOre + sums.vatOre),
          -d.totalOre,
        ]);
      }
      await issueInvoices(client, companyId, [creditId]);
      return loadInvoice(client, creditId);
    });
  }

  /** Registrerar en inbetalning mot fakturan. Överskjutande belopp ligger kvar som ej fördelat på kunden. */
  @Post(':id/payments')
  pay(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const data = parse(paymentSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await loadInvoice(client, id);
      if (d.status !== 'issued' || d.kind === 'credit_note') throw new ConflictException('Betalningar registreras på utfärdade fakturor');
      if (d.balanceOre <= 0) throw new ConflictException('Fakturan är redan betald');
      const { rows } = await client.query(
        `insert into payment (company_id, customer_id, amount_ore, payment_date, method, reference, note)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [companyId, d.customerId, data.amount, data.paymentDate, data.method, data.reference ?? d.ocr, data.note ?? null],
      );
      const allocated = Math.min(data.amount, d.balanceOre);
      await client.query(
        `insert into payment_allocation (company_id, payment_id, invoice_id, amount_ore) values ($1, $2, $3, $4)`,
        [companyId, rows[0].id, id, allocated],
      );
      const out = await loadInvoice(client, id);
      return { ...out, state: paymentState(out, today()), unallocatedOre: data.amount - allocated };
    });
  }
}

async function manualDraft(client: PoolClient, id: string) {
  const { rows } = await client.query(
    `select id, kind, status, customer_id, contract_id, invoice_date::text, due_date::text, our_reference, your_reference, message, billing_run_id
     from invoice where id = $1 for update`,
    [id],
  );
  const inv = rows[0];
  if (!inv) throw new BadRequestException('Fakturan finns inte i valt bolag');
  if (inv.status !== 'draft') throw new ConflictException('Fakturan är utfärdad och kan inte ändras. Gör en kreditfaktura i stället.');
  if (inv.billing_run_id) throw new ConflictException('Avin hör till en aviseringskörning och ändras via avtalet och körningen');
  return inv;
}

async function checkContract(client: PoolClient, contractId: string | null | undefined, customerId: string) {
  if (!contractId) return;
  const { rows } = await client.query('select customer_id from contract where id = $1', [contractId]);
  if (!rows[0]) throw fieldError('contractId', 'Avtalet finns inte i valt bolag');
  if (rows[0].customer_id !== customerId) throw fieldError('contractId', 'Avtalet tillhör en annan kund');
}

async function replaceLines(client: PoolClient, companyId: string, invoiceId: string, contractId: string | null, lines: z.output<typeof manualLine>[]) {
  await client.query('delete from invoice_line where invoice_id = $1', [invoiceId]);
  const out: NewLine[] = [];
  for (const l of lines) {
    let propertyId = l.propertyId ?? null;
    let costCenterId = l.costCenterId ?? null;
    if (l.objectId) {
      const o = (
        await client.query('select o.property_id, p.cost_center_id from rental_object o join property p on p.id = o.property_id where o.id = $1', [l.objectId])
      ).rows[0];
      if (!o) throw new BadRequestException('Objektet finns inte i valt bolag');
      propertyId = propertyId ?? o.property_id;
      costCenterId = costCenterId ?? o.cost_center_id;
    } else if (propertyId && !costCenterId) {
      costCenterId = (await client.query('select cost_center_id from property where id = $1', [propertyId])).rows[0]?.cost_center_id ?? null;
    }
    if (l.periodFrom && l.periodTo && l.periodTo < l.periodFrom) throw new BadRequestException('Periodens slut är före början');
    const net = Math.round(l.unitPrice * l.quantity);
    out.push({
      lineKind: 'manual',
      contractId,
      objectId: l.objectId ?? null,
      propertyId,
      costCenterId,
      article: l.article,
      description: l.description,
      periodFrom: l.periodFrom ?? null,
      periodTo: l.periodTo ?? null,
      quantity: l.quantity,
      unitPriceOre: l.unitPrice,
      netOre: net,
      vatRateBp: l.vatRateBp,
      vatOre: vatFor(net, l.vatRateBp),
    });
  }
  await insertLines(client, companyId, invoiceId, out);
  await recalcInvoice(client, invoiceId);
}

function fieldError(path: string, message: string) {
  return new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path, message }] });
}
