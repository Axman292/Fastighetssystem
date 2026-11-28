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
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { parse } from '../common/validation';
import { getPool, withContext } from '../db/db';
import { customer } from '../db/schema';
import { Ctx, dbContext, Public, RequestContext, requireCompany } from '../auth/request-context';
import { limitOrThrow } from '../auth/rate-limit';
import { createContractSchema } from '../contracts/contract.schemas';
import { createContract } from '../contracts/contracts.controller';
import { customerSchema } from '../customers/customers.controller';
import {
  ACTIVE_STATUSES,
  contractTypeFor,
  convertSchema,
  insertRegistration,
  MATCH_SQL,
  offerSchema,
  offerUpdateSchema,
  OBJECT_TYPES,
  deleteRegistrations,
  publicRegistrationSchema,
  REGISTRATION_SELECT,
  registrationSchema,
  settingsSchema,
  toColumns,
  updateRegistrationSchema,
  vacancies,
} from './vacancies';

const PERMISSION = 'interest.manage';
const uuidOrNull = (v?: string) => {
  if (!v) return null;
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw new BadRequestException('Ogiltigt id');
  return v;
};

/** Översikt över lediga och kommande lediga objekt. */
@Controller('vacancies')
export class VacanciesController {
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('propertyId') propertyId?: string) {
    const pid = uuidOrNull(propertyId);
    return withContext(dbContext(ctx), (_db, client) => vacancies(client, today(), pid));
  }

  /** Intressenter som passar objektet, först anmäld först, och de som redan fått erbjudande. */
  @Get(':objectId/matches')
  matches(@Ctx() ctx: RequestContext, @Param('objectId', ParseUUIDPipe) objectId: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows: obj } = await client.query(
        `select o.id, o.object_nr as "objectNr", o.type, p.name as "propertyName", cur.monthly_rent_ore::float as "monthlyRentOre"
         from rental_object o join property p on p.id = o.property_id left join rental_object_current cur on cur.object_id = o.id
         where o.id = $1`,
        [objectId],
      );
      if (!obj[0]) throw new NotFoundException('Objektet finns inte');
      const { rows: matching } = await client.query(
        `select ${REGISTRATION_SELECT}, f.id as "offerId", f.status as "offerStatus"
         from rental_object o
         left join rental_object_current cur on cur.object_id = o.id
         join interest_registration r on ${MATCH_SQL}
         join company co on co.id = r.company_id
         left join interest_offer f on f.registration_id = r.id and f.object_id = o.id
         where o.id = $1
         order by r.created_at`,
        [objectId],
      );
      const { rows: offers } = await client.query(
        `select f.id, f.status, f.note, f.created_at as "createdAt", r.id as "registrationId", r.registration_nr as "registrationNr",
                r.name, r.email, r.phone, r.status as "registrationStatus"
         from interest_offer f join interest_registration r on r.id = f.registration_id
         where f.object_id = $1 order by f.created_at`,
        [objectId],
      );
      return { object: obj[0], matching, offers };
    });
  }
}

@Controller('interests')
export class InterestsController {
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('status') status?: string, @Query('q') q?: string) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select ${REGISTRATION_SELECT},
             (select count(*) from rental_object o
                left join rental_object_status st on st.object_id = o.id
                left join rental_object_current cur on cur.object_id = o.id
               where o.active and (st.status in ('vacant','upcoming','notice')
                     or (st.status = 'occupied' and st.current_until is not null)) and ${MATCH_SQL})::int as "matchingObjects",
             (select count(*) from interest_offer f where f.registration_id = r.id)::int as "offerCount"
           from interest_registration r join company co on co.id = r.company_id
           where ($1::text is null or ($1 = 'active' and r.status = any ($3)) or r.status = $1)
             and ($2::text is null or r.name ilike '%' || $2 || '%' or r.email ilike '%' || $2 || '%'
                  or r.phone ilike '%' || $2 || '%' or r.registration_nr::text = $2)
           order by r.created_at`,
          [status || null, q?.trim() || null, ACTIVE_STATUSES],
        )
      ).rows,
    );
  }

  @Get('settings')
  getSettings(@Ctx() ctx: RequestContext) {
    const companyId = requireCompany(ctx, PERMISSION);
    return withContext(dbContext(ctx), (_db, client) => loadSettings(client, companyId));
  }

  @Put('settings')
  async saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const s = parse(settingsSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(
        `insert into interest_setting (company_id, form_enabled, intro_text, consent_text, retention_months)
         values ($1, $2, $3, $4, $5)
         on conflict (company_id) do update set form_enabled = $2, intro_text = $3, consent_text = $4, retention_months = $5`,
        [companyId, s.formEnabled, s.introText, s.consentText, s.retentionMonths],
      );
      return loadSettings(client, companyId);
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const data = parse(registrationSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await checkProperties(client, companyId, data.propertyIds);
      return insertRegistration(client, companyId, data, { source: 'manual' });
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(
        `select ${REGISTRATION_SELECT}, cu.name as "customerName", k.contract_nr as "contractNr"
         from interest_registration r join company co on co.id = r.company_id
         left join customer cu on cu.id = r.customer_id left join contract k on k.id = r.contract_id
         where r.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Anmälan finns inte');
      const { rows: offers } = await client.query(
        `select f.id, f.status, f.note, f.created_at as "createdAt", f.object_id as "objectId", o.object_nr as "objectNr",
                o.type, p.name as "propertyName", cur.monthly_rent_ore::float as "monthlyRentOre"
         from interest_offer f join rental_object o on o.id = f.object_id join property p on p.id = o.property_id
         left join rental_object_current cur on cur.object_id = o.id
         where f.registration_id = $1 order by f.created_at`,
        [id],
      );
      const all = await vacancies(client, today());
      const { rows: fit } = await client.query(
        `select o.id from interest_registration r
         join rental_object o on true left join rental_object_current cur on cur.object_id = o.id
         where r.id = $1 and o.active and ${MATCH_SQL.replace("r.status in ('new','contacted','offered')", 'true')}`,
        [id],
      );
      const fits = new Set(fit.map((f) => f.id as string));
      const matching = [...all.vacantNow, ...all.coming].filter((v) => fits.has(v.objectId));
      const { rows: properties } = await client.query(
        `select id, name from property where id = any ($1::uuid[]) order by name`,
        [rows[0].propertyIds],
      );
      return { ...rows[0], properties, offers, matching };
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const data = parse(updateRegistrationSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      if (data.propertyIds) await checkProperties(client, companyId, data.propertyIds);
      const { cols, vals } = toColumns(data);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`);
      sets.push('last_activity_at = now()');
      const { rowCount } = await client.query(`update interest_registration set ${sets.join(', ')} where id = $1`, [id, ...vals]);
      if (!rowCount) throw new NotFoundException('Anmälan finns inte');
      return { ok: true };
    });
  }

  /** Tar bort anmälan och personuppgifterna i revisionsloggen, t.ex. när någon återkallar sitt samtycke. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, PERMISSION);
    await withContext(dbContext(ctx), async (_db, client) => {
      const n = await deleteRegistrations(client, companyId, [id]);
      if (!n) throw new NotFoundException('Anmälan finns inte');
    });
  }

  @Post(':id/offers')
  offer(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    const { objectId, note } = parse(offerSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rows } = await client.query(`select o.id from rental_object o where o.id = $1 and o.company_id = $2`, [objectId, companyId]);
      if (!rows[0]) throw new BadRequestException('Objektet finns inte i bolaget');
      const reg = await client.query(`select status from interest_registration where id = $1`, [id]);
      if (!reg.rows[0]) throw new NotFoundException('Anmälan finns inte');
      const { rows: offer } = await client.query(
        `insert into interest_offer (company_id, registration_id, object_id, note) values ($1, $2, $3, $4)
         on conflict (registration_id, object_id) do update set status = 'offered', note = coalesce(excluded.note, interest_offer.note)
         returning id`,
        [companyId, id, objectId, note],
      );
      await client.query(
        `update interest_registration set last_activity_at = now(),
           status = case when status in ('new','contacted') then 'offered' else status end where id = $1`,
        [id],
      );
      return { id: offer[0].id };
    });
  }

  @Patch(':id/offers/:offerId')
  updateOffer(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() body: unknown,
  ) {
    requireCompany(ctx, PERMISSION);
    const { status, note } = parse(offerUpdateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const { rowCount } = await client.query(
        `update interest_offer set status = $3, note = coalesce($4, note) where id = $2 and registration_id = $1`,
        [id, offerId, status, note],
      );
      if (!rowCount) throw new NotFoundException('Erbjudandet finns inte');
      await client.query(`update interest_registration set last_activity_at = now() where id = $1`, [id]);
      return { ok: true };
    });
  }

  /**
   * Gör intressenten till hyresgäst (eller använder en befintlig) och skapar ett
   * avtalsutkast för objektet med objektets hyra. Allt sparas i en transaktion.
   */
  @Post(':id/convert')
  convert(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, PERMISSION);
    requireCompany(ctx, 'customer.write');
    requireCompany(ctx, 'contract.write');
    const input = parse(convertSchema, body);
    return withContext(dbContext(ctx), async (db, client) => {
      const { rows } = await client.query(`select ${REGISTRATION_SELECT} from interest_registration r join company co on co.id = r.company_id where r.id = $1`, [id]);
      const r = rows[0];
      if (!r) throw new NotFoundException('Anmälan finns inte');
      if (r.contractId) throw new ConflictException('Anmälan har redan blivit ett avtal');
      const { rows: obj } = await client.query(`select id, type from rental_object where id = $1 and company_id = $2 and active`, [
        input.objectId,
        companyId,
      ]);
      if (!obj[0]) throw new BadRequestException('Objektet finns inte i bolaget');

      let customerId = input.customerId ?? r.customerId ?? null;
      if (customerId) {
        const c = await client.query('select id from customer where id = $1 and company_id = $2', [customerId, companyId]);
        if (!c.rows[0]) throw new BadRequestException('Hyresgästen finns inte i bolaget');
      } else {
        const data = parse(customerSchema, {
          kind: r.kind,
          name: r.name,
          nationalId: input.nationalId || null,
          email: r.email,
          phone: r.phone,
          addressLine: r.addressLine,
          postalCode: r.postalCode,
          city: r.city,
          deliveryMethod: r.email ? 'email' : 'post',
          notes: r.kind === 'organization' && r.contactPerson ? `Kontaktperson: ${r.contactPerson}` : null,
        });
        await client.query(`select pg_advisory_xact_lock(hashtext('customer_nr:' || $1))`, [companyId]);
        const nr = (await client.query('select coalesce(max(customer_nr), 1000) + 1 as nr from customer where company_id = $1', [companyId]))
          .rows[0].nr;
        const [row] = await db
          .insert(customer)
          .values({ ...data, companyId, customerNr: nr })
          .returning();
        customerId = row.id;
      }

      const contractInput = parse(createContractSchema, {
        type: contractTypeFor(obj[0].type),
        customerId,
        startDate: input.startDate,
        objectIds: [input.objectId],
        notes: `Från intresseanmälan ${r.registrationNr}`,
      });
      const k = await createContract(db, client, companyId, contractInput);
      await client.query(
        `update interest_registration set status = 'converted', customer_id = $2, contract_id = $3, last_activity_at = now() where id = $1`,
        [id, customerId, k.id],
      );
      await client.query(
        `insert into interest_offer (company_id, registration_id, object_id, status) values ($1, $2, $3, 'accepted')
         on conflict (registration_id, object_id) do update set status = 'accepted'`,
        [companyId, id, input.objectId],
      );
      return { customerId, contractId: k.id, contractNr: k.contractNr };
    });
  }
}

/** Det publika anmälningsformuläret. Kräver ingen inloggning. */
@Controller('public/interest')
export class PublicInterestController {
  @Public()
  @Get(':key')
  async form(@Param('key') key: string) {
    const target = await formTarget(key);
    return withContext(target.ctx, async (_db, client) => {
      const { rows: properties } = await client.query(
        `select p.id, p.name, p.city, array_agg(distinct o.type) as types
         from property p join rental_object o on o.property_id = p.id and o.active
         where p.company_id = $1 group by p.id order by p.name`,
        [target.companyId],
      );
      return {
        companyName: target.companyName,
        introText: target.introText,
        consentText: target.consentText,
        objectTypes: [...new Set(properties.flatMap((p) => p.types as string[]))].filter((t) =>
          (OBJECT_TYPES as readonly string[]).includes(t),
        ),
        properties: properties.map((p) => ({ id: p.id, name: p.name, city: p.city })),
      };
    });
  }

  @Public()
  @Post(':key')
  @HttpCode(201)
  async submit(@Param('key') key: string, @Body() body: unknown, @Req() req: Request) {
    limitOrThrow(`interest-ip:${req.ip}`, 10, 60 * 60_000);
    const target = await formTarget(key);
    const { consent: _c, website, ...data } = parse(publicRegistrationSchema, body);
    if (website) return { ok: true }; // robot
    await withContext(target.ctx, async (_db, client) => {
      await checkProperties(client, target.companyId, data.propertyIds);
      await insertRegistration(client, target.companyId, data, { source: 'form', consentText: target.consentText });
    });
    return { ok: true };
  }
}

async function formTarget(key: string) {
  if (!/^[0-9a-f]{8,64}$/i.test(key)) throw new NotFoundException('Formuläret finns inte');
  const { rows } = await getPool().query(
    `select s.company_id as "companyId", c.group_id as "groupId", c.name as "companyName", s.intro_text as "introText",
            s.consent_text as "consentText"
     from interest_setting s join company c on c.id = s.company_id
     where s.public_key = $1 and s.form_enabled and c.active`,
    [key.toLowerCase()],
  );
  const t = rows[0];
  if (!t) throw new NotFoundException('Formuläret finns inte eller är stängt');
  return { ...t, ctx: { userId: '', groupId: t.groupId, companyIds: [t.companyId] } } as {
    companyId: string;
    companyName: string;
    introText: string | null;
    consentText: string;
    ctx: { userId: string; groupId: string; companyIds: string[] };
  };
}

async function loadSettings(client: PoolClient, companyId: string) {
  await client.query(`insert into interest_setting (company_id) values ($1) on conflict do nothing`, [companyId]);
  const { rows } = await client.query(
    `select form_enabled as "formEnabled", public_key as "publicKey", intro_text as "introText", consent_text as "consentText",
            retention_months as "retentionMonths"
     from interest_setting where company_id = $1`,
    [companyId],
  );
  return rows[0];
}

async function checkProperties(client: PoolClient, companyId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const { rows } = await client.query(`select count(*)::int as n from property where company_id = $1 and id = any ($2::uuid[])`, [
    companyId,
    ids,
  ]);
  if (rows[0].n !== new Set(ids).size) throw new BadRequestException('Okänd fastighet');
}
