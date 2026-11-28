import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { hashPassword } from '../auth/password';

/**
 * Lägger upp en koncern med tre bolag och en koncernadministratör för utveckling.
 * Bolagen har sina riktiga namn och organisationsnummer (samma som i Hogia DinHyresvärd).
 */
export async function seed(connectionString: string, adminPassword: string, log = console.log) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const existing = await client.query('select 1 from company_group limit 1');
    if (existing.rowCount) {
      log('Databasen har redan data, inget lades till.');
      return;
    }
    await client.query('begin');
    const {
      rows: [group],
    } = await client.query(`insert into company_group (name) values ('Dahlqvist-koncernen') returning id`);
    const companies = [
      ['P Dahlqvist Förvaltning AB', withCheckDigit('556315142')],
      ['Fastighet AB Hemporten K', withCheckDigit('556719791')],
      ['Fastighets AB Hardebergabanan', withCheckDigit('556752060')],
    ];
    for (const [name, orgNr] of companies) {
      await client.query(`insert into company (group_id, name, org_nr) values ($1, $2, $3)`, [group.id, name, orgNr]);
    }
    await client.query(
      `insert into app_user (group_id, email, name, password_hash, is_group_admin)
       values ($1, 'admin@example.se', 'Administratör', $2, true)`,
      [group.id, await hashPassword(adminPassword)],
    );
    await client.query('commit');
    log('Koncern, tre bolag och användaren admin@example.se är upplagda.');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Lägger till Luhn-kontrollsiffra på nio siffror och formaterar som NNNNNN-NNNN. */
export function withCheckDigit(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(nine[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  const ten = nine + check;
  return `${ten.slice(0, 6)}-${ten.slice(6)}`;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL saknas');
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
  seed(url, password)
    .then(() => {
      if (!process.env.SEED_ADMIN_PASSWORD) console.log(`Lösenord för admin@example.se: ${password}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
