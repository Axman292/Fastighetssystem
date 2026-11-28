import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PW, login as loginAs, startApp } from './helpers';

/**
 * Fas 1 är klar när två bolag kan läggas upp och data inte syns mellan dem.
 * Testerna kör mot en riktig PostgreSQL-databas som skapas på nytt varje gång.
 */
let app: INestApplication;
let stop: () => Promise<void>;
let http: ReturnType<typeof request>;
const login = (email: string, password: string) => loginAs(app, email, password);

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test'));
  http = request(app.getHttpServer());
});

afterAll(async () => stop());

describe('inloggning', () => {
  it('nekar fel lösenord och oinloggade anrop', async () => {
    await http.post('/auth/login').send({ email: 'admin@example.se', password: 'fel' }).expect(401);
    await http.get('/companies').expect(401);
  });

  it('koncernadministratören ser alla tre bolag i koncernvyn', async () => {
    const agent = await login('admin@example.se', ADMIN_PW);
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.companies).toHaveLength(3);
    expect(me.body.activeCompanyId).toBeNull();
    const list = await agent.get('/companies').expect(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      'Fastighet AB Hemporten K',
      'Fastighets AB Hardebergabanan',
      'P Dahlqvist Förvaltning AB',
    ]);
  });
});

describe('bolagsisolering', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    const agent = await login('admin@example.se', ADMIN_PW);
    const ca = await agent
      .post('/companies')
      .send({ name: 'Testbolag A AB', orgNr: '5560360793' })
      .expect(201);
    const cb = await agent
      .post('/companies')
      .send({ name: 'Testbolag B AB', orgNr: '556036-0785' })
      .expect(201);
    a = ca.body.id;
    b = cb.body.id;

    // Kostnadsställen i båda bolagen, skapade med respektive bolag valt
    await agent.post('/auth/switch-company').send({ companyId: a }).expect(200);
    await agent.post('/cost-centers').send({ code: 'A1', name: 'Fastighet i A' }).expect(201);
    await agent
      .post('/users')
      .send({ email: 'forvaltare@example.se', name: 'Förvaltare A', password: 'ett-långt-lösenord', roleKey: 'manager' })
      .expect(201);
    await agent.post('/auth/switch-company').send({ companyId: b }).expect(200);
    await agent.post('/cost-centers').send({ code: 'B1', name: 'Fastighet i B' }).expect(201);
  });

  it('avvisar organisationsnummer med fel kontrollsiffra', async () => {
    const agent = await login('admin@example.se', ADMIN_PW);
    const res = await agent.post('/companies').send({ name: 'Fel AB', orgNr: '556036-0794' }).expect(400);
    expect(res.body.fields[0].message).toBe('Ogiltigt organisationsnummer');
  });

  it('en förvaltare i bolag A ser bara bolag A', async () => {
    const agent = await login('forvaltare@example.se', 'ett-långt-lösenord');
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.companies.map((c: { companyId: string }) => c.companyId)).toEqual([a]);
    expect(me.body.activeCompanyId).toBe(a);

    const ccs = await agent.get('/cost-centers').expect(200);
    expect(ccs.body.map((c: { code: string }) => c.code)).toEqual(['A1']);
    const companies = await agent.get('/companies').expect(200);
    expect(companies.body.map((c: { id: string }) => c.id)).toEqual([a]);
  });

  it('en förvaltare kan inte välja eller läsa bolag B', async () => {
    const agent = await login('forvaltare@example.se', 'ett-långt-lösenord');
    await agent.post('/auth/switch-company').send({ companyId: b }).expect(403);
    await agent.get(`/companies/${b}`).expect(404);
    // Även om cookien manipuleras faller kontexten tillbaka och B syns inte
    const ccs = await agent.get('/cost-centers').set('x-company-id', b).expect(200);
    expect(ccs.body.map((c: { code: string }) => c.code)).not.toContain('B1');
  });

  it('en förvaltare saknar rätt att ändra bolaget och hantera användare', async () => {
    const agent = await login('forvaltare@example.se', 'ett-långt-lösenord');
    await agent.patch(`/companies/${a}`).send({ city: 'Malmö' }).expect(403);
    await agent
      .post('/users')
      .send({ email: 'x@example.se', name: 'X', password: 'ett-långt-lösenord', roleKey: 'reader' })
      .expect(403);
  });

  it('skrivningar kräver ett valt bolag, även för koncernadministratören', async () => {
    const agent = await login('admin@example.se', ADMIN_PW);
    await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
    await agent.post('/cost-centers').send({ code: 'X', name: 'Utan bolag' }).expect(403);
  });

  it('databasen själv stoppar läsning och skrivning utanför valt bolag', async () => {
    const { withContext } = await import('../src/db/db');
    const ctx = { userId: '00000000-0000-0000-0000-000000000000', groupId: '00000000-0000-0000-0000-000000000000', companyIds: [a] };

    // Ingen where-sats: RLS filtrerar ändå bort bolag B
    const rows = await withContext(ctx, async (_db, client) => (await client.query('select code from cost_center')).rows);
    expect(rows.map((r) => r.code)).toEqual(['A1']);

    await expect(
      withContext(ctx, (_db, client) =>
        client.query(`insert into cost_center (company_id, code, name) values ($1, 'HACK', 'x')`, [b]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('alla ändringar hamnar i revisionsloggen med användare', async () => {
    const agent = await login('admin@example.se', ADMIN_PW);
    await agent.post('/auth/switch-company').send({ companyId: a }).expect(200);
    await agent.patch(`/companies/${a}`).send({ city: 'Malmö' }).expect(200);
    const log = await agent.get('/audit-log').expect(200);
    const update = log.body.find((r: { tableName: string; action: string }) => r.tableName === 'company' && r.action === 'update');
    expect(update.userName).toBe('Administratör');
    expect(update.before.city).toBeNull();
    expect(update.after.city).toBe('Malmö');
    // Loggen från bolag B syns inte när A är valt
    expect(log.body.every((r: { companyId: string }) => r.companyId === a)).toBe(true);
    // Lösenord loggas aldrig
    expect(JSON.stringify(log.body)).not.toContain('scrypt$');
  });
});
