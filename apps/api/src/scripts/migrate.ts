import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = resolve(__dirname, '../../../../db/migrations');

/** Kör SQL-filer i db/migrations i namnordning, var och en i egen transaktion. */
export async function migrate(connectionString: string, log = console.log): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`Migrering körd: ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migreringen ${file} misslyckades: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL saknas');
  migrate(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
