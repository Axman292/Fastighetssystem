import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/scripts/seed-demo';
import { monthsIn } from '../src/reports/report';
import { ADMIN_EMAIL, ADMIN_PW, login, startApp } from './helpers';

/**
 * Rapporterna är klara när varje rapport går att ta fram för koncernen, ett bolag
 * och en fastighet, när siffrorna stämmer med fakturor och betalningar och när
 * rapporten går att hämta som Excel och PDF.
 */

interface Section {
  title?: string;
  columns: { key: string; label: string; type: string }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
}
interface Report {
  key: string;
  title: string;
  scope: string;
  sections: Section[];
}

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let db: Client;
const company: Record<string, string> = {};
const year = new Date().getFullYear();
const from = `${year - 1}-01-01`;
const to = `${year}-12-31`;

const get = async (key: string, q = '') => (await agent.get(`/reports/${key}?from=${from}&to=${to}${q}`).expect(200)).body as Report;
const section = (r: Report, title: string) => {
  const s = r.sections.find((x) => x.title === title);
  if (!s) throw new Error(`Sektionen ${title} saknas`);
  return s;
};

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_rapporter'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await seedDemo(ADMIN_EMAIL, ADMIN_PW, () => undefined);
  agent = await login(app);
  for (const r of (await db.query('select id, name from company')).rows) company[r.name] = r.id;
  await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await stop?.();
});

describe('rapporter', () => {
  it('listar rapporterna', async () => {
    const list = (await agent.get('/reports').expect(200)).body as { key: string; mode: string }[];
    expect(list.map((r) => r.key)).toEqual([
      'hyreslista',
      'aviseringsjournal',
      'manadsanalys',
      'kundfordran',
      'moms',
      'frivillig-skattskyldighet',
      'in-och-avflyttning',
    ]);
    await agent.get('/reports/finns-inte').expect(404);
    await agent.get('/reports/moms?from=2027-02-30').expect(400);
    await agent.get('/reports/moms?from=2027-02-01&to=2027-01-01').expect(400);
  });

  it('hyreslistan visar uthyrda och vakanta objekt', async () => {
    const r = (await agent.get('/reports/hyreslista').expect(200)).body as Report;
    expect(r.scope).toBe('Hela koncernen');
    const summary = section(r, 'Sammanställning per fastighet');
    const eken = summary.rows.find((x) => x.property === 'Eken')!;
    // 6 lägenheter, 2 parkeringar och ett förråd. 1202, P02 och F01 är vakanta.
    expect(eken).toMatchObject({ objects: 9, let: 6, vacant: 3 });
    const objects = section(r, 'Objekt');
    expect(objects.columns[0].key).toBe('company');
    const apt = objects.rows.find((x) => x.objectNr === '1001')!;
    expect(apt).toMatchObject({ status: 'Uthyrd', rent: 615_000, annual: 7_380_000, vat: 0 });
    expect(apt.customer).toMatch(/Anna Lindqvist/);
    const vacant = objects.rows.find((x) => x.objectNr === '1202')!;
    expect(vacant).toMatchObject({ status: 'Vakant', rent: null, vacantAnnual: 540_000 * 12 });
    const shop = objects.rows.find((x) => x.objectNr === 'L01')!;
    expect(shop.vat).toBe(Math.round(1_850_000 * 0.25));
    expect(summary.totals!.annual).toBe(objects.totals!.annual);
  });

  it('aviseringsjournalen stämmer med fakturorna', async () => {
    const r = await get('aviseringsjournal');
    const s = section(r, 'Utfärdade avier och fakturor');
    const db_ = (
      await db.query(
        `select count(*)::int as n, sum(total_ore)::float as total, sum(vat_ore)::float as vat from invoice
         where status = 'issued' and invoice_date between $1 and $2`,
        [from, to],
      )
    ).rows[0];
    expect(s.rows).toHaveLength(db_.n);
    expect(s.totals!.total).toBe(db_.total);
    expect(s.totals!.vat).toBe(db_.vat);
    expect(section(r, 'Per artikel och konto').totals!.vat).toBe(db_.vat);
  });

  it('kundfordran går ihop med reskontran', async () => {
    const r = await get('kundfordran');
    const s = section(r, 'Avstämning');
    const diff = s.rows.find((x) => String(x.item).startsWith('Differens'))!;
    expect(diff.amount).toBe(0);
    const closing = s.rows.find((x) => String(x.item).startsWith('Utgående'))!;
    const perCustomer = section(r, 'Per kund');
    expect(perCustomer.totals!.closing).toBe(closing.amount);
    // Någon har inte betalat, så det finns en fordran
    expect(closing.amount as number).toBeGreaterThan(0);
  });

  it('momsavstämningen räknar fram moms att betala', async () => {
    const r = await get('moms');
    const decl = section(r, 'Förslag till momsdeklaration').rows;
    const box = (b: string) => decl.find((x) => x.box === b)!.amount as number;
    expect(box('10')).toBeGreaterThan(0);
    expect(box('42')).toBeGreaterThan(0); // bostäder
    expect(box('48')).toBeGreaterThan(0);
    expect(box('49')).toBe(box('10') + box('11') + box('12') - box('48'));
    const out = (
      await db.query(
        `select sum(l.vat_ore)::float as v from invoice_line l join invoice i on i.id = l.invoice_id where i.status = 'issued' and i.invoice_date between $1 and $2`,
        [from, to],
      )
    ).rows[0].v;
    expect(box('10') + box('11') + box('12')).toBe(out);
  });

  it('månadsanalysen har en rad per månad och samma netto som journalen', async () => {
    const r = await get('manadsanalys');
    const s = section(r, 'Per månad');
    expect(s.rows).toHaveLength(monthsIn(from, to).length);
    const journal = await get('aviseringsjournal');
    expect(s.totals!.net).toBe(section(journal, 'Utfärdade avier och fakturor').totals!.net);
    expect(s.totals!.vacancy as number).toBeGreaterThan(0);
    expect(s.totals!.paid as number).toBeGreaterThan(0);
    expect(section(r, 'Netto per fastighet och månad').totals!.total).toBe(s.totals!.net);
  });

  it('frivillig skattskyldighet visar momspliktiga lokaler och andelar', async () => {
    const r = (await agent.get('/reports/frivillig-skattskyldighet').expect(200)).body as Report;
    const objs = section(r, 'Momspliktiga objekt och avvikelser').rows;
    expect(objs.find((x) => x.objectNr === 'L01')).toMatchObject({ remark: 'OK' });
    expect(String(objs.find((x) => x.objectNr === 'K01')!.remark)).toMatch(/Vakant/);
    expect(objs.find((x) => x.objectNr === '1001')).toBeUndefined();
    const verkstan = section(r, 'Momspliktig andel per fastighet').rows.find((x) => x.property === 'Verkstan')!;
    expect(verkstan.areaShare).toBe(1);
  });

  it('in- och avflyttningslistan visar avtalens startdagar', async () => {
    const r = await get('in-och-avflyttning');
    const list = section(r, 'Händelser').rows;
    const active = (await db.query(`select count(*)::int as n from contract_object co join contract c on c.id = co.contract_id where c.status = 'active'`)).rows[0].n;
    expect(list.filter((x) => x.event === 'Inflyttning')).toHaveLength(active);
    expect(section(r, 'Sammanställning').rows[0].count).toBe(active);
  });

  it('filtrerar på bolag och fastighet', async () => {
    await agent.post('/auth/switch-company').send({ companyId: company['Hardebergabanan AB'] }).expect(200);
    const r = (await agent.get('/reports/hyreslista').expect(200)).body as Report;
    expect(r.scope).toBe('Hardebergabanan AB');
    const objects = section(r, 'Objekt');
    expect(objects.columns[0].key).not.toBe('company');
    expect(new Set(objects.rows.map((x) => x.property))).toEqual(new Set(['Stationen']));

    await agent.post('/auth/switch-company').send({ companyId: 'all' }).expect(200);
    const eken = (await db.query(`select id from property where name = 'Eken'`)).rows[0].id;
    const j = await get('aviseringsjournal', `&propertyId=${eken}`);
    const lines = (
      await db.query(
        `select sum(l.net_ore)::float as n from invoice_line l join invoice i on i.id = l.invoice_id
         where i.status = 'issued' and l.property_id = $1 and i.invoice_date between $2 and $3`,
        [eken, from, to],
      )
    ).rows[0].n;
    expect(section(j, 'Utfärdade avier och fakturor').totals!.net).toBe(lines);
    const roll = (await agent.get(`/reports/hyreslista?propertyId=${eken}`).expect(200)).body as Report;
    expect(section(roll, 'Sammanställning per fastighet').rows).toHaveLength(1);
  });

  it('exporterar till Excel och PDF', async () => {
    for (const key of ['hyreslista', 'aviseringsjournal', 'manadsanalys', 'kundfordran', 'moms', 'frivillig-skattskyldighet', 'in-och-avflyttning']) {
      const x = await agent.get(`/reports/${key}?from=${from}&to=${to}&format=xlsx`).buffer(true).parse(binary).expect(200);
      expect(x.headers['content-type']).toMatch(/spreadsheetml/);
      expect(x.headers['content-disposition']).toMatch(/attachment; filename=".+\.xlsx"/);
      expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const p = await agent.get(`/reports/${key}?from=${from}&to=${to}&format=pdf`).buffer(true).parse(binary).expect(200);
      expect(p.headers['content-type']).toBe('application/pdf');
      expect((p.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});

function binary(res: NodeJS.ReadableStream & { setEncoding: (e: string) => void }, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
