import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import {
  building,
  maintenancePlanItem,
  property,
  propertyInsurance,
  propertyLoan,
  propertyTaxAssessment,
  propertyTechnical,
  propertyValuation,
} from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { ChildKind, childSchemas, propertySchema, technicalSchema } from './property.schemas';

/* eslint-disable @typescript-eslint/no-explicit-any */
const childTables: Record<ChildKind, { table: PgTable & Record<string, any>; order: any }> = {
  buildings: { table: building, order: asc(building.name) },
  'tax-assessments': { table: propertyTaxAssessment, order: desc(propertyTaxAssessment.assessmentYear) },
  insurances: { table: propertyInsurance, order: desc(propertyInsurance.validFrom) },
  valuations: { table: propertyValuation, order: desc(propertyValuation.valuationDate) },
  loans: { table: propertyLoan, order: asc(propertyLoan.lender) },
  maintenance: { table: maintenancePlanItem, order: asc(maintenancePlanItem.plannedYear) },
};

function childOf(kind: string) {
  if (!(kind in childTables)) throw new NotFoundException('Okänt register');
  const k = kind as ChildKind;
  return { ...childTables[k], schema: childSchemas[k] };
}

const LIST_SQL = `
  select p.id, p.company_id as "companyId", c.name as "companyName", p.name, p.designation,
         p.municipality, p.city, p.address_line as "addressLine", p.category,
         p.construction_year as "constructionYear",
         p.area_boa_m2::float as "areaBoaM2", p.area_loa_m2::float as "areaLoaM2",
         count(o.id) filter (where o.active)::int as "objectCount",
         coalesce(sum(o.area_m2) filter (where o.active), 0)::float as "objectAreaM2",
         coalesce(sum(cur.monthly_rent_ore) filter (where o.active), 0)::bigint::float as "monthlyRentOre",
         count(o.id) filter (where st.status in ('occupied','notice'))::int as "occupiedCount",
         coalesce(sum(cur.monthly_rent_ore) filter (where st.status in ('vacant','upcoming')), 0)::bigint::float as "vacantRentOre"
  from property p
  join company c on c.id = p.company_id
  left join rental_object o on o.property_id = p.id
  left join rental_object_current cur on cur.object_id = o.id
  left join rental_object_status st on st.object_id = o.id
  group by p.id, c.name
  order by p.name`;

@Controller('properties')
export class PropertiesController {
  /** Fastigheter i valt bolag, eller i hela koncernen. */
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => (await client.query(LIST_SQL)).rows);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'property.write');
    const data = parse(propertySchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await db.insert(property).values({ ...data, companyId }).returning();
      return row;
    });
  }

  /** Fastighetens uppgifter och nyckeltal. */
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (db, client) => {
      const [row] = await db.select().from(property).where(eq(property.id, id));
      if (!row) throw new NotFoundException('Fastigheten finns inte');
      const byType = (
        await client.query(
          `select o.type, count(*)::int as count, coalesce(sum(o.area_m2), 0)::float as "areaM2",
                  coalesce(sum(cur.monthly_rent_ore), 0)::bigint::float as "monthlyRentOre",
                  count(*) filter (where st.status in ('occupied','notice'))::int as "occupied"
           from rental_object o left join rental_object_current cur on cur.object_id = o.id
           left join rental_object_status st on st.object_id = o.id
           where o.property_id = $1 and o.active group by o.type order by o.type`,
          [id],
        )
      ).rows;
      const facts = (
        await client.query(
          `select
             (select value_sek::float from property_valuation where property_id = $1 order by valuation_date desc limit 1) as "valueSek",
             (select valuation_date from property_valuation where property_id = $1 order by valuation_date desc limit 1)::text as "valuationDate",
             (select coalesce(sum(principal_ore), 0)::bigint::float from property_loan where property_id = $1) as "loansOre",
             (select (coalesce(land_value_sek,0) + coalesce(building_value_sek,0))::float from property_tax_assessment
                where property_id = $1 order by assessment_year desc limit 1) as "taxValueSek",
             (select property_tax_ore::float from property_tax_assessment
                where property_id = $1 order by assessment_year desc limit 1) as "propertyTaxOre",
             (select name from company where id = (select company_id from property where id = $1)) as "companyName"`,
          [id],
        )
      ).rows[0];
      return { ...row, ...facts, byType };
    });
  }

  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'property.write');
    const data = parse(propertySchema.partial(), body);
    const [row] = await withContext(dbContext(ctx), (db) =>
      db.update(property).set(data).where(eq(property.id, id)).returning(),
    );
    if (!row) throw new NotFoundException('Fastigheten finns inte i valt bolag');
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'property.write');
    await withContext(dbContext(ctx), async (db, client) => {
      const { rows } = await client.query('select count(*)::int as n from rental_object where property_id = $1', [id]);
      if (rows[0].n > 0) throw new BadRequestException('Fastigheten har hyresobjekt och kan inte tas bort');
      const deleted = await db.delete(property).where(eq(property.id, id)).returning({ id: property.id });
      if (!deleted.length) throw new NotFoundException('Fastigheten finns inte i valt bolag');
    });
  }

  // ---- Tekniska uppgifter (en per fastighet) ----

  @Get(':id/technical')
  async getTechnical(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const [row] = await withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), (db) =>
      db.select().from(propertyTechnical).where(eq(propertyTechnical.propertyId, id)),
    );
    return row ?? null;
  }

  @Put(':id/technical')
  saveTechnical(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'property.write');
    const data = parse(technicalSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await db
        .insert(propertyTechnical)
        .values({ ...data, propertyId: id, companyId })
        .onConflictDoUpdate({ target: propertyTechnical.propertyId, set: data })
        .returning();
      return row;
    });
  }

  // ---- Underregister: byggnader, taxering, försäkring, värdering, lån, underhåll ----

  @Get(':id/:kind')
  listChildren(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string) {
    const { table, order } = childOf(kind);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), (db) =>
      db.select().from(table).where(eq(table.propertyId, id)).orderBy(order),
    );
  }

  @Post(':id/:kind')
  createChild(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    const { table, schema } = childOf(kind);
    const companyId = requireCompany(ctx, 'property.write');
    const data = parse(schema as typeof schema, body) as Record<string, unknown>;
    return withContext(dbContext(ctx), async (db) => {
      const [row] = await (db.insert(table) as any).values({ ...data, propertyId: id, companyId }).returning();
      return row;
    });
  }

  @Patch(':id/:kind/:rowId')
  async updateChild(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() body: unknown,
  ) {
    const { table, schema } = childOf(kind);
    requireCompany(ctx, 'property.write');
    const data = parse((schema as any).partial(), body) as Record<string, unknown>;
    const [row] = (await withContext(dbContext(ctx), (db) =>
      (db.update(table) as any).set(data).where(and(eq(table.id, rowId), eq(table.propertyId, id))).returning(),
    )) as unknown[];
    if (!row) throw new NotFoundException();
    return row;
  }

  @Delete(':id/:kind/:rowId')
  @HttpCode(204)
  async deleteChild(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    const { table } = childOf(kind);
    requireCompany(ctx, 'property.write');
    const rows = await withContext(dbContext(ctx), (db) =>
      db.delete(table).where(and(eq(table.id, rowId), eq(table.propertyId, id))).returning(),
    );
    if (!rows.length) throw new NotFoundException();
  }
}
