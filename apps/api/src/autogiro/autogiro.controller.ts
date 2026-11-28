import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { luhnValid, normalizeOrgNr, parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { normalizePersonalId } from '../customers/customers.controller';
import { AutogiroFileError, parseAutogiroFile } from './autogiro-format';
import { cancelMandate, createMandateFile, createPaymentFile, importIncoming, loadSettings, planPayments } from './autogiro-store';
import { renderMandateForm } from './mandate-pdf';

const settingsSchema = z.object({
  enabled: z.boolean(),
  customerNr: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, 'Kundnumret hos Bankgirot är högst sex siffror')
    .nullable()
    .optional()
    .transform((v) => v || null),
  bankgiro: z
    .string()
    .trim()
    .regex(/^\d{3,4}-?\d{4}$/, 'Ange bankgiro som 123-4567 eller 1234-5678')
    .nullable()
    .optional()
    .or(z.literal(''))
    .transform((v) => v || null),
});

/** Personnummer eller organisationsnummer till Bankgirots tolv siffror. */
export function holderId(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  // Organisationsnummer har 2 i tredje siffran (månad 20 eller mer)
  if (digits.length === 10 && Number(digits.slice(2, 4)) >= 20 && luhnValid(digits)) return `00${digits}`;
  if (digits.length === 12 && digits.startsWith('00') && luhnValid(digits.slice(2))) return digits;
  const p = normalizePersonalId(input);
  if (p) return p.replace('-', '');
  const o = normalizeOrgNr(input);
  return o ? `00${o.replace('-', '')}` : null;
}

const mandateSchema = z.object({
  customerId: z.string().uuid(),
  payerNr: z
    .string()
    .trim()
    .regex(/^\d{1,16}$/, 'Betalarnumret ska vara siffror (högst 16)')
    .optional(),
  clearingNr: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => /^\d{4,5}$/.test(v), 'Clearingnumret har fyra eller fem siffror'),
  accountNr: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => /^\d{1,12}$/.test(v), 'Ange kontonumret med siffror'),
  holderId: z.string().trim().min(10, 'Ange kontohavarens personnummer eller organisationsnummer'),
  holderName: z.string().trim().max(200).nullable().optional(),
  signedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * Swedbank har femsiffriga clearingnummer (8xxx-x). Bankgirot vill ha de fyra första
 * siffrorna som clearingnummer och femte siffran först i kontonumret.
 */
export function splitClearing(clearing: string, account: string): { clearingNr: string; accountNr: string } {
  if (clearing.length === 5) return { clearingNr: clearing.slice(0, 4), accountNr: `${clearing.slice(4)}${account}`.slice(-12) };
  return { clearingNr: clearing, accountNr: account };
}

const MANDATE_SQL = `
  select m.id, m.customer_id as "customerId", c.name as "customerName", c.customer_nr as "customerNr", m.payer_nr as "payerNr",
         m.clearing_nr as "clearingNr", m.account_nr as "accountNr", m.holder_id as "holderId", m.holder_name as "holderName",
         m.source, m.status, m.response, m.signed_date::text as "signedDate", m.info_code as "infoCode", m.comment_code as "commentCode",
         m.bgc_message as "bgcMessage", m.activated_date::text as "activatedDate", m.cancelled_date::text as "cancelledDate", m.note,
         m.created_at as "createdAt",
         (select count(*)::int from autogiro_payment p where p.mandate_id = m.id and p.status in ('planned','sent')) as "openPayments"
  from autogiro_mandate m join customer c on c.id = m.customer_id`;

const PAYMENT_SQL = `
  select p.id, p.invoice_id as "invoiceId", i.invoice_nr::float as "invoiceNr", p.customer_id as "customerId", c.name as "customerName",
         c.customer_nr as "customerNr", p.payer_nr as "payerNr", p.amount_ore::float as "amountOre", p.payment_date::text as "paymentDate",
         p.reference, p.status, p.status_code as "statusCode", p.message, p.file_id as "fileId", p.payment_id as "paymentId",
         i.billing_run_id as "billingRunId", b.balance_ore::float as "balanceOre",
         (select d.channel from invoice_delivery d where d.id = p.fallback_delivery_id) as "fallbackChannel",
         (select d.status from invoice_delivery d where d.id = p.fallback_delivery_id) as "fallbackStatus",
         p.created_at as "createdAt"
  from autogiro_payment p join customer c on c.id = p.customer_id join invoice i on i.id = p.invoice_id
  join invoice_balance b on b.invoice_id = i.id`;

const FILE_SQL = `
  select f.id, f.direction, f.kind, f.filename, f.record_count as "recordCount", f.total_ore::float as "totalOre",
         f.file_date::text as "fileDate", f.status, f.uploaded_at as "uploadedAt", f.result, f.created_at as "createdAt",
         (select name from app_user u where u.id = f.created_by) as "createdByName"
  from autogiro_file f`;

@Controller('autogiro')
export class AutogiroController {
  @Get('overview')
  overview(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const counts = (
        await client.query(
          `select
             (select count(*) from autogiro_mandate where status = 'active')::int as active,
             (select count(*) from autogiro_mandate where status = 'review')::int as review,
             (select count(*) from autogiro_mandate where status in ('new','cancel_new'))::int as "toSend",
             (select count(*) from autogiro_mandate where status in ('sent','cancel_sent'))::int as waiting,
             (select count(*) from autogiro_payment where status = 'planned')::int as planned,
             (select coalesce(sum(amount_ore), 0)::float from autogiro_payment where status = 'planned') as "plannedOre",
             (select count(*) from autogiro_payment where status = 'sent')::int as sent,
             (select count(*) from autogiro_payment where status = 'failed' and created_at > now() - interval '90 days')::int as failed`,
        )
      ).rows[0];
      const settings = ctx.activeCompanyId ? await loadSettings(client, ctx.activeCompanyId) : null;
      return { counts, settings };
    });
  }

  @Put('settings')
  saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const s = parse(settingsSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (s.enabled && !s.customerNr) throw new BadRequestException('Ange kundnumret hos Bankgirot för att slå på autogiro');
      const bg = s.bankgiro && !s.bankgiro.includes('-') ? `${s.bankgiro.slice(0, -4)}-${s.bankgiro.slice(-4)}` : s.bankgiro;
      await client.query(`update company set autogiro_enabled = $2, autogiro_customer_nr = $3, autogiro_bankgiro = $4 where id = $1`, [
        companyId,
        s.enabled,
        s.customerNr,
        bg,
      ]);
      return loadSettings(client, companyId);
    });
  }

  // -------------------------------------------------------------------
  // Medgivanden
  // -------------------------------------------------------------------

  @Get('mandates')
  mandates(@Ctx() ctx: RequestContext, @Query('customerId') customerId?: string) {
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new BadRequestException('Ogiltigt id');
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `${MANDATE_SQL} where ($1::uuid is null or m.customer_id = $1)
           order by (m.status in ('rejected','cancelled')), c.name, m.created_at desc limit 2000`,
          [customerId || null],
        )
      ).rows,
    );
  }

  /** Registrerar ett påskrivet medgivande. Det skickas till Bankgirot med nästa medgivandefil. */
  @Post('mandates')
  createMandate(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const d = parse(mandateSchema, body);
    const holder = holderId(d.holderId);
    if (!holder) throw new BadRequestException('Kontrollera personnumret eller organisationsnumret');
    const acc = splitClearing(d.clearingNr, d.accountNr);
    return withContext(dbContext(ctx), async (_db, client) => {
      const c = (await client.query('select customer_nr from customer where id = $1', [d.customerId])).rows[0];
      if (!c) throw new BadRequestException('Hyresgästen finns inte i valt bolag');
      const payerNr = d.payerNr?.replace(/^0+(?=\d)/, '') ?? String(c.customer_nr);
      const busy = (
        await client.query(
          `select c.name, m.customer_id from autogiro_mandate m join customer c on c.id = m.customer_id
           where (m.customer_id = $1 or m.payer_nr = $2) and m.status not in ('rejected','cancelled')`,
          [d.customerId, payerNr],
        )
      ).rows[0];
      if (busy) {
        throw new ConflictException(
          busy.customer_id === d.customerId
            ? 'Hyresgästen har redan ett medgivande. Makulera det först om kontot ska bytas.'
            : `Betalarnumret ${payerNr} används redan av ${busy.name}`,
        );
      }
      const r = await client.query(
        `insert into autogiro_mandate (company_id, customer_id, payer_nr, clearing_nr, account_nr, holder_id, holder_name, source, status, signed_date, note)
         values ($1, $2, $3, $4, $5, $6, $7, 'form', 'new', $8, $9) returning id`,
        [companyId, d.customerId, payerNr, acc.clearingNr, acc.accountNr, holder, d.holderName ?? null, d.signedDate ?? null, d.note ?? null],
      );
      return (await client.query(`${MANDATE_SQL} where m.id = $1`, [r.rows[0].id])).rows[0];
    });
  }

  /** Godkänn eller avvisa ett medgivande som hyresgästen anmält i sin internetbank. */
  @Post('mandates/:id/respond')
  respond(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'payment.write');
    const { approve } = parse(z.object({ approve: z.boolean() }), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const m = (await client.query(`select status from autogiro_mandate where id = $1 for update`, [id])).rows[0];
      if (!m) throw new BadRequestException('Medgivandet finns inte i valt bolag');
      if (m.status !== 'review') throw new ConflictException('Medgivandet väntar inte på granskning');
      await client.query(`update autogiro_mandate set status = 'new', response = $2 where id = $1`, [id, approve ? 'approve' : 'reject']);
      return (await client.query(`${MANDATE_SQL} where m.id = $1`, [id])).rows[0];
    });
  }

  @Patch('mandates/:id')
  updateMandate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'payment.write');
    const d = parse(z.object({ note: z.string().trim().max(500).nullable() }), body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query(`update autogiro_mandate set note = $2 where id = $1`, [id, d.note || null]);
      if (!r.rowCount) throw new BadRequestException('Medgivandet finns inte i valt bolag');
      return (await client.query(`${MANDATE_SQL} where m.id = $1`, [id])).rows[0];
    });
  }

  /** Makulerar ett medgivande. Planerade dragningar stoppas och hyresgästen får vanlig avi. */
  @Post('mandates/:id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await cancelMandate(client, companyId, id);
      return { ...r, mandate: (await client.query(`${MANDATE_SQL} where m.id = $1`, [id])).rows[0] };
    });
  }

  /** Medgivandeblankett att skriva ut, tom eller ifylld för en hyresgäst. */
  @Get('mandate-form.pdf')
  async form(@Ctx() ctx: RequestContext, @Query('customerId') customerId: string | undefined, @Res() res: Response) {
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new BadRequestException('Ogiltigt id');
    const companyId = ctx.activeCompanyId;
    if (!companyId && !customerId) throw new BadRequestException('Välj ett bolag');
    const data = await withContext(dbContext(ctx), async (_db, client) => {
      const customer = customerId
        ? (
            await client.query(
              `select company_id, name, customer_nr as "customerNr", national_id as "nationalId", address_line as "addressLine",
                      postal_code as "postalCode", city from customer where id = $1`,
              [customerId],
            )
          ).rows[0]
        : null;
      if (customerId && !customer) throw new BadRequestException('Hyresgästen finns inte');
      const company = (
        await client.query(
          `select name, org_nr as "orgNr", address_line as "addressLine", postal_code as "postalCode", city,
                  coalesce(autogiro_bankgiro, bankgiro) as bankgiro from company where id = $1`,
          [customer?.company_id ?? companyId],
        )
      ).rows[0];
      return { company, customer };
    });
    const buf = await renderMandateForm(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="medgivande-autogiro${data.customer ? `-${data.customer.customerNr}` : ''}.pdf"`);
    res.send(buf);
  }

  // -------------------------------------------------------------------
  // Dragningar
  // -------------------------------------------------------------------

  @Get('payments')
  payments(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    if (status && !['planned', 'sent', 'paid', 'failed', 'cancelled'].includes(status)) throw new BadRequestException('Ogiltig status');
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(`${PAYMENT_SQL} where ($1::text is null or p.status = $1) order by p.payment_date desc, c.name limit 2000`, [status || null])).rows,
    );
  }

  /** Planerar dragningar för obetalda avier hos hyresgäster med medgivande (t.ex. efter att ett medgivande godkänts). */
  @Post('payments/plan')
  plan(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), async (_db, client) => {
      const s = await loadSettings(client, companyId);
      if (!s.enabled) throw new BadRequestException('Slå på autogiro under Inställningar först');
      return { planned: await planPayments(client, companyId) };
    });
  }

  @Post('payments/:id/cancel')
  cancelPayment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query(`update autogiro_payment set status = 'cancelled', message = 'Stoppad för hand' where id = $1 and status = 'planned'`, [id]);
      if (!r.rowCount) throw new ConflictException('Bara planerade dragningar kan stoppas här. En skickad dragning stoppas hos Bankgirot.');
      return (await client.query(`${PAYMENT_SQL} where p.id = $1`, [id])).rows[0];
    });
  }

  // -------------------------------------------------------------------
  // Filer
  // -------------------------------------------------------------------

  @Get('files')
  files(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => (await client.query(`${FILE_SQL} order by f.created_at desc limit 500`)).rows);
  }

  @Post('files/mandates')
  mandateFile(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), (_db, client) => createMandateFile(client, companyId));
  }

  @Post('files/payments')
  paymentFile(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), (_db, client) => createPaymentFile(client, companyId));
  }

  /** Markerar att en utgående fil har skickats till Bankgirot. */
  @Post('files/:id/uploaded')
  markUploaded(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query(`update autogiro_file set status = 'uploaded', uploaded_at = now() where id = $1 and direction = 'out'`, [id]);
      if (!r.rowCount) throw new BadRequestException('Filen finns inte i valt bolag');
      return (await client.query(`${FILE_SQL} where f.id = $1`, [id])).rows[0];
    });
  }

  @Get('files/:id/download')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await withContext(dbContext(ctx), async (_db, client) => (await client.query('select filename, content from autogiro_file where id = $1', [id])).rows[0]);
    if (!f) throw new BadRequestException('Filen finns inte');
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/"/g, '')}"`);
    res.send(Buffer.from(f.content, 'latin1'));
  }

  /** Läser in en fil från Bankgirot: medgivandeavisering, internetbanksmedgivanden, betalningsspecifikation eller avvisade. */
  @Post('files/incoming')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async incoming(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    const companyId = requireCompany(ctx, 'payment.write');
    if (!file?.buffer?.length) throw new BadRequestException('Välj en fil');
    const raw = file.buffer.toString('latin1');
    let parsed;
    try {
      parsed = parseAutogiroFile(raw);
    } catch (err) {
      if (err instanceof AutogiroFileError) throw new BadRequestException(err.message);
      throw err;
    }
    return withContext(dbContext(ctx), (_db, client) => importIncoming(client, companyId, file.originalname || 'autogiro.txt', raw, parsed));
  }
}
