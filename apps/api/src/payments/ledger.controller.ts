import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext } from '../auth/request-context';
import { billToFor, companyInfo } from '../billing/invoice-store';
import { renderStatementPdf, Statement, StatementEntry } from './letters-pdf';

const KIND: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };
const METHOD: Record<string, string> = { bankgiro: 'bankgiro', autogiro: 'autogiro', swish: 'Swish', cash: 'kontant', other: 'annat sätt' };

/**
 * Kundreskontra: vad varje kund är skyldig, hur gammalt det är och
 * ett kontoutdrag med alla fakturor, krediter, inbetalningar och återbetalningar.
 */
@Controller('ledger')
export class LedgerController {
  /** Saldo per kund med åldersanalys. Bara kunder med öppna poster eller ej fördelade inbetalningar. */
  @Get()
  customers(@Ctx() ctx: RequestContext) {
    const asOf = today();
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `with open as (
           select i.customer_id, b.balance_ore, i.due_date, i.id
           from invoice i join invoice_balance b on b.invoice_id = i.id
           where i.status = 'issued' and i.kind <> 'credit_note' and b.balance_ore <> 0
         ), un as (
           select customer_id, sum(unallocated_ore) as un from payment_balance group by customer_id having sum(unallocated_ore) > 0
         )
         select c.id as "customerId", c.customer_nr as "customerNr", c.name as "customerName", c.company_id as "companyId", co.name as "companyName",
                count(o.id) filter (where o.balance_ore > 0)::int as "openCount",
                coalesce(sum(o.balance_ore), 0)::float as "openOre",
                coalesce(sum(o.balance_ore) filter (where o.due_date >= $1::date), 0)::float as "notDueOre",
                coalesce(sum(o.balance_ore) filter (where o.due_date < $1::date and o.due_date >= $1::date - 30), 0)::float as "d1to30Ore",
                coalesce(sum(o.balance_ore) filter (where o.due_date < $1::date - 30 and o.due_date >= $1::date - 60), 0)::float as "d31to60Ore",
                coalesce(sum(o.balance_ore) filter (where o.due_date < $1::date - 60 and o.due_date >= $1::date - 90), 0)::float as "d61to90Ore",
                coalesce(sum(o.balance_ore) filter (where o.due_date < $1::date - 90), 0)::float as "over90Ore",
                coalesce(max(un.un), 0)::float as "unallocatedOre",
                min(o.due_date) filter (where o.balance_ore > 0 and o.due_date < $1::date)::text as "oldestOverdue",
                coalesce((select max(r.level) from reminder r join invoice_balance rb on rb.invoice_id = r.invoice_id
                          where r.customer_id = c.id and rb.balance_ore > 0), 0) as "reminderLevel"
         from customer c
         join company co on co.id = c.company_id
         left join open o on o.customer_id = c.id
         left join un on un.customer_id = c.id
         group by c.id, co.name
         having count(o.id) > 0 or coalesce(max(un.un), 0) > 0
         order by coalesce(sum(o.balance_ore) filter (where o.due_date < $1::date), 0) desc, c.name`,
        [asOf],
      );
      const out = rows.map((r) => ({ ...r, overdueOre: r.d1to30Ore + r.d31to60Ore + r.d61to90Ore + r.over90Ore, balanceOre: r.openOre - r.unallocatedOre }));
      const sum = (k: keyof (typeof out)[number]) => out.reduce((s, r) => s + (r[k] as number), 0);
      return {
        asOf,
        totals: {
          balanceOre: sum('balanceOre'),
          openOre: sum('openOre'),
          notDueOre: sum('notDueOre'),
          d1to30Ore: sum('d1to30Ore'),
          d31to60Ore: sum('d31to60Ore'),
          d61to90Ore: sum('d61to90Ore'),
          over90Ore: sum('over90Ore'),
          overdueOre: sum('overdueOre'),
          unallocatedOre: sum('unallocatedOre'),
        },
        customers: out,
      };
    });
  }

  @Get('customers/:id')
  customer(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const s = await statement(client, id);
      const { company: _c, ...rest } = s;
      return rest;
    });
  }

  @Get('customers/:id/statement.pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const s = await withContext(dbContext(ctx), (_db, client) => statement(client, id));
    const pdf = await renderStatementPdf(s);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="kontoutdrag-${s.billTo.customerNr}.pdf"`);
    res.end(pdf);
  }
}

async function statement(client: PoolClient, customerId: string): Promise<Statement & { customerId: string }> {
  const cust = (await client.query('select company_id from customer where id = $1', [customerId])).rows[0];
  if (!cust) throw new BadRequestException('Kunden finns inte');
  const asOf = today();
  const events = (
    await client.query(
      `select * from (
         select i.invoice_date as d, i.issued_at as t, case when i.kind = 'credit_note' then 'credit_note' else 'invoice' end as type,
                i.kind, i.invoice_nr::text as nr, i.total_ore::float as amount, i.due_date::text as due,
                (select ci.invoice_nr::text from invoice ci where ci.id = i.credits_invoice_id) as ref, null::text as method
         from invoice i where i.customer_id = $1 and i.status = 'issued'
         union all
         select p.payment_date, p.created_at, 'payment', null, null, -p.amount_ore::float, null,
                coalesce((select string_agg(ai.invoice_nr::text, ', ' order by ai.invoice_nr) from payment_allocation a
                          join invoice ai on ai.id = a.invoice_id where a.payment_id = p.id), ''), p.method
         from payment p where p.customer_id = $1
         union all
         select r.refund_date, r.created_at, 'refund', null, null, r.amount_ore::float, null, null, r.method
         from payment_refund r join payment p on p.id = r.payment_id where p.customer_id = $1
       ) e order by d, t`,
      [customerId],
    )
  ).rows;
  let balance = 0;
  const entries: StatementEntry[] = events.map((e) => {
    balance += e.amount;
    const date = (e.d instanceof Date ? e.d.toISOString() : String(e.d)).slice(0, 10);
    const text =
      e.type === 'invoice'
        ? `${KIND[e.kind] ?? 'Faktura'} ${e.nr}`
        : e.type === 'credit_note'
          ? `Kreditfaktura ${e.nr}${e.ref ? ` (krediterar ${e.ref})` : ''}`
          : e.type === 'payment'
            ? `Inbetalning via ${METHOD[e.method] ?? e.method}${e.ref ? `, avser ${e.ref}` : ', ej fördelad'}`
            : 'Återbetalning till kund';
    return { date, type: e.type, text, amountOre: e.amount, balanceOre: balance, dueDate: e.due };
  });
  const open = (
    await client.query(
      `select i.id as "invoiceId", i.invoice_nr::float as "invoiceNr", i.kind, i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate",
              i.total_ore::float as "totalOre", b.balance_ore::float as "balanceOre", i.ocr,
              coalesce((select max(r.level) from reminder r where r.invoice_id = i.id), 0) as "reminderLevel"
       from invoice i join invoice_balance b on b.invoice_id = i.id
       where i.customer_id = $1 and i.status = 'issued' and i.kind <> 'credit_note' and b.balance_ore > 0
       order by i.due_date, i.invoice_nr`,
      [customerId],
    )
  ).rows;
  const unallocatedOre = Number(
    (await client.query('select coalesce(sum(unallocated_ore), 0)::float as n from payment_balance where customer_id = $1', [customerId])).rows[0].n,
  );
  const { billTo } = await billToFor(client, customerId);
  return {
    customerId,
    company: await companyInfo(client, cust.company_id),
    billTo,
    asOf,
    entries,
    open,
    unallocatedOre,
    balanceOre: balance,
    overdueOre: open.filter((o) => o.dueDate < asOf).reduce((s, o) => s + o.balanceOre, 0),
  };
}
