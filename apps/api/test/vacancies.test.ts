import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lostRent } from '../src/vacancies/vacancies';
import { login, startApp } from './helpers';

/**
 * Lediga objekt och intresselista: vakanser räknas ur avtalen, intressenter
 * anmäler sig i det publika formuläret, matchas mot lediga objekt och blir
 * hyresgäst med avtalsutkast. Gamla anmälningar gallras.
 */

describe('förlorad hyra', () => {
  it('räknar hyra per dag gånger lediga dagar', () => {
    // 36 500 kr/månad = 1 200 kr/dag
    expect(lostRent(3_650_000, '2026-11-01', '2026-11-11', null)).toBe(1_200_000);
    // Vakansen tog slut den 5:e: fem dagar
    expect(lostRent(3_650_000, '2026-11-01', '2026-11-11', '2026-11-05')).toBe(600_000);
    expect(lostRent(null, '2026-11-01', '2026-11-11', null)).toBe(0);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let propA: string;
const obj: Record<string, string> = {};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_vakanser'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  propA = (await agent.post('/properties').send({ name: 'Kornet', designation: 'Malmö Kornet 6', category: 'mixed' }).expect(201)).body.id;
  const mk = async (key: string, body: Record<string, unknown>) => {
    obj[key] = (await agent.post('/objects').send({ propertyId: propA, rentValidFrom: '2024-01-01', ...body }).expect(201)).body.id;
  };
  await mk('let', { objectNr: '1001', type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 });
  await mk('vacant', { objectNr: '1002', type: 'apartment', areaM2: 75, rooms: 3, monthlyRent: 12000 });
  await mk('leaving', { objectNr: '1003', type: 'apartment', areaM2: 50, rooms: 2, monthlyRent: 8000 });
  await mk('park', { objectNr: 'P01', type: 'parking', monthlyRent: 500 });

  const cust = async (name: string, nationalId: string) =>
    (await agent.post('/customers').send({ kind: 'person', name, nationalId, deliveryMethod: 'post' }).expect(201)).body.id;
  const c1 = await cust('Anna Andersson', '191212121212');
  const c2 = await cust('Bertil Berg', '198112189876');
  const contract = async (customerId: string, objectId: string, startDate: string) => {
    const id = (await agent.post('/contracts').send({ type: 'residential', customerId, startDate, objectIds: [objectId] }).expect(201)).body.id;
    await agent.post(`/contracts/${id}/activate`).send({}).expect(201);
    return id;
  };
  await contract(c1, obj.let, '2025-01-01');
  // Tidigare hyresgäst i 1002 som flyttade för 10 dagar sedan
  const old = await contract(c2, obj.vacant, '2025-01-01');
  await agent.post(`/contracts/${old}/terminate`).send({ terminationReceived: '2025-06-01', terminatedBy: 'tenant', endDate: addDays(-11) }).expect(201);
  // 1003 är uppsagd och blir ledig om en månad
  const leaving = await contract(c2, obj.leaving, '2025-01-01');
  await agent.post(`/contracts/${leaving}/terminate`).send({ terminationReceived: addDays(-60), terminatedBy: 'tenant', endDate: addDays(30) }).expect(201);
});

afterAll(async () => stop());

describe('vakansöversikt', () => {
  it('visar lediga nu och kommande, med dagar och förlorad hyra', async () => {
    const r = await agent.get('/vacancies').expect(200);
    const now = r.body.vacantNow.map((v: { objectNr: string }) => v.objectNr).sort();
    expect(now).toEqual(['1002', 'P01']);
    const v = r.body.vacantNow.find((x: { objectNr: string }) => x.objectNr === '1002');
    expect(v.vacantFrom).toBe(addDays(-10));
    expect(v.daysVacant).toBe(10);
    expect(v.lostOre).toBe(Math.round((1_200_000 * 12 * 10) / 365));
    expect(r.body.coming.map((x: { objectNr: string }) => x.objectNr)).toEqual(['1003']);
    expect(r.body.coming[0].vacantFrom).toBe(addDays(31));
    expect(r.body.coming[0].leavingTenant).toBe('Bertil Berg');
    expect(r.body.summary.vacantNow).toBe(2);
    expect(r.body.summary.totalObjects).toBe(4);
    expect(r.body.summary.monthlyLostOre).toBe(1_250_000);
  });
});

describe('intresselista', () => {
  let key: string;
  let regId: string;

  it('formuläret är stängt tills det slås på', async () => {
    const s = await agent.get('/interests/settings').expect(200);
    key = s.body.publicKey;
    expect(s.body.formEnabled).toBe(false);
    await request(app.getHttpServer()).get(`/public/interest/${key}`).expect(404);
    await agent.put('/interests/settings').send({ ...s.body, formEnabled: true, introText: 'Välkommen' }).expect(200);
  });

  it('tar emot en anmälan utan inloggning och kräver samtycke', async () => {
    const pub = request(app.getHttpServer());
    const form = await pub.get(`/public/interest/${key}`).expect(200);
    expect(form.body.companyName).toBe('Fastighet AB Hemporten K');
    expect(form.body.properties.map((p: { name: string }) => p.name)).toEqual(['Kornet']);
    expect(form.body.objectTypes.sort()).toEqual(['apartment', 'parking']);
    const body = { name: 'Cecilia Carlsson', email: 'cecilia@example.se', objectTypes: ['apartment'], minRooms: 3, maxRent: 13000 };
    await pub.post(`/public/interest/${key}`).send(body).expect(400);
    await pub.post(`/public/interest/${key}`).send({ ...body, consent: true }).expect(201);
    await pub.post(`/public/interest/${key}`).send({ name: 'Bot', email: 'bot@example.se', consent: true, website: 'spam' }).expect(201);
    const list = await agent.get('/interests').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Cecilia Carlsson', source: 'form', status: 'new', registrationNr: 1 });
    expect(list.body[0].consentText).toContain('samtycker');
    regId = list.body[0].id;
  });

  it('matchar intressenten mot lediga objekt som passar', async () => {
    const r = await agent.get('/vacancies').expect(200);
    const v = r.body.vacantNow.find((x: { objectNr: string }) => x.objectNr === '1002');
    expect(v.interested).toBe(1);
    // 1003 har bara två rum
    expect(r.body.coming[0].interested).toBe(0);
    const m = await agent.get(`/vacancies/${obj.vacant}/matches`).expect(200);
    expect(m.body.matching.map((x: { name: string }) => x.name)).toEqual(['Cecilia Carlsson']);
    const d = await agent.get(`/interests/${regId}`).expect(200);
    expect(d.body.matching.map((x: { objectNr: string }) => x.objectNr)).toEqual(['1002']);
  });

  it('erbjuder objektet och gör intressenten till hyresgäst med avtalsutkast', async () => {
    await agent.post(`/interests/${regId}/offers`).send({ objectId: obj.vacant, note: 'Visning på fredag' }).expect(201);
    expect((await agent.get(`/interests/${regId}`).expect(200)).body.status).toBe('offered');
    const c = await agent
      .post(`/interests/${regId}/convert`)
      .send({ objectId: obj.vacant, startDate: addDays(5), nationalId: '196408233234' })
      .expect(201);
    const k = await agent.get(`/contracts/${c.body.contractId}`).expect(200);
    expect(k.body.status).toBe('draft');
    expect(k.body.type).toBe('residential');
    const d = await agent.get(`/interests/${regId}`).expect(200);
    expect(d.body).toMatchObject({ status: 'converted', customerName: 'Cecilia Carlsson' });
    expect(d.body.offers[0].status).toBe('accepted');
    await agent.post(`/interests/${regId}/convert`).send({ objectId: obj.vacant, startDate: addDays(5) }).expect(409);
    // Objektet är nu kommande uthyrt, men fortfarande ledigt fram till inflytt
    const r = await agent.get('/vacancies').expect(200);
    const v = r.body.vacantNow.find((x: { objectNr: string }) => x.objectNr === '1002');
    expect(v.vacantUntil).toBe(addDays(4));
    expect(v.nextTenant).toBe('Cecilia Carlsson');
  });

  it('kan ta bort en anmälan på begäran och maskar revisionsloggen', async () => {
    const r = await agent.post('/interests').send({ name: 'David Dahl', phone: '070-1234567', objectTypes: ['parking'] }).expect(201);
    await agent.delete(`/interests/${r.body.id}`).expect(204);
    await agent.get(`/interests/${r.body.id}`).expect(404);
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { rows } = await db.query(`select before, after from audit_log where table_name = 'interest_registration' and row_id = $1`, [r.body.id]);
    await db.end();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('David Dahl');
  });

  it('gallrar anmälningar utan kontakt under lagringstiden', async () => {
    const r = await agent.post('/interests').send({ name: 'Erik Ek', email: 'erik@example.se' }).expect(201);
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(`update interest_registration set last_activity_at = now() - interval '13 months' where id = $1`, [r.body.id]);
    await db.end();
    const p = await agent.get('/gdpr/preview').expect(200);
    expect(p.body.interests.map((x: { name: string }) => x.name)).toEqual(['Erik Ek']);
    const run = await agent.post('/gdpr/run').send({}).expect(200);
    expect(run.body.interests).toBe(1);
    await agent.get(`/interests/${r.body.id}`).expect(404);
    const list = await agent.get('/interests').expect(200);
    expect(list.body.map((x: { name: string }) => x.name)).toEqual(['Cecilia Carlsson']);
  });
});
