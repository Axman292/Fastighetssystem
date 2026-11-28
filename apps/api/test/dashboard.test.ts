import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/scripts/seed-demo';
import { DASHBOARD_EXTRAS, registerDashboardExtra } from '../src/dashboard/extras';
import { ADMIN_EMAIL, ADMIN_PW, login, startApp } from './helpers';

/**
 * Startsidan är klar när nyckeltalen stämmer med listorna de länkar till,
 * för hela koncernen och för ett bolag, och när andra moduler kan lägga till egna tal.
 */

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let db: Client;
const company: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dashboard = async () => (await agent.get('/dashboard').expect(200)).body as any;

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_startsida'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await seedDemo(ADMIN_EMAIL, ADMIN_PW, () => undefined);
  agent = await login(app);
  for (const r of (await db.query('select id, name from company')).rows) company[r.name] = r.id;
  await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
}, 120_000);

afterAll(async () => {
  DASHBOARD_EXTRAS.length = 0;
  await db?.end();
  await stop?.();
});

describe('startsidan', () => {
  it('stämmer med fakturalistan och hyreslistan för koncernen', async () => {
    const d = await dashboard();
    const summary = (await agent.get('/invoices/summary').expect(200)).body;
    expect(d.receivables.openOre).toBe(summary.openOre);
    expect(d.receivables.overdueOre).toBe(summary.overdueOre);
    expect(d.receivables.overdueCount).toBe(summary.overdueCount);
    expect(d.receivables.aging.reduce((s: number, a: { amountOre: number }) => s + a.amountOre, 0)).toBe(summary.openOre);

    const objects = (await db.query('select count(*)::int as n from rental_object where active')).rows[0].n;
    expect(d.occupancy.objects).toBe(objects);
    expect(d.occupancy.let + d.occupancy.vacant + d.occupancy.upcoming).toBe(objects);
    expect(d.occupancy.byValue).toBeGreaterThan(0);
    expect(d.occupancy.byValue).toBeLessThanOrEqual(1);

    const roll = (await agent.get('/reports/hyreslista').expect(200)).body;
    const totals = roll.sections[0].totals;
    expect(d.occupancy.let).toBe(totals.let);
    expect(d.rent.monthlyOre * 12).toBe(totals.annual + roll.sections[1].totals.other * 12);

    expect(d.months).toHaveLength(12);
    expect(d.companies.length).toBe(Object.keys(company).length);
    const unmatched = (await agent.get('/bank-transactions?status=unmatched').expect(200)).body;
    expect(d.unmatched.count).toBe(unmatched.length);
  });

  it('visar bara valt bolag', async () => {
    const id = company['P Dahlqvist Förvaltning AB'];
    await agent.post('/auth/switch-company').send({ companyId: id }).expect(200);
    const d = await dashboard();
    expect(d.companies).toHaveLength(1);
    expect(d.properties.every((p: { companyName: string }) => p.companyName === 'P Dahlqvist Förvaltning AB')).toBe(true);
    const objects = (await db.query('select count(*)::int as n from rental_object where active and company_id = $1', [id])).rows[0].n;
    expect(d.occupancy.objects).toBe(objects);
    await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
  });

  it('räknar in betalningar och nya uppsägningar', async () => {
    const before = await dashboard();
    const cust = (await db.query(`select id, company_id from customer order by customer_nr limit 1`)).rows[0];
    await db.query(`insert into payment (company_id, customer_id, amount_ore, payment_date, method) values ($1, $2, 12345, current_date, 'other')`, [
      cust.company_id,
      cust.id,
    ]);
    const after = await dashboard();
    expect(after.payments.thisMonthOre).toBe(before.payments.thisMonthOre + 12345);
    expect(after.payments.thisMonthCount).toBe(before.payments.thisMonthCount + 1);
  });

  it('visar tal från andra moduler', async () => {
    registerDashboardExtra(async (client) => {
      const n = (await client.query('select count(*)::int as n from company')).rows[0].n;
      return { key: 'test', label: 'Testtal', value: String(n), href: '/bolag' };
    });
    const d = await dashboard();
    // Felanmälan registrerar också ett kort; här kontrolleras bara testets eget
    expect(d.extras.find((e: { key: string }) => e.key === 'test')).toEqual({ key: 'test', label: 'Testtal', value: String(Object.keys(company).length), href: '/bolag' });
    expect(d.extras.map((e: { key: string }) => e.key)).toContain('fault-reports');
  });
});
