import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireGroupAdmin } from '../auth/request-context';
import { BankFileError } from './bank-import';
import { encryptSecret, folderPath, generateKeyPair, runConnection } from './bank-fetch';

const SELECT = `
  select c.id, c.name, c.kind, c.host, c.port, c.username, c.remote_dir as "remoteDir", c.file_pattern as "filePattern",
         c.host_fingerprint as "hostFingerprint", c.public_key as "publicKey", c.enabled, c.auto_book as "autoBook",
         c.delete_after_fetch as "deleteAfterFetch", c.interval_minutes as "intervalMinutes", c.notify_email as "notifyEmail",
         c.last_run_at as "lastRunAt", c.last_status as "lastStatus", c.last_error as "lastError",
         (select name from app_user u where u.id = coalesce(c.updated_by, c.created_by)) as "runAsName",
         (k.connection_id is not null) as "hasKey",
         (case when c.last_run_at is null then now() else c.last_run_at + make_interval(mins => c.interval_minutes) end) as "nextRunAt"
  from bank_connection c left join bank_connection_key k on k.connection_id = c.id`;

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const schema = z.object({
  name: z.string().trim().min(1, 'Ange ett namn').max(80),
  kind: z.enum(['sftp', 'folder']),
  host: optText(200),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: optText(100),
  remoteDir: z.string().trim().max(300).default('/'),
  filePattern: optText(200),
  hostFingerprint: optText(200),
  enabled: z.boolean().default(false),
  autoBook: z.boolean().default(true),
  deleteAfterFetch: z.boolean().default(false),
  intervalMinutes: z.coerce.number().int().min(5, 'Minst 5 minuter').max(1440, 'Högst ett dygn').default(60),
  notifyEmail: z
    .string()
    .trim()
    .max(200)
    .email('Ogiltig e-postadress')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
});

/**
 * Koncernens anslutningar till banken för automatisk hämtning av inbetalningsfiler.
 * Bara koncernadministratörer får se och ändra dem.
 */
@Controller('bank-connections')
export class BankConnectionsController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    requireGroupAdmin(ctx);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => ({
      connections: (await client.query(`${SELECT} order by c.created_at`)).rows,
      runs: (
        await client.query(
          `select r.id, r.connection_id as "connectionId", r.trigger, r.started_at as "startedAt", r.finished_at as "finishedAt", r.status,
                  r.files_found as "filesFound", r.files_imported as "filesImported", r.payments, r.booked, r.unmatched, r.message
           from bank_fetch_run r where r.trigger <> 'test' order by r.started_at desc limit 30`,
        )
      ).rows,
      folderEnabled: !!process.env.BANK_FOLDER_ROOT,
      secretConfigured: !!process.env.APP_SECRET_KEY && process.env.APP_SECRET_KEY.length >= 16,
      schedulerEnabled: process.env.BANK_FETCH !== 'off',
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireGroupAdmin(ctx);
    const d = this.validate(body);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const { rows } = await client.query(
        `insert into bank_connection (group_id, name, kind, host, port, username, remote_dir, file_pattern, host_fingerprint, enabled, auto_book,
                                      delete_after_fetch, interval_minutes, notify_email)
         values (app.current_group_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [d.name, d.kind, d.host, d.port, d.username, d.remoteDir || '/', d.filePattern, d.hostFingerprint, false, d.autoBook, d.deleteAfterFetch,
         d.intervalMinutes, d.notifyEmail ?? null],
      );
      if (d.enabled) await this.enable(client, rows[0].id);
      return (await client.query(`${SELECT} where c.id = $1`, [rows[0].id])).rows[0];
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireGroupAdmin(ctx);
    const d = this.validate(body);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const old = (await client.query('select host, port from bank_connection where id = $1 for update', [id])).rows[0];
      if (!old) throw new BadRequestException('Anslutningen finns inte');
      // Byts server sparas värdnyckeln på nytt vid nästa anslutning
      const fp = d.hostFingerprint ?? (old.host === d.host && old.port === d.port ? undefined : null);
      await client.query(
        `update bank_connection set name = $2, kind = $3, host = $4, port = $5, username = $6, remote_dir = $7, file_pattern = $8,
           host_fingerprint = case when $9::boolean then $10 else host_fingerprint end, enabled = false, auto_book = $11,
           delete_after_fetch = $12, interval_minutes = $13, notify_email = $14
         where id = $1`,
        [id, d.name, d.kind, d.host, d.port, d.username, d.remoteDir || '/', d.filePattern, fp !== undefined, fp ?? null, d.autoBook,
         d.deleteAfterFetch, d.intervalMinutes, d.notifyEmail ?? null],
      );
      if (d.enabled) await this.enable(client, id);
      return (await client.query(`${SELECT} where c.id = $1`, [id])).rows[0];
    });
  }

  /** Skapar ett nytt nyckelpar. Den publika delen skickas till banken, den privata lämnar aldrig servern. */
  @Post(':id/key')
  newKey(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireGroupAdmin(ctx);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) => {
      const c = (await client.query('select id from bank_connection where id = $1 for update', [id])).rows[0];
      if (!c) throw new BadRequestException('Anslutningen finns inte');
      let enc: string;
      let pub: string;
      try {
        const k = generateKeyPair(`fastighetssystem-${new Date().toISOString().slice(0, 10)}`);
        enc = encryptSecret(k.privateKey);
        pub = k.publicKey;
      } catch (err) {
        if (err instanceof BankFileError) throw new BadRequestException(err.message);
        throw err;
      }
      await client.query(
        `insert into bank_connection_key (connection_id, group_id, private_key_enc) values ($1, app.current_group_id(), $2)
         on conflict (connection_id) do update set private_key_enc = excluded.private_key_enc, created_at = now()`,
        [id, enc],
      );
      await client.query('update bank_connection set public_key = $2 where id = $1', [id, pub]);
      return (await client.query(`${SELECT} where c.id = $1`, [id])).rows[0];
    });
  }

  /** Ansluter och listar nya filer utan att läsa in något. */
  @Post(':id/test')
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireGroupAdmin(ctx);
    await this.mustExist(ctx, id);
    return runConnection(id, 'test');
  }

  /** Hämtar och läser in nya filer nu. */
  @Post(':id/run')
  @HttpCode(200)
  async run(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireGroupAdmin(ctx);
    await this.mustExist(ctx, id);
    return runConnection(id, 'manual');
  }

  /** Filerna som hittades vid en hämtning. */
  @Get('runs/:runId')
  runFiles(@Ctx() ctx: RequestContext, @Param('runId', ParseUUIDPipe) runId: string) {
    requireGroupAdmin(ctx);
    return withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) =>
      (
        await client.query(
          `select f.remote_name as name, f.size::float as size, f.result, f.message, f.bank_file_ids as "bankFileIds"
           from bank_fetch_file f where f.run_id = $1 order by f.remote_name`,
          [runId],
        )
      ).rows,
    );
  }

  private async mustExist(ctx: RequestContext, id: string) {
    const ok = await withContext(dbContext(ctx, ctx.access.map((a) => a.companyId)), async (_db, client) =>
      (await client.query('select 1 from bank_connection where id = $1', [id])).rows[0],
    );
    if (!ok) throw new BadRequestException('Anslutningen finns inte');
  }

  private async enable(client: import('pg').PoolClient, id: string) {
    const c = (
      await client.query(
        `select c.kind, c.host, c.username, c.remote_dir, (k.connection_id is not null) as has_key
         from bank_connection c left join bank_connection_key k on k.connection_id = c.id where c.id = $1`,
        [id],
      )
    ).rows[0];
    if (c.kind === 'sftp') {
      if (!c.host || !c.username) throw new BadRequestException('Ange server och användarnamn från banken innan hämtningen slås på');
      if (!c.has_key) throw new BadRequestException('Skapa en nyckel och skicka den till banken innan hämtningen slås på');
    } else {
      try {
        folderPath(c.remote_dir);
      } catch (err) {
        if (err instanceof BankFileError) throw new BadRequestException(err.message);
        throw err;
      }
    }
    await client.query('update bank_connection set enabled = true where id = $1', [id]);
  }

  private validate(body: unknown) {
    const d = parse(schema, body);
    if (d.kind === 'folder') {
      try {
        folderPath(d.remoteDir);
      } catch (err) {
        if (err instanceof BankFileError) throw new BadRequestException(err.message);
        throw err;
      }
    }
    if (d.hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(d.hostFingerprint)) {
      throw new BadRequestException('Fingeravtrycket ska se ut som SHA256: följt av 43 tecken');
    }
    return d;
  }
}
