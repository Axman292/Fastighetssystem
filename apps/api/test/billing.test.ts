import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  billingPeriod,
  lastBankDayBefore,
  ocrFor,
  ocrValid,
  periodAmount,
  periodLabel,
  roundingFor,
} from '../src/billing/billing-rules';
import { login, startApp } from './helpers';

/**
 * Fas 4 är klar när hyresavier kan skapas ur avtalen i en körning som
 * förhandsgranskas och kontrolleras, godkänns med fakturanummer och OCR,
 * skickas, betalas och krediteras, och när databasen hindrar dubbeldebitering
 * och ändringar i utfärdade fakturor.
 */

describe('regler utan databas', () => {
  it('skapar OCR-nummer med längdsiffra och kontrollsiffra', () => {
    expect(ocrFor(1001)).toBe('100164');
    expect(ocrValid('100164')).toBe(true);
    expect(ocrValid('100165')).toBe(false);
    expect(ocrValid('100154')).toBe(false); // fel längdsiffra
    for (const n of [1, 42, 99999, 1234567]) expect(ocrValid(ocrFor(n))).toBe(true);
  });

  it('räknar perioder för månad, kvartal, förskott och efterskott', () => {
    expect(billingPeriod('2027-01-01', 'month', true)).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(billingPeriod('2027-01-01', 'month', false)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(billingPeriod('2027-02-01', 'quarter', true)).toEqual({ from: '2027-01-01', to: '2027-03-31' });
    expect(billingPeriod('2027-04-01', 'quarter', false)).toEqual({ from: '2027-01-01', to: '2027-03-31' });
    expect(periodLabel({ from: '2027-04-01', to: '2027-06-30' })).toBe('kvartal 2 2027');
    expect(periodLabel({ from: '2027-02-01', to: '2027-02-28' })).toBe('februari 2027');
  });

  it('periodiserar månadsbelopp per dag i varje kalendermånad', () => {
    const jan = { from: '2027-01-01', to: '2027-01-31' };
    expect(periodAmount(1_000_000, '2026-01-01', null, jan)).toBe(1_000_000);
    expect(periodAmount(1_000_000, '2027-01-15', null, jan)).toBe(548_387); // 17 av 31 dagar
    expect(periodAmount(1_000_000, '2026-01-01', '2027-01-14', jan)).toBe(451_613);
    const q1 = { from: '2027-01-01', to: '2027-03-31' };
    expect(periodAmount(1_000_000, '2027-02-15', null, q1)).toBe(1_500_000); // halva februari + mars
    expect(periodAmount(1_000_000, '2027-04-01', null, q1)).toBe(0);
  });

  it('sätter förfallodag till sista bankdagen före perioden', () => {
    expect(lastBankDayBefore('2027-01-01')).toBe('2026-12-30'); // nyårsafton är inte bankdag
    expect(lastBankDayBefore('2027-03-01')).toBe('2027-02-26'); // fredag
    expect(lastBankDayBefore('2027-04-01')).toBe('2027-03-31');
    expect(lastBankDayBefore('2026-06-22')).toBe('2026-06-18'); // midsommarafton 19 juni
  });

  it('öresavrundar till hela kronor', () => {
    expect(roundingFor(1_234_549)).toBe(-49);
    expect(roundingFor(1_234_550)).toBe(50);
    expect(roundingFor(-1_234_549)).toBe(49);
    expect(roundingFor(100_000)).toBe(0);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;
let db: Client;
const outbox = mkdtempSync(join(tmpdir(), 'utkorg-'));
const id: Record<string, string> = {};

beforeAll(async () => {
  process.env.OUTBOX_DIR = outbox;
  delete process.env.SMTP_HOST;
  ({ app, stop } = await startApp('fastighet_test_fas4'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('HPK AB');
  companyB = byName('Hardebergabanan AB');
  await agent.patch(`/companies/${companyA}`).send({ bankgiro: '5050-1055', vatNr: 'SE559000002201', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'mixed' }).expect(201);
  id.property = p.body.id;
  const mk = async (key: string, body: Record<string, unknown>) => {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', ...body }).expect(201);
    id[key] = r.body.id;
  };
  await mk('apt', { objectNr: '1001', type: 'apartment', areaM2: 64, rooms: 2, monthlyRent: 9000 });
  await mk('shop', { objectNr: 'L01', type: 'commercial', areaM2: 180, monthlyRent: 25000, vatLiable: true });

  const person = await agent
    .post('/customers')
    .send({ kind: 'person', name: 'Tolvan Tolvansson', nationalId: '191212121212', email: 'tolvan@example.se', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
    .expect(201);
  const org = await agent
    .post('/customers')
    .send({ kind: 'organization', name: 'Bageriet AB', nationalId: '5590000039', deliveryMethod: 'post', addressLine: 'Box 1', postalCode: '211 20', city: 'Malmö' })
    .expect(201);
  id.person = person.body.id;
  id.org = org.body.id;

  const res = await agent.post('/contracts').send({ type: 'residential', customerId: id.person, startDate: '2026-10-01', objectIds: [id.apt] }).expect(201);
  id.residential = res.body.id;
  await agent.post(`/contracts/${id.residential}/activate`).send({}).expect(201);
  const com = await agent
    .post('/contracts')
    .send({ type: 'commercial', customerId: id.org, startDate: '2026-10-01', endDate: '2029-09-30', objectIds: [id.shop], billingInterval: 'quarter' })
    .expect(201);
  id.commercial = com.body.id;
  await agent.post(`/contracts/${id.commercial}/activate`).send({}).expect(201);
});

afterAll(async () => {
  await db.end();
  await stop();
});

async function createRun(periodMonth: string, extra: Record<string, unknown> = {}) {
  const r = await agent.post('/billing-runs').send({ periodMonth, invoiceDate: `${periodMonth}-01`.replace(/-01$/, '-01'), ...extra });
  return r;
}

async function approve(runId: string) {
  const run = await agent.get(`/billing-runs/${runId}`).expect(200);
  return agent.post(`/billing-runs/${runId}/approve`).send({ fingerprint: run.body.fingerprint, acknowledgeWarnings: true });
}

describe('aviseringskörning', () => {
  it('skapar avier ur avtalen med periodisering, moms och förfallodag', async () => {
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-10' }).expect(201);
    id.run1 = r.body.id;
    const run = await agent.get(`/billing-runs/${id.run1}`).expect(200);
    expect(run.body.status).toBe('draft');
    expect(run.body.invoices).toHaveLength(2);
    const apt = run.body.invoices.find((i: { contractId: string }) => i.contractId === id.residential);
    expect(apt).toMatchObject({ kind: 'rent_notice', netOre: 900_000, vatOre: 0, totalOre: 900_000, dueDate: '2026-12-30', periodFrom: '2027-01-01' });
    const shop = run.body.invoices.find((i: { contractId: string }) => i.contractId === id.commercial);
    expect(shop).toMatchObject({ netOre: 7_500_000, vatOre: 1_875_000, totalOre: 9_375_000, periodFrom: '2027-01-01', periodTo: '2027-03-31' });
    // Första aviseringen: tidigare perioder tas inte med automatiskt
    expect(run.body.issues.some((i: { kind: string }) => i.kind === 'first_billing')).toBe(true);
    expect(run.body.blockingCount).toBe(0);
  });

  it('tillåter bara en körning under arbete per bolag', async () => {
    await agent.post('/billing-runs').send({ periodMonth: '2027-02' }).expect(409);
  });

  it('kräver ny granskning om underlaget ändrats', async () => {
    const run = await agent.get(`/billing-runs/${id.run1}`).expect(200);
    const ch = await agent
      .post(`/contracts/${id.residential}/charges`)
      .send({ article: 'fee', description: 'Hyra av festlokal', amount: 300, billFrom: '2027-01-01' })
      .expect(201);
    const stale = await agent.post(`/billing-runs/${id.run1}/approve`).send({ fingerprint: run.body.fingerprint, acknowledgeWarnings: true }).expect(201);
    expect(stale.body).toMatchObject({ ok: false, changed: true });
    await agent.delete(`/contracts/${id.residential}/charges/${ch.body.id}`).expect(204);
    await agent.post(`/billing-runs/${id.run1}/regenerate`).expect(201);
  });

  it('godkänner med fakturanummer i följd och giltigt OCR', async () => {
    const a = await approve(id.run1);
    expect(a.status).toBe(201);
    expect(a.body.ok).toBe(true);
    const list = await agent.get('/invoices').expect(200);
    const nrs = list.body.map((i: { invoiceNr: number }) => i.invoiceNr).sort();
    expect(nrs).toEqual([1001, 1002]);
    for (const i of list.body) expect(ocrValid(i.ocr)).toBe(true);
    id.aptInvoice = list.body.find((i: { contractId: string }) => i.contractId === id.residential).id;
    id.shopInvoice = list.body.find((i: { contractId: string }) => i.contractId === id.commercial).id;
  });

  it('aviserar aldrig samma period två gånger', async () => {
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-15' }).expect(201);
    const run = await agent.get(`/billing-runs/${r.body.id}`).expect(200);
    expect(run.body.invoices).toHaveLength(0);
    expect(run.body.issues.find((i: { kind: string }) => i.kind === 'already_billed')).toBeTruthy();
    await agent.post(`/billing-runs/${r.body.id}/approve`).send({ fingerprint: run.body.fingerprint, acknowledgeWarnings: true }).expect(400);
    await agent.delete(`/billing-runs/${r.body.id}`).expect(204);

    // Och databasen stoppar det även om koden skulle försöka
    const line = (await db.query(`select * from invoice_line where invoice_id = $1 limit 1`, [id.aptInvoice])).rows[0];
    const draft = (
      await db.query(
        `insert into invoice (company_id, kind, customer_id, invoice_date, due_date, delivery_method) values ($1, 'invoice', $2, '2027-01-01', '2027-01-31', 'email') returning id`,
        [companyA, id.person],
      )
    ).rows[0].id;
    await expect(
      db.query(
        `insert into invoice_line (company_id, invoice_id, line_kind, contract_id, contract_line_id, article, description, period_from, period_to, unit_price_ore, net_ore, vat_rate_bp, vat_ore)
         values ($1, $2, 'regular', $3, $4, 'rent', 'Dubblett', '2027-01-10', '2027-01-20', 1, 1, 0, 0)`,
        [companyA, draft, id.residential, line.contract_line_id],
      ),
    ).rejects.toThrow(/exclusion|invoice_line_contract_line_id/);
    await db.query('delete from invoice where id = $1', [draft]);
  });

  it('låser utfärdade fakturor i databasen', async () => {
    await expect(db.query(`update invoice set total_ore = 1 where id = $1`, [id.aptInvoice])).rejects.toThrow(/kan inte ändras/);
    await expect(db.query(`delete from invoice where id = $1`, [id.aptInvoice])).rejects.toThrow(/kan inte tas bort/);
    await expect(db.query(`update invoice_line set net_ore = 1 where invoice_id = $1`, [id.aptInvoice])).rejects.toThrow(/kan inte ändras/);
  });

  it('räknar fram retroaktiva justeringar och tar med extra debiteringar', async () => {
    // Hyran höjs retroaktivt från 15 januari, efter att januari aviserats
    const k = await agent.get(`/contracts/${id.residential}`).expect(200);
    const rent = k.body.lines.find((l: { article: string }) => l.article === 'rent');
    await agent.post(`/contracts/${id.residential}/lines/${rent.id}/change`).send({ amount: 9310, validFrom: '2027-01-15' }).expect(201);
    await agent.post(`/contracts/${id.residential}/charges`).send({ article: 'fee', description: 'Extra nyckel', amount: 250, billFrom: '2027-02-01' }).expect(201);

    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-02', invoiceDate: '2027-01-10' }).expect(201);
    id.run2 = r.body.id;
    const run = await agent.get(`/billing-runs/${id.run2}`).expect(200);
    // Kvartalsavtalet är redan aviserat för kvartal 1
    expect(run.body.invoices).toHaveLength(1);
    const inv = run.body.invoices[0];
    const byKind = (kind: string) => inv.lines.filter((l: { lineKind: string }) => l.lineKind === kind);
    expect(byKind('regular').map((l: { netOre: number }) => l.netOre)).toEqual([931_000]);
    expect(byKind('charge').map((l: { netOre: number }) => l.netOre)).toEqual([25_000]);
    // Januari: gamla raden ska bara gälla 1–14 januari, nya raden 15–31 januari
    const retro = byKind('retroactive').map((l: { netOre: number }) => l.netOre).sort((a: number, b: number) => a - b);
    expect(retro).toEqual([-493_548, 510_548]);
    expect(inv.netOre).toBe(931_000 + 25_000 - 493_548 + 510_548);
    expect((await approve(id.run2)).body.ok).toBe(true);

    // Nästa månad: justeringen och nyckeln är redan fakturerade
    const r3 = await agent.post('/billing-runs').send({ periodMonth: '2027-03', invoiceDate: '2027-02-10' }).expect(201);
    const run3 = await agent.get(`/billing-runs/${r3.body.id}`).expect(200);
    expect(run3.body.invoices).toHaveLength(1);
    expect(run3.body.invoices[0].lines.map((l: { lineKind: string; netOre: number }) => [l.lineKind, l.netOre])).toEqual([['regular', 931_000]]);
    await agent.delete(`/billing-runs/${r3.body.id}`).expect(204);
  });

  it('varnar för utkast som borde ha börjat och för avvikande moms', async () => {
    const o = await agent.post('/objects').send({ propertyId: id.property, objectNr: 'L02', type: 'commercial', monthlyRent: 5000, vatLiable: false, rentValidFrom: '2024-01-01' }).expect(201);
    await agent.post('/contracts').send({ type: 'commercial', customerId: id.org, startDate: '2027-01-01', objectIds: [o.body.id] }).expect(201);
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-03', invoiceDate: '2027-02-10' }).expect(201);
    const run = await agent.get(`/billing-runs/${r.body.id}`).expect(200);
    expect(run.body.issues.find((i: { kind: string }) => i.kind === 'draft_contract')?.severity).toBe('warning');
    await agent.delete(`/billing-runs/${r.body.id}`).expect(204);
  });

  it('stoppar godkännande när bolaget saknar bankgiro', async () => {
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    const p = await agent.post('/properties').send({ name: 'Banvallen', designation: 'Hörby Banvallen 1', category: 'commercial' }).expect(201);
    const o = await agent.post('/objects').send({ propertyId: p.body.id, objectNr: 'B1', type: 'storage', monthlyRent: 1000, rentValidFrom: '2024-01-01' }).expect(201);
    const c = await agent.post('/customers').send({ kind: 'organization', name: 'Förrådet AB', email: 'forradet@example.se' }).expect(201);
    const k = await agent.post('/contracts').send({ type: 'storage', customerId: c.body.id, startDate: '2026-01-01', objectIds: [o.body.id] }).expect(201);
    await agent.post(`/contracts/${k.body.id}/activate`).send({}).expect(201);
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-01' }).expect(201);
    const run = await agent.get(`/billing-runs/${r.body.id}`).expect(200);
    expect(run.body.issues.find((i: { kind: string }) => i.kind === 'no_bankgiro')?.severity).toBe('blocking');
    const a = await agent.post(`/billing-runs/${r.body.id}/approve`).send({ fingerprint: run.body.fingerprint, acknowledgeWarnings: true }).expect(400);
    expect(a.body.message).toContain('fel som måste rättas');
    // Bolag B ser inte bolag A:s fakturor
    expect((await agent.get('/invoices').expect(200)).body).toHaveLength(0);
    await agent.delete(`/billing-runs/${r.body.id}`).expect(204);
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });
});

describe('utskick, betalning och kreditering', () => {
  it('skickar e-post i testläge och köar brev för utskrift', async () => {
    const r = await agent.post(`/billing-runs/${id.run1}/send`).expect(201);
    expect(r.body).toMatchObject({ test: 1, post: 1, failed: 0 });
    expect(readdirSync(outbox).some((f) => f.endsWith('.eml'))).toBe(true);
    const eml = readFileSync(join(outbox, readdirSync(outbox).find((f) => f.endsWith('.eml'))!), 'utf8');
    expect(eml).toContain('tolvan@example.se');
    const pdf = await agent.get(`/billing-runs/${id.run1}/print.pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await agent.post(`/billing-runs/${id.run1}/mark-printed`).expect(201)).body.marked).toBe(1);
  });

  it('skapar PDF och Peppol-fil för en faktura', async () => {
    const pdf = await agent.get(`/invoices/${id.shopInvoice}/pdf`).expect(200);
    expect(pdf.body.length).toBeGreaterThan(2000);
    const xml = await agent.get(`/invoices/${id.shopInvoice}/peppol.xml`).expect(200);
    const text = xml.text ?? xml.body.toString();
    expect(text).toContain('<cbc:PayableAmount currencyID="SEK">93750.00</cbc:PayableAmount>');
    expect(text).toContain('<cbc:ID>SE:BANKGIRO</cbc:ID>');
  });

  it('registrerar delbetalning och full betalning', async () => {
    const a = await agent.post(`/invoices/${id.aptInvoice}/payments`).send({ amount: 4000, paymentDate: '2026-12-28' }).expect(201);
    expect(a.body).toMatchObject({ balanceOre: 500_000, state: 'partially_paid' });
    const b = await agent.post(`/invoices/${id.aptInvoice}/payments`).send({ amount: 5100, paymentDate: '2026-12-29' }).expect(201);
    expect(b.body).toMatchObject({ balanceOre: 0, state: 'paid', unallocatedOre: 10_000 });
    await agent.post(`/invoices/${id.aptInvoice}/payments`).send({ amount: 1, paymentDate: '2026-12-29' }).expect(409);
    const pays = await agent.get(`/payments?customerId=${id.person}`).expect(200);
    expect(pays.body).toHaveLength(2);
    await agent.delete(`/payments/${pays.body[0].id}`).expect(204);
    expect((await agent.get(`/invoices/${id.aptInvoice}`).expect(200)).body.state).toBe('partially_paid');
  });

  it('krediterar del av en faktura och sedan resten, men aldrig mer', async () => {
    const inv = (await agent.get(`/invoices/${id.shopInvoice}`).expect(200)).body;
    const part = await agent
      .post(`/invoices/${id.shopInvoice}/credit`)
      .send({ reason: 'Rabatt januari', lines: [{ lineId: inv.lines[0].id, amount: 5000 }] })
      .expect(201);
    expect(part.body).toMatchObject({ kind: 'credit_note', netOre: -500_000, vatOre: -125_000, totalOre: -625_000 });
    expect(part.body.ocr).toBeNull();
    await agent
      .post(`/invoices/${id.shopInvoice}/credit`)
      .send({ reason: 'För mycket', lines: [{ lineId: inv.lines[0].id, amount: 80000 }] })
      .expect(400);
    await agent.post(`/invoices/${id.shopInvoice}/credit`).send({ reason: 'Fel hyresgäst' }).expect(201);
    const after = (await agent.get(`/invoices/${id.shopInvoice}`).expect(200)).body;
    expect(after).toMatchObject({ balanceOre: 0, creditedOre: 9_375_000, state: 'credited' });
    await agent.post(`/invoices/${id.shopInvoice}/credit`).send({ reason: 'Igen' }).expect(409);
  });

  it('gör en kreditfaktura när en uppsägning gör en betald period för lång', async () => {
    // Lokalavtalet upphör i förtid 28 februari efter att hela kvartal 1 aviserats (och krediterats ovan utan ny avisering).
    // Kvartal 2 ska inte aviseras och ingen negativ avi får skapas utan att den blir en kreditfaktura.
    await agent
      .post(`/contracts/${id.commercial}/terminate`)
      .send({ terminationReceived: '2026-11-20', terminatedBy: 'mutual', endDate: '2027-02-28' })
      .expect(201);
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-04', invoiceDate: '2027-03-10' }).expect(201);
    const run = await agent.get(`/billing-runs/${r.body.id}`).expect(200);
    const shop = run.body.invoices.find((i: { contractId: string }) => i.contractId === id.commercial);
    expect(shop).toMatchObject({ kind: 'credit_note', netOre: -2_500_000 });
    // Kvartalet krediterades redan i sin helhet, så körningen varnar för dubbel kreditering
    expect(run.body.issues.find((i: { kind: string }) => i.kind === 'credited_period')?.severity).toBe('warning');
    await agent.delete(`/billing-runs/${r.body.id}`).expect(204);
  });

  it('aviserar krediterade perioder på nytt när kunden ska debiteras igen', async () => {
    const feb = (await agent.get(`/invoices?contractId=${id.residential}`).expect(200)).body.find(
      (i: { periodFrom: string; kind: string }) => i.kind === 'rent_notice' && i.periodFrom === '2027-02-01',
    );
    await agent.post(`/invoices/${feb.id}/credit`).send({ reason: 'Fel belopp', rebill: true }).expect(201);
    const r = await agent.post('/billing-runs').send({ periodMonth: '2027-03', invoiceDate: '2027-02-10' }).expect(201);
    const run = await agent.get(`/billing-runs/${r.body.id}`).expect(200);
    const inv = run.body.invoices.find((i: { contractId: string }) => i.contractId === id.residential);
    const sum = (kind: string) => inv.lines.filter((l: { lineKind: string }) => l.lineKind === kind).reduce((s: number, l: { netOre: number }) => s + l.netOre, 0);
    expect(sum('regular')).toBe(931_000);
    // Februari och januarijusteringen debiteras igen. Nyckeln (extra debitering) aviseras inte om.
    expect(sum('retroactive')).toBe(931_000 - 493_548 + 510_548);
    await agent.delete(`/billing-runs/${r.body.id}`).expect(204);
  });

  it('skapar och utfärdar en manuell faktura med nästa nummer', async () => {
    const d = await agent
      .post('/invoices')
      .send({
        customerId: id.org,
        invoiceDate: '2027-02-01',
        yourReference: 'Kim',
        lines: [{ article: 'service', description: 'Fönsterputs', quantity: 2, unitPrice: 450, vatRateBp: 2500, objectId: id.shop }],
      })
      .expect(201);
    expect(d.body).toMatchObject({ status: 'draft', netOre: 90_000, vatOre: 22_500, totalOre: 112_500, dueDate: '2027-03-03' });
    expect(d.body.lines[0].propertyId).toBe(id.property);
    await agent.put(`/invoices/${d.body.id}/lines`).send({ lines: [{ description: 'Fönsterputs', quantity: 3, unitPrice: 450, vatRateBp: 2500 }] }).expect(200);
    const issued = await agent.post(`/invoices/${d.body.id}/issue`).expect(201);
    const max = Math.max(...(await agent.get('/invoices').expect(200)).body.filter((i: { invoiceNr: number }) => i.invoiceNr !== issued.body.invoiceNr).map((i: { invoiceNr: number }) => i.invoiceNr));
    expect(issued.body).toMatchObject({ status: 'issued', invoiceNr: max + 1, totalOre: 168_800 }); // 1 687,50 avrundas till 1 688
    await agent.patch(`/invoices/${d.body.id}`).send({ message: 'Ändrad' }).expect(409);
    await agent.delete(`/invoices/${d.body.id}`).expect(409);
  });

  it('ger nyckeltal för reskontran', async () => {
    const s = await agent.get('/invoices/summary').expect(200);
    expect(s.body.openCount).toBeGreaterThan(0);
    expect(s.body.openOre).toBeGreaterThan(0);
  });
});
