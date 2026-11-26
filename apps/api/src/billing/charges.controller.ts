import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { isoDate, kronorToOre } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { monthStart } from './billing-rules';
import { ARTICLES } from './invoices.controller';

const chargeSchema = z.object({
  article: z.enum(ARTICLES).default('other'),
  description: z.string().trim().min(1, 'Ange en text').max(300),
  amount: z
    .number({ invalid_type_error: 'Ange ett belopp' })
    .finite()
    .refine((v) => v !== 0, 'Beloppet kan inte vara noll')
    .refine((v) => Math.abs(v) <= 1e9, 'För stort belopp')
    .transform(kronorToOre),
  vatRateBp: z.union([z.literal(0), z.literal(600), z.literal(1200), z.literal(2500)]).default(0),
  objectId: z.string().uuid().nullable().optional(),
  billFrom: isoDate,
  note: z.string().trim().max(500).nullable().optional(),
});

/** Extra debiteringar på ett avtal, som följer med nästa avi. Och avtalets fakturor. */
@Controller('contracts')
export class ChargesController {
  @Get(':id/charges')
  list(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) =>
      (
        await client.query(
          `select ch.id, ch.article, ch.description, ch.amount_ore::float as "amountOre", ch.vat_rate_bp as "vatRateBp",
                  ch.object_id as "objectId", o.object_nr as "objectNr", ch.bill_from::text as "billFrom", ch.note,
                  (select i.id from invoice_line l join invoice i on i.id = l.invoice_id
                   where l.contract_charge_id = ch.id and i.status = 'issued' limit 1) as "invoiceId",
                  (select i.invoice_nr::float from invoice_line l join invoice i on i.id = l.invoice_id
                   where l.contract_charge_id = ch.id and i.status = 'issued' limit 1) as "invoiceNr"
           from contract_charge ch left join rental_object o on o.id = ch.object_id
           where ch.contract_id = $1 order by ch.bill_from desc, ch.created_at desc`,
          [id],
        )
      ).rows,
    );
  }

  @Post(':id/charges')
  create(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'invoice.write');
    const data = parse(chargeSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const k = (await client.query('select type, status from contract where id = $1', [id])).rows[0];
      if (!k) throw new BadRequestException('Avtalet finns inte i valt bolag');
      if (k.status === 'cancelled' || k.status === 'draft') throw new ConflictException('Extra debiteringar läggs på aktiva eller uppsagda avtal');
      if (k.type === 'residential' && data.vatRateBp > 0) throw new BadRequestException('Bostadsavtal kan inte ha moms');
      if (data.objectId) {
        const { rows } = await client.query('select 1 from contract_object where contract_id = $1 and object_id = $2', [id, data.objectId]);
        if (!rows.length) throw new BadRequestException('Objektet ingår inte i avtalet');
      }
      const { rows } = await client.query(
        `insert into contract_charge (company_id, contract_id, object_id, article, description, amount_ore, vat_rate_bp, bill_from, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [companyId, id, data.objectId ?? null, data.article, data.description, data.amount, data.vatRateBp, monthStart(data.billFrom), data.note ?? null],
      );
      await client.query(
        `insert into contract_event (company_id, contract_id, kind, description) values ($1, $2, 'charge', $3)`,
        [companyId, id, `Extra debitering: ${data.description}, ${(data.amount / 100).toLocaleString('sv-SE')} kr`],
      );
      return { id: rows[0].id };
    });
  }

  @Delete(':id/charges/:chargeId')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('chargeId', ParseUUIDPipe) chargeId: string) {
    requireCompany(ctx, 'invoice.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select exists (select 1 from invoice_line l join invoice i on i.id = l.invoice_id
                        where l.contract_charge_id = $1 and i.status = 'issued') as billed`,
        [chargeId],
      );
      if (rows[0].billed) throw new ConflictException('Debiteringen är redan fakturerad. Gör en kreditfaktura i stället.');
      // Ligger den i ett utkast till avi tas raden bort därifrån; körningen visar det vid nästa uppdatering.
      await client.query(`delete from invoice_line where contract_charge_id = $1`, [chargeId]);
      const r = await client.query('delete from contract_charge where id = $1 and contract_id = $2', [chargeId, id]);
      if (!r.rowCount) throw new BadRequestException('Debiteringen finns inte');
    });
  }
}
