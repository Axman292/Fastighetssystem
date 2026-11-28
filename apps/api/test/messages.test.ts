import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { merge, unknownFields } from '../src/messages/messages';
import { normalizePhone, smsAllowlistBlock, smsParts, smsSender } from '../src/messages/sms';
import { login, startApp } from './helpers';

/**
 * Utskick till hyresgäster: e-post och SMS till alla eller ett urval,
 * med kopplingsfält, förhandsgranskning och logg per hyresgäst.
 */

describe('hjälpfunktioner', () => {
  it('tolkar svenska och utländska telefonnummer', () => {
    expect(normalizePhone('070-123 45 67')).toEqual({ e164: '+46701234567', mobile: true });
    expect(normalizePhone('+46 (0)70 123 45 67')).toEqual({ e164: '+46701234567', mobile: true });
    expect(normalizePhone('0046701234567')?.e164).toBe('+46701234567');
    expect(normalizePhone('040-12 34 56')).toEqual({ e164: '+4640123456', mobile: false });
    expect(normalizePhone('+4520123456')).toEqual({ e164: '+4520123456', mobile: true });
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('räknar SMS-delar', () => {
    expect(smsParts('Hej')).toMatchObject({ parts: 1, unicode: false });
    expect(smsParts('å'.repeat(160)).parts).toBe(1);
    expect(smsParts('a'.repeat(161)).parts).toBe(2);
    expect(smsParts('Hej 😀')).toMatchObject({ parts: 1, unicode: true, perPart: 70 });
  });

  it('gör ett giltigt avsändarnamn', () => {
    expect(smsSender('Fastighet AB Hemporten K')).toBe('FastighetHe');
    expect(smsSender('Ö')).toBe('Hyresvard');
  });

  it('kopplingsfält fylls i och okända fält hittas', () => {
    expect(merge('Hej {namn} i { Fastighet }, {okänt}', { namn: 'Anna', fastighet: 'Kornet' })).toBe('Hej Anna i Kornet, {okänt}');
    expect(unknownFields('Hej {namn} {lägenhet} {okänt} {datum}')).toEqual(['okänt']);
  });

  it('spärrlistan för SMS i testmiljön', () => {
    const saved = { ...process.env };
    process.env.EMAIL_ALLOWLIST_ONLY = 'true';
    process.env.SMS_ALLOWLIST = '070-111 22 33';
    expect(smsAllowlistBlock('+46701112233')).toBeNull();
    expect(smsAllowlistBlock('+46709999999')).toMatch(/Inte skickat/);
    process.env = saved;
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let propA: string;
let propB: string;
const cust: Record<string, string> = {};
let outbox: string;

const content = {
  sendEmail: true,
  sendSms: true,
  subject: 'Vattnet stängs av i {fastighet}',
  body: 'Hej {förnamn}!\nVattnet stängs av i {fastighet} ({adress}, lgh {lägenhet}).\n{bolag}',
  smsBody: 'Hej {namn}, vattnet i {fastighet} stängs av i morgon.',
};

beforeAll(async () => {
  outbox = mkdtempSync(join(tmpdir(), 'utskick-'));
  process.env.OUTBOX_DIR = outbox;
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMS_PROVIDER', 'EMAIL_ALLOWLIST_ONLY']) delete process.env[k];
  ({ app, stop } = await startApp('fastighet_test_utskick'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  propA = (await agent.post('/properties').send({ name: 'Kornet', designation: 'Malmö Kornet 6', category: 'mixed', addressLine: 'Kornvägen 6' }).expect(201)).body.id;
  propB = (await agent.post('/properties').send({ name: 'Ugglan', designation: 'Malmö Ugglan 11', category: 'residential' }).expect(201)).body.id;
  const obj = async (propertyId: string, body: Record<string, unknown>) =>
    (await agent.post('/objects').send({ propertyId, rentValidFrom: '2024-01-01', monthlyRent: 5000, ...body }).expect(201)).body.id;
  const a1 = await obj(propA, { objectNr: '1001', type: 'apartment', apartmentNr: '1102', addressLine: 'Kornvägen 6A' });
  const a2 = await obj(propA, { objectNr: '1002', type: 'apartment' });
  const shop = await obj(propA, { objectNr: 'L01', type: 'commercial', vatLiable: true });
  const b1 = await obj(propB, { objectNr: '2001', type: 'apartment' });
  const b2 = await obj(propB, { objectNr: '2002', type: 'apartment' });

  const mk = async (key: string, body: Record<string, unknown>) => {
    cust[key] = (await agent.post('/customers').send({ kind: 'person', deliveryMethod: 'post', ...body }).expect(201)).body.id;
  };
  await mk('anna', { name: 'Anna Andersson', nationalId: '191212121212', email: 'anna@example.se', phone: '070-123 45 67' });
  await mk('bertil', { name: 'Bertil Berg', nationalId: '198112189876', phone: '040-12 34 56' });
  await mk('cecilia', { name: 'Cecilia Carlsson', nationalId: '196408233234', email: 'cecilia@example.se' });
  await mk('david', { name: 'David Dahl', email: 'david@example.se', phone: '0739876543' });
  cust.butik = (await agent.post('/customers').send({ kind: 'organization', name: 'Butiken AB', nationalId: '5590000039', email: 'info@butiken.se', deliveryMethod: 'email' }).expect(201)).body.id;
  await agent.post(`/customers/${cust.butik}/contacts`).send({ name: 'Eva Ek', email: 'eva@butiken.se', phone: '0761112233' }).expect(201);

  const contract = async (body: Record<string, unknown>) => {
    const id = (await agent.post('/contracts').send(body).expect(201)).body.id;
    await agent.post(`/contracts/${id}/activate`).send({}).expect(201);
  };
  await contract({ type: 'residential', customerId: cust.anna, startDate: '2025-01-01', objectIds: [a1] });
  await contract({ type: 'residential', customerId: cust.bertil, startDate: '2025-01-01', objectIds: [a2] });
  await contract({ type: 'commercial', customerId: cust.butik, startDate: '2025-01-01', objectIds: [shop] });
  await contract({ type: 'residential', customerId: cust.cecilia, startDate: '2025-01-01', objectIds: [b1] });
  await contract({ type: 'residential', customerId: cust.david, startDate: '2099-01-01', objectIds: [b2] });
});

afterAll(async () => stop());

describe('urval och förhandsgranskning', () => {
  it('nuvarande hyresgäster i en fastighet med ifyllda kopplingsfält', async () => {
    const r = await agent.post('/messages/preview').send({ criteria: { propertyIds: [propA] }, content }).expect(200);
    const names = r.body.recipients.map((x: { name: string }) => x.name);
    expect(names).toEqual(['Anna Andersson', 'Bertil Berg', 'Butiken AB']);
    const anna = r.body.recipients[0];
    expect(anna.subject).toBe('Vattnet stängs av i Kornet');
    expect(anna.body).toBe('Hej Anna!\nVattnet stängs av i Kornet (Kornvägen 6A, lgh 1102).\nFastighet AB Hemporten K');
    expect(anna.deliveries).toEqual([
      expect.objectContaining({ channel: 'email', recipient: 'anna@example.se', skip: null }),
      expect.objectContaining({ channel: 'sms', recipient: '+46701234567', skip: null }),
    ]);
    const bertil = r.body.recipients[1];
    expect(bertil.deliveries.map((d: { skip: string }) => d.skip)).toEqual(['Saknar e-postadress', 'Inte ett mobilnummer']);
    expect(r.body.summary).toMatchObject({ tenants: 3, emails: 2, sms: 1, missingEmail: 1, missingSms: 2 });
    expect(r.body.config.sms).toBe('test');
  });

  it('filtrerar på objekttyp, avtalstyp och kommande avtal', async () => {
    const types = await agent.post('/messages/preview').send({ criteria: { objectTypes: ['commercial'] }, content }).expect(200);
    expect(types.body.recipients.map((x: { name: string }) => x.name)).toEqual(['Butiken AB']);
    const res = await agent.post('/messages/preview').send({ criteria: { contractTypes: ['residential'] }, content }).expect(200);
    expect(res.body.recipients.map((x: { name: string }) => x.name)).toEqual(['Anna Andersson', 'Bertil Berg', 'Cecilia Carlsson']);
    const upcoming = await agent.post('/messages/preview').send({ criteria: { contractStatuses: ['upcoming'] }, content }).expect(200);
    expect(upcoming.body.recipients.map((x: { name: string }) => x.name)).toEqual(['David Dahl']);
  });

  it('kontaktpersoner kan tas med', async () => {
    const r = await agent
      .post('/messages/preview')
      .send({ criteria: { objectTypes: ['commercial'], includeContacts: true }, content })
      .expect(200);
    const d = r.body.recipients[0].deliveries.map((x: { channel: string; recipient: string }) => `${x.channel}:${x.recipient}`);
    expect(d).toEqual(['email:info@butiken.se', 'email:eva@butiken.se', 'sms:+46761112233']);
  });

  it('säger till om okända kopplingsfält och saknad text', async () => {
    await agent
      .post('/messages')
      .send({ name: 'Fel', criteria: {}, content: { ...content, body: 'Hej {kundnr}', smsBody: '' } })
      .expect(400)
      .expect((r) => {
        const msgs = r.body.fields.map((f: { message: string }) => f.message);
        expect(msgs).toContain('Okänt kopplingsfält: {kundnr}');
        expect(msgs).toContain('Skriv SMS-texten');
      });
  });
});

describe('utskick', () => {
  let id: string;

  it('skickar till urvalet utom bortvalda och loggar varje mottagare', async () => {
    const r = await agent
      .post('/messages')
      .send({ name: 'Vattenavstängning Kornet', criteria: { propertyIds: [propA] }, content, excludeCustomerIds: [cust.butik] })
      .expect(201);
    id = r.body.id;
    expect(r.body.campaignNr).toBe(1);
    const d = await agent.get(`/messages/${id}`).expect(200);
    expect(d.body).toMatchObject({ status: 'done', recipientCount: 2, test: 2, skipped: 2, queued: 0, failed: 0 });
    const rows = d.body.recipients.map((x: { customerName: string; channel: string; status: string }) => [x.customerName, x.channel, x.status]);
    expect(rows).toEqual([
      ['Anna Andersson', 'email', 'test'],
      ['Anna Andersson', 'sms', 'test'],
      ['Bertil Berg', 'email', 'skipped'],
      ['Bertil Berg', 'sms', 'skipped'],
    ]);
    const files = readdirSync(outbox).filter((f) => f.startsWith(`utskick-${id}`));
    expect(files.filter((f) => f.endsWith('.eml'))).toHaveLength(1);
    const sms = files.find((f) => f.endsWith('.sms.txt'))!;
    expect(readFileSync(join(outbox, sms), 'utf8')).toContain('Hej Anna Andersson, vattnet i Kornet stängs av i morgon.');
  });

  it('syns i listan och i hyresgästens logg', async () => {
    const list = await agent.get('/messages').expect(200);
    expect(list.body[0]).toMatchObject({ name: 'Vattenavstängning Kornet', emails: 1, sms: 1 });
    const log = await agent.get(`/messages/customer/${cust.anna}`).expect(200);
    expect(log.body.map((x: { channel: string; campaignName: string }) => [x.channel, x.campaignName])).toEqual([
      ['email', 'Vattenavstängning Kornet'],
      ['sms', 'Vattenavstängning Kornet'],
    ]);
    expect((await agent.get(`/messages/customer/${cust.butik}`).expect(200)).body).toEqual([]);
  });

  it('misslyckade skickas igen', async () => {
    process.env.SMS_PROVIDER = '46elks';
    process.env.ELKS_API_USERNAME = 'u';
    process.env.ELKS_API_PASSWORD = 'p';
    const fetchMock = vi.fn(async () => new Response('fel', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await agent
      .post('/messages')
      .send({ name: 'SMS', criteria: { propertyIds: [propA] }, content: { ...content, sendEmail: false } })
      .expect(201);
    let d = await agent.get(`/messages/${r.body.id}`).expect(200);
    expect(d.body.failed).toBe(1);
    expect(d.body.recipients.find((x: { status: string }) => x.status === 'failed').note).toMatch(/46elks svarade 500/);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await agent.post(`/messages/${r.body.id}/retry`).expect(200);
    d = await agent.get(`/messages/${r.body.id}`).expect(200);
    expect(d.body).toMatchObject({ failed: 0, sent: 1 });
    const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.46elks.com/a1/sms');
    expect(String(call[1].body)).toContain('to=%2B46701234567');
    vi.unstubAllGlobals();
    delete process.env.SMS_PROVIDER;
  });

  it('provutskick till mig själv', async () => {
    const r = await agent.post('/messages/test').send({ criteria: {}, content: { ...content, sendSms: false } }).expect(200);
    expect(r.body.result).toEqual([expect.objectContaining({ channel: 'email', to: 'admin@example.se', status: 'test' })]);
  });
});

describe('mallar', () => {
  it('inbyggda och egna mallar', async () => {
    const t = await agent.post('/messages/templates').send({ name: 'Sophämtning', subject: 'Ny tid', body: 'Hej {namn}', smsBody: '' }).expect(201);
    const list = await agent.get('/messages/templates').expect(200);
    expect(list.body.builtIn.map((x: { name: string }) => x.name)).toContain('Vattenavstängning');
    expect(list.body.own.map((x: { name: string }) => x.name)).toEqual(['Sophämtning']);
    await agent.patch(`/messages/templates/${t.body.id}`).send({ name: 'Sophämtning', subject: 'Ny tid', body: 'Hej', smsBody: 'x', active: false }).expect(200);
    await agent.delete(`/messages/templates/${t.body.id}`).expect(204);
    expect((await agent.get('/messages/templates').expect(200)).body.own).toEqual([]);
  });
});
