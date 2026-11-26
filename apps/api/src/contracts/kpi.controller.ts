import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Put } from '@nestjs/common';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext } from '../auth/request-context';
import { kpiSchema } from './contract.schemas';

/** Konsumentprisindex (SCB, 1980 = 100). Gemensamt för alla bolag. */
@Controller('kpi')
export class KpiController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query('select year, month, value::float as value from kpi_value order by year desc, month desc')).rows,
    );
  }

  @Put(':year/:month')
  put(
    @Ctx() ctx: RequestContext,
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
    @Body() body: unknown,
  ) {
    if (!ctx.isGroupAdmin && !ctx.access.some((a) => a.permissions.includes('index.write'))) {
      throw new ForbiddenException('Du saknar behörighet för detta');
    }
    const { value } = parse(kpiSchema, body);
    if (year < 1980 || year > 2200 || month < 1 || month > 12) throw new ForbiddenException('Ogiltig månad');
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `insert into kpi_value (year, month, value) values ($1, $2, $3)
           on conflict (year, month) do update set value = excluded.value
           returning year, month, value::float as value`,
          [year, month, value],
        )
      ).rows[0],
    );
  }
}
