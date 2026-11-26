import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { dayBefore, today } from '../common/money';
import { parse } from '../common/validation';
import { Db, withContext } from '../db/db';
import { rentalObject, rentalObjectPrice, rentalObjectVat } from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { newObjectSchema, objectSchema, priceSchema, RESIDENTIAL_TYPES, vatSchema } from './property.schemas';

const LIST_SQL = `
  select o.id, o.company_id as "companyId", c.name as "companyName", o.property_id as "propertyId",
         p.name as "propertyName", p.designation, o.object_nr as "objectNr", o.type,
         o.area_m2::float as "areaM2", o.rooms::float as rooms, o.floor, o.apartment_nr as "apartmentNr",
         o.address_line as "addressLine", o.active,
         cur.monthly_rent_ore::float as "monthlyRentOre", cur.vat_liable as "vatLiable",
         st.status, st.current_contract_id as "currentContractId", st.current_until::text as "currentUntil",
         st.next_contract_id as "nextContractId", st.next_from::text as "nextFrom",
         (select cu.name from contract k join customer cu on cu.id = k.customer_id
            where k.id = coalesce(st.current_contract_id, st.next_contract_id)) as "tenantName"
  from rental_object o
  join property p on p.id = o.property_id
  join company c on c.id = o.company_id
  left join rental_object_current cur on cur.object_id = o.id
  left join rental_object_status st on st.object_id = o.id
  where ($4::uuid is null or o.id = $4) and ($5::text is null or st.status = $5) and ($1::uuid is null or o.property_id = $1)
    and ($2::text is null or o.type = $2)
    and ($3::text is null or o.object_nr ilike '%' || $3 || '%' or o.address_line ilike '%' || $3 || '%'
         or p.name ilike '%' || $3 || '%')
  order by p.name, o.object_nr`;

@Controller('objects')
export class ObjectsController {
  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    if (propertyId && !/^[0-9a-f-]{36}$/i.test(propertyId)) throw new BadRequestException('Ogiltig fastighet');
    // När en fastighet anges får alla bolag användaren har tillgång till läsas.
    const ids = propertyId ? ctx.access.map((a) => a.companyId) : undefined;
    return withContext(dbContext(ctx, ids), async (_db, client) =>
      (await client.query(LIST_SQL, [propertyId ?? null, type || null, q?.trim() || null, null, status || null])).rows,
    );
  }

  /** Skapar ett objekt med startdatum för hyra och momsstatus. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'property.write');
    const { monthlyRent, rentValidFrom, vatLiable, ...data } = parse(newObjectSchema, body);
    const from = rentValidFrom ?? today();
    if (vatLiable && RESIDENTIAL_TYPES.has(data.type)) {
      throw new BadRequestException('Bostäder kan inte vara momspliktiga');
    }
    return withContext(dbContext(ctx), async (db) => {
      const [obj] = await db.insert(rentalObject).values({ ...data, companyId }).returning();
      if (monthlyRent !== undefined) {
        await db.insert(rentalObjectPrice).values({
          companyId,
          objectId: obj.id,
          monthlyRentOre: monthlyRent,
          validFrom: from,
          reason: 'Ursprunglig hyra',
        });
      }
      await db.insert(rentalObjectVat).values({ companyId, objectId: obj.id, vatLiable: !!vatLiable, validFrom: from });
      return obj;
    });
  }

  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (db, client) => {
      const { rows } = await client.query(LIST_SQL, [null, null, null, id, null]);
      if (!rows[0]) throw new NotFoundException('Objektet finns inte');
      const prices = await db
        .select()
        .from(rentalObjectPrice)
        .where(eq(rentalObjectPrice.objectId, id))
        .orderBy(desc(rentalObjectPrice.validFrom));
      const vat = await db
        .select()
        .from(rentalObjectVat)
        .where(eq(rentalObjectVat.objectId, id))
        .orderBy(desc(rentalObjectVat.validFrom));
      const [details] = await db.select().from(rentalObject).where(eq(rentalObject.id, id));
      return { ...rows[0], buildingId: details.buildingId, description: details.description, prices, vat };
    });
  }

  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'property.write');
    const patch = parse(objectSchema.partial().extend({ active: z.boolean().optional() }), body);
    return withContext(dbContext(ctx), async (db, client) => {
      if (patch.type && RESIDENTIAL_TYPES.has(patch.type)) await assertNoVat(client, id);
      const [row] = await db.update(rentalObject).set(patch).where(eq(rentalObject.id, id)).returning();
      if (!row) throw new NotFoundException('Objektet finns inte i valt bolag');
      return row;
    });
  }

  /**
   * Ny hyra från ett datum. Den hyra som gällde dessförinnan avslutas dagen före.
   * Historiken skrivs aldrig över.
   */
  @Post(':id/prices')
  addPrice(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'property.write');
    const data = parse(priceSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      await closePrevious(db, rentalObjectPrice, id, data.validFrom, 'hyra');
      const [row] = await db
        .insert(rentalObjectPrice)
        .values({ companyId, objectId: id, monthlyRentOre: data.monthlyRent, validFrom: data.validFrom, reason: data.reason })
        .returning();
      return row;
    });
  }

  /** Ändrad momsstatus från ett datum, till exempel vid frivillig skattskyldighet. */
  @Post(':id/vat')
  addVat(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'property.write');
    const data = parse(vatSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      await closePrevious(db, rentalObjectVat, id, data.validFrom, 'momsstatus');
      const [row] = await db
        .insert(rentalObjectVat)
        .values({ companyId, objectId: id, vatLiable: data.vatLiable, validFrom: data.validFrom, note: data.note })
        .returning();
      return row;
    });
  }
}

async function closePrevious(
  db: Db,
  table: typeof rentalObjectPrice | typeof rentalObjectVat,
  objectId: string,
  validFrom: string,
  what: string,
) {
  const later = await db
    .select({ validFrom: table.validFrom })
    .from(table)
    .where(and(eq(table.objectId, objectId), gte(table.validFrom, validFrom)));
  if (later.length) {
    throw new ConflictException(`Det finns redan en ${what} från ${later[0].validFrom}. Välj ett senare datum.`);
  }
  await db
    .update(table)
    .set({ validTo: dayBefore(validFrom) })
    .where(and(eq(table.objectId, objectId), lt(table.validFrom, validFrom), isNull(table.validTo)));
}

async function assertNoVat(client: PoolClient, objectId: string) {
  const { rows } = await client.query(
    `select 1 from rental_object_vat where object_id = $1 and vat_liable
       and (valid_to is null or valid_to >= current_date)`,
    [objectId],
  );
  if (rows.length) throw new BadRequestException('Objektet är momspliktigt och kan inte bli en bostad');
}
