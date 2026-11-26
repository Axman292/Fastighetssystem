import {
  BadRequestException,
  Body,
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isoDate, kronorToOre } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany, requirePermission } from '../auth/request-context';

const signedKronor = z.number({ invalid_type_error: 'Ange ett belopp' }).finite().min(-1e12).max(1e12).transform(kronorToOre);

const lineSchema = z.object({
  accountNumber: z.string().regex(/^\d{4}$/, 'Ange ett fyrsiffrigt konto'),
  description: z.string().trim().max(300).nullable().optional(),
  propertyId: z.string().uuid().nullable().optional(),
  objectId: z.string().uuid().nullable().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
  net: signedKronor,
  vat: signedKronor.optional(),
  vatDeductible: z.boolean().optional(),
  periodFrom: isoDate.nullable().optional(),
  periodTo: isoDate.nullable().optional(),
});

const invoiceSchema = z
  .object({
    supplierId: z.string().uuid({ message: 'Välj leverantör' }),
    kind: z.enum(['invoice', 'credit_note']).default('invoice'),
    invoiceNr: z.string().trim().min(1, 'Ange leverantörens fakturanummer').max(60),
    invoiceDate: isoDate,
    dueDate: isoDate.nullable().optional(),
    ocr: z
      .string()
      .trim()
      .max(30)
      .nullable()
      .optional()
      .transform((v) => (v ? v.replace(/\s/g, '') : null)),
    description: z.string().trim().max(300).nullable().optional(),
    net: signedKronor,
    vat: signedKronor.default(0),
    total: signedKronor.nullable().optional(),
    lines: z.array(lineSchema).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    const total = v.total ?? v.net + v.vat;
    const rounding = total - v.net - v.vat;
    if (Math.abs(rounding) > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'Att betala ska vara netto plus moms (öresavrundning högst 1 kr)' });
    }
    const sign = v.kind === 'credit_note' ? -1 : 1;
    if (total * sign < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total'],
        message: v.kind === 'credit_note' ? 'En kreditfaktura ska ha ett negativt belopp' : 'En faktura kan inte ha ett negativt belopp. Välj kreditfaktura.',
      });
    }
    if (v.dueDate && v.dueDate < v.invoiceDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: 'Förfallodagen kan inte vara före fakturadatum' });
    }
    v.lines.forEach((l, i) => {
      if (!!l.periodFrom !== !!l.periodTo) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'periodTo'], message: 'Ange både från och till för perioden' });
      } else if (l.periodFrom && l.periodTo && l.periodTo < l.periodFrom) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'periodTo'], message: 'Perioden slutar före den börjar' });
      }
    });
  });

type InvoiceInput = z.output<typeof invoiceSchema>;

const paymentSchema = z.object({
  paidDate: isoDate,
  amount: signedKronor.optional(),
  method: z.enum(['bankgiro', 'plusgiro', 'bank_transfer', 'autogiro', 'card', 'offset', 'other']).default('bankgiro'),
  reference: z.string().trim().max(100).nullable().optional(),
});

const LIST_SQL = `
  select i.id, i.company_id as "companyId", co.name as "companyName", i.entry_nr as "entryNr", i.kind, i.status,
         i.supplier_id as "supplierId", s.name as "supplierName", s.supplier_nr as "supplierNr",
         i.invoice_nr as "invoiceNr", i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate", i.ocr, i.description,
         i.net_ore::float as "netOre", i.vat_ore::float as "vatOre", i.total_ore::float as "totalOre",
         b.paid_ore::float as "paidOre", b.balance_ore::float as "balanceOre",
         (i.status in ('registered','approved') and i.due_date < current_date) as overdue,
         i.document_id is not null as "hasDocument",
         (select string_agg(distinct p.name, ', ') from supplier_invoice_line l join property p on p.id = l.property_id
           where l.supplier_invoice_id = i.id) as "properties",
         (select coalesce(sum(l.net_ore), 0) = i.net_ore and coalesce(sum(l.vat_ore), 0) = i.vat_ore and count(*) > 0
           from supplier_invoice_line l where l.supplier_invoice_id = i.id) as "fullyCoded"
  from supplier_invoice i
  join supplier s on s.id = i.supplier_id
  join company co on co.id = i.company_id
  join supplier_invoice_balance b on b.supplier_invoice_id = i.id`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function event(client: PoolClient, companyId: string, invoiceId: string, ev: string, note: string | null = null) {
  await client.query('insert into supplier_invoice_event (company_id, supplier_invoice_id, event, note) values ($1,$2,$3,$4)', [companyId, invoiceId, ev, note]);
}

/** Kontrollerar och kompletterar raderna: objektets fastighet, kostnadsställe i rätt bolag, konto i kontoplanen. */
async function prepareLines(client: PoolClient, companyId: string, lines: InvoiceInput['lines']) {
  const out = [];
  const bad = (i: number, field: string, message: string) => {
    throw new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path: `lines.${i}.${field}`, message }] });
  };
  for (const [i, l] of lines.entries()) {
    const acc = (await client.query('select active from account where company_id = $1 and number = $2', [companyId, l.accountNumber])).rows[0];
    if (!acc) bad(i, 'accountNumber', `Konto ${l.accountNumber} finns inte i kontoplanen`);
    let propertyId = l.propertyId ?? null;
    if (l.objectId) {
      const o = (await client.query('select property_id from rental_object where id = $1 and company_id = $2', [l.objectId, companyId])).rows[0];
      if (!o) bad(i, 'objectId', 'Objektet finns inte i bolaget');
      if (propertyId && propertyId !== o.property_id) bad(i, 'objectId', 'Objektet hör till en annan fastighet');
      propertyId = o.property_id;
    }
    if (propertyId && !(await client.query('select 1 from property where id = $1 and company_id = $2', [propertyId, companyId])).rows[0]) {
      bad(i, 'propertyId', 'Fastigheten finns inte i bolaget');
    }
    if (l.costCenterId && !(await client.query('select 1 from cost_center where id = $1 and company_id = $2', [l.costCenterId, companyId])).rows[0]) {
      bad(i, 'costCenterId', 'Kostnadsstället finns inte i bolaget');
    }
    out.push({ ...l, propertyId, vat: l.vat ?? 0, vatDeductible: l.vatDeductible ?? true });
  }
  return out;
}

async function writeLines(client: PoolClient, companyId: string, invoiceId: string, lines: Awaited<ReturnType<typeof prepareLines>>) {
  await client.query('delete from supplier_invoice_line where supplier_invoice_id = $1', [invoiceId]);
  for (const [pos, l] of lines.entries()) {
    await client.query(
      `insert into supplier_invoice_line (company_id, supplier_invoice_id, position, account_number, description, property_id, object_id,
         cost_center_id, net_ore, vat_ore, vat_deductible, period_from, period_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [companyId, invoiceId, pos, l.accountNumber, l.description ?? null, l.propertyId, l.objectId ?? null, l.costCenterId ?? null,
       l.net, l.vat, l.vatDeductible, l.periodFrom ?? null, l.periodTo ?? null],
    );
  }
}

async function headerValues(client: PoolClient, data: InvoiceInput) {
  const s = (await client.query('select payment_terms_days, active from supplier where id = $1', [data.supplierId])).rows[0];
  if (!s) throw new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path: 'supplierId', message: 'Leverantören finns inte i valt bolag' }] });
  const total = data.total ?? data.net + data.vat;
  return {
    dueDate: data.dueDate ?? addDays(data.invoiceDate, s.payment_terms_days),
    total,
    rounding: total - data.net - data.vat,
  };
}

export interface VerificationRow {
  account: string;
  accountName: string | null;
  debitOre: number;
  creditOre: number;
  propertyName: string | null;
  costCenter: string | null;
  text: string | null;
}

/**
 * Bokföringsunderlag för fakturan (leverantörsskuld vid registrering):
 * kostnadskonton per rad i debet, avdragsgill moms på 2640 och leverantörsskulden på 2440 i kredit.
 * Ej avdragsgill moms läggs på kostnaden.
 */
export function supplierInvoiceVerification(
  inv: { totalOre: number; roundingOre: number },
  lines: { accountNumber: string; accountName: string | null; netOre: number; vatOre: number; vatDeductible: boolean; propertyName: string | null; costCenter: string | null; description: string | null }[],
): VerificationRow[] {
  const rows: VerificationRow[] = [];
  const push = (account: string, accountName: string | null, amount: number, extra: Partial<VerificationRow> = {}) => {
    if (!amount) return;
    rows.push({ account, accountName, debitOre: amount > 0 ? amount : 0, creditOre: amount < 0 ? -amount : 0, propertyName: null, costCenter: null, text: null, ...extra });
  };
  let vat = 0;
  for (const l of lines) {
    push(l.accountNumber, l.accountName, l.netOre + (l.vatDeductible ? 0 : l.vatOre), { propertyName: l.propertyName, costCenter: l.costCenter, text: l.description });
    if (l.vatDeductible) vat += l.vatOre;
  }
  push('2640', 'Ingående moms', vat);
  push('3740', 'Öres- och kronutjämning', inv.roundingOre);
  push('2440', 'Leverantörsskulder', -inv.totalOre);
  return rows;
}

function statusFilter(status?: string): string {
  switch (status) {
    case 'to_approve':
      return `i.status = 'registered'`;
    case 'to_pay':
      return `i.status = 'approved'`;
    case 'overdue':
      return `i.status in ('registered','approved') and i.due_date < current_date`;
    case 'unpaid':
      return `i.status in ('registered','approved')`;
    case 'paid':
      return `i.status = 'paid'`;
    case 'cancelled':
      return `i.status = 'cancelled'`;
    default:
      return 'true';
  }
}

@Controller('supplier-invoices')
export class SupplierInvoicesController {
  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string,
    @Query('propertyId') propertyId?: string,
    @Query('q') q?: string,
  ) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const where = [statusFilter(status)];
      const params: unknown[] = [];
      if (supplierId) {
        params.push(supplierId);
        where.push(`i.supplier_id = $${params.length}::uuid`);
      }
      if (propertyId) {
        params.push(propertyId);
        where.push(`exists (select 1 from supplier_invoice_line l where l.supplier_invoice_id = i.id and l.property_id = $${params.length}::uuid)`);
      }
      if (q?.trim()) {
        params.push(`%${q.trim()}%`);
        where.push(`(s.name ilike $${params.length} or i.invoice_nr ilike $${params.length} or i.ocr ilike $${params.length} or i.description ilike $${params.length})`);
      }
      return (await client.query(`${LIST_SQL} where ${where.join(' and ')} order by i.invoice_date desc, i.entry_nr desc limit 500`, params)).rows;
    });
  }

  /** Leverantörsreskontra: obetalt per leverantör med åldersanalys, och antal per läge. */
  @Get('ledger')
  ledger(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const suppliers = (
        await client.query(
          `select s.id as "supplierId", s.name as "supplierName", s.supplier_nr as "supplierNr", co.name as "companyName",
                  count(*)::int as "invoiceCount",
                  sum(b.balance_ore)::float as "balanceOre",
                  coalesce(sum(b.balance_ore) filter (where i.due_date >= current_date), 0)::float as "notDueOre",
                  coalesce(sum(b.balance_ore) filter (where current_date - i.due_date between 1 and 30), 0)::float as "d1to30Ore",
                  coalesce(sum(b.balance_ore) filter (where current_date - i.due_date between 31 and 60), 0)::float as "d31to60Ore",
                  coalesce(sum(b.balance_ore) filter (where current_date - i.due_date > 60), 0)::float as "over60Ore",
                  min(i.due_date)::text as "nextDueDate"
           from supplier_invoice i join supplier s on s.id = i.supplier_id join company co on co.id = i.company_id
           join supplier_invoice_balance b on b.supplier_invoice_id = i.id
           where i.status in ('registered','approved') and b.balance_ore <> 0
           group by s.id, co.name order by s.name`,
        )
      ).rows;
      const counts = (
        await client.query(
          `select count(*) filter (where i.status = 'registered')::int as "toApprove",
                  coalesce(sum(i.total_ore) filter (where i.status = 'registered'), 0)::float as "toApproveOre",
                  count(*) filter (where i.status = 'approved')::int as "toPay",
                  coalesce(sum(b.balance_ore) filter (where i.status = 'approved'), 0)::float as "toPayOre",
                  count(*) filter (where i.status in ('registered','approved') and i.due_date < current_date)::int as "overdue",
                  coalesce(sum(b.balance_ore) filter (where i.status in ('registered','approved') and i.due_date < current_date), 0)::float as "overdueOre",
                  count(*) filter (where i.status in ('registered','approved') and i.due_date between current_date and current_date + 7)::int as "dueThisWeek",
                  coalesce(sum(b.balance_ore) filter (where i.status in ('registered','approved') and i.due_date between current_date and current_date + 7), 0)::float as "dueThisWeekOre"
           from supplier_invoice i join supplier_invoice_balance b on b.supplier_invoice_id = i.id`,
        )
      ).rows[0];
      return { counts, suppliers };
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier_invoice.write');
    const data = parse(invoiceSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const h = await headerValues(client, data);
      const lines = await prepareLines(client, companyId, data.lines);
      const dup = (
        await client.query('select entry_nr from supplier_invoice where company_id = $1 and supplier_id = $2 and invoice_nr = $3', [companyId, data.supplierId, data.invoiceNr])
      ).rows[0];
      if (dup) {
        throw new BadRequestException({
          message: `Fakturan är redan registrerad (löpnummer ${dup.entry_nr})`,
          fields: [{ path: 'invoiceNr', message: `Leverantörens faktura ${data.invoiceNr} är redan registrerad` }],
        });
      }
      await client.query(`select pg_advisory_xact_lock(hashtext('supplier_invoice.entry_nr:' || $1))`, [companyId]);
      const nr = Number((await client.query('select coalesce(max(entry_nr), 0) + 1 as nr from supplier_invoice where company_id = $1', [companyId])).rows[0].nr);
      const { rows } = await client.query(
        `insert into supplier_invoice (company_id, entry_nr, kind, supplier_id, invoice_nr, invoice_date, due_date, ocr, description,
           net_ore, vat_ore, rounding_ore, total_ore)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [companyId, nr, data.kind, data.supplierId, data.invoiceNr, data.invoiceDate, h.dueDate, data.ocr, data.description ?? null,
         data.net, data.vat, h.rounding, h.total],
      );
      const id = rows[0].id;
      await writeLines(client, companyId, id, lines);
      await event(client, companyId, id, 'registered');
      return { id, entryNr: nr };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const inv = (
        await client.query(
          `${LIST_SQL.replace('from supplier_invoice i', `, i.rounding_ore::float as "roundingOre", i.cancel_reason as "cancelReason",
             i.approved_at as "approvedAt", (select name from app_user u where u.id = i.approved_by) as "approvedByName",
             i.created_at as "createdAt", (select name from app_user u where u.id = i.created_by) as "createdByName",
             s.bankgiro as "supplierBankgiro", s.plusgiro as "supplierPlusgiro",
             d.file_name as "documentName", d.size_bytes::int as "documentSize"
           from supplier_invoice i left join document d on d.id = i.document_id`)} where i.id = $1`,
          [id],
        )
      ).rows[0];
      if (!inv) throw new NotFoundException('Fakturan finns inte');
      const lines = (
        await client.query(
          `select l.id, l.position, l.account_number as "accountNumber", a.name as "accountName", l.description,
                  l.property_id as "propertyId", p.name as "propertyName", l.object_id as "objectId", o.object_nr as "objectNr",
                  l.cost_center_id as "costCenterId", cc.code || ' ' || cc.name as "costCenter",
                  l.net_ore::float as "netOre", l.vat_ore::float as "vatOre", l.vat_deductible as "vatDeductible",
                  l.period_from::text as "periodFrom", l.period_to::text as "periodTo"
           from supplier_invoice_line l
           left join account a on a.company_id = l.company_id and a.number = l.account_number
           left join property p on p.id = l.property_id
           left join rental_object o on o.id = l.object_id
           left join cost_center cc on cc.id = l.cost_center_id
           where l.supplier_invoice_id = $1 order by l.position`,
          [id],
        )
      ).rows;
      const payments = (
        await client.query(
          `select p.id, p.paid_date::text as "paidDate", p.amount_ore::float as "amountOre", p.method, p.reference, p.created_at as "createdAt",
                  (select name from app_user u where u.id = p.created_by) as "createdByName"
           from supplier_invoice_payment p where p.supplier_invoice_id = $1 order by p.paid_date, p.created_at`,
          [id],
        )
      ).rows;
      const events = (
        await client.query(
          `select e.event, e.note, e.created_at as "createdAt", (select name from app_user u where u.id = e.created_by) as "userName"
           from supplier_invoice_event e where e.supplier_invoice_id = $1 order by e.created_at`,
          [id],
        )
      ).rows;
      const verification = supplierInvoiceVerification(inv, lines);
      return { ...inv, lines, payments, events, verification };
    });
  }

  /** Ändrar en registrerad (ej attesterad) faktura: uppgifter och kontering. */
  @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier_invoice.write');
    const data = parse(invoiceSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select status from supplier_invoice where id = $1 for update', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status !== 'registered') throw new BadRequestException('Fakturan är attesterad och kan inte ändras. Ta bort attesten först.');
      const h = await headerValues(client, data);
      const lines = await prepareLines(client, companyId, data.lines);
      await client.query(
        `update supplier_invoice set kind = $2, supplier_id = $3, invoice_nr = $4, invoice_date = $5, due_date = $6, ocr = $7, description = $8,
           net_ore = $9, vat_ore = $10, rounding_ore = $11, total_ore = $12 where id = $1`,
        [id, data.kind, data.supplierId, data.invoiceNr, data.invoiceDate, h.dueDate, data.ocr, data.description ?? null, data.net, data.vat, h.rounding, h.total],
      );
      await writeLines(client, companyId, id, lines);
      await event(client, companyId, id, 'updated');
      return { id };
    });
  }

  /** Tar bort en registrerad faktura som lagts in av misstag. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'supplier_invoice.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select status, document_id from supplier_invoice where id = $1', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status !== 'registered') throw new BadRequestException('En attesterad faktura kan inte tas bort. Makulera den i stället.');
      await client.query('delete from supplier_invoice where id = $1', [id]);
      if (cur.document_id) await client.query('delete from document where id = $1', [cur.document_id]);
    });
  }

  /** Attest: fakturan godkänns för betalning och låses. */
  @Post(':id/approve')
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'supplier_invoice.approve');
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select status from supplier_invoice where id = $1 for update', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status !== 'registered') throw new BadRequestException('Fakturan är redan attesterad eller makulerad');
      const sums = (
        await client.query(
          `select count(l.id)::int as n, coalesce(sum(l.net_ore), 0)::float as net, coalesce(sum(l.vat_ore), 0)::float as vat,
                  i.net_ore::float as "invNet", i.vat_ore::float as "invVat"
           from supplier_invoice i left join supplier_invoice_line l on l.supplier_invoice_id = i.id where i.id = $1 group by i.id`,
          [id],
        )
      ).rows[0];
      if (!sums.n) throw new BadRequestException('Kontera fakturan innan den attesteras');
      if (sums.net !== sums.invNet || sums.vat !== sums.invVat) {
        throw new BadRequestException(
          `Konteringen summerar inte till fakturan. Rader: netto ${(sums.net / 100).toFixed(2)}, moms ${(sums.vat / 100).toFixed(2)} kr. Faktura: netto ${(sums.invNet / 100).toFixed(2)}, moms ${(sums.invVat / 100).toFixed(2)} kr.`,
        );
      }
      await client.query(`update supplier_invoice set status = 'approved', approved_at = now(), approved_by = app.current_user_id() where id = $1`, [id]);
      await event(client, companyId, id, 'approved');
      return { ok: true };
    });
  }

  @Post(':id/unapprove')
  unapprove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'supplier_invoice.approve');
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select status from supplier_invoice where id = $1 for update', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status !== 'approved') throw new BadRequestException('Fakturan är inte attesterad, eller redan betald');
      await client.query(`update supplier_invoice set status = 'registered', approved_at = null, approved_by = null where id = $1`, [id]);
      await event(client, companyId, id, 'unapproved');
      return { ok: true };
    });
  }

  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier_invoice.write');
    const { reason } = parse(z.object({ reason: z.string().trim().min(2, 'Ange varför fakturan makuleras').max(300) }), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select status from supplier_invoice where id = $1 for update', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status === 'cancelled') throw new BadRequestException('Fakturan är redan makulerad');
      if (cur.status === 'paid') throw new BadRequestException('Fakturan är betald och kan inte makuleras');
      if (cur.status === 'approved') requirePermission(ctx, companyId, 'supplier_invoice.approve');
      await client.query(`update supplier_invoice set status = 'cancelled', cancelled_at = now(), cancelled_by = app.current_user_id(), cancel_reason = $2 where id = $1`, [id, reason]);
      await event(client, companyId, id, 'cancelled', reason);
      return { ok: true };
    });
  }

  /** Registrerar betalning. Utan belopp betalas det som är kvar. */
  @Post(':id/payments')
  pay(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'supplier_invoice.pay');
    const data = parse(paymentSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (
        await client.query(
          `select i.status, b.balance_ore::float as balance from supplier_invoice i join supplier_invoice_balance b on b.supplier_invoice_id = i.id where i.id = $1`,
          [id],
        )
      ).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status === 'registered') throw new BadRequestException('Fakturan måste attesteras innan den betalas');
      if (cur.status !== 'approved') throw new BadRequestException('Fakturan är redan betald eller makulerad');
      const amount = data.amount ?? cur.balance;
      if (!amount) throw new BadRequestException('Inget kvar att betala');
      await client.query(
        `insert into supplier_invoice_payment (company_id, supplier_invoice_id, paid_date, amount_ore, method, reference) values ($1,$2,$3,$4,$5,$6)`,
        [companyId, id, data.paidDate, amount, data.method, data.reference ?? null],
      );
      const left = cur.balance - amount;
      if (left === 0) await client.query(`update supplier_invoice set status = 'paid' where id = $1`, [id]);
      await event(client, companyId, id, 'paid', `${(amount / 100).toFixed(2)} kr ${data.paidDate}`);
      return { ok: true, balanceOre: left };
    });
  }

  @Delete(':id/payments/:paymentId')
  @HttpCode(204)
  async removePayment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    const companyId = requireCompany(ctx, 'supplier_invoice.pay');
    await withContext(dbContext(ctx), async (_db, client) => {
      const p = (await client.query('select amount_ore::float as amount, paid_date::text as d from supplier_invoice_payment where id = $1 and supplier_invoice_id = $2', [paymentId, id])).rows[0];
      if (!p) throw new NotFoundException('Betalningen finns inte');
      await client.query('delete from supplier_invoice_payment where id = $1', [paymentId]);
      await client.query(`update supplier_invoice set status = 'approved' where id = $1 and status = 'paid'`, [id]);
      await event(client, companyId, id, 'payment_removed', `${(p.amount / 100).toFixed(2)} kr ${p.d}`);
    });
  }

  /** Bifogar fakturan som PDF eller bild. Ersätter tidigare bifogad fil. */
  @Post(':id/document')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  attach(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    const companyId = requireCompany(ctx, 'supplier_invoice.write');
    if (!file?.buffer?.length) throw new BadRequestException('Välj en fil');
    const mime = file.mimetype || 'application/octet-stream';
    if (!/^(application\/pdf|image\/(png|jpeg|webp|tiff))$/.test(mime)) throw new BadRequestException('Bifoga fakturan som PDF eller bild');
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = (await client.query('select document_id, status from supplier_invoice where id = $1 for update', [id])).rows[0];
      if (!cur) throw new NotFoundException('Fakturan finns inte i valt bolag');
      if (cur.status === 'cancelled') throw new BadRequestException('Fakturan är makulerad');
      // Bokföringslagen: underlaget sparas i minst sju år efter räkenskapsårets slut
      const retain = `${new Date().getFullYear() + 8}-01-01`;
      const doc = (
        await client.query(
          `insert into document (company_id, kind, file_name, mime_type, sha256, size_bytes, entity_type, entity_id, retain_until)
           values ($1, 'supplier_invoice', $2, $3, $4, $5, 'supplier_invoice', $6, $7) returning id`,
          [companyId, (file.originalname || 'faktura.pdf').slice(0, 200), mime, createHash('sha256').update(file.buffer).digest('hex'), file.size, id, retain],
        )
      ).rows[0];
      await client.query('insert into document_content (id, company_id, content) values ($1,$2,$3)', [doc.id, companyId, file.buffer]);
      await client.query('update supplier_invoice set document_id = $2 where id = $1', [id, doc.id]);
      await event(client, companyId, id, 'document', file.originalname || null);
      return { documentId: doc.id };
    });
  }

  @Get(':id/document')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const doc = await withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) =>
      (
        await client.query(
          `select d.file_name, d.mime_type, c.content from supplier_invoice i join document d on d.id = i.document_id
           join document_content c on c.id = d.id where i.id = $1`,
          [id],
        )
      ).rows[0],
    );
    if (!doc) throw new NotFoundException('Ingen fil bifogad');
    res.setHeader('content-type', doc.mime_type);
    res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    res.send(doc.content);
  }
}
