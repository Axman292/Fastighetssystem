import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLimits } from '../src/auth/rate-limit';
import { formTicket, looksLikeSpam, suggestedDueDate, ticketProblem } from '../src/work-orders/work-orders';
import { login, startApp } from './helpers';

/**
 * Felanmälan och ärenden är klara när en hyresgäst kan anmäla ett fel via
 * fastighetens länk utan att logga in (med spamskydd och bilder), när ärendet
 * kopplas till hyresgästen och går att följa, när förvaltaren kan sätta status,
 * prioritet, ansvarig och hantverkare, skicka arbetsordern och få den kvitterad,
 * när leverantörsfakturor kan kopplas som kostnad och när GDPR-gallringen tar
 * bort anmälarens uppgifter.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let outbox: string;
let dbUrl: string;
let companyA: string;
const id: Record<string, string> = {};
let formToken = '';

const pub = () => request(app.getHttpServer());
const oldTicket = (token: string) => formTicket(token, Date.now() - 10_000);
const mails = () => readdirSync(outbox).map((f) => readFileSync(join(outbox, f), 'utf8'));

beforeAll(async () => {
  process.env.APP_SECRET_KEY = 'test-hemlighet-for-felanmalan';
  outbox = mkdtempSync(join(tmpdir(), 'utkorg-arenden-'));
  process.env.OUTBOX_DIR = outbox;
  delete process.env.SMTP_HOST;
  delete process.env.BREVO_API_KEY;
  ({ app, stop } = await startApp('fastighet_test_arenden'));
  dbUrl = process.env.DATABASE_URL!;
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  id.admin = me.body.user.id;
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential', addressLine: 'Kvarngatan 4' }).expect(201);
  id.property = p.body.id;
  for (const [key, nr] of [['apt1', '1001'], ['apt2', '1002']]) {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', objectNr: nr, type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 }).expect(201);
    id[key] = r.body.id;
  }
  const c = await agent
    .post('/customers')
    .send({ kind: 'person', name: 'Anna Testsson', email: 'anna@example.se', phone: '070-174 06 01', nationalId: '191212121212', deliveryMethod: 'email', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
    .expect(201);
  id.anna = c.body.id;
  const k = await agent.post('/contracts').send({ type: 'residential', customerId: id.anna, startDate: '2026-01-01', objectIds: [id.apt1] }).expect(201);
  await agent.post(`/contracts/${k.body.id}/activate`).send({}).expect(201);
  const s = await agent.post('/suppliers').send({ name: 'Rörfirman Exempel AB', email: 'ror@example.se', phone: '040-123 45' }).expect(201);
  id.supplier = s.body.id;
});

afterAll(async () => {
  await stop();
});

describe('regler utan databas', () => {
  it('föreslår klart-datum efter prioritet', () => {
    expect(suggestedDueDate('urgent', '2026-11-28')).toBe('2026-11-29');
    expect(suggestedDueDate('normal', '2026-11-28')).toBe('2026-12-12');
  });

  it('kräver en giltig biljett som är minst några sekunder gammal', () => {
    const t = 'abcdefghijklmnopqrstuvwx';
    expect(ticketProblem(t, formTicket(t))).toMatch(/för fort/);
    expect(ticketProblem(t, formTicket(t, Date.now() - 5000))).toBeNull();
    expect(ticketProblem(t, formTicket('annannyckelannannyckel', Date.now() - 5000))).toMatch(/gammalt/);
    expect(ticketProblem(t, formTicket(t, Date.now() - 2 * 86_400_000))).toMatch(/gammalt/);
    expect(ticketProblem(t, 'skräp')).toMatch(/gammalt/);
    expect(looksLikeSpam('köp här http://a http://b www.c')).toBe(true);
    expect(looksLikeSpam('Kranen droppar i köket')).toBe(false);
  });
});

describe('felanmälningsformuläret', () => {
  it('skapas per fastighet och syns utan inloggning', async () => {
    await agent.put('/work-orders/settings').send({ notifyEmails: 'forvaltning@example.se', confirmReporter: true, formIntro: 'Vid akuta fel, ring jouren.' }).expect(200);
    await agent.put(`/work-orders/forms/${id.property}`).send({ enabled: true, defaultAssigneeUserId: id.admin }).expect(200);
    const forms = (await agent.get('/work-orders/forms').expect(200)).body;
    const f = forms.find((x: { propertyId: string }) => x.propertyId === id.property);
    expect(f.enabled).toBe(true);
    expect(f.url).toMatch(/\/felanmalan\/[A-Za-z0-9_-]{20,}$/);
    formToken = f.token;

    const r = await pub().get(`/public/fault-forms/${formToken}`).expect(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.property.name).toBe('Kvarnen');
    expect(r.body.intro).toBe('Vid akuta fel, ring jouren.');
    expect(r.body.objects.map((o: { objectNr: string }) => o.objectNr)).toEqual(['1001', '1002']);
    // Inga hyresgäster eller personuppgifter i svaret
    expect(JSON.stringify(r.body)).not.toMatch(/Anna/);
    await pub().get('/public/fault-forms/finnsinteeeeeeeeeeeeeeeeee').expect(404);

    const qr = await agent.get(`/work-orders/forms/${id.property}/qr`).expect(200);
    expect(qr.headers['content-type']).toBe('image/png');
  });

  it('stoppar robotar, för snabba svar och skräppost', async () => {
    const base = { title: 'Kranen droppar', name: 'Anna Testsson', email: 'anna@example.se', category: 'plumbing' };
    // Dolt fält ifyllt: svarar ok men sparar inget
    const bot = await pub().post(`/public/fault-forms/${formToken}`).send({ ...base, ticket: oldTicket(formToken), website: 'http://spam' }).expect(201);
    expect(bot.body.orderNr).toBeNull();
    const fast = await pub().post(`/public/fault-forms/${formToken}`).send({ ...base, ticket: formTicket(formToken) }).expect(400);
    expect(fast.body.message).toMatch(/för fort/);
    await pub().post(`/public/fault-forms/${formToken}`).send({ ...base, ticket: 'x.y' }).expect(400);
    const noContact = await pub().post(`/public/fault-forms/${formToken}`).send({ title: 'Kranen', name: 'Anna', ticket: oldTicket(formToken) }).expect(400);
    expect(noContact.body.fields[0].message).toMatch(/e-post eller telefon/);
    const list = (await agent.get('/work-orders?status=all').expect(200)).body;
    expect(list).toHaveLength(0);
  });

  it('tar emot en anmälan med bild, kopplar hyresgästen och skickar besked', async () => {
    clearLimits();
    const r = await pub()
      .post(`/public/fault-forms/${formToken}`)
      .field('ticket', oldTicket(formToken))
      .field('objectId', id.apt1)
      .field('category', 'plumbing')
      .field('title', 'Kranen i köket droppar')
      .field('description', 'Det droppar hela tiden, även när kranen är stängd.')
      .field('location', 'Kök')
      .field('name', 'Anna Testsson')
      .field('email', 'Anna@Example.se')
      .field('phone', '070-174 06 01')
      .field('masterKeyOk', 'true')
      .attach('photos', PNG, { filename: 'kran.png', contentType: 'image/png' })
      .attach('photos', Buffer.from('inte en bild'), { filename: 'virus.exe', contentType: 'application/octet-stream' })
      .expect(201);
    expect(r.body.orderNr).toBe(1);
    expect(r.body.statusUrl).toMatch(/\/felanmalan\/arende\//);
    id.reporterToken = r.body.publicToken;

    const list = (await agent.get('/work-orders').expect(200)).body;
    expect(list).toHaveLength(1);
    id.wo = list[0].id;
    const d = (await agent.get(`/work-orders/${id.wo}`).expect(200)).body;
    expect(d).toMatchObject({
      source: 'form',
      status: 'new',
      priority: 'normal',
      objectNr: '1001',
      customerName: 'Anna Testsson',
      reporterEmail: 'anna@example.se',
      masterKeyOk: true,
      assigneeUserId: id.admin,
    });
    expect(d.photos).toHaveLength(1); // exe-filen sparas inte
    const img = await agent.get(`/work-orders/${id.wo}/photos/${d.photos[0].id}`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');

    const all = mails().join('\n');
    expect(all).toMatch(/To: forvaltning@example.se/);
    expect(all).toMatch(/Subject: =\?UTF-8\?Q\?Ny_felanm=C3=A4lan_1/);
    expect(all).toMatch(/To: anna@example.se/);
    expect(d.events.filter((e: { kind: string }) => e.kind === 'email').length).toBeGreaterThanOrEqual(2);
  });

  it('begränsar antalet anmälningar per IP-adress', async () => {
    clearLimits();
    for (let i = 0; i < 5; i++) {
      await pub().post(`/public/fault-forms/${formToken}`).send({ title: `Lampa ${i} trasig`, name: 'Bo', phone: '0701740602', ticket: oldTicket(formToken) }).expect(201);
    }
    await pub().post(`/public/fault-forms/${formToken}`).send({ title: 'Lampa igen', name: 'Bo', phone: '0701740602', ticket: oldTicket(formToken) }).expect(429);
    clearLimits();
    // De extra ärendena makuleras så att listan blir lätt att läsa
    for (const w of (await agent.get('/work-orders').expect(200)).body.filter((x: { title: string }) => x.title.startsWith('Lampa'))) {
      await agent.post(`/work-orders/${w.id}/status`).send({ status: 'cancelled', notifyReporter: false }).expect(201);
    }
  });

  it('stängs av och slutar då ta emot anmälningar', async () => {
    await agent.put(`/work-orders/forms/${id.property}`).send({ enabled: false }).expect(200);
    expect((await pub().get(`/public/fault-forms/${formToken}`).expect(200)).body.enabled).toBe(false);
    await pub().post(`/public/fault-forms/${formToken}`).send({ title: 'Test', name: 'Bo', phone: '0701740602', ticket: oldTicket(formToken) }).expect(403);
    await agent.put(`/work-orders/forms/${id.property}`).send({ enabled: true }).expect(200);
  });
});

describe('handläggning', () => {
  it('registrerar ärenden manuellt med förslag på klart-datum', async () => {
    const r = await agent.post('/work-orders').send({ propertyId: id.property, objectId: id.apt2, title: 'Ytterdörren går inte att låsa', category: 'lock', priority: 'urgent', source: 'phone' }).expect(201);
    const d = (await agent.get(`/work-orders/${r.body.id}`).expect(200)).body;
    expect(d.dueDate).toBe(suggestedDueDate('urgent', new Date().toISOString().slice(0, 10)));
    expect(d.assigneeUserId).toBe(id.admin);
    // Objekt i en annan fastighet godtas inte
    const p2 = await agent.post('/properties').send({ name: 'Annan', designation: 'Malmö Annan 1', category: 'residential' }).expect(201);
    await agent.post('/work-orders').send({ propertyId: p2.body.id, objectId: id.apt1, title: 'Fel' }).expect(400);
    // Akuta ärenden först
    const list = (await agent.get('/work-orders').expect(200)).body;
    expect(list[0].priority).toBe('urgent');
    const sum = (await agent.get('/work-orders/summary').expect(200)).body;
    expect(sum).toMatchObject({ new: 2, open: 2, urgent: 1 });
    // Kortet på startsidan
    const dash = (await agent.get('/dashboard').expect(200)).body;
    expect(dash.extras.find((e: { key: string }) => e.key === 'fault-reports')).toMatchObject({ value: '2', href: '/arenden', tone: 'bad' });
  });

  it('ändrar prioritet och hantverkare och loggar det', async () => {
    const d = (await agent.put(`/work-orders/${id.wo}`).send({ priority: 'high', supplierId: id.supplier, costEstimate: 2500, scheduledDate: '2026-12-02' }).expect(200)).body;
    expect(d.priority).toBe('high');
    expect(d.supplierName).toBe('Rörfirman Exempel AB');
    expect(d.costEstimateOre).toBe(250000);
    const kinds = d.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['priority', 'supplier', 'updated']));
  });

  it('skickar arbetsordern till hantverkaren med bilden och en kvitteringslänk', async () => {
    const before = mails().length;
    const d = (await agent.post(`/work-orders/${id.wo}/send-to-supplier`).send({ message: 'Ring Anna innan ni kommer.' }).expect(201)).body;
    expect(d.status).toBe('assigned');
    expect(d.supplierToken).toBeTruthy();
    expect(d.supplierUrl).toMatch(/\/arbetsorder\//);
    id.supplierToken = d.supplierToken;
    const m = mails();
    expect(m.length).toBe(before + 1);
    const mail = m.find((x) => /To: ror@example.se/.test(x))!;
    expect(mail).toMatch(/kran\.png/);
    expect(mail).toMatch(/huvudnyckel/);

    const v = (await pub().get(`/public/work-orders/${id.supplierToken}`).expect(200)).body;
    expect(v).toMatchObject({ orderNr: 1, objectNr: '1001', contactName: 'Anna Testsson', masterKeyOk: true, location: 'Kök' });
    expect(v.events.some((e: { body: string }) => e.body === 'Ring Anna innan ni kommer.')).toBe(true);
    await pub().get(`/public/work-orders/${id.supplierToken}/photos/${v.photos[0].id}`).expect(200);
    // En hantverkare utan e-post kan inte få arbetsordern
    const s2 = await agent.post('/suppliers').send({ name: 'Utan Mejl AB' }).expect(201);
    const other = (await agent.get('/work-orders').expect(200)).body.find((x: { id: string }) => x.id !== id.wo);
    await agent.put(`/work-orders/${other.id}`).send({ supplierId: s2.body.id }).expect(200);
    const err = await agent.post(`/work-orders/${other.id}/send-to-supplier`).send({}).expect(400);
    expect(err.body.message).toMatch(/ingen e-postadress/);
  });

  it('hantverkaren kvitterar arbetet som utfört med en bild', async () => {
    const r = await pub()
      .post(`/public/work-orders/${id.supplierToken}/report`)
      .field('action', 'done')
      .field('body', 'Bytt packning i blandaren.')
      .field('name', 'Kalle Rörsson')
      .attach('photos', PNG, { filename: 'efter.png', contentType: 'image/png' })
      .expect(201);
    expect(r.body.status).toBe('done');
    const d = (await agent.get(`/work-orders/${id.wo}`).expect(200)).body;
    expect(d.status).toBe('done');
    expect(d.doneAt).toBeTruthy();
    expect(d.photos).toHaveLength(2);
    expect(d.events.some((e: { kind: string; author: string }) => e.kind === 'supplier_report' && e.author === 'Kalle Rörsson')).toBe(true);
  });

  it('anmälaren ser status och meddelanden till sig, men inte interna kommentarer', async () => {
    await agent.post(`/work-orders/${id.wo}/comments`).send({ body: 'Intern: fakturera inte hyresgästen', visibility: 'internal' }).expect(201);
    const before = mails().length;
    await agent.post(`/work-orders/${id.wo}/comments`).send({ body: 'Hantverkaren har bytt packningen.', visibility: 'reporter' }).expect(201);
    expect(mails().length).toBe(before + 1);
    const v = (await pub().get(`/public/fault-reports/${id.reporterToken}`).expect(200)).body;
    expect(v.statusLabel).toBe('Åtgärdad');
    const text = JSON.stringify(v);
    expect(text).toMatch(/bytt packningen/);
    expect(text).not.toMatch(/Intern/);
    expect(text).not.toMatch(/Kalle/);
    expect(text).not.toMatch(/ror@example/);
    const w = (await pub().post(`/public/fault-reports/${id.reporterToken}/messages`).send({ body: 'Tack, nu fungerar det!' }).expect(201)).body;
    expect(w.events.at(-1)).toMatchObject({ kind: 'you', body: 'Tack, nu fungerar det!' });
    await pub().get('/public/fault-reports/finnsinteeeeeeeeeeeeeeeeeeee').expect(404);
  });

  it('kopplar leverantörsfakturor som kostnad', async () => {
    const si = await agent
      .post('/supplier-invoices')
      .send({
        supplierId: id.supplier,
        invoiceNr: 'R-77',
        invoiceDate: new Date().toISOString().slice(0, 10),
        net: 1800,
        vat: 450,
        lines: [{ accountNumber: '5170', propertyId: id.property, objectId: id.apt1, net: 1800, vat: 450 }],
      })
      .expect(201);
    const cand = (await agent.get(`/work-orders/${id.wo}/cost-candidates`).expect(200)).body;
    expect(cand[0]).toMatchObject({ id: si.body.id, sameSupplier: true, sameProperty: true });
    const d = (await agent.post(`/work-orders/${id.wo}/costs`).send({ supplierInvoiceId: si.body.id }).expect(201)).body;
    expect(d.costs).toHaveLength(1);
    expect(d.costs[0].netOre).toBe(180000);
    const list = (await agent.get('/work-orders?status=all').expect(200)).body;
    expect(list.find((x: { id: string }) => x.id === id.wo).costOre).toBe(180000);
    const linked = (await agent.get(`/work-orders/by-supplier-invoice/${si.body.id}`).expect(200)).body;
    expect(linked[0].orderNr).toBe(1);
    const removed = (await agent.delete(`/work-orders/${id.wo}/costs/${d.costs[0].id}`).expect(200)).body;
    expect(removed.costs).toHaveLength(0);
    await agent.post(`/work-orders/${id.wo}/costs`).send({ supplierInvoiceId: si.body.id }).expect(201);
  });

  it('avslutas och spärrar då nya meddelanden', async () => {
    const d = (await agent.post(`/work-orders/${id.wo}/status`).send({ status: 'closed', resolution: 'Packning bytt' }).expect(201)).body;
    expect(d.status).toBe('closed');
    expect(d.closedAt).toBeTruthy();
    await pub().post(`/public/fault-reports/${id.reporterToken}/messages`).send({ body: 'Hej' }).expect(400);
    await pub().post(`/public/work-orders/${id.supplierToken}/report`).send({ action: 'comment', body: 'Hej' }).expect(400);
  });

  it('objekt med ärenden kan inte tas bort', async () => {
    const r = await agent.delete(`/objects/${id.apt2}`).expect(409);
    expect(r.body.message).toMatch(/felanmälningar/);
  });

  it('är skyddat per bolag', async () => {
    const me = await agent.get('/auth/me').expect(200);
    const other = me.body.companies.find((c: { companyId: string }) => c.companyId !== companyA).companyId;
    await agent.post('/auth/switch-company').send({ companyId: other }).expect(200);
    expect((await agent.get('/work-orders?status=all').expect(200)).body).toHaveLength(0);
    await agent.get(`/work-orders/${id.wo}`).expect(404);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});

describe('dataskydd', () => {
  it('rensar anmälarens uppgifter på avslutade ärenden utan hyresgäst efter lagringstiden', async () => {
    const sql = new Client({ connectionString: dbUrl });
    await sql.connect();
    await sql.query(`update work_order set closed_at = now() - interval '3 years', updated_at = now() - interval '3 years' where status = 'cancelled'`);
    await sql.query(`alter table work_order disable trigger work_order_stamp`);
    await sql.query(`update work_order set updated_at = now() - interval '3 years' where status = 'cancelled'`);
    await sql.query(`alter table work_order enable trigger work_order_stamp`);
    const p = (await agent.get('/gdpr/preview').expect(200)).body;
    expect(p.workOrders).toBe(5);
    await agent.post('/gdpr/run').expect(200);
    const left = (await sql.query(`select count(*)::int as n from work_order where status = 'cancelled' and (reporter_name is not null or reporter_phone is not null or reporter_ip is not null)`)).rows[0].n;
    expect(left).toBe(0);
    const audit = (await sql.query(`select count(*)::int as n from audit_log where table_name = 'work_order' and after::text like '%0701740602%'`)).rows[0].n;
    expect(audit).toBe(0);
    await sql.end();
  });

  it('tar med felanmälningar i registerutdraget', async () => {
    const json = (await agent.get(`/gdpr/customers/${id.anna}/extract.json`).expect(200)).body;
    expect(json.workOrders[0]).toMatchObject({ orderNr: 1, reporterEmail: 'anna@example.se' });
  });
});
