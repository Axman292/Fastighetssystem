import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { isoDate, kronorToOre } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { allocatePayment, unallocated } from './payment-store';

const amount = z.number({ invalid_type_error: 'Ange ett belopp' }).finite().positive('Ange ett belopp').max(1e10).transform(kronorToOre);

const createSchema = z.object({
  customerId: z.string().uuid(),
  amount,
  paymentDate: isoDate,
  method: z.enum(['bankgiro', 'autogiro', 'swish', 'cash', 'other']).default('bankgiro'),
  reference: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /** Fördela direkt på kundens öppna fakturor, äldst först */
  allocate: z.boolean().default(true),
});

const allocateSchema = z.object({
  invoiceId: z.string().uuid().nullable().optional(),
  amount: amount.nullable().optional(),
});

const refundSchema = z.object({
  amount,
  refundDate: isoDate,
  method: z.enum(['bank', 'swish', 'cash', 'other']).default('bank'),
  note: z.string().trim().max(300).nullable().optional(),
});

export const PAYMENT_LIST_SQL = `
  select p.id, p.company_id as "companyId", p.customer_id as "customerId", c.name as "customerName", c.customer_nr as "customerNr",
         p.amount_ore::float as "amountOre", p.payment_date::text as "paymentDate", p.method, p.reference, p.note,
         b.allocated_ore::float as "allocatedOre", b.refunded_ore::float as "refundedOre", b.unallocated_ore::float as "unallocatedOre",
         p.bank_transaction_id as "bankTransactionId", t.bank_file_id as "bankFileId",
         coalesce((select string_agg(i.invoice_nr::text, ', ' order by i.invoice_nr) from payment_allocation a
                   join invoice i on i.id = a.invoice_id where a.payment_id = p.id), '') as invoices
  from payment p
  join customer c on c.id = p.customer_id
  join payment_balance b on b.payment_id = p.id
  left join bank_transaction t on t.id = p.bank_transaction_id`;

@Controller('payments')
export class PaymentsController {
  /** Inbetalningar med fördelning, till exempel för en kund eller bara de med ej fördelat belopp. */
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('customerId') customerId?: string, @Query('unallocated') onlyUnallocated?: string) {
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new BadRequestException('Ogiltigt id');
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `${PAYMENT_LIST_SQL}
           where ($1::uuid is null or p.customer_id = $1) and ($2::boolean is false or b.unallocated_ore > 0)
           order by p.payment_date desc, p.created_at desc limit 500`,
          [customerId || null, onlyUnallocated === '1' || onlyUnallocated === 'true'],
        )
      ).rows,
    );
  }

  /** Registrerar en inbetalning på kunden (t.ex. kontant eller Swish) och fördelar den äldst först. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const data = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const ok = (await client.query('select 1 from customer where id = $1', [data.customerId])).rows[0];
      if (!ok) throw new BadRequestException('Kunden finns inte i valt bolag');
      const { rows } = await client.query(
        `insert into payment (company_id, customer_id, amount_ore, payment_date, method, reference, note)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [companyId, data.customerId, data.amount, data.paymentDate, data.method, data.reference ?? null, data.note ?? null],
      );
      const allocations = data.allocate ? await allocatePayment(client, companyId, rows[0].id) : [];
      const p = (await client.query(`${PAYMENT_LIST_SQL} where p.id = $1`, [rows[0].id])).rows[0];
      return { ...p, allocations };
    });
  }

  /** Fördelar ej fördelat belopp på en faktura, eller på kundens öppna fakturor äldst först. */
  @Post(':id/allocate')
  allocate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const data = parse(allocateSchema, body ?? {});
    return withContext(dbContext(ctx), async (_db, client) => {
      const allocations = await allocatePayment(client, companyId, id, { invoiceId: data.invoiceId, amount: data.amount });
      if (!allocations.length) throw new ConflictException('Kunden har inga obetalda fakturor att fördela på');
      const p = (await client.query(`${PAYMENT_LIST_SQL} where p.id = $1`, [id])).rows[0];
      return { ...p, allocations };
    });
  }

  /** Betalar tillbaka ej fördelat belopp till kunden. */
  @Post(':id/refunds')
  refund(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const data = parse(refundSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const p = await unallocated(client, id);
      if (data.amount > p.unallocated) {
        throw new BadRequestException({ message: 'Ogiltiga uppgifter', fields: [{ path: 'amount', message: `Högst ${p.unallocated / 100} kr kan betalas tillbaka` }] });
      }
      await client.query(
        `insert into payment_refund (company_id, payment_id, amount_ore, refund_date, method, note) values ($1, $2, $3, $4, $5, $6)`,
        [companyId, id, data.amount, data.refundDate, data.method, data.note ?? null],
      );
      return (await client.query(`${PAYMENT_LIST_SQL} where p.id = $1`, [id])).rows[0];
    });
  }

  /** Ångrar fördelningen av en betalning, så att den kan fördelas om. */
  @Delete(':id/allocations')
  @HttpCode(204)
  async unallocate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'payment.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      await unallocated(client, id);
      await client.query('delete from payment_allocation where payment_id = $1', [id]);
    });
  }

  /**
   * Tar bort en felregistrerad betalning. Fördelningen tas bort och fakturan blir obetald igen.
   * Kom betalningen från en bankfil går transaktionen tillbaka till att vänta på bokföring.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'payment.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const p = (await client.query('select bank_transaction_id from payment where id = $1 for update', [id])).rows[0];
      if (!p) throw new BadRequestException('Betalningen finns inte i valt bolag');
      const refunds = (await client.query('select count(*)::int as n from payment_refund where payment_id = $1', [id])).rows[0].n;
      if (refunds) throw new ConflictException('Betalningen har en återbetalning och kan inte tas bort');
      await client.query('delete from payment where id = $1', [id]);
      if (p.bank_transaction_id) {
        await client.query(`update bank_transaction set status = 'unmatched', customer_id = null, invoice_id = null, match_rule = null,
                              note = 'Betalningen togs bort. Välj kund och faktura igen.' where id = $1`, [p.bank_transaction_id]);
      }
    });
  }
}
