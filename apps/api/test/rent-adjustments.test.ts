import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adjustedAmount } from '../src/rent-adjustments/rent-adjustment';
import { login, startApp } from './helpers';

/**
 * Hyresjustering: hyran för många avtal och objekt ändras på en gång från ett
 * datum, med förhandsvisning, historik och möjlighet att ångra.
 */

describe('avrundning', () => {
  it('räknar procent med avrundning till krona, tiotal eller öre', () => {
    expect(adjustedAmount(912_345, { method: 'percent', percent: 3.5, rounding: 'krona' })).toBe(944_300);
    expect(adjustedAmount(912_345, { method: 'percent', percent: 3.5, rounding: 'ten' })).toBe(944_000);
    expect(adjustedAmount(912_345, { method: 'percent', percent: 3.5, rounding: 'none' })).toBe(944_277);
    expect(adjustedAmount(900_000, { method: 'amount', amount: 250, rounding: 'krona' })).toBe(925_000);
    expect(adjustedAmount(900_000, { method: 'percent', percent: -2, rounding: 'krona' })).toBe(882_000);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;
let propA: string;
let propB: string;
const obj: Record<string, string> = {};
const k: Record<string, string> = {};

const base = { effectiveDate: '2027-01-01', method: 'percent', percent: 4, rounding: 'krona' };

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_hyresjustering'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('HPK AB');
  companyB = byName('Hardebergabanan AB');
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  propA = (await agent.post('/properties').send({ name: 'Kornet', designation: 'Malmö Kornet 6', category: 'mixed' }).expect(201)).body.id;
  propB = (await agent.post('/properties').send({ name: 'Ugglan', designation: 'Malmö Ugglan 11', category: 'residential' }).expect(201)).body.id;
  const mk = async (key: string, propertyId: string, body: Record<string, unknown>) => {
    obj[key] = (await agent.post('/objects').send({ propertyId, rentValidFrom: '2024-01-01', ...body }).expect(201)).body.id;
  };
  await mk('a1', propA, { objectNr: '1001', type: 'apartment', areaM2: 60, monthlyRent: 9000 });
  await mk('a2', propA, { objectNr: '1002', type: 'apartment', areaM2: 70, monthlyRent: 10000 });
  await mk('vacant', propA, { objectNr: '1003', type: 'apartment', areaM2: 50, monthlyRent: 8000 });
  await mk('shop', propA, { objectNr: 'L01', type: 'commercial', areaM2: 100, monthlyRent: 20000, vatLiable: true });
  await mk('b1', propB, { objectNr: '2001', type: 'apartment', areaM2: 55, monthlyRent: 8500 });
  await mk('park', propA, { objectNr: 'P01', type: 'parking', monthlyRent: 500 });

  const cust = async (name: string, nationalId: string) =>
    (await agent.post('/customers').send({ kind: 'person', name, nationalId, deliveryMethod: 'post' }).expect(201)).body.id;
  const c1 = await cust('Anna Andersson', '191212121212');
  const c2 = await cust('Bertil Berg', '198112189876');
  const c3 = await cust('Cecilia Carlsson', '196408233234');
  const org = (await agent.post('/customers').send({ kind: 'organization', name: 'Butiken AB', nationalId: '5590000039', deliveryMethod: 'post' }).expect(201))
    .body.id;

  const contract = async (key: string, body: Record<string, unknown>) => {
    k[key] = (await agent.post('/contracts').send(body).expect(201)).body.id;
    await agent.post(`/contracts/${k[key]}/activate`).send({}).expect(201);
  };
  await contract('a1', { type: 'residential', customerId: c1, startDate: '2025-01-01', objectIds: [obj.a1, obj.park] });
  await contract('a2', { type: 'residential', customerId: c2, startDate: '2026-06-01', objectIds: [obj.a2] });
  await contract('b1', { type: 'residential', customerId: c3, startDate: '2025-01-01', objectIds: [obj.b1] });
  await contract('shop', {
    type: 'commercial',
    customerId: org,
    startDate: '2025-01-01',
    objectIds: [obj.shop],
    indexClause: { baseYear: 2024, baseValue: 400, adjustMonth: 1 },
  });
});

afterAll(async () => stop());

describe('förhandsvisning', () => {
  it('visar bostäder i vald fastighet med ny hyra och lediga objekt', async () => {
    const r = await agent
      .post('/rent-adjustments/preview')
      .send({ ...base, propertyIds: [propA], objectTypes: ['apartment'] })
      .expect(200);
    const rows = r.body.rows as { key: string; objectNr: string; kind: string; currentOre: number; newOre: number; status: string }[];
    expect(rows.map((x) => [x.kind, x.objectNr, x.currentOre, x.newOre, x.status])).toEqual([
      ['line', '1001', 900_000, 936_000, 'ready'],
      ['line', '1002', 1_000_000, 1_040_000, 'ready'],
      ['object', '1003', 800_000, 832_000, 'ready'],
    ]);
    expect(r.body.summary).toMatchObject({ ready: 3, contracts: 2, beforeOre: 1_900_000, afterOre: 1_976_000 });
    // Inget har ändrats
    const c = await agent.get(`/contracts/${k.a1}`).expect(200);
    expect(c.body.lines.filter((l: { validTo: string | null }) => !l.validTo)).toHaveLength(2);
  });

  it('hoppar över avtal med indexklausul om man inte väljer att ta med dem', async () => {
    const r = await agent.post('/rent-adjustments/preview').send({ ...base, propertyIds: [propA], objectTypes: ['commercial'] }).expect(200);
    const line = r.body.rows.find((x: { kind: string }) => x.kind === 'line');
    expect(line).toMatchObject({ objectNr: 'L01', status: 'indexed' });
    const incl = await agent
      .post('/rent-adjustments/preview')
      .send({ ...base, propertyIds: [propA], objectTypes: ['commercial'], includeIndexed: true })
      .expect(200);
    expect(incl.body.rows.find((x: { kind: string }) => x.kind === 'line')).toMatchObject({ status: 'ready', newOre: 2_080_000 });
  });

  it('kräver procent eller belopp', async () => {
    const r = await agent.post('/rent-adjustments/preview').send({ effectiveDate: '2027-01-01', method: 'percent' }).expect(400);
    expect(r.body.fields[0].path).toBe('percent');
  });
});

describe('genomförande', () => {
  let adjustmentId: string;

  it('ändrar avtalens och objektens hyra från datumet och sparar historik', async () => {
    const preview = await agent.post('/rent-adjustments/preview').send({ ...base, objectTypes: ['apartment'] }).expect(200);
    const b1 = preview.body.rows.find((x: { objectNr: string }) => x.objectNr === '2001');
    const r = await agent
      .post('/rent-adjustments')
      .send({ ...base, objectTypes: ['apartment'], name: 'Bostäder 2027', reason: 'Förhandlat med Hyresgästföreningen', excludeKeys: [b1.key] })
      .expect(201);
    adjustmentId = r.body.id;
    expect(r.body).toMatchObject({ adjustmentNr: 1, lineCount: 2, objectCount: 3, beforeOre: 1_900_000, afterOre: 1_976_000 });

    const c = await agent.get(`/contracts/${k.a1}`).expect(200);
    const rents = c.body.lines
      .filter((l: { description: string }) => l.description === 'Hyra 1001')
      .map((l: { validFrom: string; validTo: string | null; amountOre: number }) => [l.validFrom, l.validTo, l.amountOre]);
    expect(rents).toEqual([
      ['2025-01-01', '2026-12-31', 900_000],
      ['2027-01-01', null, 936_000],
    ]);
    // Parkeringen ingick inte i urvalet
    expect(c.body.lines.filter((l: { description: string }) => l.description === 'Parkering P01')).toHaveLength(1);
    expect(c.body.events.some((e: { description: string }) => e.description.startsWith('Hyresjustering 1 Bostäder 2027'))).toBe(true);

    // Bortvalt avtal är orört
    const other = await agent.get(`/contracts/${k.b1}`).expect(200);
    expect(other.body.lines).toHaveLength(1);

    // Objektens hyra, även det lediga objektet
    const detail = await agent.get(`/rent-adjustments/${adjustmentId}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'applied', canRevert: true, reason: 'Förhandlat med Hyresgästföreningen' });
    expect(detail.body.items.map((i: { kind: string; objectNr: string; newOre: number }) => [i.kind, i.objectNr, i.newOre])).toEqual([
      ['line', '1001', 936_000],
      ['line', '1002', 1_040_000],
      ['object', '1001', 936_000],
      ['object', '1002', 1_040_000],
      ['object', '1003', 832_000],
    ]);
    const list = await agent.get('/rent-adjustments').expect(200);
    expect(list.body[0]).toMatchObject({ name: 'Bostäder 2027', lineCount: 2 });
  });

  it('justerar inte samma rad två gånger från samma datum', async () => {
    const r = await agent.post('/rent-adjustments/preview').send({ ...base, propertyIds: [propA], objectTypes: ['apartment'] }).expect(200);
    expect(r.body.rows.map((x: { status: string }) => x.status)).toEqual(['same_day', 'same_day', 'same_day']);
    await agent
      .post('/rent-adjustments')
      .send({ ...base, propertyIds: [propA], objectTypes: ['apartment'], name: 'Igen' })
      .expect(400);
  });

  it('ångrar justeringen och återställer den tidigare hyran', async () => {
    await agent.post(`/rent-adjustments/${adjustmentId}/revert`).expect(200);
    const c = await agent.get(`/contracts/${k.a1}`).expect(200);
    const rents = c.body.lines.filter((l: { description: string }) => l.description === 'Hyra 1001');
    expect(rents.map((l: { validTo: string | null; amountOre: number }) => [l.validTo, l.amountOre])).toEqual([[null, 900_000]]);
    const o = await agent.get(`/objects/${obj.vacant}`).expect(200);
    expect(o.body.prices.map((p: { validTo: string | null; monthlyRentOre: number }) => [p.validTo, p.monthlyRentOre])).toEqual([[null, 800_000]]);
    const detail = await agent.get(`/rent-adjustments/${adjustmentId}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'reverted', canRevert: false });
    await agent.post(`/rent-adjustments/${adjustmentId}/revert`).expect(409);
  });

  it('kan inte ångras när den nya hyran finns på en avi', async () => {
    const r = await agent
      .post('/rent-adjustments')
      .send({ ...base, propertyIds: [propB], objectTypes: ['apartment'], name: 'Ugglan 2027' })
      .expect(201);
    await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-10', propertyIds: [propB] }).expect(201);
    const detail = await agent.get(`/rent-adjustments/${r.body.id}`).expect(200);
    expect(detail.body.canRevert).toBe(false);
    expect(detail.body.revertBlocker).toContain('avi');
    await agent.post(`/rent-adjustments/${r.body.id}/revert`).expect(409);
  });

  it('kräver valt bolag och visar inte andra bolags justeringar', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    expect((await agent.get('/rent-adjustments').expect(200)).body).toHaveLength(0);
    await agent.get(`/rent-adjustments/${adjustmentId}`).expect(404);
    const pre = await agent.post('/rent-adjustments/preview').send({ ...base, objectTypes: ['apartment'] }).expect(200);
    expect(pre.body.rows).toHaveLength(0);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});
