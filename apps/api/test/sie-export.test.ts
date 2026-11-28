import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/scripts/seed-demo';
import { decodeCp437, encodeCp437, quote, sieAmount } from '../src/accounting/sie';
import { fiscalYear } from '../src/accounting/sie-export';
import { ADMIN_EMAIL, ADMIN_PW, login, startApp } from './helpers';

/**
 * SIE-exporten är klar när filen följer SIE typ 4 (PC8, CRLF, balanserade
 * verifikationer), när varje händelse bara kommer med en gång och när en
 * händelse som ändras efter exporten ger en rättelse.
 */

interface Row { account: string; debitOre: number; creditOre: number }
interface Voucher { key: string; kind: string; date: string; text: string; correction: boolean; rows: Row[] }
interface Preview {
  vouchers: Voucher[];
  issues: { severity: string; message: string }[];
  blocked: boolean;
  summary: { accounts: { account: string; debitOre: number; creditOre: number }[]; debitOre: number };
}

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let db: Client;
let companyId = '';
const d = new Date();
const to = d.toISOString().slice(0, 10);
const from = new Date(d.getTime() - 360 * 86_400_000).toISOString().slice(0, 10);

const preview = async (f = from, t = to) => (await agent.get(`/accounting/sie/preview?from=${f}&to=${t}`).expect(200)).body as Preview;
const download = async (id: string) =>
  (
    await agent
      .get(`/accounting/sie/exports/${id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200)
  ).body as Buffer;

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_sie'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await seedDemo(ADMIN_EMAIL, ADMIN_PW, () => undefined);
  agent = await login(app);
  companyId = (await db.query(`select id from company where name like 'P Dahlqvist%'`)).rows[0].id;
  await agent.post('/auth/switch-company').send({ companyId }).expect(200);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await stop?.();
});

describe('SIE-format', () => {
  it('kodar svenska tecken i PC8 (teckentabell 437)', () => {
    expect([...encodeCp437('åäöÅÄÖé')]).toEqual([0x86, 0x84, 0x94, 0x8f, 0x8e, 0x99, 0x82]);
    expect(decodeCp437(encodeCp437('Trädgården 13 – Hjärpen'))).toBe('Trädgården 13 - Hjärpen');
  });
  it('skriver belopp och text enligt formatet', () => {
    expect(sieAmount(-125050)).toBe('-1250.50');
    expect(sieAmount(7)).toBe('0.07');
    expect(quote('Säg "hej"')).toBe('"Säg \\"hej\\""');
  });
  it('räknar fram räkenskapsåret', () => {
    expect(fiscalYear('2026-03-15', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(fiscalYear('2026-03-15', 5)).toEqual({ from: '2025-05-01', to: '2026-04-30' });
  });
});

describe('SIE-export', () => {
  let firstExportId = '';

  it('förhandsgranskar verifikationer som går jämnt ut', async () => {
    const p = await preview();
    expect(p.blocked).toBe(false);
    expect(p.vouchers.length).toBeGreaterThan(0);
    for (const v of p.vouchers) {
      const debit = v.rows.reduce((s, r) => s + r.debitOre, 0);
      const credit = v.rows.reduce((s, r) => s + r.creditOre, 0);
      expect(debit, v.text).toBe(credit);
      expect(debit, v.text).toBeGreaterThan(0);
    }
    const kinds = new Set(p.vouchers.map((v) => v.kind));
    for (const k of ['customer_invoice', 'payment', 'supplier_invoice', 'supplier_payment']) expect(kinds.has(k), k).toBe(true);

    // Kundfordran i debet = summan av utfärdade avier och fakturor
    const invoiced = (
      await db.query(
        `select coalesce(sum(total_ore) filter (where total_ore > 0), 0)::float as pos, count(*)::int as n from invoice
         where company_id = $1 and status = 'issued' and invoice_date between $2 and $3`,
        [companyId, from, to],
      )
    ).rows[0];
    expect(p.vouchers.filter((v) => v.kind === 'customer_invoice')).toHaveLength(invoiced.n);
    const receivableDebit = p.vouchers
      .filter((v) => v.kind === 'customer_invoice')
      .flatMap((v) => v.rows)
      .filter((r) => r.account === '1510')
      .reduce((s, r) => s + r.debitOre, 0);
    expect(receivableDebit).toBe(invoiced.pos);

    // Bara attesterade leverantörsfakturor kommer med
    const approved = (
      await db.query(
        `select count(*)::int as n from supplier_invoice where company_id = $1 and status in ('approved','paid') and invoice_date between $2 and $3`,
        [companyId, from, to],
      )
    ).rows[0].n;
    expect(p.vouchers.filter((v) => v.kind === 'supplier_invoice')).toHaveLength(approved);
  });

  it('skapar en SIE-fil som går att läsa in', async () => {
    const before = await preview();
    const r = await agent.post('/accounting/sie/exports').send({ from, to }).expect(201);
    firstExportId = r.body.id;
    expect(r.body.voucherCount).toBe(before.vouchers.length);
    expect(r.body.filename).toMatch(/^SIE-P-Dahlqvist.*\.se$/);

    const buf = await download(firstExportId);
    expect(buf.includes(Buffer.from([0x0d, 0x0a]))).toBe(true);
    const text = decodeCp437(buf);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('#FLAGGA 0');
    expect(text).toContain('#FORMAT PC8');
    expect(text).toContain('#SIETYP 4');
    expect(text).toMatch(/#ORGNR \d{6}-\d{4}/);
    expect(text).toMatch(/#RAR 0 \d{8} \d{8}/);
    expect(text).toContain('#KONTO 1510 "Kundfordringar"');
    expect(text).toContain('#KONTO 3911 "Hyresintäkter"');
    expect((text.match(/^#VER /gm) ?? []).length).toBe(before.vouchers.length);
    expect(text).toMatch(/^#VER "A" "" \d{8} "Hyresavi \d+/m);
    // Varje verifikation går jämnt ut i filen
    let sum = 0;
    for (const l of lines) {
      if (l === '{') sum = 0;
      const m = l.match(/^\s+#TRANS \d{4} \{[^}]*\} (-?\d+\.\d{2})/);
      if (m) sum += Math.round(Number(m[1]) * 100);
      if (l === '}') expect(sum).toBe(0);
    }
  });

  it('exporterar aldrig samma händelse två gånger', async () => {
    const p = await preview();
    expect(p.vouchers).toHaveLength(0);
    expect(p.issues.some((i) => i.message.includes('redan exporterad'))).toBe(true);
    await agent.post('/accounting/sie/exports').send({ from, to }).expect(400);
  });

  it('gör en rättelse när en exporterad betalning tas bort', async () => {
    const pay = (
      await db.query(
        `select p.id, p.amount_ore::float as amount from payment p where p.company_id = $1 and p.payment_date between $2 and $3
         and not exists (select 1 from payment_refund r where r.payment_id = p.id) order by p.payment_date desc limit 1`,
        [companyId, from, to],
      )
    ).rows[0];
    await agent.delete(`/payments/${pay.id}`).expect(204);
    const p = await preview();
    expect(p.vouchers).toHaveLength(1);
    const v = p.vouchers[0];
    expect(v.correction).toBe(true);
    expect(v.key).toBe(`payment:${pay.id}`);
    expect(v.rows.find((r) => r.account === '1930')?.creditOre).toBe(pay.amount);
    const r = await agent.post('/accounting/sie/exports').send({ from, to }).expect(201);
    expect(r.body.correctionCount).toBe(1);
    expect((await preview()).vouchers).toHaveLength(0);

    // Bara den senaste exporten kan ångras, och då kommer händelserna tillbaka
    await agent.delete(`/accounting/sie/exports/${firstExportId}`).expect(409);
    await agent.delete(`/accounting/sie/exports/${r.body.id}`).expect(204);
    expect((await preview()).vouchers).toHaveLength(1);
  });

  it('använder bolagets serie och konton', async () => {
    const s = (await agent.get('/accounting/settings').expect(200)).body;
    await agent.put('/accounting/settings').send({ ...s, series: 'h', bankAccount: '1940' }).expect(200);
    const p = await preview();
    expect(p.vouchers[0].rows.some((r) => r.account === '1940')).toBe(true);
    const r = await agent.post('/accounting/sie/exports').send({ from, to }).expect(201);
    expect(decodeCp437(await download(r.body.id))).toMatch(/^#VER "H" "" /m);
    await agent.put('/accounting/settings').send({ ...s, series: 'A', bankAccount: '12' }).expect(400);
  });

  it('visar inte ett annat bolags exporter', async () => {
    const other = (await db.query(`select id from company where name like 'Hardeberga%'`)).rows[0].id;
    await agent.post('/auth/switch-company').send({ companyId: other }).expect(200);
    expect((await agent.get('/accounting/sie/exports').expect(200)).body).toHaveLength(0);
    await agent.get(`/accounting/sie/exports/${firstExportId}/file`).expect(404);
    await agent.post('/auth/switch-company').send({ companyId }).expect(200);
  });
});
