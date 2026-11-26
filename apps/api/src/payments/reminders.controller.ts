import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isoDate, today } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { renderRemindersPdf } from './letters-pdf';
import { createReminders, loadReminders, REMINDER_SQL, reminderCandidates, sendReminders } from './reminders';

const createSchema = z.object({
  reminderDate: isoDate.optional(),
  invoiceIds: z.array(z.string().uuid()).min(1, 'Välj minst en faktura').max(2000),
  chargeFee: z.boolean().default(true),
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(2000) });

@Controller('reminders')
export class RemindersController {
  /** Förslag: förfallna fakturor som kan påminnas, som väntar på frist eller som är redo för inkasso. */
  @Get('suggestion')
  suggestion(@Ctx() ctx: RequestContext, @Query('date') date?: string) {
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
    return withContext(dbContext(ctx), async (_db, client) => {
      const rows = await reminderCandidates(client, d);
      const settings = ctx.activeCompanyId
        ? (
            await client.query(
              `select reminder_fee_ore::float as "feeOre", reminder_grace_days as "graceDays", reminder_due_days as "dueDays",
                      late_interest_bp as "interestBp" from company where id = $1`,
              [ctx.activeCompanyId],
            )
          ).rows[0]
        : null;
      return { date: d, settings, candidates: rows };
    });
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query('invoiceId') invoiceId?: string, @Query('customerId') customerId?: string, @Query('status') status?: string) {
    for (const v of [invoiceId, customerId]) if (v && !/^[0-9a-f-]{36}$/i.test(v)) throw new BadRequestException('Ogiltigt id');
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `${REMINDER_SQL}
           where ($1::uuid is null or r.invoice_id = $1) and ($2::uuid is null or r.customer_id = $2) and ($3::text is null or r.status = $3)
           order by r.created_at desc, cu.name limit 1000`,
          [invoiceId || null, customerId || null, status || null],
        )
      ).rows,
    );
  }

  /** Skapar påminnelser för valda fakturor och skickar dem som ska gå med e-post. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'reminder.send');
    const data = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const res = await createReminders(client, companyId, { reminderDate: data.reminderDate ?? today(), invoiceIds: data.invoiceIds, chargeFee: data.chargeFee });
      const delivery = await sendReminders(client, res.created);
      return { ...res, delivery };
    });
  }

  /** Försöker skicka påminnelser som misslyckats igen. */
  @Post('send')
  send(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireCompany(ctx, 'reminder.send');
    const data = parse(idsSchema, body);
    return withContext(dbContext(ctx), (_db, client) => sendReminders(client, data.ids));
  }

  /** Påminnelser som ska skickas som brev, samlade för utskrift. */
  @Get('print.pdf')
  async print(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('ids') ids?: string) {
    const list = await withContext(dbContext(ctx), async (_db, client) => {
      const wanted = (ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      const found = wanted.length
        ? wanted
        : (await client.query(`select id from reminder where channel = 'post' and status = 'queued'`)).rows.map((r) => r.id as string);
      return found.length ? loadReminders(client, found) : [];
    });
    if (!list.length) throw new BadRequestException('Det finns inga påminnelser att skriva ut');
    const pdf = await renderRemindersPdf(list);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'inline; filename="paminnelser.pdf"');
    res.end(pdf);
  }

  /** Markerar utskrivna brev som skickade. */
  @Post('mark-printed')
  markPrinted(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireCompany(ctx, 'reminder.send');
    const data = parse(idsSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rowCount } = await client.query(
        `update reminder set status = 'printed', sent_at = now() where id = any($1) and channel = 'post' and status = 'queued'`,
        [data.ids],
      );
      return { printed: rowCount };
    });
  }

  @Get(':id/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const list = await withContext(dbContext(ctx), (_db, client) => loadReminders(client, [id]));
    if (!list.length) throw new BadRequestException('Påminnelsen finns inte');
    const pdf = await renderRemindersPdf(list);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="paminnelse-${list[0].invoiceNr}-${list[0].level}.pdf"`);
    res.end(pdf);
  }
}
