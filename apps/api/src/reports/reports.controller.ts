import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { today } from '../common/money';
import { withContext } from '../db/db';
import { Ctx, dbContext, readableCompanyIds, RequestContext } from '../auth/request-context';
import type { Report, ReportFilters } from './report';
import { fileName, reportToPdf, reportToXlsx } from './report-export';
import { REPORTS } from './reports';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

function validDate(s: string) {
  const d = new Date(`${s}T00:00:00Z`);
  return ISO.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function readFilters(mode: 'period' | 'date', from?: string, to?: string, propertyId?: string): ReportFilters {
  const year = new Date().getFullYear();
  const t = to || (mode === 'date' ? today() : `${year}-12-31`);
  const f = mode === 'date' ? t : from || `${year}-01-01`;
  if (!validDate(f) || !validDate(t)) throw new BadRequestException('Ange datum som ÅÅÅÅ-MM-DD');
  if (t < f) throw new BadRequestException('Perioden slutar före den börjar');
  if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 366 * 5) throw new BadRequestException('Välj en period på högst fem år');
  if (propertyId && !UUID.test(propertyId)) throw new BadRequestException('Ogiltig fastighet');
  return { from: f, to: t, propertyId: propertyId || null };
}

function stockholmNow(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
}

/**
 * Rapporter: hyreslista, aviseringsjournal, månadsanalys, avstämning av
 * kundfordran, moms, frivillig skattskyldighet och in- och avflyttningar.
 * Varje rapport kan visas på skärmen eller hämtas som Excel eller PDF.
 */
@Controller('reports')
export class ReportsController {
  @Get()
  list() {
    return REPORTS.map(({ key, title, description, mode }) => ({ key, title, description, mode }));
  }

  @Get(':key')
  async show(
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('propertyId') propertyId?: string,
    @Query('format') format?: string,
  ) {
    const def = REPORTS.find((r) => r.key === key);
    if (!def) throw new NotFoundException('Rapporten finns inte');
    if (format && !['json', 'xlsx', 'pdf'].includes(format)) throw new BadRequestException('Formatet ska vara xlsx eller pdf');
    const f = readFilters(def.mode, from, to, propertyId);
    const companyIds = readableCompanyIds(ctx);

    const report: Report = await withContext(dbContext(ctx, companyIds), async (_db, client) => {
      let propertyName: string | null = null;
      if (f.propertyId) {
        const p = (await client.query('select name, designation from property where id = $1', [f.propertyId])).rows[0];
        if (!p) throw new NotFoundException('Fastigheten finns inte');
        propertyName = `${p.name} (${p.designation})`;
      }
      const companies = (await client.query('select name from company order by name')).rows.map((r) => r.name as string);
      const body = await def.build({ client, f, multi: companies.length > 1 });
      return {
        key: def.key,
        title: def.title,
        description: def.description,
        mode: def.mode,
        scope: ctx.activeCompanyId ? (companies[0] ?? '') : 'Hela koncernen',
        filters: [
          def.mode === 'date' ? { label: 'Per datum', value: f.to } : { label: 'Period', value: `${f.from} – ${f.to}` },
          ...(propertyName ? [{ label: 'Fastighet', value: propertyName }] : []),
        ],
        generatedAt: stockholmNow(),
        ...body,
      };
    });

    if (format === 'xlsx') {
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${fileName(report, 'xlsx')}"`);
      res.end(await reportToXlsx(report));
      return;
    }
    if (format === 'pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `inline; filename="${fileName(report, 'pdf')}"`);
      res.end(await reportToPdf(report));
      return;
    }
    return report;
  }
}
