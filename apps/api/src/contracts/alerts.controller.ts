import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isoDate, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { activeAlerts, contractEvents, DEFAULT_SETTINGS, toIcs, withAcks } from './alerts';
import { recipients, sendDigest } from './alert-digest';
import { addDays } from './contract-rules';

const ackSchema = z.object({
  key: z.string().min(5).max(300),
  contractId: z.string().uuid(),
  kind: z.string().min(1).max(40),
  date: isoDate,
  action: z.enum(['done', 'snooze']),
  snoozeUntil: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const days = z.number().int().min(1).max(730);
const settingsSchema = z.object({
  noticeDays: days,
  endingDays: days,
  renegotiateDays: days,
  indexDays: days,
  rentChangeDays: days,
  securityDays: days,
  digestEnabled: z.boolean(),
  digestFrequency: z.enum(['daily', 'weekly']),
  digestWeekday: z.number().int().min(1).max(7),
  recipientIds: z.array(z.string().uuid()).max(200),
});

const rangeSchema = z.object({ from: isoDate, to: isoDate });

@Controller('contract-alerts')
export class ContractAlertsController {
  /** Påminnelser att hantera nu. handled=1 tar även med klara och uppskjutna. */
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('handled') handled?: string) {
    return withContext(dbContext(ctx), (_db, client) => activeAlerts(client, { includeHandled: handled === '1' }));
  }

  /** Alla avtalsdatum i ett datumspann, för kalendern. */
  @Get('calendar')
  calendar(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const { from, to } = parse(rangeSchema, query);
    if (to < from) throw new BadRequestException('Slutdatum före startdatum');
    if (to > addDays(from, 800)) throw new BadRequestException('Välj högst två år åt gången');
    return withContext(dbContext(ctx), async (_db, client) => {
      const items = await withAcks(client, await contractEvents(client, { from, to }));
      return items.sort((a, b) => a.date.localeCompare(b.date) || a.contractNr - b.contractNr);
    });
  }

  /** Kalenderfil med avtalsdatumen de kommande tolv månaderna. */
  @Get('calendar.ics')
  async ics(@Ctx() ctx: RequestContext, @Res() res: Response) {
    const now = today();
    const items = await withContext(dbContext(ctx), (_db, client) => contractEvents(client, { from: now, to: addDays(now, 366) }));
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="avtalsbevakning.ics"');
    res.send(toIcs(items, process.env.PUBLIC_URL?.replace(/\/+$/, '') ?? ''));
  }

  /** Kommande datum för ett avtal, med vad som gjorts med påminnelserna. */
  @Get('contract/:id')
  forContract(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const now = today();
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const items = await withAcks(client, await contractEvents(client, { from: addDays(now, -60), to: addDays(now, 730), contractId: id }));
      return items.sort((a, b) => a.date.localeCompare(b.date));
    });
  }

  /** Markera en påminnelse som klar eller skjut upp den. */
  @Post('ack')
  ack(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'contract.write');
    const a = parse(ackSchema, body);
    if (a.action === 'snooze' && (!a.snoozeUntil || a.snoozeUntil <= today())) {
      throw new BadRequestException('Välj ett datum efter i dag att påminnas igen');
    }
    if (!a.key.includes(a.contractId)) throw new BadRequestException('Påminnelsen hör inte till avtalet');
    return withContext(dbContext(ctx), async (_db, client) => {
      const k = await client.query('select 1 from contract where id = $1 and company_id = $2', [a.contractId, companyId]);
      if (!k.rowCount) throw new NotFoundException('Avtalet finns inte i valt bolag');
      const { rows } = await client.query(
        `insert into contract_alert_ack (company_id, contract_id, alert_key, kind, due_date, action, snooze_until, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (company_id, alert_key) do update
           set action = excluded.action, snooze_until = excluded.snooze_until, note = excluded.note
         returning id`,
        [companyId, a.contractId, a.key, a.kind, a.date, a.action, a.action === 'snooze' ? a.snoozeUntil : null, a.note ?? null],
      );
      await client.query(
        `insert into contract_event (company_id, contract_id, kind, description) values ($1, $2, 'note', $3)`,
        [
          companyId,
          a.contractId,
          a.action === 'done'
            ? `Påminnelse hanterad (${a.date})${a.note ? `: ${a.note}` : ''}`
            : `Påminnelse (${a.date}) uppskjuten till ${a.snoozeUntil}${a.note ? `: ${a.note}` : ''}`,
        ],
      );
      return { id: rows[0].id };
    });
  }

  /** Ångra klar eller uppskjuten. */
  @Delete('ack/:id')
  @HttpCode(204)
  async unack(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'contract.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const r = await client.query('delete from contract_alert_ack where id = $1 and company_id = $2', [id, companyId]);
      if (!r.rowCount) throw new NotFoundException('Finns inte');
    });
  }

  @Get('settings')
  settings(@Ctx() ctx: RequestContext) {
    if (!ctx.activeCompanyId) throw new BadRequestException('Välj ett bolag för att se inställningarna');
    const companyId = ctx.activeCompanyId;
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select notice_days as "noticeDays", ending_days as "endingDays", renegotiate_days as "renegotiateDays",
                index_days as "indexDays", rent_change_days as "rentChangeDays", security_days as "securityDays",
                digest_enabled as "digestEnabled", digest_frequency as "digestFrequency", digest_weekday as "digestWeekday",
                last_digest_at as "lastDigestAt", last_digest_note as "lastDigestNote"
         from contract_alert_setting where company_id = $1`,
        [companyId],
      );
      const users = (
        await client.query(
          `select u.id, u.name, u.email, exists (select 1 from contract_alert_recipient r where r.company_id = $1 and r.user_id = u.id) as selected
           from app_user u
           where u.active and (u.is_group_admin or exists (select 1 from membership m where m.user_id = u.id and m.company_id = $1
                   and (m.valid_until is null or m.valid_until >= current_date)))
           order by u.name`,
          [companyId],
        )
      ).rows;
      return {
        ...(rows[0] ?? { ...DEFAULT_SETTINGS, digestEnabled: false, digestFrequency: 'weekly', digestWeekday: 1, lastDigestAt: null, lastDigestNote: null }),
        users,
      };
    });
  }

  @Put('settings')
  async saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'contract.write');
    const s = parse(settingsSchema, body);
    await withContext(dbContext(ctx), async (_db, client) => {
      await client.query(
        `insert into contract_alert_setting (company_id, notice_days, ending_days, renegotiate_days, index_days, rent_change_days,
                                             security_days, digest_enabled, digest_frequency, digest_weekday)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (company_id) do update set
           notice_days = excluded.notice_days, ending_days = excluded.ending_days, renegotiate_days = excluded.renegotiate_days,
           index_days = excluded.index_days, rent_change_days = excluded.rent_change_days, security_days = excluded.security_days,
           digest_enabled = excluded.digest_enabled, digest_frequency = excluded.digest_frequency, digest_weekday = excluded.digest_weekday`,
        [companyId, s.noticeDays, s.endingDays, s.renegotiateDays, s.indexDays, s.rentChangeDays, s.securityDays, s.digestEnabled, s.digestFrequency, s.digestWeekday],
      );
      const members = (
        await client.query(
          `select u.id from app_user u where u.id = any($2) and u.active
             and (u.is_group_admin or exists (select 1 from membership m where m.user_id = u.id and m.company_id = $1))`,
          [companyId, s.recipientIds],
        )
      ).rows.map((r) => r.id as string);
      if (members.length !== new Set(s.recipientIds).size) throw new BadRequestException('En mottagare har inte tillgång till bolaget');
      await client.query('delete from contract_alert_recipient where company_id = $1 and not (user_id = any($2))', [companyId, members]);
      await client.query(
        `insert into contract_alert_recipient (company_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
        [companyId, members],
      );
    });
    return this.settings(ctx);
  }

  /** Skickar sammanfattningen nu, till alla mottagare eller bara till mig själv. */
  @Post('digest/send')
  sendNow(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'contract.write');
    const { toMe } = parse(z.object({ toMe: z.boolean().default(false) }), body ?? {});
    return withContext(dbContext(ctx), async (_db, client) => {
      if (!toMe && !(await recipients(client, [companyId])).length) {
        throw new BadRequestException('Välj minst en mottagare och spara först');
      }
      return sendDigest(client, [companyId], toMe ? { userId: ctx.userId, name: ctx.name, email: ctx.email, companyIds: [companyId] } : undefined);
    });
  }
}
