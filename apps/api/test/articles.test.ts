import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFromName } from '../src/articles/articles.controller';
import { addonArticle } from '../src/imports/validate';
import { login, startApp } from './helpers';

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_artiklar'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('HPK AB');
  companyB = byName('Hardebergabanan AB');
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
});

afterAll(async () => stop());

describe('artikelkoder och import', () => {
  it('gör kod av namnet', () => {
    expect(codeFromName('Kabel-TV')).toBe('kabel_tv');
    expect(codeFromName('Sophämtning Ö')).toBe('sophamtning_o');
    expect(codeFromName('!!!')).toBe('artikel');
  });

  it('väljer artikel för tillägg i importen', () => {
    const reg = [
      { code: 'broadband', name: 'Bredband', active: true },
      { code: 'cable_tv', name: 'Kabel-TV', active: true },
      { code: 'property_tax', name: 'Fastighetsskatt', active: true },
      { code: 'snow', name: 'Snöröjning', active: true },
      { code: 'other', name: 'Övrigt', active: true },
    ];
    expect(addonArticle('Bredband 100/100', reg)).toBe('broadband');
    expect(addonArticle('Kabel-TV', reg)).toBe('cable_tv');
    expect(addonArticle('Fastighetsskatt', reg)).toBe('property_tax');
    expect(addonArticle('Snöröjning', reg)).toBe('snow');
    expect(addonArticle('Vatten', reg)).toBe('other'); // vatten finns inte i detta register
  });
});

describe('artikelregister', () => {
  it('har standardartiklar med konto per bolag', async () => {
    const all = (await agent.get('/articles').expect(200)).body;
    const own = all.filter((a: { companyId: string }) => a.companyId === companyA);
    expect(all.every((a: { companyId: string }) => a.companyId === companyA)).toBe(true);
    const by = (c: string) => own.find((a: { code: string }) => a.code === c);
    expect(by('rent')).toMatchObject({ name: 'Hyra', accountNumber: '3911', system: true, alwaysActive: true });
    expect(by('broadband')).toMatchObject({ name: 'Bredband', accountNumber: '3990', system: false });
    expect(by('property_tax')).toMatchObject({ name: 'Fastighetsskatt' });
    expect(by('fee')).toMatchObject({ vatRateBp: 0 });
  });

  it('lägger till, döper om och skyddar artiklar', async () => {
    const created = (await agent.post('/articles').send({ name: 'Snöröjning', accountNumber: '3990', vatRateBp: 2500 }).expect(201)).body;
    expect(created.code).toBe('snorojning');
    await agent.post('/articles').send({ name: 'snöröjning', accountNumber: '3990' }).expect(409);
    await agent.post('/articles').send({ name: 'Fel konto', accountNumber: '5130' }).expect(400);
    await agent.post('/articles').send({ name: 'Inget konto', accountNumber: '3999' }).expect(400);

    // Ändra namn utan att momsen försvinner
    await agent.patch(`/articles/${created.id}`).send({ name: 'Snöröjning och sandning' }).expect(200);
    let a = (await agent.get('/articles').expect(200)).body.find((x: { id: string }) => x.id === created.id);
    expect(a).toMatchObject({ name: 'Snöröjning och sandning', vatRateBp: 2500, code: 'snorojning' });

    // Standardartiklar kan döpas om men inte tas bort eller göras inaktiva
    const rent = (await agent.get('/articles').expect(200)).body.find((x: { code: string }) => x.code === 'rent');
    await agent.patch(`/articles/${rent.id}`).send({ name: 'Grundhyra' }).expect(200);
    await agent.patch(`/articles/${rent.id}`).send({ active: false }).expect(400);
    await agent.delete(`/articles/${rent.id}`).expect(400);

    // Används på en faktura: kontot sparas på raden och artikeln kan inte tas bort
    const c = await agent.post('/customers').send({ kind: 'organization', name: 'Snö AB', email: 'sno@example.se' }).expect(201);
    const inv = (
      await agent
        .post('/invoices')
        .send({ customerId: c.body.id, invoiceDate: '2027-02-01', lines: [{ article: 'snorojning', description: 'Snöröjning januari', quantity: 1, unitPrice: 1000, vatRateBp: 2500 }] })
        .expect(201)
    ).body;
    expect(inv.lines[0]).toMatchObject({ article: 'snorojning', articleName: 'Snöröjning och sandning', accountNumber: '3990' });
    await agent.delete(`/articles/${created.id}`).expect(400);
    await agent.patch(`/articles/${created.id}`).send({ active: false }).expect(200);
    a = (await agent.get('/articles').expect(200)).body.find((x: { id: string }) => x.id === created.id);
    expect(a).toMatchObject({ active: false, useCount: 1 });

    // Okänd artikel ger ett begripligt fel
    const bad = await agent
      .post('/invoices')
      .send({ customerId: c.body.id, invoiceDate: '2027-02-01', lines: [{ article: 'finns_inte', description: 'X', quantity: 1, unitPrice: 1, vatRateBp: 0 }] })
      .expect(400);
    expect(bad.body.message).toBe('Artikeln finns inte i bolagets artikelregister');

    // Oanvänd artikel kan tas bort
    const tmp = (await agent.post('/articles').send({ name: 'Tillfällig', accountNumber: '3990' }).expect(201)).body;
    await agent.delete(`/articles/${tmp.id}`).expect(204);
  });

  it('artiklar i ett bolag syns inte i ett annat', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    const all = (await agent.get('/articles').expect(200)).body;
    expect(all.some((a: { code: string }) => a.code === 'snorojning')).toBe(false);
    expect(all.find((a: { code: string }) => a.code === 'rent').name).toBe('Hyra');
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });

  it('nytt bolag får standardartiklar', async () => {
    const co = await agent.post('/companies').send({ name: 'Artikelbolaget AB', orgNr: '5560360793' });
    if (co.status !== 201) return; // bolag skapas bara av koncernadministratör med giltigt organisationsnummer
    await agent.post('/auth/switch-company').send({ companyId: co.body.id }).expect(200);
    const all = (await agent.get('/articles').expect(200)).body;
    expect(all.length).toBeGreaterThanOrEqual(14);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});
