import {
  BadRequestException,
  Body,
  ConflictException,
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
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { dayBefore, today } from '../common/money';
import { parse } from '../common/validation';
import { Db, withContext } from '../db/db';
import {
  contract,
  contractDeposit,
  contractEvent,
  contractIndexClause,
  contractLine,
  contractObject,
} from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { RESIDENTIAL_TYPES } from '../properties/property.schemas';
import {
  changeLineSchema,
  createContractSchema,
  depositSchema,
  eventSchema,
  indexClauseSchema,
  indexRunSchema,
  lineSchema,
  terminateSchema,
  updateContractSchema,
} from './contract.schemas';
import { extendedEndDate, noticeDeadline, terminationEndDate } from './contract-rules';
import { applyIndexation, previewIndexation } from './indexation';
import { attentionItems } from './attention';
import { renderContractPdf } from './contract-pdf';

type ContractRow = typeof contract.$inferSelect;

const TERMINATED_BY: Record<string, string> = {
  tenant: 'hyresgästen',
  landlord: 'hyresvärden',
  mutual: 'båda parter',
};

const LIST_SQL = `
  select k.id, k.company_id as "companyId", co.name as "companyName", k.contract_nr as "contractNr", k.type,
         k.status, k.start_date::text as "startDate", k.end_date::text as "endDate",
         k.customer_id as "customerId", c.name as "customerName", c.customer_nr as "customerNr",
         k.renegotiate_by::text as "renegotiateBy", k.notice_months as "noticeMonths",
         coalesce((select sum(l.amount_ore) from contract_line l where l.contract_id = k.id
            and l.valid_from <= greatest(current_date, k.start_date)
            and (l.valid_to is null or l.valid_to >= greatest(current_date, k.start_date))), 0)::bigint::float as "monthlyOre",
         coalesce((select string_agg(o.object_nr || ' ' || p.name, ', ' order by o.object_nr)
            from contract_object x join rental_object o on o.id = x.object_id join property p on p.id = o.property_id
            where x.contract_id = k.id), '') as objects
  from contract k
  join customer c on c.id = k.customer_id
  join company co on co.id = k.company_id
  where ($1::text is null or k.status = $1)
    and ($2::uuid is null or k.customer_id = $2)
    and ($3::text is null or c.name ilike '%' || $3 || '%' or k.contract_nr::text = $3
         or exists (select 1 from contract_object x join rental_object o on o.id = x.object_id
                    where x.contract_id = k.id and o.object_nr ilike '%' || $3 || '%'))
    and ($4::uuid is null or exists (select 1 from contract_object x where x.contract_id = k.id and x.object_id = $4))
  order by k.contract_nr desc`;

@Controller('contracts')
export class ContractsController {
  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('objectId') objectId?: string,
    @Query('q') q?: string,
  ) {
    for (const v of [customerId, objectId]) {
      if (v && !/^[0-9a-f-]{36}$/i.test(v)) throw new BadRequestException('Ogiltigt id');
    }
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(LIST_SQL, [status || null, customerId || null, q?.trim() || null, objectId || null])).rows,
    );
  }

  /** Avtal som behöver hanteras: uppsägningstider, avtal som löper ut, utkast med mera. */
  @Get('attention')
  attention(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (_db, client) => attentionItems(client));
  }

  /** Förhandsvisning av indexuppräkning för ett år. */
  @Get('indexation')
  indexation(@Ctx() ctx: RequestContext, @Query('year') year: string) {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1990 || y > 2200) throw new BadRequestException('Ange år');
    return withContext(dbContext(ctx), (_db, client) => previewIndexation(client, y));
  }

  @Post('indexation')
  runIndexation(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireCompany(ctx, 'index.write');
    const { year, contractIds } = parse(indexRunSchema, body);
    return withContext(dbContext(ctx), (_db, client) => applyIndexation(client, year, contractIds));
  }

  /** Nytt avtal som utkast. Hyresrader fylls i från objektens hyra om inga rader skickas med. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'contract.write');
    const { objectIds, lines, indexClause, ...data } = parse(createContractSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('contract_nr:' || $1))`, [companyId]);
      const { rows } = await client.query(
        'select coalesce(max(contract_nr), 1000) + 1 as nr from contract where company_id = $1',
        [companyId],
      );
      const [row] = await db
        .insert(contract)
        .values({ ...data, companyId, contractNr: rows[0].nr })
        .returning();
      for (const objectId of new Set(objectIds)) {
        await attachObject(db, client, row, objectId, lines === undefined, !!indexClause);
      }
      for (const l of lines ?? []) {
        await insertLine(db, row, l);
      }
      if (indexClause) await saveIndexClause(db, client, row, indexClause);
      await addEvent(db, row, 'created', `Avtal ${row.contractNr} upprättat som utkast`);
      return row;
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (db, client) => {
      const k = await load(db, id);
      const customer = (
        await client.query(
          `select id, customer_nr as "customerNr", kind, name, national_id as "nationalId", email, phone,
                  address_line as "addressLine", postal_code as "postalCode", city
           from customer where id = $1`,
          [k.customerId],
        )
      ).rows[0];
      const objects = (
        await client.query(
          `select x.id, x.object_id as "objectId", x.valid_from::text as "validFrom", x.valid_to::text as "validTo",
                  o.object_nr as "objectNr", o.type, o.area_m2::float as "areaM2", o.rooms::float as rooms,
                  o.address_line as "addressLine", o.apartment_nr as "apartmentNr",
                  p.id as "propertyId", p.name as "propertyName", p.designation
           from contract_object x join rental_object o on o.id = x.object_id join property p on p.id = o.property_id
           where x.contract_id = $1 order by o.object_nr`,
          [id],
        )
      ).rows;
      const lines = await db
        .select()
        .from(contractLine)
        .where(eq(contractLine.contractId, id))
        .orderBy(asc(contractLine.validFrom), asc(contractLine.createdAt));
      const [indexClause] = await db.select().from(contractIndexClause).where(eq(contractIndexClause.contractId, id));
      const deposits = await db.select().from(contractDeposit).where(eq(contractDeposit.contractId, id));
      const events = await db
        .select()
        .from(contractEvent)
        .where(eq(contractEvent.contractId, id))
        .orderBy(desc(contractEvent.eventDate), desc(contractEvent.createdAt));
      const company = (
        await client.query(
          `select name, org_nr as "orgNr", vat_nr as "vatNr", address_line as "addressLine", postal_code as "postalCode",
                  city, bankgiro, plusgiro from company where id = $1`,
          [k.companyId],
        )
      ).rows[0];
      const ref = k.startDate > today() ? k.startDate : today();
      const current = lines.filter((l) => l.validFrom <= ref && (!l.validTo || l.validTo >= ref));
      const monthlyOre = current.reduce((s, l) => s + l.amountOre, 0);
      const monthlyVatOre = current.reduce((s, l) => s + Math.round((l.amountOre * l.vatRateBp) / 10000), 0);
      return {
        ...k,
        companyName: company?.name as string,
        company,
        customer,
        objects,
        lines,
        indexClause: indexClause ?? null,
        deposits,
        events,
        monthlyOre,
        monthlyVatOre,
        noticeDeadline: k.status === 'active' ? noticeDeadline(k.endDate, k.noticeMonths) : null,
      };
    });
  }

  @Get(':id/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const data = await this.get(ctx, id);
    const buf = await renderContractPdf(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="hyresavtal-${data.contractNr}.pdf"`);
    res.send(buf);
  }

  /**
   * Ändrar avtalsuppgifter. Typ, hyresgäst och avtalstid kan bara ändras i utkast;
   * för aktiva avtal görs det med uppsägning eller förlängning.
   */
  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const patch = parse(updateContractSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      const locked = ['type', 'customerId', 'startDate', 'endDate'] as const;
      if (k.status !== 'draft' && locked.some((f) => patch[f] !== undefined && patch[f] !== k[f])) {
        throw new ConflictException('Typ, hyresgäst och avtalstid kan bara ändras medan avtalet är ett utkast');
      }
      if (k.status === 'cancelled') throw new ConflictException('Avtalet är makulerat');
      const start = patch.startDate ?? k.startDate;
      const end = patch.endDate === undefined ? k.endDate : patch.endDate;
      if (end && end < start) throw new BadRequestException('Slutdatum är före startdatum');
      if (patch.type === 'residential' && k.type !== 'residential') {
        const { rows } = await client.query('select 1 from contract_line where contract_id = $1 and vat_rate_bp > 0', [id]);
        if (rows.length) throw new BadRequestException('Avtalet har rader med moms och kan inte bli ett bostadsavtal');
      }
      if (k.status === 'draft' && (start !== k.startDate || end !== k.endDate)) {
        await client.query('update contract_object set valid_from = $2, valid_to = $3 where contract_id = $1', [id, start, end]);
        await client.query('update contract_line set valid_from = $3 where contract_id = $1 and valid_from = $2', [id, k.startDate, start]);
        await client.query(
          'update contract_line set valid_to = $3 where contract_id = $1 and valid_to is not distinct from $2::date',
          [id, k.endDate, end],
        );
      }
      const [row] = await db.update(contract).set(patch).where(eq(contract.id, id)).returning();
      return row;
    });
  }

  @Post(':id/objects')
  addObject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const { objectId, prefill } = parse(z.object({ objectId: z.string().uuid(), prefill: z.boolean().default(true) }), body);
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      if (k.status !== 'draft') throw new ConflictException('Objekt kan bara läggas till i utkast');
      const [clause] = await db.select().from(contractIndexClause).where(eq(contractIndexClause.contractId, id));
      await attachObject(db, client, k, objectId, prefill, !!clause);
      return { ok: true };
    });
  }

  @Delete(':id/objects/:objectId')
  @HttpCode(204)
  async removeObject(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('objectId', ParseUUIDPipe) objectId: string,
  ) {
    requireCompany(ctx, 'contract.write');
    await withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      if (k.status !== 'draft') throw new ConflictException('Objekt kan bara tas bort ur utkast');
      await db.delete(contractObject).where(and(eq(contractObject.contractId, id), eq(contractObject.objectId, objectId)));
      await db.delete(contractLine).where(and(eq(contractLine.contractId, id), eq(contractLine.objectId, objectId)));
    });
  }

  @Post(':id/activate')
  activate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.activate');
    const { signedDate } = parse(z.object({ signedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), body ?? {});
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      if (k.status !== 'draft') throw new ConflictException('Bara utkast kan aktiveras');
      const { rows } = await client.query(
        `select (select count(*) from contract_object where contract_id = $1)::int as objects,
                (select count(*) from contract_line where contract_id = $1)::int as lines`,
        [id],
      );
      if (!rows[0].objects) throw new BadRequestException('Avtalet måste omfatta minst ett objekt');
      if (!rows[0].lines) throw new BadRequestException('Avtalet saknar hyresrader');
      const [row] = await db
        .update(contract)
        .set({ status: 'active', signedDate: signedDate ?? k.signedDate ?? today() })
        .where(eq(contract.id, id))
        .returning();
      await addEvent(db, k, 'activated', `Avtalet aktiverat${signedDate ? `, undertecknat ${signedDate}` : ''}`);
      return row;
    });
  }

  /** Uppsägning. Slutdatum räknas fram ur uppsägningstid och förlängning om inget anges. */
  @Post(':id/terminate')
  terminate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const data = parse(terminateSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      if (k.status !== 'active') throw new ConflictException('Bara aktiva avtal kan sägas upp');
      const end =
        data.endDate ??
        terminationEndDate({
          endDate: k.endDate,
          noticeMonths: k.noticeMonths,
          extensionMonths: k.extensionMonths,
          received: data.terminationReceived,
        });
      if (end < k.startDate) throw new BadRequestException('Slutdatum är före avtalets start');
      await closeAt(client, id, end);
      const [row] = await db
        .update(contract)
        .set({
          status: 'terminated',
          endDate: end,
          terminationReceived: data.terminationReceived,
          terminatedBy: data.terminatedBy,
          terminationReason: data.reason,
        })
        .where(eq(contract.id, id))
        .returning();
      await addEvent(
        db,
        k,
        'terminated',
        `Uppsagt av ${TERMINATED_BY[data.terminatedBy]}, mottaget ${data.terminationReceived}. Avtalet upphör ${end}.` +
          (data.reason ? ` Orsak: ${data.reason}` : ''),
        data.terminationReceived,
      );
      return row;
    });
  }

  /** Återkallar en uppsägning så att avtalet löper vidare med tidigare villkor. */
  @Post(':id/withdraw-termination')
  withdrawTermination(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const { endDate } = parse(z.object({ endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }), body ?? {});
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      if (k.status !== 'terminated') throw new ConflictException('Avtalet är inte uppsagt');
      if (endDate && endDate < k.endDate!) throw new BadRequestException('Nytt slutdatum måste vara senare än uppsägningsdatumet');
      await reopenFrom(client, id, k.endDate!, endDate);
      const [row] = await db
        .update(contract)
        .set({ status: 'active', endDate, terminationReceived: null, terminatedBy: null, terminationReason: null })
        .where(eq(contract.id, id))
        .returning();
      await addEvent(db, k, 'note', `Uppsägningen återkallad. Avtalet löper ${endDate ? `till ${endDate}` : 'tills vidare'}.`);
      return row;
    });
  }

  /** Förlänger ett tidsbestämt avtal, som standard med avtalets förlängningstid. */
  @Post(':id/extend')
  extend(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const data = parse(z.object({ endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), body ?? {});
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      if (k.status !== 'active' || !k.endDate) throw new ConflictException('Bara aktiva tidsbestämda avtal kan förlängas');
      const end = data.endDate ?? (k.extensionMonths ? extendedEndDate(k.endDate, k.extensionMonths) : null);
      if (!end) throw new BadRequestException('Ange nytt slutdatum, avtalet saknar förlängningstid');
      if (end <= k.endDate) throw new BadRequestException('Nytt slutdatum måste vara senare än nuvarande');
      await reopenFrom(client, id, k.endDate, end);
      const [row] = await db.update(contract).set({ endDate: end }).where(eq(contract.id, id)).returning();
      await addEvent(db, k, 'extended', `Avtalet förlängt från ${k.endDate} till ${end}`);
      return row;
    });
  }

  /** Makulerar ett utkast eller ett avtal som inte har börjat. Objekten blir lediga. */
  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const { reason } = parse(z.object({ reason: z.string().max(2000).optional() }), body ?? {});
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      const notStarted = k.status === 'active' && k.startDate > today();
      if (k.status !== 'draft' && !notStarted) {
        throw new ConflictException('Bara utkast och avtal som ännu inte börjat kan makuleras. Säg upp avtalet i stället.');
      }
      await db.delete(contractObject).where(eq(contractObject.contractId, id));
      const [row] = await db.update(contract).set({ status: 'cancelled' }).where(eq(contract.id, id)).returning();
      await addEvent(db, k, 'cancelled', `Avtalet makulerat${reason ? `: ${reason}` : ''}`);
      return row;
    });
  }

  // ---------------------------------------------------------------- Rader

  @Post(':id/lines')
  addLine(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const data = parse(lineSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      assertOpen(k);
      return insertLine(db, k, data);
    });
  }

  @Patch(':id/lines/:lineId')
  async updateLine(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, 'contract.write');
    const data = parse(lineSchema.partial(), body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      if (k.status !== 'draft') {
        throw new ConflictException('Rader i aktiva avtal ändras med ny hyra från ett datum, så att historiken finns kvar');
      }
      const { amount, validFrom, validTo, ...rest } = data;
      const set: Partial<typeof contractLine.$inferInsert> = { ...rest };
      if (validFrom !== undefined) set.validFrom = validFrom ?? k.startDate;
      if (validTo !== undefined) set.validTo = validTo ?? k.endDate;
      if (amount !== undefined) set.amountOre = amount;
      if (amount !== undefined) set.baseAmountOre = amount;
      const [row] = await db
        .update(contractLine)
        .set(set)
        .where(and(eq(contractLine.id, lineId), eq(contractLine.contractId, id)))
        .returning();
      if (!row) throw new NotFoundException('Raden finns inte');
      if (row.indexed && row.baseAmountOre === null) {
        await db.update(contractLine).set({ baseAmountOre: row.amountOre }).where(eq(contractLine.id, lineId));
      }
      return row;
    });
  }

  @Delete(':id/lines/:lineId')
  @HttpCode(204)
  async deleteLine(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    requireCompany(ctx, 'contract.write');
    await withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      if (k.status !== 'draft') throw new ConflictException('Rader i aktiva avtal avslutas i stället för att tas bort');
      await db.delete(contractLine).where(and(eq(contractLine.id, lineId), eq(contractLine.contractId, id)));
    });
  }

  /** Nytt belopp från ett datum. Raden avslutas dagen före och en ny rad läggs till. */
  @Post(':id/lines/:lineId/change')
  changeLine(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, 'contract.write');
    const data = parse(changeLineSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      assertOpen(k);
      const [line] = await db
        .select()
        .from(contractLine)
        .where(and(eq(contractLine.id, lineId), eq(contractLine.contractId, id)));
      if (!line) throw new NotFoundException('Raden finns inte');
      if (data.validFrom <= line.validFrom) throw new BadRequestException(`Ändringen måste gälla efter ${line.validFrom}`);
      if (line.validTo && data.validFrom > line.validTo) throw new BadRequestException(`Raden upphörde ${line.validTo}`);
      await db.update(contractLine).set({ validTo: dayBefore(data.validFrom) }).where(eq(contractLine.id, lineId));
      const [row] = await db
        .insert(contractLine)
        .values({
          companyId: k.companyId,
          contractId: id,
          objectId: line.objectId,
          article: line.article,
          description: line.description,
          amountOre: data.amount,
          vatRateBp: line.vatRateBp,
          indexed: line.indexed,
          baseAmountOre: line.indexed ? (data.newBase ? data.amount : line.baseAmountOre) : null,
          validFrom: data.validFrom,
          validTo: line.validTo,
          reason: data.reason,
        })
        .returning();
      await addEvent(
        db,
        k,
        'rent_changed',
        `${line.description}: ${kr(line.amountOre)} → ${kr(data.amount)} per månad från ${data.validFrom}` +
          (data.reason ? ` (${data.reason})` : ''),
        data.validFrom,
      );
      return row;
    });
  }

  @Post(':id/lines/:lineId/end')
  endLine(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, 'contract.write');
    const { validTo } = parse(z.object({ validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      assertOpen(k);
      const [line] = await db
        .select()
        .from(contractLine)
        .where(and(eq(contractLine.id, lineId), eq(contractLine.contractId, id)));
      if (!line) throw new NotFoundException('Raden finns inte');
      if (validTo < line.validFrom) throw new BadRequestException(`Raden börjar ${line.validFrom}`);
      const [row] = await db.update(contractLine).set({ validTo }).where(eq(contractLine.id, lineId)).returning();
      await addEvent(db, k, 'rent_changed', `${line.description} upphör ${validTo}`, validTo);
      return row;
    });
  }

  // ---------------------------------------------------------------- Index, deposition, händelser

  @Put(':id/index-clause')
  putIndexClause(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const data = parse(indexClauseSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      const k = await load(db, id);
      assertOpen(k);
      return saveIndexClause(db, client, k, data);
    });
  }

  @Delete(':id/index-clause')
  @HttpCode(204)
  async deleteIndexClause(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'contract.write');
    await withContext(dbContext(ctx), async (db) => {
      await load(db, id);
      await db.delete(contractIndexClause).where(eq(contractIndexClause.contractId, id));
    });
  }

  /** Indexuppräkning av ett enskilt avtal. */
  @Post(':id/index')
  indexOne(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'index.write');
    const { year } = parse(z.object({ year: z.number().int().min(1990).max(2200) }), body);
    return withContext(dbContext(ctx), async (db, client) => {
      await load(db, id);
      const [r] = await applyIndexation(client, year, [id]);
      if (!r) throw new BadRequestException('Avtalet har ingen indexklausul eller gäller inte vid uppräkningen');
      if (r.result !== 'applied') throw new BadRequestException(r.message);
      return r;
    });
  }

  @Post(':id/deposits')
  addDeposit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const { amount, ...data } = parse(depositSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      const [row] = await db
        .insert(contractDeposit)
        .values({ ...data, amountOre: amount, companyId: k.companyId, contractId: id })
        .returning();
      return row;
    });
  }

  @Patch(':id/deposits/:depositId')
  updateDeposit(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('depositId', ParseUUIDPipe) depositId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, 'contract.write');
    const { amount, ...data } = parse(depositSchema.partial(), body);
    return withContext(dbContext(ctx), async (db) => {
      await load(db, id);
      const [row] = await db
        .update(contractDeposit)
        .set(amount === undefined ? data : { ...data, amountOre: amount })
        .where(and(eq(contractDeposit.id, depositId), eq(contractDeposit.contractId, id)))
        .returning();
      if (!row) throw new NotFoundException('Säkerheten finns inte');
      return row;
    });
  }

  @Delete(':id/deposits/:depositId')
  @HttpCode(204)
  async deleteDeposit(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('depositId', ParseUUIDPipe) depositId: string,
  ) {
    requireCompany(ctx, 'contract.write');
    await withContext(dbContext(ctx), async (db) => {
      await load(db, id);
      await db.delete(contractDeposit).where(and(eq(contractDeposit.id, depositId), eq(contractDeposit.contractId, id)));
    });
  }

  @Post(':id/events')
  addNote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'contract.write');
    const data = parse(eventSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const k = await load(db, id);
      return addEvent(db, k, 'note', data.description, data.eventDate);
    });
  }
}

// -------------------------------------------------------------------- hjälpfunktioner

async function load(db: Db, id: string): Promise<ContractRow> {
  const [k] = await db.select().from(contract).where(eq(contract.id, id));
  if (!k) throw new NotFoundException('Avtalet finns inte i valt bolag');
  return k;
}

function assertOpen(k: ContractRow) {
  if (k.status === 'cancelled') throw new ConflictException('Avtalet är makulerat');
}

function kr(ore: number): string {
  return `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`;
}

async function addEvent(db: Db, k: ContractRow, kind: string, description: string, eventDate = today()) {
  const [row] = await db
    .insert(contractEvent)
    .values({ companyId: k.companyId, contractId: k.id, kind, description, eventDate })
    .returning();
  return row;
}

const ARTICLE_FOR_TYPE: Record<string, { article: string; label: string }> = {
  parking: { article: 'parking', label: 'Parkering' },
  storage: { article: 'storage', label: 'Förråd' },
};

/** Kopplar ett objekt till avtalet och fyller i en hyresrad från objektets hyra vid avtalsstart. */
async function attachObject(db: Db, client: PoolClient, k: ContractRow, objectId: string, prefill: boolean, indexed: boolean) {
  const { rows } = await client.query(
    `select o.object_nr as "objectNr", o.type,
       coalesce(
         (select monthly_rent_ore from rental_object_price where object_id = o.id
            and valid_from <= $2 and (valid_to is null or valid_to >= $2) order by valid_from desc limit 1),
         (select monthly_rent_ore from rental_object_price where object_id = o.id order by valid_from limit 1)
       )::bigint::float as rent,
       coalesce(
         (select vat_liable from rental_object_vat where object_id = o.id
            and valid_from <= $2 and (valid_to is null or valid_to >= $2) order by valid_from desc limit 1),
         (select vat_liable from rental_object_vat where object_id = o.id order by valid_from limit 1),
         false
       ) as "vatLiable"
     from rental_object o where o.id = $1`,
    [objectId, k.startDate],
  );
  const o = rows[0];
  if (!o) throw new BadRequestException('Objektet finns inte i valt bolag');
  if (RESIDENTIAL_TYPES.has(o.type) && k.type !== 'residential') {
    throw new BadRequestException(`${o.objectNr} är en bostad och kan bara ingå i ett bostadsavtal`);
  }
  await db.insert(contractObject).values({
    companyId: k.companyId,
    contractId: k.id,
    objectId,
    validFrom: k.startDate,
    validTo: k.endDate,
  });
  if (prefill && o.rent !== null) {
    const a = ARTICLE_FOR_TYPE[o.type] ?? { article: 'rent', label: 'Hyra' };
    const useIndex = indexed && !RESIDENTIAL_TYPES.has(o.type);
    await db.insert(contractLine).values({
      companyId: k.companyId,
      contractId: k.id,
      objectId,
      article: a.article,
      description: `${a.label} ${o.objectNr}`,
      amountOre: o.rent,
      vatRateBp: o.vatLiable && k.type !== 'residential' ? 2500 : 0,
      indexed: useIndex,
      baseAmountOre: useIndex ? o.rent : null,
      validFrom: k.startDate,
      validTo: k.endDate,
    });
  }
}

async function insertLine(db: Db, k: ContractRow, l: z.output<typeof lineSchema>) {
  const validFrom = l.validFrom ?? k.startDate;
  const validTo = l.validTo === undefined ? k.endDate : l.validTo;
  if (validFrom < k.startDate) throw new BadRequestException('Raden kan inte börja före avtalet');
  if (k.endDate && validTo && validTo > k.endDate) throw new BadRequestException('Raden kan inte gälla efter avtalets slut');
  if (k.type === 'residential' && l.vatRateBp > 0) throw new BadRequestException('Bostadsavtal kan inte ha moms');
  const [row] = await db
    .insert(contractLine)
    .values({
      companyId: k.companyId,
      contractId: k.id,
      objectId: l.objectId ?? null,
      article: l.article,
      description: l.description,
      amountOre: l.amount,
      vatRateBp: l.vatRateBp,
      indexed: l.indexed,
      baseAmountOre: l.indexed ? l.amount : null,
      validFrom,
      validTo: validTo ?? (k.endDate || null),
      reason: l.reason,
    })
    .returning();
  return row;
}

async function saveIndexClause(db: Db, client: PoolClient, k: ContractRow, c: z.output<typeof indexClauseSchema>) {
  let baseValue = c.baseValue;
  if (baseValue === undefined) {
    const { rows } = await client.query('select value::float as v from kpi_value where year = $1 and month = $2', [
      c.baseYear,
      c.baseMonth,
    ]);
    if (!rows[0]) {
      throw new BadRequestException({
        message: 'KPI saknas för basmånaden',
        fields: [{ path: 'baseValue', message: `Ange KPI för ${c.baseYear}-${String(c.baseMonth).padStart(2, '0')} eller lägg in värdet` }],
      });
    }
    baseValue = rows[0].v as number;
  }
  const values = { ...c, baseValue, companyId: k.companyId, contractId: k.id };
  const [row] = await db
    .insert(contractIndexClause)
    .values(values)
    .onConflictDoUpdate({ target: contractIndexClause.contractId, set: { ...c, baseValue } })
    .returning();
  return row;
}

/** Avslutar objekt och rader vid ett slutdatum. Rader som skulle börja senare tas bort. */
async function closeAt(client: PoolClient, contractId: string, end: string) {
  await client.query(
    'update contract_object set valid_to = $2 where contract_id = $1 and (valid_to is null or valid_to > $2)',
    [contractId, end],
  );
  await client.query('delete from contract_line where contract_id = $1 and valid_from > $2', [contractId, end]);
  await client.query(
    'update contract_line set valid_to = $2 where contract_id = $1 and (valid_to is null or valid_to > $2)',
    [contractId, end],
  );
}

/** Förlänger objekt och rader som slutade vid oldEnd till newEnd (null = tills vidare). */
async function reopenFrom(client: PoolClient, contractId: string, oldEnd: string, newEnd: string | null) {
  await client.query('update contract_object set valid_to = $3 where contract_id = $1 and valid_to = $2', [
    contractId,
    oldEnd,
    newEnd,
  ]);
  await client.query('update contract_line set valid_to = $3 where contract_id = $1 and valid_to = $2', [
    contractId,
    oldEnd,
    newEnd,
  ]);
}
