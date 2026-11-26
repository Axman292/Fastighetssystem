import { Pool, PoolClient } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/** Det som avgör vad databasen släpper igenom för ett anrop. */
export interface DbContext {
  userId: string;
  groupId: string;
  /** Bolag som RLS ska släppa igenom i den här transaktionen. */
  companyIds: string[];
  requestId?: string;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL saknas');
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Kör fn i en transaktion som rollen fastighet_app, med bolagskontext satt.
 * Radnivåsäkerheten i databasen filtrerar sedan på app.company_ids,
 * så att ett bolags data aldrig kan läcka till ett annat även vid en bugg i koden.
 */
export async function withContext<T>(ctx: DbContext, fn: (db: Db, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role fastighet_app');
    await client.query(
      `select set_config('app.user_id', $1, true),
              set_config('app.group_id', $2, true),
              set_config('app.company_ids', $3, true),
              set_config('app.request_id', $4, true)`,
      [ctx.userId, ctx.groupId, toPgArray(ctx.companyIds), ctx.requestId ?? ''],
    );
    const result = await fn(drizzle(client, { schema }), client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Ändrar vilka bolag RLS släpper igenom, inom pågående transaktion. */
export async function setCompanyIds(client: PoolClient, companyIds: string[]): Promise<void> {
  await client.query(`select set_config('app.company_ids', $1, true)`, [toPgArray(companyIds)]);
}

/**
 * Systemåtkomst utan RLS. Används bara för inloggning och sessioner,
 * där användarens bolag ännu inte är kända.
 */
export function systemDb(): Db {
  return drizzle(getPool(), { schema });
}

function toPgArray(ids: string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Ogiltigt bolags-id: ${id}`);
  }
  return `{${ids.join(',')}}`;
}
