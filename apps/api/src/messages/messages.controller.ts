import { Body, Controller, Delete, Get, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { parse } from '../common/validation';
import { DbContext, withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import {
  BUILT_IN_TEMPLATES,
  createCampaign,
  deliveryConfig,
  preview as buildPreview,
  previewSchema,
  queuedCount,
  requeueFailed,
  sendBatch,
  sendSchema,
  sendTest,
  templateSchema,
  testSchema,
} from './messages';

const log = new Logger('Utskick');
/** Utskick med högst så här många mottagare skickas klart innan svaret kommer. Större skickas i bakgrunden. */
const INLINE_LIMIT = 25;
const running = new Set<string>();

/** Skickar köade mottagare i omgångar, var och en i egen transaktion så att loggen sparas löpande. */
async function drain(ctx: DbContext, campaignId: string): Promise<void> {
  if (running.has(campaignId)) return;
  running.add(campaignId);
  try {
    for (let i = 0; i < 10000; i++) {
      const left = await withContext(ctx, (_db, client) => sendBatch(client, campaignId));
      if (!left) break;
    }
  } finally {
    running.delete(campaignId);
  }
}

const COUNTS = `
  count(*) filter (where r.status = 'sent')::int as sent,
  count(*) filter (where r.status = 'test')::int as test,
  count(*) filter (where r.status = 'failed')::int as failed,
  count(*) filter (where r.status = 'skipped')::int as skipped,
  count(*) filter (where r.status = 'queued')::int as queued,
  count(*) filter (where r.channel = 'email' and r.status in ('sent','test'))::int as emails,
  count(*) filter (where r.channel = 'sms' and r.status in ('sent','test'))::int as sms`;

/**
 * Utskick till hyresgäster: e-post och SMS till alla eller ett urval,
 * till exempel om vattenavstängning eller planerat underhåll.
 */
@Controller('messages')
export class MessagesController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select m.id, m.company_id as "companyId", co.name as "companyName", m.campaign_nr as "campaignNr", m.name,
                  m.send_email as "sendEmail", m.send_sms as "sendSms", m.subject, m.status, m.recipient_count as "recipientCount",
                  m.created_at as "createdAt", u.name as "createdByName", ${COUNTS}
           from message_campaign m
           join company co on co.id = m.company_id
           left join app_user u on u.id = m.created_by
           left join message_recipient r on r.campaign_id = m.id
           group by m.id, co.name, u.name
           order by m.created_at desc`,
        )
      ).rows,
    );
  }

  @Get('config')
  config() {
    return deliveryConfig();
  }

  // ------------------------------------------------------------------ mallar

  @Get('templates')
  templates(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => ({
      builtIn: BUILT_IN_TEMPLATES,
      own: (
        await client.query(
          `select t.id, t.company_id as "companyId", co.name as "companyName", t.name, t.subject, t.body, t.sms_body as "smsBody",
                  t.active, t.updated_at as "updatedAt"
           from message_template t join company co on co.id = t.company_id
           order by t.active desc, t.name`,
        )
      ).rows,
    }));
  }

  @Post('templates')
  createTemplate(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'message.send');
    const t = parse(templateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `insert into message_template (company_id, name, subject, body, sms_body, active) values ($1, $2, $3, $4, $5, $6) returning id`,
          [companyId, t.name, t.subject, t.body, t.smsBody, t.active],
        )
      ).rows[0],
    );
  }

  @Patch('templates/:id')
  updateTemplate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'message.send');
    const t = parse(templateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query(
        `update message_template set name = $2, subject = $3, body = $4, sms_body = $5, active = $6 where id = $1 returning id`,
        [id, t.name, t.subject, t.body, t.smsBody, t.active],
      );
      if (!r.rowCount) throw new NotFoundException('Mallen finns inte');
      return r.rows[0];
    });
  }

  @Delete('templates/:id')
  @HttpCode(204)
  async deleteTemplate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'message.send');
    await withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query('delete from message_template where id = $1', [id]);
      if (!r.rowCount) throw new NotFoundException('Mallen finns inte');
    });
  }

  // ------------------------------------------------------------------ utskick

  /** Visar vilka som får utskicket och hur texten blir för var och en. Inget skickas. */
  @Post('preview')
  @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'message.send');
    const input = parse(previewSchema, body);
    return withContext(dbContext(ctx), (_db, client) => buildPreview(client, companyId, input));
  }

  /** Skickar ett prov till användaren själv. */
  @Post('test')
  @HttpCode(200)
  test(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'message.send');
    const input = parse(testSchema, body);
    return withContext(dbContext(ctx), (_db, client) => sendTest(client, companyId, input, ctx.email));
  }

  @Post()
  async send(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'message.send');
    const input = parse(sendSchema, body);
    const db = dbContext(ctx, [companyId]);
    const created = await withContext(db, (_db, client) => createCampaign(client, companyId, input));
    const queued = await withContext(db, (_db, client) => queuedCount(client, created.id));
    if (queued <= INLINE_LIMIT) await drain(db, created.id);
    else drain(db, created.id).catch((err) => log.error(`Utskick ${created.id} avbröts: ${(err as Error).message}`));
    return created;
  }

  /** Utskicksloggen för en hyresgäst. */
  @Get('customer/:customerId')
  forCustomer(@Ctx() ctx: RequestContext, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select r.id, r.campaign_id as "campaignId", m.campaign_nr as "campaignNr", m.name as "campaignName", r.channel, r.recipient,
                  r.subject, r.body, r.status, r.note, r.sent_at as "sentAt", r.created_at as "createdAt"
           from message_recipient r join message_campaign m on m.id = r.campaign_id
           where r.customer_id = $1
           order by r.created_at desc, r.channel`,
          [customerId],
        )
      ).rows,
    );
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select m.id, m.company_id as "companyId", co.name as "companyName", m.campaign_nr as "campaignNr", m.name,
                m.send_email as "sendEmail", m.send_sms as "sendSms", m.subject, m.body, m.sms_body as "smsBody", m.criteria,
                m.status, m.recipient_count as "recipientCount", m.created_at as "createdAt", u.name as "createdByName",
                t.name as "templateName", ${COUNTS}
         from message_campaign m
         join company co on co.id = m.company_id
         left join app_user u on u.id = m.created_by
         left join message_template t on t.id = m.template_id
         left join message_recipient r on r.campaign_id = m.id
         where m.id = $1
         group by m.id, co.name, u.name, t.name`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Utskicket finns inte');
      const { rows: recipients } = await client.query(
        `select r.id, r.customer_id as "customerId", c.customer_nr as "customerNr", r.customer_name as "customerName", r.channel,
                r.recipient, r.subject, r.body, r.status, r.note, r.sent_at as "sentAt"
         from message_recipient r left join customer c on c.id = r.customer_id
         where r.campaign_id = $1
         order by r.customer_name, r.channel, r.recipient`,
        [id],
      );
      return { ...rows[0], sending: running.has(id), recipients };
    });
  }

  /** Försöker igen med de mottagare som misslyckades, och skickar det som fortfarande ligger i kö. */
  @Post(':id/retry')
  @HttpCode(200)
  async retry(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'message.send');
    const db = dbContext(ctx, [companyId]);
    const requeued = await withContext(db, async (_db, client) => {
      const owner = await client.query('select 1 from message_campaign where id = $1', [id]);
      if (!owner.rowCount) throw new NotFoundException('Utskicket finns inte');
      return requeueFailed(client, id);
    });
    const queued = await withContext(db, (_db, client) => queuedCount(client, id));
    if (queued <= INLINE_LIMIT) await drain(db, id);
    else drain(db, id).catch((err) => log.error(`Utskick ${id} avbröts: ${(err as Error).message}`));
    return { requeued, queued };
  }
}
