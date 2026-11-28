import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import {
  applyAdjustment,
  applySchema,
  criteriaSchema,
  previewAdjustment,
  previewResponse,
  revertAdjustment,
  revertBlocker,
} from './rent-adjustment';

/**
 * Hyresjustering: ändra hyran för många avtal och objekt på en gång,
 * till exempel den årliga hyreshöjningen för bostäder.
 */
@Controller('rent-adjustments')
export class RentAdjustmentsController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select a.id, a.company_id as "companyId", co.name as "companyName", a.adjustment_nr as "adjustmentNr", a.name,
                  a.effective_date::text as "effectiveDate", a.method, a.percent::float as percent, a.amount_ore::float as "amountOre",
                  a.status, a.line_count as "lineCount", a.object_count as "objectCount",
                  a.total_before_ore::float as "beforeOre", a.total_after_ore::float as "afterOre",
                  a.created_at as "createdAt", u.name as "createdByName", a.reverted_at as "revertedAt"
           from rent_adjustment a
           join company co on co.id = a.company_id
           left join app_user u on u.id = a.created_by
           order by a.created_at desc`,
        )
      ).rows,
    );
  }

  /** Visar vad en justering skulle ändra. Inget sparas. */
  @Post('preview')
  @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const c = parse(criteriaSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => previewResponse(await previewAdjustment(client, c)));
  }

  @Post()
  apply(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'contract.write');
    const data = parse(applySchema, body);
    return withContext(dbContext(ctx), (_db, client) => applyAdjustment(client, companyId, data));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const blocker = await revertBlocker(client, id);
      const { rows: a } = await client.query(
        `select a.id, a.company_id as "companyId", co.name as "companyName", a.adjustment_nr as "adjustmentNr", a.name,
                a.effective_date::text as "effectiveDate", a.method, a.percent::float as percent, a.amount_ore::float as "amountOre",
                a.rounding, a.criteria, a.reason, a.status, a.line_count as "lineCount", a.object_count as "objectCount",
                a.total_before_ore::float as "beforeOre", a.total_after_ore::float as "afterOre",
                a.created_at as "createdAt", u.name as "createdByName", a.reverted_at as "revertedAt", r.name as "revertedByName"
         from rent_adjustment a
         join company co on co.id = a.company_id
         left join app_user u on u.id = a.created_by
         left join app_user r on r.id = a.reverted_by
         where a.id = $1`,
        [id],
      );
      const { rows: items } = await client.query(
        `select i.id, i.kind, i.contract_id as "contractId", k.contract_nr as "contractNr", c.name as "customerName",
                i.object_id as "objectId", o.object_nr as "objectNr", o.type as "objectType", p.name as "propertyName",
                i.description, i.old_amount_ore::float as "oldOre", i.new_amount_ore::float as "newOre"
         from rent_adjustment_item i
         left join contract k on k.id = i.contract_id
         left join customer c on c.id = k.customer_id
         left join rental_object o on o.id = i.object_id
         left join property p on p.id = o.property_id
         where i.adjustment_id = $1
         order by i.kind, p.name, o.object_nr, k.contract_nr`,
        [id],
      );
      return { ...a[0], canRevert: blocker === null, revertBlocker: blocker, items };
    });
  }

  /** Ångrar en justering så länge den nya hyran inte har aviserats. */
  @Post(':id/revert')
  @HttpCode(200)
  revert(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'contract.write');
    return withContext(dbContext(ctx), (_db, client) => revertAdjustment(client, id));
  }
}
