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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { ADAPTERS, adapterFor, genericAdapter } from './adapters';
import { applyBatch, ApplyResult, rollbackBatch } from './apply';
import { ENTITIES } from './entities';
import { FormatError, parseFile } from './formats';
import { reconcile } from './reconcile';
import { summarize, validateBatch } from './validate';

const MAX_FILE = 25 * 1024 * 1024;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Ange ett namn').max(200),
  sourceSystem: z.enum(ADAPTERS.map((a) => a.key) as [string, ...string[]]),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  defaultPropertyId: z.string().uuid().nullable().optional(),
  controlTotals: z.record(z.number().finite().nullable()).optional(),
});

const mappingSchema = z.object({
  mapping: z.record(z.string().max(300).nullable()),
});

const decisionSchema = z.object({
  approveUpdate: z.boolean().optional(),
  skip: z.boolean().optional(),
  overrides: z
    .object({
      propertyId: z.string().uuid().nullable().optional(),
      propertyName: z.string().trim().max(200).nullable().optional(),
      vatLiable: z.boolean().optional(),
      linkTo: z.string().max(100).nullable().optional(),
    })
    .optional(),
});

const bulkSchema = z.object({
  rowIds: z.array(z.string().uuid()).max(5000).optional(),
  overrides: decisionSchema.shape.overrides,
  entity: z.string().max(40).optional(),
  status: z.enum(['update', 'new', 'link', 'error', 'unchanged', 'skipped']).optional(),
  approveUpdate: z.boolean().optional(),
  skip: z.boolean().optional(),
});

class Rollback extends Error {
  constructor(public payload: unknown) {
    super('rollback');
  }
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
};

/**
 * Importcentralen: datamigrering från DinHyresvärd och andra system.
 * Flöde: skapa import → ladda upp filer → mappa → kontrollera → testimport → skarp import → avstämning (→ ångra).
 */
@Controller('imports')
export class ImportCenterController {
  @Get('meta')
  meta() {
    return {
      adapters: ADAPTERS.map((a) => ({ key: a.key, label: a.label, description: a.description })),
      entities: ENTITIES,
    };
  }

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select b.id, b.company_id as "companyId", co.name as "companyName", b.batch_nr as "batchNr", b.name, b.source_system as "sourceSystem",
                  b.status, b.created_at as "createdAt", b.committed_at as "committedAt", b.rolled_back_at as "rolledBackAt",
                  u.name as "createdByName",
                  (select count(*) from import_file f where f.batch_id = b.id)::int as files,
                  b.validation -> 'totals' as totals
           from import_batch b join company co on co.id = b.company_id left join app_user u on u.id = b.created_by
           order by b.created_at desc`,
        )
      ).rows,
    );
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'import.manage');
    const data = parse(createSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('import_batch:' || $1))`, [companyId]);
      const { rows } = await client.query(
        `insert into import_batch (company_id, batch_nr, name, source_system)
         values ($1, (select coalesce(max(batch_nr), 0) + 1 from import_batch where company_id = $1), $2, $3)
         returning id, batch_nr as "batchNr"`,
        [companyId, data.name, data.sourceSystem],
      );
      await event(client, ctx, rows[0].id, companyId, 'created', `Import ${rows[0].batchNr} skapad (${adapterFor(data.sourceSystem).label})`);
      return rows[0];
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      const files = (
        await client.query(
          `select id, file_name as "fileName", format, size_bytes::float as "sizeBytes", note, created_at as "createdAt" from import_file where batch_id = $1 order by created_at`,
          [id],
        )
      ).rows;
      const tables = (
        await client.query(
          `select id, file_id as "fileId", name, profile, headers, mapping, source_totals as "sourceTotals", jsonb_array_length(data) as rows,
                  (select jsonb_agg(x) from (select x from jsonb_array_elements(data) with ordinality as e(x, n) where n <= 5) s) as sample
           from import_table where batch_id = $1 order by created_at, name`,
          [id],
        )
      ).rows;
      const properties = (await client.query('select id, name, designation, address_line as "addressLine" from property order by name')).rows;
      // Fastigheter som skapas i importen kan också väljas för objekt som saknar fastighet
      const newProperties = (
        await client.query(`select label from import_row where batch_id = $1 and entity = 'property' and status = 'new' order by label`, [id])
      ).rows.map((r) => r.label as string);
      return { ...b, files, tables, properties, newProperties, adapter: adapterFor(b.sourceSystem) && { key: b.sourceSystem, label: adapterFor(b.sourceSystem).label } };
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireCompany(ctx, 'import.manage');
    const data = parse(updateSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      if (data.name) await client.query('update import_batch set name = $2 where id = $1', [id, data.name]);
      if (data.controlTotals) await client.query('update import_batch set control_totals = $2 where id = $1', [id, data.controlTotals]);
      if (data.defaultPropertyId !== undefined) {
        assertEditable(b);
        await client.query(`update import_batch set default_property_id = $2, status = 'draft' where id = $1`, [id, data.defaultPropertyId]);
        if (b.status !== 'draft') await this.revalidate(client, ctx, id);
      }
      if (b.status === 'committed' && data.controlTotals) {
        await client.query('update import_batch set reconciliation = $2 where id = $1', [id, await reconcile(client, id)]);
      }
      return { ok: true };
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'import.manage');
    await withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      if (b.status === 'committed') throw new ConflictException('En genomförd import kan inte tas bort. Ångra den först.');
      if ((await client.query('select 1 from import_change where batch_id = $1 limit 1', [id])).rowCount) {
        throw new ConflictException('Importen har genomförts och ångrats. Den sparas för spårbarhet.');
      }
      await client.query('delete from import_batch where id = $1', [id]);
    });
  }

  /** Laddar upp en eller flera filer. Varje flik eller tabell känns igen och får en föreslagen mappning. */
  @Post(':id/files')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', 50, { limits: { fileSize: MAX_FILE } }))
  async upload(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files?: Express.Multer.File[]) {
    const companyId = requireCompany(ctx, 'import.manage');
    if (!files?.length) throw new BadRequestException('Välj minst en fil');
    // Läs filerna innan något sparas, så att en trasig fil inte ger en halv uppladdning
    const parsed: { f: Express.Multer.File; fileName: string; p: Awaited<ReturnType<typeof parseFile>> }[] = [];
    for (const f of files) {
      const fileName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        parsed.push({ f, fileName, p: await parseFile(fileName, f.buffer) });
      } catch (e) {
        if (e instanceof FormatError) throw new BadRequestException(`${fileName}: ${e.message}`);
        throw new BadRequestException(`${fileName} kunde inte läsas`);
      }
    }
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      const adapter = adapterFor(b.sourceSystem);
      const out = [];
      for (const { f, fileName, p } of parsed) {
        const sha = createHash('sha256').update(f.buffer).digest('hex');
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        const ins = await client.query(
          `insert into import_file (company_id, batch_id, file_name, format, mime_type, size_bytes, sha256, content, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, app.current_user_id())
           on conflict (batch_id, sha256) do nothing returning id`,
          [companyId, id, fileName, p.format, f.mimetype && f.mimetype !== 'application/octet-stream' ? f.mimetype : (MIME[ext] ?? f.mimetype), f.size, sha, f.buffer],
        );
        if (!ins.rowCount) {
          out.push({ fileName, duplicate: true, tables: [] });
          continue;
        }
        const fileId = ins.rows[0].id;
        const tables = [];
        for (const t of p.tables) {
          const det = adapter.detect(t, fileName) ?? genericAdapter.detect(t, fileName)!;
          await client.query(
            `insert into import_table (company_id, batch_id, file_id, name, profile, headers, data, mapping) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [companyId, id, fileId, t.name, det.profile, JSON.stringify(t.headers), JSON.stringify(t.rows), det.mapping],
          );
          tables.push({ name: t.name, rows: t.rows.length, label: det.label });
        }
        const note =
          p.format === 'pdf' || p.format === 'document'
            ? 'Dokument, sparas som bilaga'
            : tables.map((t) => `${t.name}: ${t.label}, ${t.rows} rader`).join(' · ');
        await client.query('update import_file set note = $2 where id = $1', [fileId, note]);
        await event(client, ctx, id, companyId, 'file_added', `Fil uppladdad: ${fileName}`, { format: p.format, tables });
        out.push({ fileName, duplicate: false, format: p.format, tables });
      }
      await client.query(`update import_batch set status = 'draft', test_result = null where id = $1`, [id]);
      return { files: out };
    });
  }

  @Delete(':id/files/:fileId')
  @HttpCode(204)
  async removeFile(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    const companyId = requireCompany(ctx, 'import.manage');
    await withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      const f = await client.query('delete from import_file where id = $1 and batch_id = $2 returning file_name', [fileId, id]);
      if (!f.rowCount) throw new NotFoundException('Filen finns inte');
      await client.query(`delete from import_row where batch_id = $1 and (file_id = $2 or table_id is null)`, [id, fileId]);
      await client.query(`update import_batch set status = 'draft', test_result = null where id = $1`, [id]);
      await event(client, ctx, id, companyId, 'file_removed', `Fil borttagen: ${f.rows[0].file_name}`);
    });
  }

  /** Sparar mappningen för en tabell: systemfält → kolumnrubrik i filen. */
  @Put(':id/tables/:tableId/mapping')
  saveMapping(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('tableId', ParseUUIDPipe) tableId: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'import.manage');
    const { mapping } = parse(mappingSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      const t = (await client.query('select name, headers, profile from import_table where id = $1 and batch_id = $2', [tableId, id])).rows[0];
      if (!t) throw new NotFoundException('Tabellen finns inte');
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(mapping)) {
        if (!v) continue;
        if (!/^(meta|[a-z]+)\.[a-zA-Z]+$/.test(k)) throw new BadRequestException(`Okänt fält ${k}`);
        if (!t.headers.includes(v)) throw new BadRequestException(`Kolumnen "${v}" finns inte i ${t.name}`);
        clean[k] = v;
      }
      const profile = t.profile === 'ignored' && Object.keys(clean).length ? 'generic' : t.profile;
      await client.query('update import_table set mapping = $2, profile = $3, updated_at = now() where id = $1', [tableId, clean, profile]);
      await client.query(`update import_batch set status = 'draft', test_result = null where id = $1`, [id]);
      await event(client, ctx, id, companyId, 'mapped', `Mappning ändrad för ${t.name}`, { fields: Object.keys(clean).length });
      return { ok: true };
    });
  }

  /** Kontrollerar alla poster: saknade och felaktiga uppgifter, dubbletter och koppling till fastighet. */
  @Post(':id/validate')
  @HttpCode(200)
  validate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'import.manage');
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      return this.revalidate(client, ctx, id);
    });
  }

  private async revalidate(client: PoolClient, ctx: RequestContext, id: string) {
    const b = await loadBatch(client, id);
    const decisions = (
      await client.query(
        `select entity, record_key as "recordKey", approve_update as "approveUpdate", skip, overrides from import_decision where batch_id = $1`,
        [id],
      )
    ).rows;
    const { recs, sourceTotals } = await validateBatch(
      client,
      { id, companyId: b.companyId, companyName: b.companyName, sourceSystem: b.sourceSystem, defaultPropertyId: b.defaultPropertyId },
      decisions,
    );
    await client.query('delete from import_row where batch_id = $1', [id]);
    // Spara i omgångar om 500 poster
    for (let i = 0; i < recs.length; i += 500) {
      const chunk = recs.slice(i, i + 500);
      await client.query(
        `insert into import_row (company_id, batch_id, table_id, file_id, source_row, entity, record_key, label, data, status, issues, changes, target_id)
         select $1, $2, x.table_id, x.file_id, x.source_row, x.entity, x.record_key, x.label, x.data, x.status, x.issues, x.changes, x.target_id
         from jsonb_to_recordset($3::jsonb) as x(table_id uuid, file_id uuid, source_row int, entity text, record_key text, label text,
                                                 data jsonb, status text, issues jsonb, changes jsonb, target_id uuid)`,
        [
          b.companyId,
          id,
          JSON.stringify(
            chunk.map((r) => ({
              table_id: r.tableId,
              file_id: r.fileId,
              source_row: r.sourceRow,
              entity: r.entity,
              record_key: r.key,
              label: r.label,
              data: r.data,
              status: r.status,
              issues: r.issues,
              changes: r.changes,
              target_id: r.targetId,
            })),
          ),
        ],
      );
    }
    for (const [tableId, totals] of Object.entries(sourceTotals)) {
      await client.query('update import_table set source_totals = $2 where id = $1', [tableId, totals]);
    }
    const perEntity = summarize(recs);
    const totals = Object.values(perEntity).reduce(
      (s, e) => {
        for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] += e[k] ?? 0;
        return s;
      },
      { total: 0, new: 0, update: 0, unchanged: 0, link: 0, error: 0, skipped: 0, warnings: 0 },
    );
    const validation = { perEntity, totals, at: new Date().toISOString() };
    await client.query(`update import_batch set status = 'validated', validation = $2, validated_at = now(), test_result = null where id = $1`, [id, validation]);
    await event(client, ctx, id, b.companyId, 'validated', `Kontroll: ${totals.total} poster, ${totals.error} med fel, ${totals.update} ändringar`, totals);
    return validation;
  }

  @Get(':id/rows')
  rows(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('entity') entity?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('issues') issues?: string,
    @Query('offset') offset?: string,
  ) {
    return withContext(dbContext(ctx), async (_db, client) => {
      await loadBatch(client, id);
      const params = [id, entity || null, status || null, q?.trim() || null, issues === 'warning' ? 'warning' : null, Math.max(0, Number(offset) || 0)];
      const where = `r.batch_id = $1 and ($2::text is null or r.entity = $2) and ($3::text is null or r.status = $3)
          and ($4::text is null or r.label ilike '%' || $4 || '%' or r.record_key ilike '%' || $4 || '%')
          and ($5::text is null or r.issues @> '[{"level":"warning"}]')`;
      const { rows } = await client.query(
        `select r.id, r.entity, r.record_key as "recordKey", r.label, r.status, r.issues, r.changes, r.source_row as "sourceRow",
                f.file_name as "fileName", t.name as "tableName", r.target_id as "targetId",
                r.data - array(select k from jsonb_object_keys(r.data) k where k like '\\_%') as data,
                r.data -> '_propertyId' as "propertyId", r.data -> '_link' as link,
                coalesce(d.approve_update, false) as "approveUpdate", coalesce(d.skip, false) as skip, coalesce(d.overrides, '{}') as overrides
         from import_row r
         left join import_file f on f.id = r.file_id
         left join import_table t on t.id = r.table_id
         left join import_decision d on d.batch_id = r.batch_id and d.entity = r.entity and d.record_key = r.record_key
         where ${where}
         order by case r.status when 'error' then 0 when 'update' then 1 when 'new' then 2 when 'link' then 3 else 4 end, r.entity, r.source_row nulls last, r.label
         limit 200 offset $6`,
        params,
      );
      const total = (await client.query(`select count(*)::int as n from import_row r where ${where}`, params.slice(0, 5))).rows[0].n;
      return { rows, total };
    });
  }

  /** Beslut för en post: godkänn överskrivning, hoppa över eller koppla till annan fastighet. */
  @Put(':id/rows/:rowId/decision')
  decide(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('rowId', ParseUUIDPipe) rowId: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'import.manage');
    const data = parse(decisionSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      const r = (await client.query('select entity, record_key, label from import_row where id = $1 and batch_id = $2', [rowId, id])).rows[0];
      if (!r) throw new NotFoundException('Posten finns inte');
      await client.query(
        `insert into import_decision (batch_id, company_id, entity, record_key, approve_update, skip, overrides, updated_by)
         values ($1, $2, $3, $4, coalesce($5::boolean, false), coalesce($6::boolean, false), coalesce($7::jsonb, '{}'::jsonb), app.current_user_id())
         on conflict (batch_id, entity, record_key) do update set
           approve_update = coalesce($5::boolean, import_decision.approve_update),
           skip = coalesce($6::boolean, import_decision.skip),
           overrides = case when $7::jsonb is null then import_decision.overrides else import_decision.overrides || $7::jsonb end,
           updated_at = now(), updated_by = app.current_user_id()`,
        [id, companyId, r.entity, r.record_key, data.approveUpdate ?? null, data.skip ?? null, data.overrides ? JSON.stringify(data.overrides) : null],
      );
      const what = [
        data.approveUpdate !== undefined && (data.approveUpdate ? 'överskrivning godkänd' : 'överskrivning ej godkänd'),
        data.skip !== undefined && (data.skip ? 'hoppas över' : 'tas med'),
        data.overrides && 'rättad',
      ]
        .filter(Boolean)
        .join(', ');
      await event(client, ctx, id, companyId, 'decision', `${r.label}: ${what}`);
      // Hoppa över och rättelser påverkar status och kopplingar: kontrollera om
      if (data.skip !== undefined || data.overrides) return this.revalidate(client, ctx, id);
      await client.query(`update import_batch set status = 'validated', test_result = null where id = $1 and status = 'tested'`, [id]);
      return { ok: true };
    });
  }

  /** Godkänn eller hoppa över många poster på en gång, t.ex. alla ändringar av hyresgäster. */
  @Post(':id/rows/bulk')
  @HttpCode(200)
  bulk(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'import.manage');
    const data = parse(bulkSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      assertEditable(b);
      const { rowCount } = await client.query(
        `insert into import_decision (batch_id, company_id, entity, record_key, approve_update, skip, overrides, updated_by)
         select r.batch_id, r.company_id, r.entity, r.record_key, coalesce($4::boolean, false), coalesce($5::boolean, false),
                coalesce($7::jsonb, '{}'::jsonb), app.current_user_id()
         from import_row r where r.batch_id = $1 and ($2::text is null or r.entity = $2) and ($3::text is null or r.status = $3)
           and ($6::uuid[] is null or r.id = any($6::uuid[]))
         on conflict (batch_id, entity, record_key) do update set
           approve_update = coalesce($4::boolean, import_decision.approve_update), skip = coalesce($5::boolean, import_decision.skip),
           overrides = case when $7::jsonb is null then import_decision.overrides else import_decision.overrides || $7::jsonb end,
           updated_at = now(), updated_by = app.current_user_id()`,
        [
          id,
          data.entity ?? null,
          data.status ?? null,
          data.approveUpdate ?? null,
          data.skip ?? null,
          data.rowIds ?? null,
          data.overrides ? JSON.stringify(data.overrides) : null,
        ],
      );
      const what = data.overrides ? 'rättade' : data.approveUpdate ? 'överskrivning godkänd' : data.approveUpdate === false ? 'överskrivning ej godkänd' : data.skip ? 'hoppas över' : 'tas med';
      await event(client, ctx, id, companyId, 'decision', `${rowCount} poster: ${what}`);
      if (data.skip !== undefined || data.overrides) return this.revalidate(client, ctx, id);
      await client.query(`update import_batch set status = 'validated', test_result = null where id = $1 and status = 'tested'`, [id]);
      return { ok: true, count: rowCount };
    });
  }

  /** Testimport: allt sparas på riktigt i en transaktion som sedan rullas tillbaka. */
  @Post(':id/test')
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'import.manage');
    let outcome: { result: ApplyResult; reconciliation: unknown };
    try {
      await withContext(dbContext(ctx), async (_db, client) => {
        const b = await loadBatch(client, id);
        if (b.status === 'draft') throw new BadRequestException('Kör kontrollen först');
        assertEditable(b);
        const result = await applyBatch(client, { ...b, sourceLabel: adapterFor(b.sourceSystem).label }, 'test');
        throw new Rollback({ result, reconciliation: await reconcile(client, id) });
      });
      throw new Error('unreachable');
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      outcome = e.payload as typeof outcome;
    }
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      const ok = outcome.result.errors.length === 0;
      const testResult = { ...outcome, ok, at: new Date().toISOString() };
      await client.query(`update import_batch set status = $2, test_result = $3, tested_at = now() where id = $1`, [id, ok ? 'tested' : 'validated', testResult]);
      const created = Object.values(outcome.result.created).reduce((s, n) => s + n, 0);
      await event(client, ctx, id, b.companyId, 'tested', ok ? `Testimport utan fel: ${created} poster skulle skapas` : `Testimport: ${outcome.result.errors.length} fel`, {
        created: outcome.result.created,
        updated: outcome.result.updated,
        errors: outcome.result.errors.length,
      });
      return testResult;
    });
  }

  /** Skarp import. Kräver en godkänd testimport utan ändringar sedan dess. */
  @Post(':id/commit')
  @HttpCode(200)
  async commit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'import.manage');
    try {
      return await withContext(dbContext(ctx), async (_db, client) => {
        const b = await loadBatch(client, id);
        if (b.status !== 'tested') throw new BadRequestException('Gör en testimport utan fel först');
        const bad = (await client.query(`select count(*)::int as n from import_row where batch_id = $1 and status = 'error'`, [id])).rows[0].n;
        if (bad) throw new BadRequestException(`${bad} poster har fel. Rätta dem eller välj Hoppa över innan importen genomförs.`);
        // Lås mot två samtidiga körningar av samma import
        await client.query('select 1 from import_batch where id = $1 for update', [id]);
        const result = await applyBatch(client, { ...b, sourceLabel: adapterFor(b.sourceSystem).label }, 'commit');
        if (result.errors.length) throw new Rollback(result);
        const rec = await reconcile(client, id);
        await client.query(
          `update import_batch set status = 'committed', committed_at = now(), committed_by = app.current_user_id(), reconciliation = $2 where id = $1`,
          [id, rec],
        );
        const created = Object.values(result.created).reduce((s, n) => s + n, 0);
        const updated = Object.values(result.updated).reduce((s, n) => s + n, 0);
        await event(client, ctx, id, b.companyId, 'committed', `Import genomförd: ${created} poster skapade, ${updated} uppdaterade`, result);
        return { result, reconciliation: rec };
      });
    } catch (e) {
      if (e instanceof Rollback) {
        throw new BadRequestException({ message: 'Importen stoppades av ett fel. Ingenting har sparats.', errors: (e.payload as ApplyResult).errors });
      }
      throw e;
    }
  }

  /** Ångrar en genomförd import. Stoppas om importerade poster har ändrats eller börjat användas. */
  @Post(':id/rollback')
  @HttpCode(200)
  async rollback(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'import.manage');
    try {
      return await withContext(dbContext(ctx), async (_db, client) => {
        const b = await loadBatch(client, id);
        if (b.status !== 'committed') throw new BadRequestException('Bara en genomförd import kan ångras');
        const purged = (await client.query('select purged_at from import_batch where id = $1', [id])).rows[0]?.purged_at;
        if (purged) throw new BadRequestException('Importen har gallrats enligt dataskyddsinställningarna och kan inte längre ångras');
        await client.query('select 1 from import_batch where id = $1 for update', [id]);
        // Tillåter att just denna imports utfärdade fakturor tas bort
        await client.query(`select set_config('app.import_rollback', $1, true)`, [id]);
        const r = await rollbackBatch(client, id, b.committedAt);
        if (!r.ok) throw new Rollback(r.blockers);
        await client.query(
          `update import_batch set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = app.current_user_id() where id = $1`,
          [id],
        );
        await client.query('update import_row set target_id = null where batch_id = $1', [id]);
        await event(client, ctx, id, b.companyId, 'rolled_back', `Import ångrad: ${r.deleted} rader borttagna, ${r.restored} återställda`, r);
        return r;
      });
    } catch (e) {
      if (e instanceof Rollback) {
        throw new ConflictException({ message: 'Importen kan inte ångras. Ingenting har ändrats.', blockers: e.payload });
      }
      throw e;
    }
  }

  /** Kör samma filer igen i en ny import. Det som redan importerats känns igen och dubbleras inte. */
  @Post(':id/copy')
  @HttpCode(200)
  copy(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'import.manage');
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      await client.query(`select pg_advisory_xact_lock(hashtext('import_batch:' || $1))`, [companyId]);
      const { rows } = await client.query(
        `insert into import_batch (company_id, batch_nr, name, source_system, default_property_id, control_totals)
         select company_id, (select coalesce(max(batch_nr), 0) + 1 from import_batch where company_id = $2), name || ' (ny körning)', source_system, default_property_id, control_totals
         from import_batch where id = $1 returning id, batch_nr as "batchNr"`,
        [id, companyId],
      );
      const nb = rows[0].id;
      const files = (await client.query('select id from import_file where batch_id = $1 order by created_at', [id])).rows;
      for (const f of files) {
        const nf = (
          await client.query(
            `insert into import_file (company_id, batch_id, file_name, format, mime_type, size_bytes, sha256, content, note, created_by)
             select company_id, $2, file_name, format, mime_type, size_bytes, sha256, content, note, app.current_user_id() from import_file where id = $1 returning id`,
            [f.id, nb],
          )
        ).rows[0].id;
        await client.query(
          `insert into import_table (company_id, batch_id, file_id, name, profile, headers, data, mapping)
           select company_id, $2, $3, name, profile, headers, data, mapping from import_table where file_id = $1`,
          [f.id, nb, nf],
        );
      }
      await event(client, ctx, nb, companyId, 'created', `Import ${rows[0].batchNr} skapad som ny körning av import ${b.batchNr}`);
      return rows[0];
    });
  }

  @Get(':id/reconciliation')
  reconciliation(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const b = await loadBatch(client, id);
      return b.status === 'committed' ? reconcile(client, id) : (b.reconciliation ?? null);
    });
  }

  @Get(':id/events')
  events(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select e.id, e.kind, e.message, e.details, e.created_at as "createdAt", u.name as "userName"
           from import_event e left join app_user u on u.id = e.user_id where e.batch_id = $1 order by e.id desc`,
          [id],
        )
      ).rows,
    );
  }
}

async function loadBatch(client: PoolClient, id: string) {
  const b = (
    await client.query(
      `select b.id, b.company_id as "companyId", co.name as "companyName", b.batch_nr as "batchNr", b.name, b.source_system as "sourceSystem",
              b.status, b.default_property_id as "defaultPropertyId", b.control_totals as "controlTotals", b.validation,
              b.test_result as "testResult", b.reconciliation, b.validated_at as "validatedAt", b.tested_at as "testedAt",
              b.committed_at::text as "committedAt", b.rolled_back_at as "rolledBackAt", b.created_at as "createdAt",
              cu.name as "committedByName"
       from import_batch b join company co on co.id = b.company_id left join app_user cu on cu.id = b.committed_by where b.id = $1`,
      [id],
    )
  ).rows[0];
  if (!b) throw new NotFoundException('Importen finns inte i valt bolag');
  return b;
}

function assertEditable(b: { status: string }) {
  if (b.status === 'committed') throw new ConflictException('Importen är genomförd. Ångra den, eller kör filerna igen som en ny import.');
  if (b.status === 'rolled_back') throw new ConflictException('Importen är ångrad. Kör filerna igen som en ny import.');
}

async function event(client: PoolClient, ctx: RequestContext, batchId: string, companyId: string, kind: string, message: string, details?: unknown) {
  await client.query(`insert into import_event (company_id, batch_id, kind, message, details, user_id) values ($1, $2, $3, $4, $5, $6)`, [
    companyId,
    batchId,
    kind,
    message,
    details === undefined ? null : JSON.stringify(details),
    ctx.userId,
  ]);
}
