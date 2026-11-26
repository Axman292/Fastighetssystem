import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { kronor } from '../common/money';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { computeEconomy, Period, periodDays, PropertyEconomy, STATEMENT_GROUPS, sumEconomies } from './economy';
import { REPORT_GROUP_LABEL, reportGroupOf } from './report-groups';

function readPeriod(from?: string, to?: string): Period {
  const year = new Date().getFullYear();
  const p = { from: from || `${year}-01-01`, to: to || `${year}-12-31` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || Number.isNaN(Date.parse(p.from)) || Number.isNaN(Date.parse(p.to))) {
    throw new BadRequestException('Ange perioden som ÅÅÅÅ-MM-DD');
  }
  if (p.to < p.from) throw new BadRequestException('Perioden slutar före den börjar');
  if (periodDays(p) > 366 * 5) throw new BadRequestException('Välj en period på högst fem år');
  return p;
}

function statement(e: PropertyEconomy) {
  return STATEMENT_GROUPS.map((g) => ({
    group: g,
    label: REPORT_GROUP_LABEL[g],
    actualOre: e.actual[g],
    estimatedOre: e.estimated[g] ?? null,
    valueOre: e.value[g],
    budgetOre: e.hasBudget ? e.budget[g] : null,
  }));
}

function months(p: Period): Period[] {
  const out: Period[] = [];
  let d = new Date(`${p.from.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 10) <= p.to && out.length < 60) {
    const start = d.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const end = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
    out.push({ from: start < p.from ? p.from : start, to: end > p.to ? p.to : end });
    d = next;
  }
  return out;
}

const budgetSchema = z.object({
  lines: z
    .array(
      z.object({
        reportGroup: z.enum(['rent_income', 'other_income', 'operating', 'maintenance', 'property_tax', 'insurance', 'admin', 'interest', 'investment']),
        amount: kronor.nullable(),
      }),
    )
    .max(20),
});

/** Ekonomisk uppföljning: fastigheter, bolag och koncern, med budget mot utfall. */
@Controller('economy')
export class EconomyController {
  /** Jämförelse av fastigheter och bolag för en period. */
  @Get('overview')
  overview(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string) {
    const period = readPeriod(from, to);
    const days = periodDays(period);
    return withContext(dbContext(ctx), async (_db, client) => {
      const list = await computeEconomy(client, period);
      const byCompany = new Map<string, PropertyEconomy[]>();
      for (const e of list) byCompany.set(e.companyId, [...(byCompany.get(e.companyId) ?? []), e]);
      const unallocated = (
        await client.query(
          `select co.id as "companyId", co.name as "companyName",
             (select coalesce(sum(l.net_ore), 0)::float from invoice_line l join invoice i on i.id = l.invoice_id
               where i.company_id = co.id and i.status = 'issued' and l.property_id is null
                 and i.invoice_date between $1::date and $2::date) as "incomeOre",
             (select coalesce(sum(l.net_ore + case when l.vat_deductible then 0 else l.vat_ore end), 0)::float
               from supplier_invoice_line l join supplier_invoice i on i.id = l.supplier_invoice_id
               where i.company_id = co.id and i.status <> 'cancelled' and l.property_id is null
                 and l.account_number ~ '^[4-8]' and coalesce(l.period_from, i.invoice_date) <= $2::date
                 and coalesce(l.period_to, i.invoice_date) >= $1::date) as "costOre"
           from company co order by co.name`,
          [period.from, period.to],
        )
      ).rows.filter((r) => r.incomeOre || r.costOre);
      return {
        period: { ...period, days },
        properties: list.map(({ actual, estimated, value, budget, ...rest }) => ({
          ...rest,
          value,
          estimatedGroups: Object.keys(estimated),
          budget: rest.hasBudget ? budget : null,
        })),
        companies: [...byCompany.entries()].map(([companyId, l]) => ({ companyId, companyName: l[0].companyName, ...sumEconomies(l, days) })),
        total: sumEconomies(list, days),
        unallocated,
      };
    });
  }

  /** Resultaträkning för en fastighet, med månader, konton och budget. */
  @Get('properties/:id')
  property(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('from') from?: string, @Query('to') to?: string) {
    const period = readPeriod(from, to);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const [e] = await computeEconomy(client, period, id);
      if (!e) throw new NotFoundException('Fastigheten finns inte');
      const monthly = [];
      for (const m of months(period)) {
        const [x] = await computeEconomy(client, m, id);
        monthly.push({ month: m.from.slice(0, 7), incomeOre: x.kpi.incomeOre, opexOre: x.kpi.opexOre, netOperatingOre: x.kpi.netOperatingOre });
      }
      const sF = 'coalesce(l.period_from, i.invoice_date)';
      const sT = 'coalesce(l.period_to, i.invoice_date)';
      const byAccount = (
        await client.query(
          `select l.account_number as account, a.name, a.report_group as override,
                  sum(round((l.net_ore + case when l.vat_deductible then 0 else l.vat_ore end)::numeric
                      * (least(${sT}, $2::date) - greatest(${sF}, $1::date) + 1) / (${sT} - ${sF} + 1)))::float as "amountOre",
                  count(distinct i.id)::int as "invoiceCount"
           from supplier_invoice_line l join supplier_invoice i on i.id = l.supplier_invoice_id
           left join account a on a.company_id = l.company_id and a.number = l.account_number
           where l.property_id = $3 and i.status <> 'cancelled' and ${sF} <= $2::date and ${sT} >= $1::date
           group by l.account_number, a.name, a.report_group order by l.account_number`,
          [period.from, period.to, id],
        )
      ).rows.map((r) => {
        const g = reportGroupOf(r.account, r.override);
        return { account: r.account, name: r.name, group: g, groupLabel: REPORT_GROUP_LABEL[g], amountOre: r.amountOre, invoiceCount: r.invoiceCount };
      });
      const costLines = (
        await client.query(
          `select i.id as "invoiceId", i.entry_nr as "entryNr", i.invoice_date::text as "invoiceDate", s.name as "supplierName", i.status,
                  l.account_number as account, l.description, o.object_nr as "objectNr",
                  (l.net_ore + case when l.vat_deductible then 0 else l.vat_ore end)::float as "amountOre",
                  l.period_from::text as "periodFrom", l.period_to::text as "periodTo"
           from supplier_invoice_line l join supplier_invoice i on i.id = l.supplier_invoice_id join supplier s on s.id = i.supplier_id
           left join rental_object o on o.id = l.object_id
           where l.property_id = $3 and i.status <> 'cancelled'
             and coalesce(l.period_from, i.invoice_date) <= $2::date and coalesce(l.period_to, i.invoice_date) >= $1::date
           order by i.invoice_date desc, i.entry_nr desc limit 100`,
          [period.from, period.to, id],
        )
      ).rows;
      return {
        period: { ...period, days: periodDays(period) },
        propertyId: e.propertyId,
        companyId: e.companyId,
        companyName: e.companyName,
        name: e.name,
        designation: e.designation,
        areaM2: e.areaM2,
        valueSek: e.valueSek,
        rentValueOre: e.rentValueOre,
        vacantRentOre: e.vacantRentOre,
        hasBudget: e.hasBudget,
        kpi: e.kpi,
        statement: statement(e),
        monthly,
        byAccount,
        costLines,
      };
    });
  }

  /** Budget för ett år, med föregående års utfall som stöd. */
  @Get('properties/:id/budget/:year')
  getBudget(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('year', ParseIntPipe) year: number) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const rows = (
        await client.query(`select report_group as "reportGroup", amount_ore::float as "amountOre" from property_budget where property_id = $1 and year = $2`, [id, year])
      ).rows;
      const [prev] = await computeEconomy(client, { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }, id);
      if (!prev) throw new NotFoundException('Fastigheten finns inte');
      return STATEMENT_GROUPS.map((g) => ({
        reportGroup: g,
        label: REPORT_GROUP_LABEL[g],
        amountOre: rows.find((r) => r.reportGroup === g)?.amountOre ?? null,
        previousYearOre: prev.value[g],
      }));
    });
  }

  @Put('properties/:id/budget/:year')
  saveBudget(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('year', ParseIntPipe) year: number, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'budget.write');
    if (year < 2000 || year > 2100) throw new BadRequestException('Ogiltigt år');
    const { lines } = parse(budgetSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (!(await client.query('select 1 from property where id = $1', [id])).rows[0]) throw new NotFoundException('Fastigheten finns inte i valt bolag');
      for (const l of lines) {
        if (l.amount === null) {
          await client.query('delete from property_budget where property_id = $1 and year = $2 and report_group = $3', [id, year, l.reportGroup]);
        } else {
          await client.query(
            `insert into property_budget (company_id, property_id, year, report_group, amount_ore) values ($1,$2,$3,$4,$5)
             on conflict (property_id, year, report_group) do update set amount_ore = excluded.amount_ore`,
            [companyId, id, year, l.reportGroup, l.amount],
          );
        }
      }
      return { ok: true };
    });
  }
}
