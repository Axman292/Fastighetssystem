import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers';

const db = 'fs_test_seed_company';
let stop: () => Promise<void>;
let url: string;

beforeAll(async () => {
  ({ stop } = await startApp(db));
  url = process.env.DATABASE_URL!;
});
afterAll(async () => stop());

async function companies() {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query('select name, bankgiro, plusgiro, vat_nr, address_line, city, invoice_email from company order by name');
  await c.end();
  return rows;
}

describe('påhittade bolagsuppgifter i testmiljön', () => {
  it('fyller bara i tomma fält och skriver aldrig över', async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query(`update company set plusgiro = '12345-6', city = 'Lund' where name = 'Hardebergabanan AB'`);
    await c.end();

    const { seedTestCompanyData } = await import('../src/scripts/seed-test-company');
    await seedTestCompanyData(url, () => undefined);
    const rows = await companies();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.bankgiro || r.plusgiro).toBeTruthy();
      expect(r.vat_nr).toMatch(/^SE\d{12}$/);
      expect(r.address_line).toBeTruthy();
      expect(r.invoice_email).toMatch(/@example\.se$/);
    }
    const hbb = rows.find((r) => r.name === 'Hardebergabanan AB')!;
    expect(hbb.bankgiro).toBeNull();
    expect(hbb.plusgiro).toBe('12345-6');
    expect(hbb.city).toBe('Lund');

    await seedTestCompanyData(url, () => undefined);
    expect(await companies()).toEqual(rows);
  });
});
