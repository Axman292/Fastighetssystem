import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMonths,
  indexSupplement,
  noticeDeadline,
  terminationEndDate,
} from '../src/contracts/contract-rules';
import { normalizePersonalId } from '../src/customers/customers.controller';
import { login, startApp } from './helpers';

/**
 * Fas 3 är klar när hyresgäster kan registreras, avtal kan upprättas,
 * aktiveras, ändras, sägas upp och indexuppräknas, och objektens status
 * räknas fram ur avtalen.
 */

describe('regler utan databas', () => {
  it('kontrollerar personnummer och samordningsnummer', () => {
    expect(normalizePersonalId('121212-1212')).toBe('20121212-1212');
    expect(normalizePersonalId('121212+1212')).toBe('19121212-1212');
    expect(normalizePersonalId('191212121212')).toBe('19121212-1212');
    expect(normalizePersonalId('121212-1213')).toBeNull();
    expect(normalizePersonalId('701063-2391')).toBe('19701063-2391'); // dag 63 = samordningsnummer
  });

  it('räknar uppsägning av avtal som löper tills vidare från närmaste månadsskifte', () => {
    expect(terminationEndDate({ endDate: null, noticeMonths: 3, extensionMonths: null, received: '2026-11-15' })).toBe('2027-02-28');
    expect(terminationEndDate({ endDate: null, noticeMonths: 3, extensionMonths: null, received: '2026-11-30' })).toBe('2027-02-28');
    expect(terminationEndDate({ endDate: null, noticeMonths: 1, extensionMonths: null, received: '2027-01-31' })).toBe('2027-02-28');
  });

  it('förlänger tidsbestämda avtal när uppsägningen kommer för sent', () => {
    expect(noticeDeadline('2027-12-31', 9)).toBe('2027-03-31');
    const base = { endDate: '2027-12-31', noticeMonths: 9, extensionMonths: 36 };
    expect(terminationEndDate({ ...base, received: '2027-03-31' })).toBe('2027-12-31');
    expect(terminationEndDate({ ...base, received: '2027-04-01' })).toBe('2030-12-31');
    expect(terminationEndDate({ ...base, extensionMonths: null, received: '2027-06-01' })).toBe('2027-12-31');
  });

  it('räknar indextillägg med andel och golv', () => {
    const base = { baseValue: 400, sharePct: 100, floorAtBase: true, baseAmountOre: 2_500_000 };
    expect(indexSupplement({ ...base, newValue: 420 })).toBe(125_000);
    expect(indexSupplement({ ...base, newValue: 420, sharePct: 80 })).toBe(100_000);
    expect(indexSupplement({ ...base, newValue: 380 })).toBe(0);
    expect(indexSupplement({ ...base, newValue: 380, floorAtBase: false })).toBe(-125_000);
  });

  it('hanterar månader av olika längd', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-03-15', -3)).toBe('2026-12-15');
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;
const obj: Record<string, string> = {};

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_fas3'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('HPK AB');
  companyB = byName('Hardebergabanan AB');
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'mixed' }).expect(201);
  const mk = async (key: string, body: Record<string, unknown>) => {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', ...body }).expect(201);
    obj[key] = r.body.id;
  };
  await mk('apt', { objectNr: '1001', type: 'apartment', areaM2: 64, rooms: 2, monthlyRent: 9000 });
  await mk('shop', { objectNr: 'L01', type: 'commercial', areaM2: 180, monthlyRent: 25000, vatLiable: true });
  await mk('park', { objectNr: 'P01', type: 'parking', monthlyRent: 500 });
  await mk('store', { objectNr: 'F01', type: 'storage', monthlyRent: 300 });
});

afterAll(async () => stop());

describe('hyresgäster', () => {
  it('registrerar privatperson och företag med löpande kundnummer', async () => {
    const a = await agent
      .post('/customers')
      .send({ kind: 'person', name: 'Tolvan Tolvansson', nationalId: '191212121212', email: 'tolvan@example.se' })
      .expect(201);
    expect(a.body).toMatchObject({ customerNr: 1001, nationalId: '19121212-1212' });
    const b = await agent
      .post('/customers')
      .send({ kind: 'organization', name: 'Bageriet AB', nationalId: '5590000039', deliveryMethod: 'post' })
      .expect(201);
    expect(b.body).toMatchObject({ customerNr: 1002, nationalId: '559000-0039' });
  });

  it('kontrollerar personnummer, dubbletter och e-post för e-postfaktura', async () => {
    const bad = await agent.post('/customers').send({ kind: 'person', name: 'X', nationalId: '121212-1213', deliveryMethod: 'post' }).expect(400);
    expect(bad.body.fields[0]).toMatchObject({ path: 'nationalId', message: 'Ogiltigt personnummer' });
    await agent.post('/customers').send({ kind: 'person', name: 'Y', nationalId: '19121212-1212', deliveryMethod: 'post' }).expect(409);
    const noMail = await agent.post('/customers').send({ kind: 'person', name: 'Z' }).expect(400);
    expect(noMail.body.fields[0].path).toBe('email');
  });

  it('söker och visar bara hyresgäster i valt bolag', async () => {
    const q = await agent.get('/customers?q=bager').expect(200);
    expect(q.body.map((c: { name: string }) => c.name)).toEqual(['Bageriet AB']);
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    expect((await agent.get('/customers').expect(200)).body).toHaveLength(0);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});

describe('avtal', () => {
  let person: string;
  let org: string;
  let residential: string;
  let commercial: string;

  beforeAll(async () => {
    const list = (await agent.get('/customers').expect(200)).body as { id: string; kind: string }[];
    person = list.find((c) => c.kind === 'person')!.id;
    org = list.find((c) => c.kind === 'organization')!.id;
  });

  it('upprättar bostadsavtal med hyresrader från objektens hyra', async () => {
    const r = await agent
      .post('/contracts')
      .send({ type: 'residential', customerId: person, startDate: '2025-04-01', objectIds: [obj.apt, obj.park] })
      .expect(201);
    residential = r.body.id;
    expect(r.body).toMatchObject({ contractNr: 1001, status: 'draft' });
    const k = await agent.get(`/contracts/${residential}`).expect(200);
    expect(k.body.lines.map((l: { description: string }) => l.description).sort()).toEqual(['Hyra 1001', 'Parkering P01']);
    expect(k.body.lines.every((l: { vatRateBp: number }) => l.vatRateBp === 0)).toBe(true);
    expect(k.body.monthlyOre).toBe(950_000);
  });

  it('nekar moms i bostadsavtal och bostäder i lokalavtal', async () => {
    await agent
      .post(`/contracts/${residential}/lines`)
      .send({ article: 'service', description: 'Bredband', amount: 200, vatRateBp: 2500 })
      .expect(400);
    const r = await agent
      .post('/contracts')
      .send({ type: 'commercial', customerId: org, startDate: '2025-01-01', objectIds: [obj.apt] })
      .expect(400);
    expect(r.body.message).toContain('bostad');
  });

  it('kräver objekt och hyresrader innan avtalet aktiveras', async () => {
    const empty = await agent.post('/contracts').send({ type: 'other', customerId: org, startDate: '2026-01-01' }).expect(201);
    await agent.post(`/contracts/${empty.body.id}/activate`).send({}).expect(400);
  });

  it('aktiverar avtalet och objekten blir uthyrda', async () => {
    await agent.post(`/contracts/${residential}/activate`).send({ signedDate: '2025-03-10' }).expect(201);
    const o = await agent.get(`/objects/${obj.apt}`).expect(200);
    expect(o.body).toMatchObject({ status: 'occupied', currentContractId: residential, tenantName: 'Tolvan Tolvansson' });
    await agent.patch(`/contracts/${residential}`).send({ startDate: '2025-05-01' }).expect(409);
  });

  it('nekar att samma objekt hyrs ut i två avtal samtidigt', async () => {
    const r = await agent
      .post('/contracts')
      .send({ type: 'residential', customerId: person, startDate: '2026-01-01', objectIds: [obj.apt] })
      .expect(409);
    expect(r.body.message).toBe('Objektet ingår redan i ett annat avtal under perioden');
  });

  it('ändrar hyran från ett datum och behåller historiken', async () => {
    const k = await agent.get(`/contracts/${residential}`).expect(200);
    const rent = k.body.lines.find((l: { description: string }) => l.description === 'Hyra 1001');
    await agent
      .post(`/contracts/${residential}/lines/${rent.id}/change`)
      .send({ amount: 9300, validFrom: '2026-01-01', reason: 'Hyresförhandling 2026' })
      .expect(201);
    await agent.post(`/contracts/${residential}/lines/${rent.id}/change`).send({ amount: 9400, validFrom: '2025-01-01' }).expect(400);
    const after = await agent.get(`/contracts/${residential}`).expect(200);
    const rents = after.body.lines.filter((l: { description: string }) => l.description === 'Hyra 1001');
    expect(rents.map((l: { validFrom: string; validTo: string | null; amountOre: number }) => [l.validFrom, l.validTo, l.amountOre])).toEqual([
      ['2025-04-01', '2025-12-31', 900_000],
      ['2026-01-01', null, 930_000],
    ]);
    expect(after.body.monthlyOre).toBe(980_000);
  });

  it('säger upp bostadsavtalet med tre månaders uppsägningstid', async () => {
    const r = await agent
      .post(`/contracts/${residential}/terminate`)
      .send({ terminationReceived: '2026-11-15', terminatedBy: 'tenant', reason: 'Flyttar' })
      .expect(201);
    expect(r.body).toMatchObject({ status: 'terminated', endDate: '2027-02-28' });
    const o = await agent.get(`/objects/${obj.apt}`).expect(200);
    expect(o.body).toMatchObject({ status: 'notice', currentUntil: '2027-02-28' });
    // Nästa hyresgäst kan skrivas in från dagen efter
    const next = await agent
      .post('/contracts')
      .send({ type: 'residential', customerId: person, startDate: '2027-03-01', objectIds: [obj.apt] })
      .expect(201);
    expect((await agent.get(`/objects/${obj.apt}`).expect(200)).body.nextContractId).toBe(next.body.id);
    await agent.post(`/contracts/${next.body.id}/cancel`).send({ reason: 'Ångrade sig' }).expect(201);
    expect((await agent.get(`/objects/${obj.apt}`).expect(200)).body.nextContractId).toBeNull();
  });

  it('återkallar en uppsägning', async () => {
    await agent.post(`/contracts/${residential}/withdraw-termination`).send({}).expect(201);
    const k = await agent.get(`/contracts/${residential}`).expect(200);
    expect(k.body).toMatchObject({ status: 'active', endDate: null });
    expect(k.body.objects.every((o: { validTo: string | null }) => o.validTo === null)).toBe(true);
    expect(k.body.events.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['created', 'activated', 'rent_changed', 'terminated', 'note']),
    );
  });

  it('upprättar lokalavtal med moms, indexklausul och förlängning', async () => {
    await agent.put('/kpi/2024/10').send({ value: 400 }).expect(200);
    const r = await agent
      .post('/contracts')
      .send({
        type: 'commercial',
        customerId: org,
        startDate: '2025-01-01',
        endDate: '2027-12-31',
        noticeMonths: 9,
        extensionMonths: 36,
        objectIds: [obj.shop, obj.store],
        indexClause: { baseYear: 2024 },
        specialTerms: 'Lokalen får användas för bageri och kafé.',
      })
      .expect(201);
    commercial = r.body.id;
    await agent.post(`/contracts/${commercial}/deposits`).send({ kind: 'bank_guarantee', amount: 75000, dueDate: '2024-12-15' }).expect(201);
    await agent.post(`/contracts/${commercial}/activate`).send({}).expect(201);
    const k = await agent.get(`/contracts/${commercial}`).expect(200);
    const shop = k.body.lines.find((l: { description: string }) => l.description === 'Hyra L01');
    expect(shop).toMatchObject({ vatRateBp: 2500, indexed: true, baseAmountOre: 2_500_000, validTo: '2027-12-31' });
    expect(k.body.indexClause).toMatchObject({ baseValue: 400, baseMonth: 10, adjustMonth: 1 });
    expect(k.body.noticeDeadline).toBe('2027-03-31');
    expect(k.body.monthlyVatOre).toBe(625_000);
    // Tidsbestämt avtal som inte är uppsagt räknas som uthyrt, inte uppsagt
    expect((await agent.get(`/objects/${obj.shop}`).expect(200)).body.status).toBe('occupied');
  });

  it('räknar upp hyran med KPI en gång per år', async () => {
    const missing = await agent.get('/contracts/indexation?year=2026').expect(200);
    expect(missing.body[0]).toMatchObject({ status: 'missing_kpi' });
    await agent.put('/kpi/2025/10').send({ value: 420 }).expect(200);
    const preview = await agent.get('/contracts/indexation?year=2026').expect(200);
    expect(preview.body).toHaveLength(1);
    expect(preview.body[0]).toMatchObject({ status: 'ready', baseAmountOre: 2_530_000, newIndexOre: 126_500, currentIndexOre: 0 });
    const run = await agent.post('/contracts/indexation').send({ year: 2026 }).expect(201);
    expect(run.body[0]).toMatchObject({ result: 'applied' });
    const again = await agent.post('/contracts/indexation').send({ year: 2026 }).expect(201);
    expect(again.body[0]).toMatchObject({ result: 'skipped', status: 'done' });
    const k = await agent.get(`/contracts/${commercial}`).expect(200);
    const idx = k.body.lines.find((l: { article: string }) => l.article === 'index');
    expect(idx).toMatchObject({ amountOre: 126_500, vatRateBp: 2500, validFrom: '2026-01-01', validTo: '2027-12-31' });
    expect(k.body.monthlyOre).toBe(2_530_000 + 126_500);
  });

  it('förlänger lokalavtalet med förlängningstiden', async () => {
    const r = await agent.post(`/contracts/${commercial}/extend`).send({}).expect(201);
    expect(r.body.endDate).toBe('2030-12-31');
    const k = await agent.get(`/contracts/${commercial}`).expect(200);
    expect(k.body.lines.filter((l: { validTo: string | null }) => l.validTo === '2027-12-31')).toHaveLength(0);
  });

  it('säger upp lokalavtalet i tid till avtalstidens slut', async () => {
    const r = await agent
      .post(`/contracts/${commercial}/terminate`)
      .send({ terminationReceived: '2030-02-01', terminatedBy: 'landlord' })
      .expect(201);
    expect(r.body.endDate).toBe('2030-12-31');
  });

  it('visar bevakningar och skapar PDF', async () => {
    const att = await agent.get('/contracts/attention').expect(200);
    expect(att.body.some((a: { kind: string }) => a.kind === 'draft')).toBe(true);
    const pdf = await agent.get(`/contracts/${commercial}/pdf`).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('visar uthyrningsgrad per fastighet', async () => {
    const list = await agent.get('/properties').expect(200);
    expect(list.body[0]).toMatchObject({ objectCount: 4, occupiedCount: 4, vacantRentOre: 0 });
  });

  it('släpper inte igenom avtal till ett annat bolag', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    await agent.get(`/contracts/${commercial}`).expect(200); // läsning i egna bolag är tillåten
    await agent.post(`/contracts/${commercial}/events`).send({ description: 'Försök' }).expect(404);
    expect((await agent.get('/contracts').expect(200)).body).toHaveLength(0);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});
