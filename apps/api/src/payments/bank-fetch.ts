import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { utils as sshUtils } from 'ssh2';
import { getPool, withContext } from '../db/db';
import { deliverEmail } from '../billing/delivery';
import {
  BankFileError,
  BankFileSection,
  CompanyAccounts,
  ImportResult,
  importSections,
  loadCompanyAccounts,
  parseBankFile,
  sectionAccount,
  sectionBelongsTo,
  sha256,
} from './bank-import';

/**
 * Automatisk hämtning av inbetalningsfiler från banken.
 *
 * Banken (t.ex. Danske Bank) lägger camt.054-filer i en mapp på sin SFTP-server.
 * Systemet loggar in med en SSH-nyckel som det själv skapat, hämtar nya filer,
 * läser in dem i rätt bolag och bokför de betalningar som matchar en avi.
 * Det som inte matchar ligger kvar under Inbetalningar och skickas som påminnelse
 * till e-postadressen i anslutningen.
 *
 * Varje anslutning hämtas med sitt intervall av en timer i API:et, och kan också
 * hämtas direkt med "Hämta nu". Ett lås i databasen gör att samma anslutning aldrig
 * hämtas av två processer samtidigt.
 */

// ---------------------------------------------------------------------
// Nyckel och kryptering
// ---------------------------------------------------------------------

function secretKey(): Buffer {
  const s = process.env.APP_SECRET_KEY?.trim();
  if (!s || s.length < 16) {
    throw new BankFileError('APP_SECRET_KEY saknas på servern. Den behövs för att spara bankens nyckel säkert (se deploy/BANKFIL.md).');
  }
  return createHash('sha256').update(`bank-connection:${s}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, data] = enc.split(':');
  if (v !== 'v1') throw new BankFileError('Okänt nyckelformat');
  const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new BankFileError('Nyckeln kunde inte låsas upp. Har APP_SECRET_KEY ändrats? Skapa då en ny nyckel och skicka den till banken.');
  }
}

/** Skapar ett RSA-nyckelpar (4096 bitar) i OpenSSH-format. Danske Bank kräver RSA på minst 2048 bitar. */
export function generateKeyPair(comment: string): { publicKey: string; privateKey: string } {
  const k = sshUtils.generateKeyPairSync('rsa', { bits: 4096, comment });
  return { publicKey: k.public.trim(), privateKey: k.private };
}

/** SHA256-fingeravtryck som OpenSSH visar det, t.ex. SHA256:abc… */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

// ---------------------------------------------------------------------
// Källor: SFTP hos banken, eller en mapp på servern
// ---------------------------------------------------------------------

export interface RemoteFile {
  name: string;
  size: number | null;
  modifiedAt: Date | null;
}

interface Source {
  list(): Promise<RemoteFile[]>;
  get(name: string): Promise<Buffer>;
  remove(name: string): Promise<void>;
  close(): Promise<void>;
  /** Värdnyckelns fingeravtryck efter anslutning (SFTP). */
  hostFingerprint?: string | null;
}

export interface ConnectionRow {
  id: string;
  group_id: string;
  name: string;
  kind: 'sftp' | 'folder';
  host: string | null;
  port: number;
  username: string | null;
  remote_dir: string;
  file_pattern: string | null;
  host_fingerprint: string | null;
  enabled: boolean;
  auto_book: boolean;
  delete_after_fetch: boolean;
  interval_minutes: number;
  notify_email: string | null;
  created_by: string | null;
  updated_by: string | null;
  private_key_enc: string | null;
}

const MAX_FILE = 50 * 1024 * 1024;

/** Mappar på servern får bara ligga under BANK_FOLDER_ROOT. */
export function folderPath(dir: string): string {
  const root = process.env.BANK_FOLDER_ROOT?.trim();
  if (!root) throw new BankFileError('Hämtning från mapp är inte påslagen på servern (BANK_FOLDER_ROOT saknas).');
  const full = resolve(root, dir.replace(/^\/+/, ''));
  const rel = relative(resolve(root), full);
  if (rel.startsWith('..')) throw new BankFileError('Mappen måste ligga under serverns mapp för bankfiler');
  return full;
}

async function folderSource(dir: string): Promise<Source> {
  const base = folderPath(dir);
  await fs.mkdir(base, { recursive: true });
  return {
    async list() {
      const out: RemoteFile[] = [];
      for (const e of await fs.readdir(base, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const st = await fs.stat(join(base, e.name));
        out.push({ name: e.name, size: st.size, modifiedAt: st.mtime });
      }
      return out;
    },
    get: (name) => fs.readFile(join(base, name)),
    remove: (name) => fs.unlink(join(base, name)),
    close: async () => undefined,
  };
}

async function sftpSource(c: ConnectionRow): Promise<Source> {
  if (!c.host || !c.username) throw new BankFileError('Ange server och användarnamn från banken');
  if (!c.private_key_enc) throw new BankFileError('Skapa en nyckel och skicka den publika delen till banken först');
  const sftp = new SftpClient('bankfil');
  let seen: string | null = null;
  const dir = c.remote_dir || '/';
  try {
    await sftp.connect({
      host: c.host,
      port: c.port,
      username: c.username,
      privateKey: decryptSecret(c.private_key_enc),
      readyTimeout: 20000,
      retries: 1,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return !c.host_fingerprint || c.host_fingerprint === seen;
      },
    });
  } catch (err) {
    if (c.host_fingerprint && seen && seen !== c.host_fingerprint) {
      throw new BankFileError(
        `Bankens server har en annan nyckel (${seen}) än den som sparats (${c.host_fingerprint}). Kontrollera med banken innan du godkänner den nya.`,
      );
    }
    throw new BankFileError(`Kunde inte ansluta till ${c.host}: ${(err as Error).message}`);
  }
  const path = (name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
  return {
    get hostFingerprint() {
      return seen;
    },
    async list() {
      const items = await sftp.list(dir);
      return items
        .filter((i) => i.type === '-' && !i.name.startsWith('.'))
        .map((i) => ({ name: i.name, size: i.size ?? null, modifiedAt: i.modifyTime ? new Date(i.modifyTime) : null }));
    },
    async get(name) {
      const b = await sftp.get(path(name));
      if (!Buffer.isBuffer(b)) throw new BankFileError('Filen kunde inte hämtas');
      return b;
    },
    async remove(name) {
      await sftp.delete(path(name));
    },
    async close() {
      await sftp.end().catch(() => undefined);
    },
  };
}

function openSource(c: ConnectionRow): Promise<Source> {
  return c.kind === 'folder' ? folderSource(c.remote_dir) : sftpSource(c);
}

/** Mönster som *.xml eller camt054_*.xml till ett reguljärt uttryck. */
export function patternMatches(pattern: string | null, name: string): boolean {
  const p = pattern?.trim();
  if (!p) return true;
  return p.split(/[,;\s]+/).filter(Boolean).some((one) => {
    const rx = new RegExp(`^${one.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return rx.test(name);
  });
}

// ---------------------------------------------------------------------
// En hämtning
// ---------------------------------------------------------------------

export interface RunSummary {
  runId: string | null;
  status: 'ok' | 'error' | 'busy';
  filesFound: number;
  filesImported: number;
  payments: number;
  booked: number;
  unmatched: number;
  message: string | null;
  files: { name: string; result: string; message: string | null }[];
}

export async function loadConnection(id: string): Promise<ConnectionRow | null> {
  const { rows } = await getPool().query(
    `select c.*, k.private_key_enc from bank_connection c left join bank_connection_key k on k.connection_id = c.id where c.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

const kr = (ore: number) => `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;

/**
 * Hämtar nya filer för en anslutning. trigger "test" ansluter och listar filer utan att läsa in något.
 * Körs med behörighet som den som senast ändrade anslutningen (koncernadministratör).
 */
export async function runConnection(connectionId: string, trigger: 'schedule' | 'manual' | 'test'): Promise<RunSummary> {
  const lockClient = await getPool().connect();
  const summary: RunSummary = { runId: null, status: 'ok', filesFound: 0, filesImported: 0, payments: 0, booked: 0, unmatched: 0, message: null, files: [] };
  try {
    const lock = await lockClient.query(`select pg_try_advisory_lock(hashtext('bank_fetch'), hashtext($1)) as ok`, [connectionId]);
    if (!lock.rows[0].ok) return { ...summary, status: 'busy', message: 'En hämtning pågår redan' };
    try {
      return await runLocked(connectionId, trigger, summary);
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtext('bank_fetch'), hashtext($1))`, [connectionId]);
    }
  } finally {
    lockClient.release();
  }
}

async function runLocked(connectionId: string, trigger: 'schedule' | 'manual' | 'test', summary: RunSummary): Promise<RunSummary> {
  const c = await loadConnection(connectionId);
  if (!c) throw new BankFileError('Anslutningen finns inte');
  const userId = c.updated_by ?? c.created_by;
  if (!userId) throw new BankFileError('Anslutningen saknar ansvarig användare');
  const companyIds: string[] = (await getPool().query('select id from company where group_id = $1 and active', [c.group_id])).rows.map((r) => r.id);
  const ctx = (ids: string[]) => ({ userId, groupId: c.group_id, companyIds: ids, requestId: `bankfil-${connectionId.slice(0, 8)}` });

  const run = await withContext(ctx(companyIds), async (_db, client) =>
    (await client.query(`insert into bank_fetch_run (group_id, connection_id, trigger) values ($1, $2, $3) returning id`, [c.group_id, c.id, trigger])).rows[0].id as string,
  );
  summary.runId = run;
  const record = (f: RemoteFile, hash: string | null, result: string, message: string | null, fileIds: string[] = []) =>
    withContext(ctx(companyIds), async (_db, client) => {
      await client.query(
        `insert into bank_fetch_file (group_id, connection_id, run_id, remote_name, size, modified_at, sha256, result, message, bank_file_ids)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
        [c.group_id, c.id, run, f.name.slice(0, 300), f.size, f.modifiedAt, hash, result, message?.slice(0, 1000) ?? null, fileIds],
      );
    });

  const imported: (ImportResult & { companyName: string })[] = [];
  const problems: string[] = [];
  let source: Source | null = null;
  try {
    source = await openSource(c);
    if (c.kind === 'sftp' && !c.host_fingerprint && source.hostFingerprint) {
      // Första anslutningen: värdnyckeln sparas och kontrolleras vid varje senare hämtning
      await withContext(ctx(companyIds), (_db, client) =>
        client.query('update bank_connection set host_fingerprint = $2 where id = $1', [c.id, source!.hostFingerprint]),
      );
    }
    const all = (await source.list()).filter((f) => patternMatches(c.file_pattern, f.name)).sort((a, b) => a.name.localeCompare(b.name));
    const done = await withContext(ctx(companyIds), async (_db, client) =>
      (
        await client.query(
          `select remote_name, size, modified_at from bank_fetch_file where connection_id = $1 and result in ('imported','duplicate','ignored')`,
          [c.id],
        )
      ).rows,
    );
    const key = (n: string, s: number | null, m: Date | null) => `${n}|${s ?? -1}|${m ? new Date(m).getTime() : 0}`;
    const handled = new Set(done.map((d) => key(d.remote_name, d.size === null ? null : Number(d.size), d.modified_at)));
    const fresh = all.filter((f) => !handled.has(key(f.name, f.size, f.modifiedAt)));
    summary.filesFound = fresh.length;
    if (trigger === 'test') {
      summary.files = fresh.map((f) => ({ name: f.name, result: 'new', message: null }));
      summary.message = `Anslutningen fungerar. ${all.length} filer i mappen, varav ${fresh.length} nya.`;
    } else {
      const companies = await withContext(ctx(companyIds), (_db, client) => loadCompanyAccounts(client, companyIds));
      for (const f of fresh) {
        const res = await handleFile(source, c, f, companies, ctx);
        summary.files.push({ name: f.name, result: res.result, message: res.message });
        await record(f, res.hash, res.result, res.message, res.imported.map((i) => i.id));
        if (res.result === 'error' || res.warning) problems.push(`${f.name}: ${res.message}`);
        if (res.result === 'imported') summary.filesImported += 1;
        for (const i of res.imported) {
          imported.push({ ...i, companyName: companies.find((x) => x.id === i.companyId)?.name ?? '' });
          summary.payments += i.payments;
          summary.booked += i.booked;
          summary.unmatched += i.unmatched;
        }
        if (c.delete_after_fetch && (res.result === 'imported' || res.result === 'duplicate')) {
          await source.remove(f.name).catch((err) => problems.push(`${f.name}: kunde inte tas bort hos banken (${(err as Error).message})`));
        }
      }
      summary.message = fresh.length
        ? `${summary.filesImported} filer inlästa, ${summary.payments} betalningar, ${summary.booked} bokförda, ${summary.unmatched} att hantera.`
        : 'Inga nya filer.';
    }
    if (problems.length) {
      summary.status = 'error';
      summary.message = `${summary.message} Problem: ${problems.join(' ')}`;
    }
  } catch (err) {
    summary.status = 'error';
    summary.message = err instanceof BankFileError ? err.message : `Hämtningen misslyckades: ${(err as Error).message}`;
  } finally {
    await source?.close();
  }

  await withContext(ctx(companyIds), async (_db, client) => {
    await client.query(
      `update bank_fetch_run set finished_at = now(), status = $2, files_found = $3, files_imported = $4, payments = $5, booked = $6, unmatched = $7, message = $8
       where id = $1`,
      [run, summary.status, summary.filesFound, summary.filesImported, summary.payments, summary.booked, summary.unmatched, summary.message?.slice(0, 2000)],
    );
    if (trigger !== 'test') {
      await client.query(`update bank_connection set last_run_at = now(), last_status = $2, last_error = $3 where id = $1`, [
        c.id,
        summary.status,
        summary.status === 'error' ? summary.message?.slice(0, 2000) : null,
      ]);
    }
  });

  if (trigger !== 'test' && c.notify_email && (summary.unmatched > 0 || summary.status === 'error')) {
    await notify(c, summary, imported).catch((err) => console.warn(`Bankfil: e-post kunde inte skickas: ${(err as Error).message}`));
  }
  return summary;
}

async function handleFile(
  source: Source,
  c: ConnectionRow,
  f: RemoteFile,
  companies: CompanyAccounts[],
  ctx: (ids: string[]) => { userId: string; groupId: string; companyIds: string[]; requestId: string },
): Promise<{ result: 'imported' | 'duplicate' | 'error' | 'ignored'; message: string | null; hash: string | null; imported: ImportResult[]; warning?: boolean }> {
  if (f.size !== null && f.size > MAX_FILE) return { result: 'error', message: 'Filen är större än 50 MB', hash: null, imported: [] };
  let buf: Buffer;
  try {
    buf = await source.get(f.name);
  } catch (err) {
    return { result: 'error', message: `Kunde inte hämtas: ${(err as Error).message}`, hash: null, imported: [] };
  }
  const hash = sha256(buf);
  let parsed;
  try {
    parsed = parseBankFile(buf);
  } catch (err) {
    if (!(err instanceof BankFileError)) throw err;
    // Andra filer i mappen (kvittenser, kontoutdrag i andra format) hoppas över
    const ignored = /varken en BgMax-fil eller en camt/.test(err.message);
    return { result: ignored ? 'ignored' : 'error', message: err.message, hash, imported: [] };
  }
  const byCompany = new Map<string, BankFileSection[]>();
  const unknown: string[] = [];
  for (const s of parsed.sections) {
    const owner = companies.find((co) => sectionBelongsTo(s, co));
    if (!owner) {
      if (s.payments.length) unknown.push(sectionAccount(s));
      continue;
    }
    byCompany.set(owner.id, [...(byCompany.get(owner.id) ?? []), s]);
  }
  const imported: ImportResult[] = [];
  for (const [companyId, sections] of byCompany) {
    const res = await withContext(ctx([companyId]), (_db, client) =>
      importSections(client, { companyId, filename: f.name, sha256: hash, parsed, sections, source: 'auto', connectionId: c.id, autoBook: c.auto_book }),
    );
    if (res) imported.push(res);
  }
  if (unknown.length) {
    // Det som hörde till kända bolag är inläst och hämtas inte igen. Resten får läsas in för hand.
    return {
      result: imported.length ? 'imported' : 'error',
      warning: true,
      message: `Filen innehåller betalningar till ${unknown.join(', ')}, som inte hör till något bolag. Lägg in bankgirot eller kontot under Bolag och ladda sedan upp filen för hand under Inbetalningar.`,
      hash,
      imported,
    };
  }
  if (!imported.length) return { result: byCompany.size ? 'duplicate' : 'ignored', message: byCompany.size ? 'Redan inläst' : 'Inga betalningar', hash, imported };
  return { result: 'imported', message: null, hash, imported };
}

async function notify(c: ConnectionRow, s: RunSummary, imported: (ImportResult & { companyName: string })[]) {
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, '') ?? '';
  const lines = [
    'Hej,',
    '',
    `Systemet har hämtat inbetalningar från ${c.name}.`,
    '',
    ...imported.map(
      (i) =>
        `${i.companyName}: ${i.payments} betalningar på ${kr(i.totalOre)}. ${i.booked} bokförda mot avier, ${i.unmatched} behöver hanteras.`,
    ),
    ...(s.status === 'error' ? ['', `Problem: ${s.message}`] : []),
    '',
    s.unmatched ? `Betalningarna som inte kunde matchas finns under Inbetalningar${base ? `: ${base}/inbetalningar` : ''}.` : '',
    '',
    'Det här meddelandet skickas automatiskt.',
  ];
  await deliverEmail(
    {
      fromName: 'Fastighetssystemet',
      to: c.notify_email!,
      subject: s.status === 'error' ? 'Problem vid hämtning av inbetalningar' : `${s.unmatched} inbetalningar att hantera`,
      text: lines.join('\n'),
      attachments: [],
    },
    `bankfil-${Date.now()}`,
  );
}

// ---------------------------------------------------------------------
// Schemaläggning
// ---------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
let ticking = false;

/** Hämtar anslutningar som är på tur. Exporteras för tester. */
export async function runDue(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    const { rows } = await getPool().query(
      `select id from bank_connection
       where enabled and (last_run_at is null or last_run_at + make_interval(mins => interval_minutes) <= now())
       order by last_run_at nulls first limit 20`,
    );
    for (const r of rows) {
      try {
        const s = await runConnection(r.id, 'schedule');
        if (s.status === 'error') console.warn(`Bankfil ${r.id}: ${s.message}`);
      } catch (err) {
        console.warn(`Bankfil ${r.id}: ${(err as Error).message}`);
      }
    }
    return rows.length;
  } finally {
    ticking = false;
  }
}

/** Startar timern som hämtar bankfiler. Stängs av med BANK_FETCH=off. */
export function startBankFetchScheduler(everyMs = 60_000): void {
  if (process.env.BANK_FETCH === 'off' || timer) return;
  timer = setInterval(() => void runDue().catch((err) => console.warn(`Bankfil: ${(err as Error).message}`)), everyMs);
  timer.unref();
}

export function stopBankFetchScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
