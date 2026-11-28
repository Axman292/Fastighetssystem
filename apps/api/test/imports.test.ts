import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, startApp } from './helpers';
import { bilplatser, bostader, FakeApartment, lokaler, sieFile } from './fixtures/dinhyresvard';

/**
 * Importcentralen är klar när en hel export från DinHyresvärd kan läsas in,
 * kontrolleras, testas, importeras skarpt, köras om utan dubbletter, och ångras.
 */
let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let company: string;

const CO = 'P Dahlqvist Förvaltning AB';
const base: FakeApartment[] = [
  // Ett blockavtal: samma hyresgäst och startdatum för två lägenheter, hela hyran står på första raden
  { nr: '20001', address: 'Testgatan 1 A LGH 11, 223 52 Lund', rent: 8000, property: 'Testgården 1', company: CO, tenant: 'Testhotellet AB', email: 'hotell@example.se', start: '2025-07-01', contractRent: 18000 },
  { nr: '20002', address: 'Testgatan 1 A LGH 12, 223 52 Lund', rent: 10000, property: 'Testgården 1', company: CO, tenant: 'Testhotellet AB', email: 'hotell@example.se', start: '2025-07-01', contractRent: 0 },
  // Privatperson med medhyresgäst
  { nr: '20003', address: 'Testgatan 1 B LGH 13, 223 52 Lund', rent: 9000, property: 'Testgården 1', company: CO, tenant: 'Anna Testsson', tenantId: '19121212-1212', email: 'anna@example.se', cotenant: 'Bertil Testsson', start: '2024-02-01', contractRent: 9000 },
  // Avslutat avtal, objektet vakant nu
  { nr: '20004', address: 'Testgatan 1 B LGH 14, 223 52 Lund', rent: 7000, property: 'Testgården 1', company: CO, tenant: 'Cecilia Testdotter', tenantId: '197001011236', start: '2020-01-01', end: '2025-12-31', contractRent: 7000 },
  // Tillhör ett annat bolag
  { nr: '29999', address: 'Annangatan 1, 211 11 Malmö', rent: 5000, property: 'Annanstans 2', company: 'Annat Bolag AB', tenant: 'Någon', start: '2025-01-01' },
];

async function files() {
  return {
    bostader: await bostader(base),
    lokaler: await lokaler([
      { nr: 'T-LOK1', address: 'Testgatan 1, 223 52 Lund', size: 120, type: 'Restaurang', rent: 10000, year: 120000, yearVat: 150000 },
      { nr: 'T-LOK2', address: 'Okändvägen 9, 211 11 Malmö', size: 50, type: 'Kontor', rent: 4000, year: 48000, yearVat: 48000 },
    ]),
    bilplatser: await bilplatser([{ nr: 'T-P1', address: 'Testgatan 1, 223 52 Lund', place: 'P-Plats 1', rent: 500 }]),
  };
}

async function newBatch(sourceSystem = 'dinhyresvard', name = 'Migrering DinHyresvärd') {
  const res = await agent.post('/imports').send({ name, sourceSystem }).expect(201);
  return res.body.id as string;
}

async function rows(batch: string, entity: string) {
  return (await agent.get(`/imports/${batch}/rows?entity=${entity}`).expect(200)).body.rows as any[];
}

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_import'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  company = me.body.companies.find((c: { companyName: string }) => c.companyName === CO).companyId;
  await agent.post('/auth/switch-company').send({ companyId: company }).expect(200);
});

afterAll(async () => stop());

describe('importcentral, DinHyresvärd', () => {
  let batch: string;

  it('läser in exporterna och känner igen bostäder, lokaler och bilplatser', async () => {
    batch = await newBatch();
    const f = await files();
    const up = await agent
      .post(`/imports/${batch}/files`)
      .attach('files', f.bostader, 'Bostäder.xlsx')
      .attach('files', f.lokaler, 'Lokaler.xlsx')
      .attach('files', f.bilplatser, 'Bilplatser.xlsx')
      .expect(200);
    expect(up.body.files.map((x: any) => x.tables[0].label)).toEqual([
      'Bostäder med hyresgäster och kontrakt (DinHyresvärd)',
      'Lokaler (DinHyresvärd)',
      'Bilplatser (DinHyresvärd)',
    ]);
    // Samma fil två gånger i samma import läses inte in igen
    const again = await agent.post(`/imports/${batch}/files`).attach('files', f.bilplatser, 'Bilplatser.xlsx').expect(200);
    expect(again.body.files[0].duplicate).toBe(true);
  });

  it('kontrollerar posterna: annat bolag, saknad fastighet, blockavtal och medhyresgäst', async () => {
    const v = (await agent.post(`/imports/${batch}/validate`).expect(200)).body;
    expect(v.perEntity.property).toMatchObject({ new: 1, skipped: 1 });
    expect(v.perEntity.object).toMatchObject({ new: 6, error: 1, skipped: 1 });
    expect(v.perEntity.customer).toMatchObject({ new: 3, skipped: 1 });
    expect(v.perEntity.contract).toMatchObject({ new: 3, skipped: 1 });
    expect(v.perEntity.cotenant).toMatchObject({ new: 1 });

    const objs = await rows(batch, 'object');
    const lok2 = objs.find((o) => o.label === 'Objekt T-LOK2');
    expect(lok2.status).toBe('error');
    expect(lok2.issues[0].message).toMatch(/Välj vilken fastighet/);
    const lok1 = objs.find((o) => o.label === 'Objekt T-LOK1');
    expect(lok1.data).toMatchObject({ type: 'restaurant', vatLiable: true, monthlyRent: 1_000_000, rentFrom: '2026-11-01' });
    expect(lok1.issues.some((i: any) => /efter adressen/.test(i.message))).toBe(true);

    const contracts = await rows(batch, 'contract');
    const block = contracts.find((c) => c.label.includes('Testhotellet'));
    expect(block.data.status).toBe('active');
    const ended = contracts.find((c) => c.label.includes('Cecilia'));
    expect(ended.data.status).toBe('terminated');
  });

  it('kräver att fel rättas innan skarp import, och rättelsen är ett beslut som sparas', async () => {
    await agent.post(`/imports/${batch}/test`).expect(200);
    const blocked = await agent.post(`/imports/${batch}/commit`);
    expect(blocked.status).toBe(400);

    const props = (await agent.get(`/imports/${batch}`).expect(200)).body.properties;
    expect(props).toHaveLength(0); // fastigheten finns bara i filen ännu
    const lok2 = (await rows(batch, 'object')).find((o) => o.label === 'Objekt T-LOK2');
    await agent.put(`/imports/${batch}/rows/${lok2.id}/decision`).send({ skip: true }).expect(200);
    const v = (await agent.get(`/imports/${batch}`).expect(200)).body.validation;
    expect(v.perEntity.object).toMatchObject({ new: 6, error: 0, skipped: 2 });
  });

  it('testimport sparar ingenting men visar avstämningen', async () => {
    const t = (await agent.post(`/imports/${batch}/test`).expect(200)).body;
    expect(t.ok).toBe(true);
    expect(t.result.created).toMatchObject({ property: 1, object: 6, customer: 3, contract: 3, cotenant: 1 });
    expect(t.reconciliation.batch).toMatchObject({ properties: 1, objects: 6, customers: 3, activeContracts: 2, endedContracts: 1 });
    // 8000 + 10000 + 9000 kr i aktiva avtal
    expect(t.reconciliation.batch.monthlyRentOre).toBe(2_700_000);
    expect((await agent.get('/properties').expect(200)).body).toHaveLength(0);
  });

  it('skarp import skapar fastighet, objekt, hyresgäster och avtal', async () => {
    const c = (await agent.post(`/imports/${batch}/commit`).expect(200)).body;
    expect(c.result.created).toMatchObject({ property: 1, object: 6, customer: 3, contract: 3 });
    const list = (await agent.get('/contracts').expect(200)).body;
    expect(list).toHaveLength(3);
    const block = list.find((k: any) => k.customerName === 'Testhotellet AB');
    expect(block.objects).toContain('20001');
    expect(block.objects).toContain('20002');
    expect(block.monthlyOre).toBe(1_800_000);
    const customers = (await agent.get('/customers').expect(200)).body;
    const anna = customers.find((x: any) => x.name === 'Anna Testsson');
    expect(anna).toMatchObject({ kind: 'person', nationalId: '19121212-1212' });
    const annaFull = (await agent.get(`/customers/${anna.id}`).expect(200)).body;
    expect(annaFull.contacts[0]).toMatchObject({ name: 'Bertil Testsson', role: 'Medhyresgäst' });
    expect(customers.find((x: any) => x.name === 'Testhotellet AB').kind).toBe('organization');

    const rec = (await agent.get(`/imports/${batch}/reconciliation`).expect(200)).body;
    const objCmp = rec.comparison.find((x: any) => x.key === 'objects');
    expect(objCmp).toMatchObject({ imported: 6, system: 6 });
    // En genomförd import kan inte ändras
    await agent.post(`/imports/${batch}/validate`).expect(409);
  });

  it('samma filer igen ger inga dubbletter', async () => {
    const copy = (await agent.post(`/imports/${batch}/copy`).expect(200)).body.id;
    const v = (await agent.post(`/imports/${copy}/validate`).expect(200)).body;
    expect(v.totals.new).toBe(0);
    expect(v.perEntity.object.unchanged).toBe(6);
    expect(v.perEntity.contract.unchanged).toBe(3);
    expect(v.perEntity.customer.unchanged).toBe(3);
  });

  it('ändrad hyra skrivs bara över efter godkännande, och kan ångras', async () => {
    const b2 = await newBatch('dinhyresvard', 'Ny hyra');
    const changed = base.map((r) => (r.nr === '20001' ? { ...r, rent: 8500 } : r));
    await agent.post(`/imports/${b2}/files`).attach('files', await bostader(changed), 'Bostäder.xlsx').expect(200);
    const v = (await agent.post(`/imports/${b2}/validate`).expect(200)).body;
    expect(v.perEntity.object.update).toBe(1);
    const obj = (await rows(b2, 'object')).find((o) => o.label === 'Objekt 20001');
    expect(obj.changes).toEqual([{ field: 'monthlyRent', label: 'Månadshyra', current: 800000, incoming: 850000 }]);

    // Utan godkännande: ingenting skrivs över
    await agent.post(`/imports/${b2}/test`).expect(200);
    const t = (await agent.post(`/imports/${b2}/test`).expect(200)).body;
    expect(t.result.updated.object).toBeUndefined();

    await agent.put(`/imports/${b2}/rows/${obj.id}/decision`).send({ approveUpdate: true }).expect(200);
    const t2 = (await agent.post(`/imports/${b2}/test`).expect(200)).body;
    expect(t2.result.updated.object).toBe(1);
    await agent.post(`/imports/${b2}/commit`).expect(200);
    const o = (await agent.get(`/objects/${obj.targetId}`).expect(200)).body;
    expect(o.prices.map((p: any) => [p.monthlyRentOre, p.validFrom, p.validTo])).toEqual([
      [850000, '2026-11-01', null],
    ]);

    const rb = (await agent.post(`/imports/${b2}/rollback`).expect(200)).body;
    expect(rb.restored).toBeGreaterThan(0);
    const o2 = (await agent.get(`/objects/${obj.targetId}`).expect(200)).body;
    expect(o2.prices.map((p: any) => p.monthlyRentOre)).toEqual([800000]);
  });

  it('ångring stoppas om importerade poster har ändrats efteråt', async () => {
    const customers = (await agent.get('/customers').expect(200)).body;
    const anna = customers.find((x: any) => x.name === 'Anna Testsson');
    const full = (await agent.get(`/customers/${anna.id}`).expect(200)).body;
    await new Promise((r) => setTimeout(r, 1100));
    await agent
      .patch(`/customers/${anna.id}`)
      .send({ kind: 'person', name: 'Anna Testsson', nationalId: full.nationalId, email: 'ny@example.se' })
      .expect(200);
    const res = await agent.post(`/imports/${batch}/rollback`).expect(409);
    expect(res.body.blockers[0]).toMatch(/customer .* har ändrats/);
    expect((await agent.get('/contracts').expect(200)).body).toHaveLength(3);
  });

  it('hela importen kan ångras när inget har ändrats', async () => {
    // Återställ kunden till importens värden: ändringen ovan blockerar annars
    const b3 = await newBatch('dinhyresvard', 'Ångras direkt');
    await agent
      .post(`/imports/${b3}/files`)
      .attach('files', await bostader([{ nr: '30001', address: 'Nygatan 2, 223 52 Lund', rent: 6000, property: 'Nyhuset 3', company: CO, tenant: 'Dan Testberg', tenantId: '198001011232', start: '2026-01-01', contractRent: 6000 }]), 'b.xlsx')
      .expect(200);
    await agent.post(`/imports/${b3}/validate`).expect(200);
    await agent.post(`/imports/${b3}/test`).expect(200);
    await agent.post(`/imports/${b3}/commit`).expect(200);
    expect((await agent.get('/contracts').expect(200)).body).toHaveLength(4);
    const rb = (await agent.post(`/imports/${b3}/rollback`).expect(200)).body;
    expect(rb.deleted).toBeGreaterThan(5);
    expect((await agent.get('/contracts').expect(200)).body).toHaveLength(3);
    expect((await agent.get('/properties').expect(200)).body.map((p: any) => p.name)).toEqual(['Testgården 1']);
    const events = (await agent.get(`/imports/${b3}/events`).expect(200)).body.map((e: any) => e.kind);
    expect(events).toEqual(['rolled_back', 'committed', 'tested', 'validated', 'file_added', 'created']);
  });
});

describe('importcentral, andra format', () => {
  it('läser kontoplan och verifikationer från SIE 4 (CP437)', async () => {
    const b = await newBatch('generic', 'Bokföring');
    const up = (await agent.post(`/imports/${b}/files`).attach('files', sieFile(), 'bokforing.se').expect(200)).body;
    expect(up.files[0].format).toBe('sie');
    const v = (await agent.post(`/imports/${b}/validate`).expect(200)).body;
    // Bolaget har redan BAS-standardkonton (fas 6). Två av kontona i filen finns och kopplas, tre är nya.
    expect(v.perEntity.account.total).toBe(5);
    // 1930, 1510, 3010 och 3011 finns redan i bolagets kontoplan (FastBAS)
    expect(v.perEntity.account.new).toBe(1);
    expect(v.perEntity.voucher.new).toBe(2);
    const acc = await rows(b, 'account');
    expect(acc.map((a) => a.label)).toContain('1930 Företagskonto');
    await agent.post(`/imports/${b}/test`).expect(200);
    const c = (await agent.post(`/imports/${b}/commit`).expect(200)).body;
    expect(c.result.created).toMatchObject({ account: 1, voucher: 2 });
  });

  it('läser hyresgäster från CSV i Windows-1252 med semikolon', async () => {
    const b = await newBatch('generic', 'Kunder CSV');
    const csv = 'Kundnummer;Namn;Personnummer;E-post;Adress;Postnummer;Ort\r\nK1;Örjan Åkesson;19121212-1212;orjan@example.se;Gränden 1;111 22;Växjö\r\nK2;Felaktig Person;123;;;;\r\n';
    const buf = Buffer.from([...csv].map((c) => ({ Ö: 0xd6, Å: 0xc5, ä: 0xe4, å: 0xe5, ö: 0xf6 })[c] ?? c.charCodeAt(0)));
    await agent.post(`/imports/${b}/files`).attach('files', buf, 'kunder.csv').expect(200);
    const v = (await agent.post(`/imports/${b}/validate`).expect(200)).body;
    expect(v.perEntity.customer).toMatchObject({ total: 2 });
    const cs = await rows(b, 'customer');
    // Anna Testsson har samma personnummer och finns redan: kopplas, inte dubblett
    const orjan = cs.find((c) => c.label === 'Örjan Åkesson');
    expect(orjan.status).toBe('update');
    expect(orjan.changes.map((c: any) => c.field)).toContain('name');
    const fel = cs.find((c) => c.label === 'Felaktig Person');
    expect(fel.issues.map((i: any) => i.message).join(' ')).toMatch(/Ogiltigt person/);
  });

  it('sparar PDF-bilagor och kopplar dem till avtal efter objektsnumret i filnamnet', async () => {
    const b = await newBatch('dinhyresvard', 'Bilagor');
    const pdf = Buffer.from('%PDF-1.4\n%påhittad\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF');
    await agent.post(`/imports/${b}/files`).attach('files', pdf, 'Hyresavtal 20003.pdf').attach('files', Buffer.from('%PDF-1.4 x'), 'Okänt.pdf').expect(200);
    await agent.post(`/imports/${b}/validate`).expect(200);
    const docs = await rows(b, 'document');
    expect(docs.find((d) => d.label === 'Hyresavtal 20003.pdf').issues[0].message).toMatch(/Kopplas till avtal \d+ \(objekt 20003\)/);
    expect(docs.find((d) => d.label === 'Okänt.pdf').issues[0].level).toBe('warning');
    await agent.post(`/imports/${b}/test`).expect(200);
    const c = (await agent.post(`/imports/${b}/commit`).expect(200)).body;
    expect(c.result.created.document).toBe(2);
  });

  it('läser kundreskontra och betalningar, med rätt saldo, och kan ångra utfärdade fakturor', async () => {
    const b = await newBatch('dinhyresvard', 'Kundreskontra');
    const reskontra =
      'Fakturanummer;Kund;Fakturadatum;Förfallodatum;OCR;Belopp;Moms;Restbelopp;Objekt\n' +
      '70001;Testhotellet AB;2026-10-01;2026-10-31;7000107;18000;0;0;20001\n' +
      '70002;Testhotellet AB;2026-11-01;2026-11-30;7000206;18000;0;18000;20001\n' +
      '70003;19121212-1212;2026-11-01;2026-11-30;7000305;9000;0;4000;20003\n';
    const betalningar = 'Betaldatum;Belopp;Fakturanummer;Betalare\n2026-11-15;5000;70003;Anna Testsson\n';
    await agent
      .post(`/imports/${b}/files`)
      .attach('files', Buffer.from(reskontra), 'kundreskontra.csv')
      .attach('files', Buffer.from(betalningar), 'betalningar.csv')
      .expect(200);
    const v = (await agent.post(`/imports/${b}/validate`).expect(200)).body;
    expect(v.perEntity.invoice).toMatchObject({ new: 3, error: 0 });
    expect(v.perEntity.payment).toMatchObject({ new: 1, error: 0 });
    expect(v.perEntity.customer).toBeUndefined();
    const t = (await agent.post(`/imports/${b}/test`).expect(200)).body;
    expect(t.result.errors).toEqual([]);
    // 70002 helt obetald (18 000) och 70003 delvis betald (4 000 kvar)
    expect(t.reconciliation.batch).toMatchObject({ unpaidInvoices: 2, receivablesOre: 2_200_000 });
    await agent.post(`/imports/${b}/commit`).expect(200);
    const rb = await agent.post(`/imports/${b}/rollback`);
    expect(rb.status).toBe(200);
    const again = (await agent.post(`/imports/${(await agent.post(`/imports/${b}/copy`).expect(200)).body.id}/validate`).expect(200)).body;
    expect(again.perEntity.invoice.new).toBe(3);
  });

  it('kräver behörighet och valt bolag', async () => {
    await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
    await agent.post('/imports').send({ name: 'x', sourceSystem: 'generic' }).expect(403);
    await agent.post('/auth/switch-company').send({ companyId: company }).expect(200);
  });
});
