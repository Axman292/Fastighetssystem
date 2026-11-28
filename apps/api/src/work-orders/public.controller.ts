import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { today } from '../common/money';
import { parse } from '../common/validation';
import { DbContext, getPool, withContext } from '../db/db';
import { Public } from '../auth/request-context';
import { appUrl } from '../auth/security';
import { limitOrThrow } from '../auth/rate-limit';
import { caseLink } from './work-orders.controller';
import {
  addEvent,
  CATEGORY,
  CATEGORY_LABEL,
  emailList,
  formTicket,
  getSettings,
  loadDetail,
  looksLikeSpam,
  mailAndLog,
  matchCustomer,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  newReportMail,
  nextOrderNr,
  receiptMail,
  REPORTER_STATUS_LABEL,
  savePhotos,
  Status,
  STATUS_LABEL,
  suggestedDueDate,
  ticketProblem,
} from './work-orders';

/**
 * Sidor utan inloggning:
 *  - felanmälningsformuläret för en fastighet (/felanmalan/:token)
 *  - anmälarens statussida (/felanmalan/arende/:token)
 *  - hantverkarens arbetsorder (/arbetsorder/:token)
 *
 * Varje länk innehåller en lång slumpad nyckel. Databasen släpps bara upp för
 * det bolag som nyckeln hör till, och svaren innehåller bara det som behövs.
 * Spamskydd: dolt fält, minsta ifyllnadstid med signerad biljett, gräns per
 * IP-adress och per formulär, längdgränser och högst fem bilder.
 */

const LIMIT_PER_IP = { limit: Number(process.env.FAULT_REPORTS_PER_IP ?? 5), windowMs: 60 * 60_000 };
const LIMIT_PER_FORM = { limit: 60, windowMs: 60 * 60_000 };
const LIMIT_READ = { limit: 120, windowMs: 15 * 60_000 };

const tokenOk = (t: string) => /^[A-Za-z0-9_-]{20,64}$/.test(t);

function publicCtx(companyId: string, groupId: string): DbContext {
  return { userId: '', groupId, companyIds: [companyId] };
}

async function lookupForm(token: string) {
  if (!tokenOk(token)) return null;
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role fastighet_app');
    const r = (await client.query('select * from app.fault_form_lookup($1)', [token])).rows[0];
    await client.query('commit');
    return (r ?? null) as { form_id: string; company_id: string; group_id: string; property_id: string; enabled: boolean } | null;
  } finally {
    client.release();
  }
}

async function lookupOrder(token: string, kind: 'reporter' | 'supplier') {
  if (!tokenOk(token)) return null;
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role fastighet_app');
    const r = (await client.query('select * from app.work_order_lookup($1, $2)', [token, kind])).rows[0];
    await client.query('commit');
    return (r ?? null) as { id: string; company_id: string; group_id: string } | null;
  } finally {
    client.release();
  }
}

const reportSchema = z.object({
  ticket: z.string().max(200),
  // Dolt fält som människor inte ser. Fylls det i är det en robot.
  website: z.string().max(500).optional(),
  objectId: z.string().uuid().nullable().optional().or(z.literal('').transform(() => null)),
  objectText: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORY).default('other'),
  title: z.string().trim().min(3, 'Beskriv felet med några ord').max(200),
  description: z.string().trim().max(5000).optional(),
  location: z.string().trim().max(200).optional(),
  name: z.string().trim().min(2, 'Skriv ditt namn').max(200),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Ange en giltig e-postadress'),
  phone: z.string().trim().max(50).optional(),
  masterKeyOk: z
    .union([z.boolean(), z.enum(['true', 'false', 'on'])])
    .optional()
    .transform((v) => v === true || v === 'true' || v === 'on'),
  accessNote: z.string().trim().max(1000).optional(),
  urgent: z
    .union([z.boolean(), z.enum(['true', 'false', 'on'])])
    .optional()
    .transform((v) => v === true || v === 'true' || v === 'on'),
}).refine((v) => (v.email && v.email.length) || (v.phone && v.phone.replace(/\D/g, '').length >= 7), {
  message: 'Ange e-post eller telefon så att vi kan nå dig',
  path: ['email'],
});

const commentSchema = z.object({ body: z.string().trim().min(1, 'Skriv ett meddelande').max(2000), ticket: z.string().max(200).optional(), website: z.string().max(500).optional() });
const supplierReportSchema = z.object({
  action: z.enum(['comment', 'started', 'done']),
  body: z.string().trim().max(3000).optional(),
  name: z.string().trim().max(100).optional(),
});

@Public()
@Controller('public')
export class PublicWorkOrdersController {
  /** Formulärets uppgifter: fastighet, objekt och bolagets text. */
  @Get('fault-forms/:token')
  async form(@Param('token') token: string, @Req() req: Request) {
    limitOrThrow(`fault-read:${req.ip}`, LIMIT_READ.limit, LIMIT_READ.windowMs);
    const f = await lookupForm(token);
    if (!f) throw new NotFoundException('Länken till felanmälan finns inte. Kontrollera adressen eller kontakta din hyresvärd.');
    return withContext(publicCtx(f.company_id, f.group_id), async (_db, client) => {
      const p = (
        await client.query(
          `select p.name, p.address_line as "addressLine", p.postal_code as "postalCode", p.city, c.name as "companyName"
           from property p join company c on c.id = p.company_id where p.id = $1`,
          [f.property_id],
        )
      ).rows[0];
      const settings = await getSettings(client, f.company_id);
      if (!f.enabled) return { enabled: false, property: p, intro: null, objects: [], categories: [], ticket: null };
      // Bara objektnummer och typ visas, aldrig vem som bor där
      const objects = (
        await client.query(
          `select id, object_nr as "objectNr", type, apartment_nr as "apartmentNr", address_line as "addressLine"
           from rental_object where property_id = $1 and active order by object_nr`,
          [f.property_id],
        )
      ).rows;
      return {
        enabled: true,
        property: p,
        intro: settings.formIntro,
        objects,
        categories: CATEGORY.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
        ticket: formTicket(token),
      };
    });
  }

  /** Tar emot en felanmälan med upp till fem bilder. */
  @Post('fault-forms/:token')
  @HttpCode(201)
  @UseInterceptors(FilesInterceptor('photos', MAX_PHOTOS, { limits: { fileSize: MAX_PHOTO_BYTES, fields: 30 } }))
  async report(@Param('token') token: string, @Body() body: unknown, @Req() req: Request, @UploadedFiles() files: Express.Multer.File[] = []) {
    const f = await lookupForm(token);
    if (!f) throw new NotFoundException('Länken till felanmälan finns inte');
    if (!f.enabled) throw new ForbiddenException('Felanmälan via formuläret är avstängd för fastigheten. Kontakta din hyresvärd.');
    const v = parse(reportSchema, body);
    // Robotar: låtsas att det gick bra men spara inget
    if (v.website) return { ok: true, orderNr: null, statusUrl: null };
    const problem = ticketProblem(token, v.ticket);
    if (problem) throw new BadRequestException(problem);
    limitOrThrow(`fault-ip:${req.ip}`, LIMIT_PER_IP.limit, LIMIT_PER_IP.windowMs);
    limitOrThrow(`fault-form:${f.form_id}`, LIMIT_PER_FORM.limit, LIMIT_PER_FORM.windowMs);
    if (looksLikeSpam(`${v.title} ${v.description ?? ''}`)) throw new BadRequestException('Meddelandet innehåller för många länkar');

    return withContext(publicCtx(f.company_id, f.group_id), async (_db, client) => {
      let objectId = v.objectId ?? null;
      if (objectId) {
        const o = (await client.query('select property_id from rental_object where id = $1', [objectId])).rows[0];
        if (!o || o.property_id !== f.property_id) objectId = null;
      }
      const email = v.email ? v.email.toLowerCase() : null;
      const phone = v.phone || null;
      const customerId = await matchCustomer(client, f.property_id, objectId, email, phone);
      const priority = v.urgent ? 'high' : 'normal';
      const form = (await client.query('select default_assignee_user_id from fault_form where id = $1', [f.form_id])).rows[0];
      const nr = await nextOrderNr(client, f.company_id);
      const description = [v.description, !objectId && v.objectText ? `Lägenhet/objekt enligt anmälaren: ${v.objectText}` : null].filter(Boolean).join('\n\n') || null;
      const row = (
        await client.query(
          `insert into work_order (company_id, order_nr, source, property_id, object_id, customer_id, title, description, category, location,
             priority, reporter_name, reporter_email, reporter_phone, master_key_ok, access_note, assignee_user_id, due_date, reporter_ip)
           values ($1, $2, 'form', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
          [
            f.company_id, nr, f.property_id, objectId, customerId, v.title, description, v.category, v.location || null, priority,
            v.name, email, phone, v.masterKeyOk, v.accessNote || null, form?.default_assignee_user_id ?? null,
            suggestedDueDate(priority, today()), (req.ip ?? '').slice(0, 64) || null,
          ],
        )
      ).rows[0];
      await addEvent(client, f.company_id, row.id, 'created', `Felanmälan via formuläret${v.urgent ? ' (markerad som brådskande av anmälaren)' : ''}`, {
        authorLabel: v.name,
      });
      const n = await savePhotos(client, f.company_id, row.id, files, 'Från anmälaren');
      if (n) await addEvent(client, f.company_id, row.id, 'photo', n === 1 ? '1 bild bifogad av anmälaren' : `${n} bilder bifogade av anmälaren`, { authorLabel: v.name });

      const d = (await loadDetail(client, row.id))!;
      const settings = await getSettings(client, f.company_id);
      const statusUrl = `${appUrl(req)}/felanmalan/arende/${d.publicToken}`;
      // Besked till förvaltningen
      const to = new Set(emailList(settings.notifyEmails));
      if (d.assigneeEmail) to.add(d.assigneeEmail);
      const mail = newReportMail(d, caseLink(req, d.id));
      for (const addr of to) await mailAndLog(client, f.company_id, d, addr, mail.subject, mail.text, 'Besked om ny felanmälan');
      // Kvittens till anmälaren
      if (settings.confirmReporter && email) {
        const r = receiptMail(d, statusUrl);
        await mailAndLog(client, f.company_id, d, email, r.subject, r.text, 'Kvittens till anmälaren');
      }
      return { ok: true, orderNr: nr, statusUrl, publicToken: d.publicToken };
    });
  }

  /** Anmälarens vy: status och meddelanden som är riktade till anmälaren. */
  @Get('fault-reports/:token')
  async reportStatus(@Param('token') token: string, @Req() req: Request) {
    limitOrThrow(`fault-read:${req.ip}`, LIMIT_READ.limit, LIMIT_READ.windowMs);
    const o = await lookupOrder(token, 'reporter');
    if (!o) throw new NotFoundException('Ärendet finns inte');
    return withContext(publicCtx(o.company_id, o.group_id), async (_db, client) => reporterView(client, o.id));
  }

  /** Anmälaren skriver ett meddelande i sitt ärende. */
  @Post('fault-reports/:token/messages')
  @HttpCode(201)
  async reporterMessage(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const o = await lookupOrder(token, 'reporter');
    if (!o) throw new NotFoundException('Ärendet finns inte');
    const v = parse(commentSchema, body);
    if (v.website) return { ok: true };
    limitOrThrow(`fault-msg:${req.ip}`, 10, 60 * 60_000);
    if (looksLikeSpam(v.body)) throw new BadRequestException('Meddelandet innehåller för många länkar');
    return withContext(publicCtx(o.company_id, o.group_id), async (_db, client) => {
      const d = (await loadDetail(client, o.id))!;
      if (d.status === 'closed' || d.status === 'cancelled') throw new BadRequestException('Ärendet är avslutat. Gör en ny felanmälan om felet finns kvar.');
      await addEvent(client, o.company_id, o.id, 'reporter_comment', v.body, { visibility: 'reporter', authorLabel: d.reporterName ?? 'Anmälaren' });
      if (d.assigneeEmail) {
        await mailAndLog(
          client, o.company_id, d, d.assigneeEmail,
          `Ärende ${d.orderNr}: nytt meddelande från anmälaren`,
          `${d.reporterName ?? 'Anmälaren'} skrev om ärende ${d.orderNr} (${d.title}):\n\n${v.body}\n\n${caseLink(req, d.id)}`,
          'Besked till ansvarig',
        );
      }
      return reporterView(client, o.id);
    });
  }

  /** Hantverkarens arbetsorder. */
  @Get('work-orders/:token')
  async supplierView(@Param('token') token: string, @Req() req: Request) {
    limitOrThrow(`fault-read:${req.ip}`, LIMIT_READ.limit, LIMIT_READ.windowMs);
    const o = await lookupOrder(token, 'supplier');
    if (!o) throw new NotFoundException('Arbetsordern finns inte');
    return withContext(publicCtx(o.company_id, o.group_id), async (_db, client) => supplierView(client, o.id));
  }

  /** Hantverkaren kvitterar: påbörjat, utfört eller en kommentar, med bilder. */
  @Post('work-orders/:token/report')
  @HttpCode(201)
  @UseInterceptors(FilesInterceptor('photos', MAX_PHOTOS, { limits: { fileSize: MAX_PHOTO_BYTES, fields: 10 } }))
  async supplierReport(@Param('token') token: string, @Body() body: unknown, @Req() req: Request, @UploadedFiles() files: Express.Multer.File[] = []) {
    const o = await lookupOrder(token, 'supplier');
    if (!o) throw new NotFoundException('Arbetsordern finns inte');
    const v = parse(supplierReportSchema, body);
    limitOrThrow(`wo-supplier:${req.ip}`, 30, 60 * 60_000);
    return withContext(publicCtx(o.company_id, o.group_id), async (_db, client) => {
      const d = (await loadDetail(client, o.id))!;
      if (d.status === 'closed' || d.status === 'cancelled') throw new BadRequestException('Arbetsordern är avslutad');
      const who = v.name || d.supplierName || 'Hantverkaren';
      if (v.action === 'comment' && !v.body && !files.length) throw new BadRequestException('Skriv ett meddelande eller bifoga en bild');
      if (v.action !== 'comment') {
        const status: Status = v.action === 'done' ? 'done' : 'in_progress';
        await client.query(
          `update work_order set status = $2, done_at = case when $2 = 'done' then coalesce(done_at, now()) else done_at end where id = $1`,
          [o.id, status],
        );
        await addEvent(client, o.company_id, o.id, 'status', `Status: ${STATUS_LABEL[status]} (kvitterat av ${who})`, { authorLabel: who });
      }
      if (v.body) await addEvent(client, o.company_id, o.id, 'supplier_report', v.body, { visibility: 'supplier', authorLabel: who });
      const n = await savePhotos(client, o.company_id, o.id, files, `Från ${who}`);
      if (n) await addEvent(client, o.company_id, o.id, 'photo', `${n} bild(er) från ${who}`, { authorLabel: who });
      const after = (await loadDetail(client, o.id))!;
      if (after.assigneeEmail) {
        const what = v.action === 'done' ? 'har kvitterat arbetet som utfört' : v.action === 'started' ? 'har påbörjat arbetet' : 'har skrivit';
        await mailAndLog(
          client, o.company_id, after, after.assigneeEmail,
          `Arbetsorder ${after.orderNr}: ${who} ${what}`,
          `${who} ${what} i ärende ${after.orderNr} (${after.title}).${v.body ? `\n\n${v.body}` : ''}\n\n${caseLink(req, after.id)}`,
          'Besked till ansvarig',
        );
      }
      return supplierView(client, o.id);
    });
  }

  @Get('work-orders/:token/photos/:docId')
  async supplierPhoto(@Param('token') token: string, @Param('docId', ParseUUIDPipe) docId: string, @Res() res: Response) {
    const o = await lookupOrder(token, 'supplier');
    if (!o) throw new NotFoundException('Arbetsordern finns inte');
    const doc = await withContext(publicCtx(o.company_id, o.group_id), async (_db, client) =>
      (
        await client.query(
          `select d.file_name, d.mime_type, c.content from document d join document_content c on c.id = d.id
           where d.id = $1 and d.entity_type = 'work_order' and d.entity_id = $2`,
          [docId, o.id],
        )
      ).rows[0],
    );
    if (!doc) throw new NotFoundException('Bilden finns inte');
    res.setHeader('content-type', doc.mime_type);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(doc.content);
  }
}

async function reporterView(client: PoolClient, id: string) {
  const d = (await loadDetail(client, id))!;
  return {
    orderNr: d.orderNr,
    title: d.title,
    category: CATEGORY_LABEL[d.category as keyof typeof CATEGORY_LABEL] ?? d.category,
    status: d.status,
    statusLabel: REPORTER_STATUS_LABEL[d.status as Status],
    propertyName: d.propertyName,
    objectNr: d.objectNr,
    companyName: d.companyName,
    createdAt: d.createdAt,
    doneAt: d.doneAt,
    scheduledDate: d.scheduledDate,
    canWrite: !['closed', 'cancelled'].includes(d.status),
    anonymized: !!d.anonymizedAt,
    // Bara det som riktats till anmälaren, och statusbyten utan interna kommentarer
    events: d.events
      .filter((e) => e.visibility === 'reporter' || e.kind === 'created' || (e.kind === 'status' && e.visibility === 'internal'))
      .map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind === 'reporter_comment' ? 'you' : e.kind === 'comment' ? 'message' : e.kind === 'status' || e.kind === 'created' ? 'status' : 'message',
        body:
          e.kind === 'created'
            ? 'Felanmälan mottagen'
            : e.kind === 'status'
              ? String(e.body ?? '').replace(/^Status: /, '').replace(/ \(kvitterat av .*\)$/, '')
              : e.body,
      })),
  };
}

async function supplierView(client: PoolClient, id: string) {
  const d = (await loadDetail(client, id))!;
  return {
    orderNr: d.orderNr,
    title: d.title,
    description: d.description,
    category: CATEGORY_LABEL[d.category as keyof typeof CATEGORY_LABEL] ?? d.category,
    priority: d.priority,
    status: d.status,
    statusLabel: STATUS_LABEL[d.status as Status],
    companyName: d.companyName,
    propertyName: d.propertyName,
    addressLine: d.addressLine,
    postalCode: d.postalCode,
    city: d.city,
    objectNr: d.objectNr,
    apartmentNr: d.apartmentNr,
    floor: d.floor,
    location: d.location,
    dueDate: d.dueDate,
    scheduledDate: d.scheduledDate,
    costEstimateOre: d.costEstimateOre,
    masterKeyOk: d.masterKeyOk,
    accessNote: d.accessNote,
    contactName: d.reporterName,
    contactPhone: d.reporterPhone,
    canReport: !['closed', 'cancelled'].includes(d.status),
    photos: d.photos.map((p) => ({ id: p.id, fileName: p.fileName })),
    events: d.events
      .filter((e) => e.visibility === 'supplier' || e.kind === 'status')
      .map((e) => ({ id: e.id, createdAt: e.createdAt, author: e.author, body: e.body, kind: e.kind })),
  };
}
