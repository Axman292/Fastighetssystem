import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultReportGroup } from '../src/economy/report-groups';
import { normalizeBankgiro } from '../src/suppliers/suppliers.controller';
import { supplierInvoiceVerification } from '../src/suppliers/supplier-invoices.controller';
import { login, startApp } from './helpers';

/**
 * Fas 6 är klar när leverantörer och deras fakturor kan registreras, konteras på fastighet,
 * attesteras och betalas utan dubbelregistrering, och när varje fastighet har en resultaträkning
 * med driftnetto, direktavkastning, vakansgrad, kr/m² och budget mot utfall.
 */

describe('utan databas', () => {
  it('kontrollerar bankgiro', () => {
    expect(normalizeBankgiro('5050-1055')).toBe('5050-1055');
    expect(normalizeBankgiro('50501055')).toBe('5050-1055');
    expect(normalizeBankgiro('5050-1056')).toBeNull();
  });

  it('lägger konton i rätt rapportgrupp', () => {
    expect(defaultReportGroup('3911')).toBe('rent_income');
    expect(defaultReportGroup('3010')).toBe('rent_income');
    expect(defaultReportGroup('3100')).toBe('rent_income');
    expect(defaultReportGroup('3110')).toBe('other_income');
    expect(defaultReportGroup('3540')).toBe('other_income');
    expect(defaultReportGroup('3001')).toBe('none');
    expect(defaultReportGroup('5130')).toBe('operating');
    expect(defaultReportGroup('5170')).toBe('maintenance');
    expect(defaultReportGroup('5191')).toBe('property_tax');
    expect(defaultReportGroup('6310')).toBe('insurance');
    expect(defaultReportGroup('6530')).toBe('admin');
    expect(defaultReportGroup('8410')).toBe('interest');
    expect(defaultReportGroup('1110')).toBe('investment');
    expect(defaultReportGroup('2440')).toBe('none');
  });

  it('gör ett balanserat bokföringsunderlag där ej avdragsgill moms blir kostnad', () => {
    const v = supplierInvoiceVerification({ totalOre: 18_700, roundingOre: -50 }, [
      { accountNumber: '5170', accountName: null, netOre: 10_000, vatOre: 2_500, vatDeductible: true, propertyName: 'A', costCenter: null, description: null },
      { accountNumber: '5130', accountName: null, netOre: 5_000, vatOre: 1_250, vatDeductible: false, propertyName: 'B', costCenter: null, description: null },
    ]);
    const debit = v.reduce((s, r) => s + r.debitOre, 0);
    const credit = v.reduce((s, r) => s + r.creditOre, 0);
    expect(debit).toBe(credit);
    expect(v.find((r) => r.account === '5130')?.debitOre).toBe(6_250);
    expect(v.find((r) => r.account === '2640')?.debitOre).toBe(2_500);
    expect(v.find((r) => r.account === '3740')?.creditOre).toBe(50);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let db: Client;
let companyA: string;
let companyB: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_fas6'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  companyB = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighets AB Hardebergabanan').companyId;
  await agent.patch(`/companies/${companyA}`).send({ bankgiro: '5050-1055', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential' }).expect(201);
  id.prop = p.body.id;
  for (const [key, nr] of [['apt1', '1001'], ['apt2', '1002']]) {
    const r = await agent.post('/objects').send({ propertyId: id.prop, rentValidFrom: '2024-01-01', objectNr: nr, type: 'apartment', areaM2: 50, rooms: 2, monthlyRent: 10000 }).expect(201);
    id[key] = r.body.id;
  }
  const c = await agent
    .post('/customers')
    .send({ kind: 'person', name: 'Anna Testsson', email: 'anna@example.se', deliveryMethod: 'email', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
    .expect(201);
  const k = await agent.post('/contracts').send({ type: 'residential', customerId: c.body.id, startDate: '2026-12-01', objectIds: [id.apt1] }).expect(201);
  await agent.post(`/contracts/${k.body.id}/activate`).send({}).expect(201);
  const run = await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-10' }).expect(201);
  const detail = await agent.get(`/billing-runs/${run.body.id}`).expect(200);
  await agent.post(`/billing-runs/${run.body.id}/approve`).send({ fingerprint: detail.body.fingerprint, acknowledgeWarnings: true }).expect(201);

  await agent.post(`/properties/${id.prop}/tax-assessments`).send({ assessmentYear: 2027, propertyTaxOre: 3650 }).expect(201);
  await agent.post(`/properties/${id.prop}/valuations`).send({ valuationDate: '2026-12-31', valueSek: 4_000_000 }).expect(201);
});

afterAll(async () => {
  await db?.end();
  await stop?.();
});

describe('kontoplan och leverantörer', () => {
  it('har BAS-konton för fastighetsbolag i varje bolag, även nya', async () => {
    const r = await agent.get('/accounts').expect(200);
    const numbers = r.body.map((a: { number: string }) => a.number);
    expect(numbers).toEqual(expect.arrayContaining(['2440', '2640', '5130', '5170', '5191', '8410']));
    expect(r.body.find((a: { number: string }) => a.number === '5170').reportGroup).toBe('maintenance');
    const n = await db.query(`select count(*)::int as n from account a join company c on c.id = a.company_id where c.name = 'Fastighets AB Hardebergabanan'`);
    expect(n.rows[0].n).toBeGreaterThan(20);
  });

  it('kan lägga till konton och ändra rapportgrupp', async () => {
    const a = await agent.post('/accounts').send({ number: '5150', name: 'Snöröjning' }).expect(201);
    await agent.patch(`/accounts/${a.body.id}`).send({ reportGroup: 'maintenance' }).expect(200);
    const r = await agent.get('/accounts').expect(200);
    expect(r.body.find((x: { number: string }) => x.number === '5150').reportGroup).toBe('maintenance');
    await agent.patch(`/accounts/${a.body.id}`).send({ reportGroup: null }).expect(200);
    await agent.post('/accounts').send({ number: '5150', name: 'Dubblett' }).expect(409);
  });

  it('registrerar leverantörer med löpnummer och kontrollerade uppgifter', async () => {
    await agent.post('/suppliers').send({ name: 'Fel AB', bankgiro: '5050-1056' }).expect(400);
    await agent.post('/suppliers').send({ name: 'Fel AB', defaultAccount: '9999' }).expect(400);
    const s = await agent.post('/suppliers').send({ name: 'Malmö Energi AB', bankgiro: '50501055', paymentTermsDays: 20, defaultAccount: '5130' }).expect(201);
    id.energy = s.body.id;
    expect(s.body.supplierNr).toBe(101);
    const b = await agent.post('/suppliers').send({ name: 'Byggfirman Exempel AB' }).expect(201);
    id.builder = b.body.id;
    expect(b.body.supplierNr).toBe(102);
    const one = await agent.get(`/suppliers/${id.energy}`).expect(200);
    expect(one.body).toMatchObject({ bankgiro: '5050-1055', paymentTermsDays: 20, defaultAccount: '5130' });
  });
});

describe('leverantörsfakturor', () => {
  it('registrerar en faktura med kontering och förfallodag från villkoren', async () => {
    const r = await agent
      .post('/supplier-invoices')
      .send({
        supplierId: id.energy,
        invoiceNr: 'E-1001',
        invoiceDate: '2027-01-15',
        ocr: '1234 5678',
        net: 4000,
        vat: 1000,
        lines: [{ accountNumber: '5130', propertyId: id.prop, net: 3000, vat: 750, vatDeductible: false }],
      })
      .expect(201);
    id.inv1 = r.body.id;
    expect(r.body.entryNr).toBe(1);
    const d = await agent.get(`/supplier-invoices/${id.inv1}`).expect(200);
    expect(d.body).toMatchObject({ dueDate: '2027-02-04', ocr: '12345678', totalOre: 500_000, status: 'registered', fullyCoded: false });
  });

  it('stoppar samma faktura från samma leverantör två gånger', async () => {
    const r = await agent.post('/supplier-invoices').send({ supplierId: id.energy, invoiceNr: 'E-1001', invoiceDate: '2027-01-15', net: 10 }).expect(400);
    expect(r.body.message).toMatch(/redan registrerad/);
  });

  it('kräver att konteringen stämmer innan attest', async () => {
    const r = await agent.post(`/supplier-invoices/${id.inv1}/approve`).expect(400);
    expect(r.body.message).toMatch(/summerar inte/);
    await agent.post(`/supplier-invoices/${id.inv1}/payments`).send({ paidDate: '2027-01-20' }).expect(400);
    await agent
      .put(`/supplier-invoices/${id.inv1}`)
      .send({
        supplierId: id.energy,
        invoiceNr: 'E-1001',
        invoiceDate: '2027-01-15',
        ocr: '12345678',
        net: 4000,
        vat: 1000,
        lines: [
          { accountNumber: '5130', propertyId: id.prop, net: 3000, vat: 750, vatDeductible: false },
          { accountNumber: '5120', objectId: id.apt2, description: 'El trapphus', net: 1000, vat: 250, vatDeductible: false },
        ],
      })
      .expect(200);
    const d = await agent.get(`/supplier-invoices/${id.inv1}`).expect(200);
    expect(d.body.lines[1]).toMatchObject({ propertyId: id.prop, objectNr: '1002' });
    expect(d.body.fullyCoded).toBe(true);
    await agent.post(`/supplier-invoices/${id.inv1}/approve`).expect(201);
  });

  it('låser en attesterad faktura, även direkt i databasen', async () => {
    await agent
      .put(`/supplier-invoices/${id.inv1}`)
      .send({ supplierId: id.energy, invoiceNr: 'E-1001', invoiceDate: '2027-01-15', net: 1, lines: [] })
      .expect(400);
    await agent.delete(`/supplier-invoices/${id.inv1}`).expect(400);
    await expect(db.query('update supplier_invoice set net_ore = 1 where id = $1', [id.inv1])).rejects.toThrow(/attesterad/);
    await expect(db.query('delete from supplier_invoice_line where supplier_invoice_id = $1', [id.inv1])).rejects.toThrow(/attesterad/);
  });

  it('bokföringsunderlaget balanserar och lägger ej avdragsgill moms på kostnaden', async () => {
    const d = await agent.get(`/supplier-invoices/${id.inv1}`).expect(200);
    const v = d.body.verification as { account: string; debitOre: number; creditOre: number }[];
    expect(v.reduce((s, r) => s + r.debitOre - r.creditOre, 0)).toBe(0);
    expect(v.find((r) => r.account === '5130')?.debitOre).toBe(375_000);
    expect(v.find((r) => r.account === '2640')).toBeUndefined();
    expect(v.find((r) => r.account === '2440')?.creditOre).toBe(500_000);
  });

  it('registrerar delbetalning och slutbetalning, men aldrig för mycket', async () => {
    await agent.post(`/supplier-invoices/${id.inv1}/payments`).send({ paidDate: '2027-01-30', amount: 2000 }).expect(201);
    await agent.post(`/supplier-invoices/${id.inv1}/payments`).send({ paidDate: '2027-01-30', amount: 3500 }).expect(400);
    await expect(
      db.query(`insert into supplier_invoice_payment (company_id, supplier_invoice_id, paid_date, amount_ore) values ($1,$2,'2027-01-30',400000)`, [companyA, id.inv1]),
    ).rejects.toThrow(/större än/);
    await agent.post(`/supplier-invoices/${id.inv1}/cancel`).send({ reason: 'Fel' }).expect(400);
    const r = await agent.post(`/supplier-invoices/${id.inv1}/payments`).send({ paidDate: '2027-02-01' }).expect(201);
    expect(r.body.balanceOre).toBe(0);
    const d = await agent.get(`/supplier-invoices/${id.inv1}`).expect(200);
    expect(d.body).toMatchObject({ status: 'paid', paidOre: 500_000, balanceOre: 0 });
    expect(d.body.events.map((e: { event: string }) => e.event)).toEqual(['registered', 'updated', 'approved', 'paid', 'paid']);
    // Ångra den sista betalningen: tillbaka till attesterad
    await agent.delete(`/supplier-invoices/${id.inv1}/payments/${d.body.payments[1].id}`).expect(204);
    expect((await agent.get(`/supplier-invoices/${id.inv1}`)).body.status).toBe('approved');
    await agent.post(`/supplier-invoices/${id.inv1}/payments`).send({ paidDate: '2027-02-01' }).expect(201);
  });

  it('bifogar fakturan som PDF', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% testfaktura\n');
    await agent.post(`/supplier-invoices/${id.inv1}/document`).attach('file', Buffer.from('hej'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
    await agent.post(`/supplier-invoices/${id.inv1}/document`).attach('file', pdf, { filename: 'faktura E-1001.pdf', contentType: 'application/pdf' }).expect(201);
    const r = await agent.get(`/supplier-invoices/${id.inv1}/document`).expect(200);
    expect(r.headers['content-type']).toMatch(/pdf/);
    expect(Buffer.from(r.body).toString()).toContain('testfaktura');
    const d = await agent.get(`/supplier-invoices/${id.inv1}`).expect(200);
    expect(d.body.documentName).toBe('faktura E-1001.pdf');
  });

  it('föreslår kontering från leverantörens senaste faktura', async () => {
    const r = await agent.get(`/suppliers/${id.energy}/suggestion`).expect(200);
    expect(r.body.lines).toHaveLength(2);
    expect(r.body.lines[0]).toMatchObject({ accountNumber: '5130', propertyId: id.prop, share: 0.75, vatDeductible: false });
  });

  it('periodiserar kostnader, makulerar och visar leverantörsreskontra', async () => {
    // Årsavgift för fastighetsskötsel som avser hela 2027, och ett underhåll i januari
    const yearly = await agent
      .post('/supplier-invoices')
      .send({ supplierId: id.builder, invoiceNr: 'B-1', invoiceDate: '2027-01-02', dueDate: '2027-01-31', net: 36500, vat: 0,
              lines: [{ accountNumber: '5193', propertyId: id.prop, net: 36500, periodFrom: '2027-01-01', periodTo: '2027-12-31' }] })
      .expect(201);
    await agent.post(`/supplier-invoices/${yearly.body.id}/approve`).expect(201);
    const repair = await agent
      .post('/supplier-invoices')
      .send({ supplierId: id.builder, invoiceNr: 'B-2', invoiceDate: '2027-01-20', dueDate: '2027-02-10', net: 8000, vat: 2000,
              lines: [{ accountNumber: '5170', propertyId: id.prop, net: 8000, vat: 2000, vatDeductible: false }] })
      .expect(201);
    id.repair = repair.body.id;
    const wrong = await agent.post('/supplier-invoices').send({ supplierId: id.builder, invoiceNr: 'B-3', invoiceDate: '2027-01-21', net: 100, lines: [] }).expect(201);
    await agent.post(`/supplier-invoices/${wrong.body.id}/cancel`).send({ reason: 'Felskickad' }).expect(201);
    await agent.post(`/supplier-invoices/${wrong.body.id}/approve`).expect(400);
    // Kreditfaktura
    await agent.post('/supplier-invoices').send({ supplierId: id.builder, kind: 'credit_note', invoiceNr: 'B-4', invoiceDate: '2027-01-22', net: 100 }).expect(400);
    const credit = await agent
      .post('/supplier-invoices')
      .send({ supplierId: id.builder, kind: 'credit_note', invoiceNr: 'B-4', invoiceDate: '2027-01-22', net: -1000, vat: -250,
              lines: [{ accountNumber: '5170', propertyId: id.prop, net: -1000, vat: -250, vatDeductible: false }] })
      .expect(201);
    await agent.post(`/supplier-invoices/${credit.body.id}/approve`).expect(201);

    const toApprove = await agent.get('/supplier-invoices?status=to_approve').expect(200);
    expect(toApprove.body.map((i: { invoiceNr: string }) => i.invoiceNr)).toEqual(['B-2']);
    const ledger = await agent.get('/supplier-invoices/ledger').expect(200);
    const builder = ledger.body.suppliers.find((s: { supplierId: string }) => s.supplierId === id.builder);
    expect(builder.balanceOre).toBe(3_650_000 + 1_000_000 - 125_000);
    expect(ledger.body.counts.toApprove).toBe(1);
  });

  it('visar inte ett bolags leverantörsfakturor i ett annat bolag', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    expect((await agent.get('/supplier-invoices').expect(200)).body).toHaveLength(0);
    expect((await agent.get('/suppliers').expect(200)).body).toHaveLength(0);
    await agent.post('/supplier-invoices').send({ supplierId: id.energy, invoiceNr: 'X', invoiceDate: '2027-01-01', net: 1 }).expect(400);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});

describe('ekonomisk uppföljning', () => {
  const jan = 'from=2027-01-01&to=2027-01-31';

  it('räknar fram fastighetens resultaträkning för januari', async () => {
    const r = await agent.get(`/economy/properties/${id.prop}?${jan}`).expect(200);
    const g = Object.fromEntries(r.body.statement.map((s: { group: string; valueOre: number }) => [s.group, s.valueOre]));
    // Hyra för lägenhet 1001 i januari
    expect(g.rent_income).toBe(1_000_000);
    // Värme och el inklusive ej avdragsgill moms
    expect(g.operating).toBe(375_000 + 125_000);
    // Underhåll 10 000 kr minus kredit 1 250 kr. Den ej attesterade fakturan räknas med.
    expect(g.maintenance).toBe(1_000_000 - 125_000);
    // Årsavgiften fördelas per dag: 31 av 365 dagar
    expect(g.admin).toBe(310_000);
    // Fastighetsskatt finns inte bokad och beräknas ur taxeringen (3 650 kr per år)
    const tax = r.body.statement.find((s: { group: string }) => s.group === 'property_tax');
    expect(tax).toMatchObject({ actualOre: 0, estimatedOre: 31_000, valueOre: 31_000 });
    const opex = 500_000 + 875_000 + 310_000 + 31_000;
    expect(r.body.kpi.netOperatingOre).toBe(1_000_000 - opex);
    // Halva hyresvärdet är vakant
    expect(r.body.kpi.vacancyRate).toBeCloseTo(0.5, 3);
    expect(r.body.areaM2).toBe(100);
    expect(r.body.kpi.rentPerM2).toBeCloseTo((10_000 * 365) / 31 / 100, 1);
    expect(r.body.kpi.yield).toBeCloseTo(((1_000_000 - opex) * (365 / 31)) / 100 / 4_000_000, 4);
    expect(r.body.monthly).toHaveLength(1);
    expect(r.body.byAccount.map((a: { account: string }) => a.account)).toEqual(['5120', '5130', '5170', '5193']);
  });

  it('jämför budget mot utfall', async () => {
    await agent
      .put(`/economy/properties/${id.prop}/budget/2027`)
      .send({ lines: [{ reportGroup: 'rent_income', amount: 240_000 }, { reportGroup: 'maintenance', amount: 36_500 }] })
      .expect(200);
    const b = await agent.get(`/economy/properties/${id.prop}/budget/2027`).expect(200);
    expect(b.body.find((x: { reportGroup: string }) => x.reportGroup === 'rent_income').amountOre).toBe(24_000_000);
    const r = await agent.get(`/economy/properties/${id.prop}?${jan}`).expect(200);
    const rent = r.body.statement.find((s: { group: string }) => s.group === 'rent_income');
    expect(rent.budgetOre).toBe(Math.round((24_000_000 * 31) / 365));
    expect(r.body.kpi.budgetNetOperatingOre).toBe(Math.round((24_000_000 * 31) / 365) - Math.round((3_650_000 * 31) / 365));
    // Tom rad tar bort budgeten för gruppen
    await agent.put(`/economy/properties/${id.prop}/budget/2027`).send({ lines: [{ reportGroup: 'maintenance', amount: null }] }).expect(200);
    const b2 = await agent.get(`/economy/properties/${id.prop}/budget/2027`).expect(200);
    expect(b2.body.find((x: { reportGroup: string }) => x.reportGroup === 'maintenance').amountOre).toBeNull();
  });

  it('jämför fastigheter och bolag och summerar koncernen', async () => {
    await agent.post('/properties').send({ name: 'Tomten', designation: 'Malmö Tomten 1', category: 'land' }).expect(201);
    await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
    const r = await agent.get(`/economy/overview?${jan}`).expect(200);
    expect(r.body.properties).toHaveLength(2);
    const hpk = r.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K');
    expect(hpk.propertyCount).toBe(2);
    expect(hpk.kpi.incomeOre).toBe(1_000_000);
    expect(r.body.total.kpi.netOperatingOre).toBe(hpk.kpi.netOperatingOre);
    await agent.get('/economy/overview?from=2027-02-01&to=2027-01-01').expect(400);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});
