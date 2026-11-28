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
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { isoDate, kronorToOre, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { appUrl } from '../auth/security';
import { registerDashboardExtra } from '../dashboard/extras';
import {
  addEvent,
  CATEGORY,
  CATEGORY_LABEL,
  Detail,
  emailList,
  getSettings,
  LIST_SQL,
  loadDetail,
  mailAndLog,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  newToken,
  nextOrderNr,
  OPEN_STATUSES,
  PRIORITY,
  PRIORITY_LABEL,
  savePhotos,
  STATUS,
  STATUS_LABEL,
  statusMail,
  suggestedDueDate,
  workOrderMail,
} from './work-orders';

const PERMISSION = 'work_order.manage';

// Kortet "Öppna felanmälningar" på startsidan
registerDashboardExtra(async (client) => {
  const r = (
    await client.query(
      `select count(*)::int as open,
              count(*) filter (where priority = 'urgent')::int as urgent,
              count(*) filter (where status = 'new')::int as "new",
              count(*) filter (where due_date < current_date)::int as late
       from work_order where status = any($1::text[])`,
      [OPEN_STATUSES],
    )
  ).rows[0] as { open: number; urgent: number; new: number; late: number };
  const sub = [r.urgent ? `${r.urgent} akuta` : null, r.new ? `${r.new} nya` : null, r.late ? `${r.late} försenade` : null].filter(Boolean).join(', ');
  return {
    key: 'fault-reports',
    label: 'Öppna felanmälningar',
    value: String(r.open),
    sub: sub || (r.open ? 'inga brådskande' : 'allt är åtgärdat'),
    href: '/arenden',
    tone: r.urgent || r.late ? 'bad' : r.new ? 'warn' : 'neutral',
  };
});

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const baseSchema = z.object({
  propertyId: z.string().uuid('Välj fastighet'),
  objectId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1, 'Beskriv felet kort').max(200),
  description: optText(5000),
  category: z.enum(CATEGORY).default('other'),
  location: optText(200),
  priority: z.enum(PRIORITY).default('normal'),
  source: z.enum(['manual', 'phone', 'email', 'inspection']).default('manual'),
  reporterName: optText(200),
  reporterEmail: z
    .string()
    .trim()
    .email('Ange en giltig e-postadress')
    .max(200)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  reporterPhone: optText(50),
  masterKeyOk: z.boolean().default(false),
  accessNote: optText(1000),
  notifyReporter: z.boolean().default(true),
  assigneeUserId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  scheduledDate: isoDate.nullable().optional(),
  costEstimate: z.number().finite().min(0).max(1e9).nullable().optional(),
  chargeable: z.boolean().default(false),
  resolution: optText(5000),
});

const createSchema = baseSchema;
const updateSchema = baseSchema.omit({ source: true }).partial().extend({ propertyId: z.string().uuid().optional() });

const statusSchema = z.object({
  status: z.enum(STATUS),
  message: optText(2000),
  resolution: optText(5000),
  notifyReporter: z.boolean().default(true),
});

const commentSchema = z.object({
  body: z.string().trim().min(1, 'Skriv en kommentar').max(5000),
  visibility: z.enum(['internal', 'reporter', 'supplier']).default('internal'),
});

const sendSchema = z.object({ message: optText(2000), includePhotos: z.boolean().default(true) });
const costSchema = z.object({ supplierInvoiceId: z.string().uuid() });

const settingsSchema = z.object({
  notifyEmails: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .refine((v) => !v || v.split(/[,;\s]+/).filter(Boolean).every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)), 'Ange e-postadresser åtskilda med komma'),
  confirmReporter: z.boolean(),
  formIntro: optText(2000),
});

const formSchema = z.object({ enabled: z.boolean(), defaultAssigneeUserId: z.string().uuid().nullable().optional() });

const FIELD_COLUMN: Record<string, string> = {
  propertyId: 'property_id',
  objectId: 'object_id',
  customerId: 'customer_id',
  title: 'title',
  description: 'description',
  category: 'category',
  location: 'location',
  priority: 'priority',
  reporterName: 'reporter_name',
  reporterEmail: 'reporter_email',
  reporterPhone: 'reporter_phone',
  masterKeyOk: 'master_key_ok',
  accessNote: 'access_note',
  notifyReporter: 'notify_reporter',
  assigneeUserId: 'assignee_user_id',
  supplierId: 'supplier_id',
  dueDate: 'due_date',
  scheduledDate: 'scheduled_date',
  costEstimate: 'cost_estimate_ore',
  chargeable: 'chargeable',
  resolution: 'resolution',
};

function statusLink(req: Request | undefined, token: string) {
  return `${appUrl(req)}/felanmalan/arende/${token}`;
}
function supplierLink(req: Request | undefined, token: string) {
  return `${appUrl(req)}/arbetsorder/${token}`;
}
export function caseLink(req: Request | undefined, id: string) {
  return `${appUrl(req)}/arenden/${id}`;
}

/** Kontrollerar att objekt och hyresgäst hör till fastigheten och att användaren finns i bolaget. */
async function checkRefs(
  client: PoolClient,
  companyId: string,
  v: { propertyId?: string; objectId?: string | null; assigneeUserId?: string | null; supplierId?: string | null },
) {
  if (v.objectId && v.propertyId) {
    const o = (await client.query('select property_id from rental_object where id = $1', [v.objectId])).rows[0];
    if (!o) throw new BadRequestException('Objektet finns inte i bolaget');
    if (o.property_id !== v.propertyId) throw new BadRequestException('Objektet hör inte till fastigheten');
  }
  if (v.assigneeUserId) {
    const m = (
      await client.query(
        `select 1 from app_user u where u.id = $1 and u.active
           and (u.is_group_admin or exists (select 1 from membership m where m.user_id = u.id and m.company_id = $2))`,
        [v.assigneeUserId, companyId],
      )
    ).rows[0];
    if (!m) throw new BadRequestException('Den ansvarige har ingen behörighet i bolaget');
  }
}

async function load(client: PoolClient, id: string, req?: Request): Promise<Detail & { statusUrl?: string; supplierUrl?: string | null }> {
  const d = await loadDetail(client, id);
  if (!d) throw new NotFoundException('Ärendet finns inte');
  if (!req) return d;
  return { ...d, statusUrl: statusLink(req, d.publicToken), supplierUrl: d.supplierToken ? supplierLink(req, d.supplierToken) : null };
}

@Controller('work-orders')
export class WorkOrdersController {
  /** Ärenden. status: open (standard), late, all eller en status. */
  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('status') status = 'open',
    @Query('propertyId') propertyId?: string,
    @Query('objectId') objectId?: string,
    @Query('customerId') customerId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('q') q?: string,
  ) {
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    const statuses =
      status === 'open' || status === 'late' ? OPEN_STATUSES : status === 'all' ? [...STATUS] : (STATUS as readonly string[]).includes(status) ? [status] : OPEN_STATUSES;
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `${LIST_SQL}
           where w.status = any($2::text[])
             and ($3::boolean = false or (w.due_date < current_date))
             and ($4::uuid is null or w.property_id = $4)
             and ($5::uuid is null or w.object_id = $5)
             and ($6::uuid is null or w.customer_id = $6)
             and ($7::uuid is null or w.supplier_id = $7)
             and ($8::text = '' or w.title ilike '%' || $8 || '%' or w.description ilike '%' || $8 || '%'
                  or w.reporter_name ilike '%' || $8 || '%' or o.object_nr ilike $8 || '%' or w.order_nr::text = $8)
           order by case w.priority when 'urgent' then 0 when 'high' then 1 else 2 end, w.created_at desc
           limit 1000`,
          [OPEN_STATUSES, statuses, status === 'late', uuid(propertyId), uuid(objectId), uuid(customerId), uuid(supplierId), (q ?? '').trim().slice(0, 100)],
        )
      ).rows,
    );
  }

  /** Nyckeltal för översikten. */
  @Get('summary')
  summary(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = (
        await client.query(
          `select count(*) filter (where status = 'new')::int as "new",
                  count(*) filter (where status = any($1::text[]))::int as "open",
                  count(*) filter (where status = any($1::text[]) and priority = 'urgent')::int as urgent,
                  count(*) filter (where status = any($1::text[]) and due_date < current_date)::int as late,
                  count(*) filter (where status = 'assigned')::int as "atSupplier",
                  count(*) filter (where status = 'done')::int as "toClose",
                  count(*) filter (where created_at >= now() - interval '30 days')::int as "last30",
                  round(avg(extract(epoch from (done_at - created_at)) / 86400) filter (where done_at >= now() - interval '90 days')::numeric, 1)::float as "avgDays"
           from work_order`,
          [OPEN_STATUSES],
        )
      ).rows[0];
      return r;
    });
  }

  /** Val för formulären: fastigheter, objekt, ansvariga och hantverkare i valt bolag. */
  @Get('options')
  options(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const companyId = ctx.activeCompanyId;
      return {
        properties: (await client.query(`select id, name, designation from property where sold_date is null order by name`)).rows,
        objects: (
          await client.query(
            `select o.id, o.property_id as "propertyId", o.object_nr as "objectNr", o.type, o.apartment_nr as "apartmentNr",
                    (select c.id from contract_object co join contract k on k.id = co.contract_id join customer c on c.id = k.customer_id
                     where co.object_id = o.id and k.status in ('active','terminated') and k.start_date <= current_date
                       and (k.end_date is null or k.end_date >= current_date) limit 1) as "customerId",
                    (select c.name from contract_object co join contract k on k.id = co.contract_id join customer c on c.id = k.customer_id
                     where co.object_id = o.id and k.status in ('active','terminated') and k.start_date <= current_date
                       and (k.end_date is null or k.end_date >= current_date) limit 1) as "customerName"
             from rental_object o where o.active order by o.object_nr`,
          )
        ).rows,
        users: companyId
          ? (
              await client.query(
                `select u.id, u.name, u.email from app_user u
                 where u.active and (u.is_group_admin or exists (
                   select 1 from membership m join role_permission rp on rp.role_id = m.role_id and rp.permission = $2
                   where m.user_id = u.id and m.company_id = $1 and (m.valid_until is null or m.valid_until >= current_date)))
                 order by u.name`,
                [companyId, PERMISSION],
              )
            ).rows
          : [],
        suppliers: (await client.query(`select id, name, email, phone from supplier where active order by name`)).rows,
        categories: CATEGORY.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
        priorities: PRIORITY.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
        statuses: STATUS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      };
    });
  }

  // -------------------------------------------------------------------
  // Inställningar och formulärlänkar
  // -------------------------------------------------------------------

  @Get('settings')
  settings(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => (ctx.activeCompanyId ? getSettings(client, ctx.activeCompanyId) : null));
  }

  @Put('settings')
  saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const s = parse(settingsSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(
        `insert into work_order_setting (company_id, notify_emails, confirm_reporter, form_intro) values ($1, $2, $3, $4)
         on conflict (company_id) do update set notify_emails = $2, confirm_reporter = $3, form_intro = $4`,
        [companyId, emailList(s.notifyEmails).join(', ') || null, s.confirmReporter, s.formIntro],
      );
      return getSettings(client, companyId);
    });
  }

  /** Fastigheterna med formulärets länk och om det är på. */
  @Get('forms')
  forms(@Ctx() ctx: RequestContext, @Req() req: Request) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select p.id as "propertyId", p.name as "propertyName", p.designation, co.name as "companyName",
                  f.id as "formId", f.token, coalesce(f.enabled, false) as enabled, f.default_assignee_user_id as "defaultAssigneeUserId",
                  u.name as "defaultAssigneeName",
                  (select count(*) from work_order w where w.property_id = p.id and w.source = 'form')::int as "reportCount"
           from property p join company co on co.id = p.company_id
           left join fault_form f on f.property_id = p.id
           left join app_user u on u.id = f.default_assignee_user_id
           where p.sold_date is null
           order by co.name, p.name`,
        )
      ).rows.map((r) => ({ ...r, url: r.token ? `${appUrl(req)}/felanmalan/${r.token}` : null })),
    );
  }

  /** Slår på eller av formuläret för en fastighet. Länken skapas första gången. */
  @Put('forms/:propertyId')
  saveForm(@Ctx() ctx: RequestContext, @Param('propertyId', ParseUUIDPipe) propertyId: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const f = parse(formSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (!(await client.query('select 1 from property where id = $1', [propertyId])).rows[0]) throw new NotFoundException('Fastigheten finns inte i valt bolag');
      await checkRefs(client, companyId, { assigneeUserId: f.defaultAssigneeUserId });
      await client.query(
        `insert into fault_form (company_id, property_id, token, enabled, default_assignee_user_id) values ($1, $2, $3, $4, $5)
         on conflict (company_id, property_id) do update set enabled = $4, default_assignee_user_id = $5`,
        [companyId, propertyId, newToken(), f.enabled, f.defaultAssigneeUserId ?? null],
      );
      return { ok: true };
    });
  }

  /** Ny länk, t.ex. om den gamla spridits fel. Den gamla slutar fungera. */
  @Post('forms/:propertyId/new-link')
  newLink(@Ctx() ctx: RequestContext, @Param('propertyId', ParseUUIDPipe) propertyId: string) {
    requireCompany(ctx, PERMISSION);
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query('update fault_form set token = $2 where property_id = $1', [propertyId, newToken()]);
      if (!r.rowCount) throw new NotFoundException('Formuläret är inte skapat');
      return { ok: true };
    });
  }

  /** QR-kod (PNG) som leder till formuläret, för anslag i trapphuset. */
  @Get('forms/:propertyId/qr')
  async qr(@Ctx() ctx: RequestContext, @Param('propertyId', ParseUUIDPipe) propertyId: string, @Req() req: Request, @Res() res: Response) {
    const token = await withContext(dbContext(ctx), async (_db, client) => (await client.query('select token from fault_form where property_id = $1', [propertyId])).rows[0]?.token);
    if (!token) throw new NotFoundException('Formuläret är inte skapat');
    const png = await QRCode.toBuffer(`${appUrl(req)}/felanmalan/${token}`, { width: 600, margin: 2 });
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'no-store');
    res.end(png);
  }

  /** Ärenden som en leverantörsfaktura är kopplad till. */
  @Get('by-supplier-invoice/:id')
  bySupplierInvoice(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select w.id, w.order_nr as "orderNr", w.title, w.status from work_order_cost wc join work_order w on w.id = wc.work_order_id
           where wc.supplier_invoice_id = $1 order by w.order_nr`,
          [id],
        )
      ).rows,
    );
  }

  // -------------------------------------------------------------------
  // Ett ärende
  // -------------------------------------------------------------------

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await load(client, id);
      return {
        ...d,
        statusUrl: statusLink(req, d.publicToken),
        supplierUrl: d.supplierToken ? supplierLink(req, d.supplierToken) : null,
      };
    });
  }

  /** Registrerar ett ärende, t.ex. efter ett telefonsamtal. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (!(await client.query('select 1 from property where id = $1', [v.propertyId])).rows[0]) throw new BadRequestException('Fastigheten finns inte i valt bolag');
      await checkRefs(client, companyId, v);
      const nr = await nextOrderNr(client, companyId);
      const row = (
        await client.query(
          `insert into work_order (company_id, order_nr, source, property_id, object_id, customer_id, title, description, category, location, priority,
             reporter_name, reporter_email, reporter_phone, master_key_ok, access_note, notify_reporter, assignee_user_id, supplier_id,
             due_date, scheduled_date, cost_estimate_ore, chargeable, resolution)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
          [
            companyId, nr, v.source, v.propertyId, v.objectId ?? null, v.customerId ?? null, v.title, v.description, v.category, v.location, v.priority,
            v.reporterName, v.reporterEmail ?? null, v.reporterPhone, v.masterKeyOk, v.accessNote, v.notifyReporter,
            v.assigneeUserId ?? ctx.userId, v.supplierId ?? null, v.dueDate ?? suggestedDueDate(v.priority, today()), v.scheduledDate ?? null,
            v.costEstimate === null || v.costEstimate === undefined ? null : kronorToOre(v.costEstimate), v.chargeable, v.resolution,
          ],
        )
      ).rows[0];
      await addEvent(client, companyId, row.id, 'created', `Registrerat (${{ manual: 'manuellt', phone: 'telefon', email: 'e-post', inspection: 'besiktning' }[v.source]})`);
      return { id: row.id, orderNr: nr };
    });
  }

  @Put(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(updateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = await load(client, id);
      if (cur.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      const propertyId = v.propertyId ?? cur.propertyId;
      const objectId = v.objectId !== undefined ? v.objectId : v.propertyId && v.propertyId !== cur.propertyId ? null : cur.objectId;
      await checkRefs(client, companyId, { propertyId, objectId, assigneeUserId: v.assigneeUserId });
      const sets: string[] = [];
      const params: unknown[] = [id];
      const data: Record<string, unknown> = { ...v };
      if (v.propertyId && v.propertyId !== cur.propertyId && v.objectId === undefined) data.objectId = null;
      if (data.costEstimate !== undefined) data.costEstimate = data.costEstimate === null ? null : kronorToOre(data.costEstimate as number);
      for (const [k, val] of Object.entries(data)) {
        const col = FIELD_COLUMN[k];
        if (!col || val === undefined) continue;
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
      if (!sets.length) return load(client, id, req);
      await client.query(`update work_order set ${sets.join(', ')} where id = $1`, params);
      const after = await load(client, id);
      if (after.priority !== cur.priority) await addEvent(client, companyId, id, 'priority', `Prioritet: ${PRIORITY_LABEL[after.priority as keyof typeof PRIORITY_LABEL]}`);
      if (after.assigneeUserId !== cur.assigneeUserId) {
        await addEvent(client, companyId, id, 'assigned', after.assigneeName ? `Ansvarig: ${after.assigneeName}` : 'Ingen ansvarig');
        if (after.assigneeEmail && after.assigneeUserId !== ctx.userId) {
          await mailAndLog(
            client, companyId, after, after.assigneeEmail,
            `Ärende ${after.orderNr} har tilldelats dig: ${after.title}`,
            `Hej ${after.assigneeName}!\n\n${ctx.name} har gjort dig ansvarig för ärende ${after.orderNr} (${after.title}) i ${after.propertyName}.\n\n${caseLink(req, id)}`,
            'Besked till ansvarig',
          );
        }
      }
      if (after.supplierId !== cur.supplierId) await addEvent(client, companyId, id, 'supplier', after.supplierName ? `Hantverkare: ${after.supplierName}` : 'Ingen hantverkare');
      const other = Object.keys(v).filter((k) => !['priority', 'assigneeUserId', 'supplierId'].includes(k));
      if (other.length) await addEvent(client, companyId, id, 'updated', 'Uppgifterna ändrades');
      return load(client, id, req);
    });
  }

  /** Byter status. Anmälaren får besked när ärendet åtgärdats, om det är valt. */
  @Post(':id/status')
  status(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(statusSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = await load(client, id);
      if (cur.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      if (cur.status === v.status && !v.message) return load(client, id, req);
      const finished = v.status === 'done' || v.status === 'closed';
      await client.query(
        `update work_order set status = $2,
           done_at = case when $3 then coalesce(done_at, now()) else null end,
           closed_at = case when $2 = 'closed' then coalesce(closed_at, now()) else null end,
           resolution = coalesce($4, resolution)
         where id = $1`,
        [id, v.status, finished, v.resolution],
      );
      if (cur.status !== v.status) {
        await addEvent(client, companyId, id, 'status', `Status: ${STATUS_LABEL[v.status]}${v.message ? `. ${v.message}` : ''}`, {
          visibility: v.message ? 'reporter' : 'internal',
        });
      }
      const after = await load(client, id);
      // Besked till anmälaren när det händer något som rör dem
      const tellReporter = v.notifyReporter && after.notifyReporter && after.reporterEmail && cur.status !== v.status && ['in_progress', 'done', 'cancelled'].includes(v.status);
      if (tellReporter) {
        const m = statusMail(after, statusLink(req, after.publicToken), v.message);
        await mailAndLog(client, companyId, after, after.reporterEmail!, m.subject, m.text, 'Statusbesked till anmälaren');
      }
      return load(client, id, req);
    });
  }

  @Post(':id/comments')
  comment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(commentSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await load(client, id);
      if (d.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      await addEvent(client, companyId, id, 'comment', v.body, { visibility: v.visibility });
      if (v.visibility === 'reporter' && d.reporterEmail) {
        await mailAndLog(
          client, companyId, d, d.reporterEmail,
          `Ärende ${d.orderNr}: nytt meddelande`,
          `Hej${d.reporterName ? ` ${d.reporterName}` : ''}!\n\nNytt meddelande om ditt ärende ${d.orderNr} (${d.title}):\n\n${v.body}\n\nFölj ärendet: ${statusLink(req, d.publicToken)}\n\nVänliga hälsningar\n${d.companyName}`,
          'Meddelande till anmälaren',
        );
      }
      if (v.visibility === 'supplier' && d.supplierEmail && d.supplierToken) {
        await mailAndLog(
          client, companyId, d, d.supplierEmail,
          `Arbetsorder ${d.orderNr}: nytt meddelande från ${d.companyName}`,
          `Hej!\n\nNytt meddelande om arbetsorder ${d.orderNr} (${d.title}):\n\n${v.body}\n\n${supplierLink(req, d.supplierToken)}\n\nVänliga hälsningar\n${d.companyName}`,
          'Meddelande till hantverkaren',
        );
      }
      return load(client, id, req);
    });
  }

  /** Skickar arbetsordern till hantverkaren med e-post, med bilderna bifogade och en länk för att kvittera. */
  @Post(':id/send-to-supplier')
  sendToSupplier(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(sendSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const cur = await load(client, id);
      if (cur.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      if (!cur.supplierId) throw new BadRequestException('Välj en hantverkare först');
      if (!cur.supplierEmail) throw new BadRequestException(`${cur.supplierName} har ingen e-postadress i leverantörsregistret`);
      if (cur.status === 'closed' || cur.status === 'cancelled') throw new BadRequestException('Ärendet är avslutat');
      await client.query(
        `update work_order set supplier_token = coalesce(supplier_token, $2), sent_to_supplier_at = now(),
           status = case when status = 'new' then 'assigned' else status end where id = $1`,
        [id, newToken()],
      );
      const d = await load(client, id);
      if (cur.status === 'new') await addEvent(client, companyId, id, 'status', `Status: ${STATUS_LABEL.assigned}`);
      const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
      if (v.includePhotos && d.photos.length) {
        let total = 0;
        const rows = (
          await client.query(
            `select d.file_name, d.mime_type, c.content from document d join document_content c on c.id = d.id
             where d.entity_type = 'work_order' and d.entity_id = $1 order by d.created_at`,
            [id],
          )
        ).rows;
        for (const r of rows) {
          total += r.content.length;
          if (total > 15 * 1024 * 1024) break;
          attachments.push({ filename: r.file_name, content: r.content, contentType: r.mime_type });
        }
      }
      const m = workOrderMail(d, supplierLink(req, d.supplierToken!), v.message);
      const status = await mailAndLog(client, companyId, d, d.supplierEmail!, m.subject, m.text, 'Arbetsorder', attachments);
      if (v.message) await addEvent(client, companyId, id, 'comment', v.message, { visibility: 'supplier' });
      return { ...(await load(client, id, req)), mailStatus: status };
    });
  }

  // -------------------------------------------------------------------
  // Bilder
  // -------------------------------------------------------------------

  @Post(':id/photos')
  @UseInterceptors(FilesInterceptor('photos', MAX_PHOTOS, { limits: { fileSize: MAX_PHOTO_BYTES } }))
  addPhotos(@Ctx() ctx: RequestContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: Express.Multer.File[] = []) {
    const companyId = requireCompany(ctx, PERMISSION);
    if (!files.length) throw new BadRequestException('Välj en eller flera bilder');
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await load(client, id);
      if (d.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      const n = await savePhotos(client, companyId, id, files, null);
      if (!n) throw new BadRequestException('Bilderna måste vara JPEG, PNG, WebP, HEIC eller GIF');
      await addEvent(client, companyId, id, 'photo', n === 1 ? '1 bild tillagd' : `${n} bilder tillagda`);
      return load(client, id, req);
    });
  }

  @Get(':id/photos/:docId')
  async photo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Res() res: Response) {
    const doc = await withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select d.file_name, d.mime_type, c.content from document d join document_content c on c.id = d.id
           where d.id = $1 and d.entity_type = 'work_order' and d.entity_id = $2`,
          [docId, id],
        )
      ).rows[0],
    );
    if (!doc) throw new NotFoundException('Bilden finns inte');
    res.setHeader('content-type', doc.mime_type);
    res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(doc.content);
  }

  @Delete(':id/photos/:docId')
  @HttpCode(204)
  async removePhoto(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string) {
    const companyId = requireCompany(ctx, PERMISSION);
    await withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query(`delete from document where id = $1 and entity_type = 'work_order' and entity_id = $2 and company_id = $3`, [docId, id, companyId]);
      if (!r.rowCount) throw new NotFoundException('Bilden finns inte');
      await addEvent(client, companyId, id, 'photo', 'En bild togs bort');
    });
  }

  // -------------------------------------------------------------------
  // Kostnader
  // -------------------------------------------------------------------

  /** Leverantörsfakturor som kan kopplas: hantverkarens först, sedan övriga på fastigheten, senaste året. */
  @Get(':id/cost-candidates')
  costCandidates(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await load(client, id);
      return (
        await client.query(
          `select si.id, si.entry_nr as "entryNr", si.invoice_nr as "invoiceNr", sp.name as "supplierName", si.invoice_date::text as "invoiceDate",
                  si.net_ore::float as "netOre", si.total_ore::float as "totalOre", si.status, si.description,
                  (si.supplier_id = $2) as "sameSupplier",
                  exists (select 1 from supplier_invoice_line l where l.supplier_invoice_id = si.id and l.property_id = $3) as "sameProperty"
           from supplier_invoice si join supplier sp on sp.id = si.supplier_id
           where si.company_id = $4 and si.status <> 'cancelled'
             and si.invoice_date >= current_date - interval '13 months'
             and not exists (select 1 from work_order_cost wc where wc.work_order_id = $1 and wc.supplier_invoice_id = si.id)
           order by (si.supplier_id = $2) desc nulls last, si.invoice_date desc
           limit 200`,
          [id, d.supplierId, d.propertyId, d.companyId],
        )
      ).rows;
    });
  }

  @Post(':id/costs')
  addCost(@Ctx() ctx: RequestContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const v = parse(costSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const d = await load(client, id);
      if (d.companyId !== companyId) throw new NotFoundException('Ärendet finns inte i valt bolag');
      const si = (await client.query('select entry_nr, invoice_nr, net_ore::float as net from supplier_invoice where id = $1', [v.supplierInvoiceId])).rows[0];
      if (!si) throw new BadRequestException('Fakturan finns inte i valt bolag');
      await client.query('insert into work_order_cost (company_id, work_order_id, supplier_invoice_id) values ($1, $2, $3) on conflict do nothing', [
        companyId, id, v.supplierInvoiceId,
      ]);
      await addEvent(client, companyId, id, 'cost', `Leverantörsfaktura ${si.entry_nr} (${si.invoice_nr}) kopplad, ${Math.round(si.net / 100).toLocaleString('sv-SE')} kr exkl. moms`);
      return load(client, id, req);
    });
  }

  @Delete(':id/costs/:costId')
  removeCost(@Ctx() ctx: RequestContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Param('costId', ParseUUIDPipe) costId: string) {
    const companyId = requireCompany(ctx, PERMISSION);
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = (
        await client.query(
          `delete from work_order_cost wc using supplier_invoice si where wc.id = $1 and wc.work_order_id = $2 and si.id = wc.supplier_invoice_id
           returning si.entry_nr`,
          [costId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException('Kopplingen finns inte');
      await addEvent(client, companyId, id, 'cost', `Leverantörsfaktura ${r.entry_nr} kopplades bort`);
      return load(client, id, req);
    });
  }
}
