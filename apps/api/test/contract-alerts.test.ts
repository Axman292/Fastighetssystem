import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../src/common/money';
import { addDays, addMonths, lastDayOfMonth, noticeDeadline } from '../src/contracts/contract-rules';
import { digestText, stockholmNow } from '../src/contracts/alert-digest';
import { toIcs, type ContractAlert } from '../src/contracts/alerts';
import { login, startApp } from './helpers';

/**
 * Avtalsbevakning: påminnelser om uppsägningstid, avtalsslut, omförhandling,
 * KPI-uppräkning, hyresändringar och säkerheter, med kalender, klarmarkering,
 * framförhållning per bolag och e-postsammanfattning.
 */

const outbox = mkdtempSync(join(tmpdir(), 'bevakning-'));
process.env.OUTBOX_DIR = outbox;

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;
let userId: string;
let commercial: string;
let residential: string;

const now = today();
const endDate = lastDayOfMonth(addMonths(now, 11));
const deadline = noticeDeadline(endDate, 9)!;
const indexDate = `${addDays(now, 40).slice(0, 7)}-01`;

type Alert = ContractAlert;
const kinds = (list: Alert[], contractId: string) => list.filter((a) => a.contractId === contractId).map((a) => a.kind).sort();

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_bevakning'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  userId = me.body.user.id;
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('Fastighet AB Hemporten K');
  companyB = byName('Fastighets AB Hardebergabanan');
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'mixed' }).expect(201);
  const mk = async (body: Record<string, unknown>) =>
    (await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', ...body }).expect(201)).body.id as string;
  const shop = await mk({ objectNr: 'L01', type: 'commercial', areaM2: 180, monthlyRent: 25000, vatLiable: true });
  const apt = await mk({ objectNr: '1001', type: 'apartment', areaM2: 64, rooms: 2, monthlyRent: 9000 });
  const store = await mk({ objectNr: 'F01', type: 'storage', monthlyRent: 300 });

  const org = (await agent.post('/customers').send({ kind: 'organization', name: 'Bageriet AB', nationalId: '5590000039', deliveryMethod: 'post' }).expect(201)).body.id;
  const person = (await agent.post('/customers').send({ kind: 'person', name: 'Tolvan Tolvansson', nationalId: '191212121212', email: 'tolvan@example.se' }).expect(201)).body.id;

  // Lokalavtal med nio månaders uppsägning, förlängning och indexklausul
  commercial = (
    await agent
      .post('/contracts')
      .send({
        type: 'commercial',
        customerId: org,
        startDate: '2024-01-01',
        endDate,
        noticeMonths: 9,
        extensionMonths: 36,
        objectIds: [shop],
        indexClause: { baseYear: 2023, baseMonth: 10, baseValue: 400, adjustMonth: Number(indexDate.slice(5, 7)) },
      })
      .expect(201)
  ).body.id;
  const k = await agent.get(`/contracts/${commercial}`).expect(200);
  const rent = k.body.lines[0];
  await agent.patch(`/contracts/${commercial}/lines/${rent.id}`).send({ indexed: true }).expect(200);
  await agent.post(`/contracts/${commercial}/activate`).send({ signedDate: '2023-12-01' }).expect(201);
  await agent
    .post(`/contracts/${commercial}/lines`)
    .send({ article: 'service', description: 'Bredband', amount: 200, vatRateBp: 2500, validFrom: addDays(now, 20) })
    .expect(201);
  await agent
    .post(`/contracts/${commercial}/deposits`)
    .send({ kind: 'bank_guarantee', amount: 75000, receivedDate: '2023-12-15', validUntil: addDays(now, 30) })
    .expect(201);

  // Bostad som löper tills vidare med omförhandling
  residential = (
    await agent
      .post('/contracts')
      .send({ type: 'residential', customerId: person, startDate: '2025-01-01', objectIds: [apt], renegotiateBy: addDays(now, 10) })
      .expect(201)
  ).body.id;
  await agent.post(`/contracts/${residential}/activate`).send({}).expect(201);

  // Utkast
  await agent.post('/contracts').send({ type: 'storage', customerId: person, startDate: addDays(now, 5), objectIds: [store] }).expect(201);
});

afterAll(async () => stop());

describe('regler utan databas', () => {
  it('ger datum, timme och veckodag i svensk tid', () => {
    expect(stockholmNow(new Date('2026-11-30T06:30:00Z'))).toEqual({ date: '2026-11-30', hour: 7, weekday: 1 });
    expect(stockholmNow(new Date('2026-07-04T22:30:00Z'))).toEqual({ date: '2026-07-05', hour: 0, weekday: 7 });
  });

  it('skriver kalenderfil och sammanfattning', () => {
    const a = {
      key: 'index:x:2027-01-01',
      kind: 'index',
      label: 'KPI-uppräkning',
      date: '2027-01-01',
      severity: 'high',
      overdue: false,
      message: 'Hyran ska räknas upp, efter KPI.',
      action: 'Kör indexuppräkningen',
      link: '/avtal/indexering',
      contractId: 'x',
      contractNr: 1001,
      contractType: 'commercial',
      companyId: 'c',
      companyName: 'Bolaget AB',
      customerName: 'Bageriet AB',
      objects: 'L01',
      ack: null,
    } as Alert;
    const ics = toIcs([a], 'https://test.se');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270101');
    expect(ics).toContain('SUMMARY:KPI-uppräkning: Bageriet AB\\, avtal 1001');
    const text = digestText([a, { ...a, date: '2026-11-01', key: 'b' }], '2026-12-10', 'https://test.se', false);
    expect(text).toContain('FÖRSENAT (1)');
    expect(text).toContain('INOM 30 DAGAR (1)');
    expect(text).toContain('https://test.se/avtal/bevakning');
  });
});

describe('påminnelser', () => {
  it('räknar fram påminnelser ur avtalen', async () => {
    const list = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    expect(kinds(list, commercial)).toEqual(['index', 'notice_deadline', 'rent_change', 'security_expiry']);
    expect(kinds(list, residential)).toEqual(['renegotiate']);
    expect(list.some((a) => a.kind === 'draft')).toBe(true);
    const notice = list.find((a) => a.kind === 'notice_deadline')!;
    expect(notice.date).toBe(deadline);
    expect(notice.message).toContain('förlängs annars med 36 månader');
    const idx = list.find((a) => a.kind === 'index')!;
    expect(idx.date).toBe(indexDate);
    expect(idx.link).toContain('/avtal/indexering');
    expect(list.find((a) => a.kind === 'rent_change')!.message).toContain('25 000 kr blir 25 200 kr');
    // Att hantera på avtalssidan och översikten bygger på samma lista
    const att = (await agent.get('/contracts/attention').expect(200)).body as Alert[];
    expect(att.map((a) => a.key).sort()).toEqual(list.map((a) => a.key).sort());
  });

  it('markerar klar, ångrar och skjuter upp', async () => {
    const list = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    const r = list.find((a) => a.kind === 'renegotiate')!;
    const body = { key: r.key, contractId: r.contractId, kind: r.kind, date: r.date };
    const done = await agent.post('/contract-alerts/ack').send({ ...body, action: 'done', note: 'Klart med hyresgästen' }).expect(201);
    let after = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    expect(after.some((a) => a.key === r.key)).toBe(false);
    const handled = (await agent.get('/contract-alerts?handled=1').expect(200)).body as Alert[];
    expect(handled.find((a) => a.key === r.key)!.ack).toMatchObject({ action: 'done', note: 'Klart med hyresgästen' });
    const k = await agent.get(`/contracts/${residential}`).expect(200);
    expect(k.body.events.some((e: { description: string }) => e.description.startsWith('Påminnelse hanterad'))).toBe(true);

    await agent.delete(`/contract-alerts/ack/${done.body.id}`).expect(204);
    after = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    expect(after.some((a) => a.key === r.key)).toBe(true);

    await agent.post('/contract-alerts/ack').send({ ...body, action: 'snooze', snoozeUntil: now }).expect(400);
    await agent.post('/contract-alerts/ack').send({ ...body, action: 'snooze', snoozeUntil: addDays(now, 3) }).expect(201);
    after = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    expect(after.some((a) => a.key === r.key)).toBe(false);
  });

  it('visar kalender och datum per avtal', async () => {
    const cal = (await agent.get(`/contract-alerts/calendar?from=${now}&to=${addDays(now, 400)}`).expect(200)).body as Alert[];
    expect(cal.map((a) => a.kind)).toEqual(expect.arrayContaining(['notice_deadline', 'index', 'renegotiate', 'security_expiry']));
    expect(cal.find((a) => a.kind === 'renegotiate')!.ack).toMatchObject({ action: 'snooze' });
    await agent.get(`/contract-alerts/calendar?from=${now}&to=${addDays(now, 1000)}`).expect(400);
    const one = (await agent.get(`/contract-alerts/contract/${commercial}`).expect(200)).body as Alert[];
    expect(one.every((a) => a.contractId === commercial)).toBe(true);
    expect(one.map((a) => a.kind)).toContain('notice_deadline');
    const ics = await agent.get('/contract-alerts/calendar.ics').buffer(true).expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(String(ics.text ?? ics.body)).toContain('BEGIN:VEVENT');
  });

  it('räknar säkerheter som ska lämnas och KPI-uppräkning som gjorts', async () => {
    await agent.post(`/contracts/${residential}/deposits`).send({ kind: 'deposit', amount: 18000, dueDate: addDays(now, -3) }).expect(201);
    const list = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    const dep = list.find((a) => a.kind === 'deposit_due')!;
    expect(dep).toMatchObject({ overdue: true, severity: 'high' });
    expect(dep.message).toContain('skulle ha lämnats');
  });

  it('styr framförhållningen per bolag', async () => {
    const s = (await agent.get('/contract-alerts/settings').expect(200)).body;
    expect(s).toMatchObject({ noticeDays: 120, indexDays: 60, digestEnabled: false });
    expect(s.users.some((u: { id: string }) => u.id === userId)).toBe(true);
    const days = Math.round((Date.parse(deadline) - Date.parse(now)) / 86400000);
    await agent
      .put('/contract-alerts/settings')
      .send({ ...s, noticeDays: Math.max(1, days - 5), users: undefined, lastDigestAt: undefined, lastDigestNote: undefined, recipientIds: [] })
      .expect(200);
    const list = (await agent.get('/contract-alerts').expect(200)).body as Alert[];
    expect(list.some((a) => a.kind === 'notice_deadline')).toBe(false);
  });

  it('skickar e-postsammanfattning till valda mottagare', async () => {
    await agent.post('/contract-alerts/digest/send').send({}).expect(400); // ingen mottagare än
    const s = (await agent.get('/contract-alerts/settings').expect(200)).body;
    const saved = await agent
      .put('/contract-alerts/settings')
      .send({
        noticeDays: 120,
        endingDays: s.endingDays,
        renegotiateDays: s.renegotiateDays,
        indexDays: s.indexDays,
        rentChangeDays: s.rentChangeDays,
        securityDays: s.securityDays,
        digestEnabled: true,
        digestFrequency: 'daily',
        digestWeekday: 1,
        recipientIds: [userId],
      })
      .expect(200);
    expect(saved.body.users.find((u: { id: string }) => u.id === userId).selected).toBe(true);

    const r = await agent.post('/contract-alerts/digest/send').send({}).expect(201);
    expect(r.body).toMatchObject({ recipients: 1, test: 1 });
    const files = readdirSync(outbox).filter((f) => f.startsWith('avtalsbevakning-'));
    expect(files).toHaveLength(1);
    const mail = readFileSync(join(outbox, files[0]), 'utf8');
    expect(mail).toContain('Avtalsbevakning');

    // Schemalagt utskick: en gång per dag
    const { runDueDigests } = await import('../src/contracts/alert-digest');
    const at = new Date(`${stockholmNow().date}T12:00:00+01:00`);
    expect(await runDueDigests(() => undefined, at)).toBe(1);
    expect(await runDueDigests(() => undefined, at)).toBe(0);
    const after = (await agent.get('/contract-alerts/settings').expect(200)).body;
    expect(after.lastDigestNote).toContain('Skickat till 1 av 1');
  });

  it('visar inget från andra bolag och kräver valt bolag för ändringar', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    expect((await agent.get('/contract-alerts').expect(200)).body).toHaveLength(0);
    const list = (await agent.get(`/contract-alerts/calendar?from=${now}&to=${addDays(now, 400)}`).expect(200)).body;
    expect(list).toHaveLength(0);
    await agent
      .post('/contract-alerts/ack')
      .send({ key: `renegotiate:${residential}:${now}`, contractId: residential, kind: 'renegotiate', date: now, action: 'done' })
      .expect(404);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});
