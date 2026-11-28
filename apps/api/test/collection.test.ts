import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBgMax } from '../src/payments/bgmax';
import { interestFor, rateOn } from '../src/collection/late-interest';
import { addMonths, installmentStates, splitInstallments } from '../src/collection/payment-plans';
import { login, startApp } from './helpers';

/**
 * Dröjsmålsränta, avbetalningsplaner och inkasso är klara när räntan debiteras på riktigt
 * (på nästa avi eller som räntefaktura, aldrig två gånger för samma dag), när en plan
 * pausar påminnelser och tar emot delbetalningar, när obetalt kan lämnas till inkasso med
 * en ärendefil och skrivas av som kundförlust, och när allt kommer med i SIE-exporten.
 */

const refs = [
  { validFrom: '2026-01-01', rateBp: 200 },
  { validFrom: '2026-07-01', rateBp: 200 },
  { validFrom: '2027-01-01', rateBp: 300 },
];
const law = { useReference: true, marginBp: 800, fixedBp: 1000, contractBp: null, referenceRates: refs };

describe('räntan utan databas', () => {
  it('använder referensräntan för halvåret + 8 procentenheter, eller avtalad ränta', () => {
    expect(rateOn('2026-12-31', law)).toBe(1000);
    expect(rateOn('2027-01-01', law)).toBe(1100);
    expect(rateOn('2027-01-01', { ...law, useReference: false })).toBe(1000);
    expect(rateOn('2027-01-01', { ...law, contractBp: 1500 })).toBe(1500);
  });

  it('räknar per dag på det som är obetalt och byter sats vid halvårsskiftet', () => {
    // 10 000 kr, 10 % i december, 11 % i januari
    const r = interestFor(1_000_000, [], '2026-12-01', '2027-01-31', law);
    expect(r.days).toBe(62);
    expect(r.amountOre).toBe(Math.round((1_000_000 * 1000 * 31 + 1_000_000 * 1100 * 31) / (10_000 * 365)));
    expect(r.rateText).toBe('10 % / 11 %');
    // Halva betalas 16 december: underlaget halveras från och med den dagen
    const half = interestFor(1_000_000, [{ date: '2026-12-16', amountOre: 500_000 }], '2026-12-01', '2026-12-31', law);
    expect(half.amountOre).toBe(Math.round((1_000_000 * 1000 * 15 + 500_000 * 1000 * 16) / (10_000 * 365)));
    expect(interestFor(1_000_000, [{ date: '2026-11-30', amountOre: 1_000_000 }], '2026-12-01', '2026-12-31', law).amountOre).toBe(0);
  });

  it('delar upp en avbetalningsplan i hela kronor och följer betalningarna', () => {
    const parts = splitInstallments(1_000_050, 3, '2027-03-25');
    expect(parts.map((p) => p.amountOre)).toEqual([333_300, 333_300, 333_450]);
    expect(parts.reduce((a, p) => a + p.amountOre, 0)).toBe(1_000_050);
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    const st = installmentStates(parts, 400_000, '2027-05-01');
    expect(st.map((s) => s.state)).toEqual(['paid', 'overdue', 'due']);
    expect(st[1].coveredOre).toBe(66_700);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
const id: Record<string, string> = {};
const inv: Record<string, { id: string; invoiceNr: number; ocr: string; totalOre: number; dueDate: string }> = {};

function upload(text: string, name: string) {
  return agent.post('/bank-files').attach('file', Buffer.from(text, 'latin1'), name);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const binary = (res: any, cb: (err: Error | null, body: any) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
async function approveRun(month: string, invoiceDate: string) {
  const run = await agent.post('/billing-runs').send({ periodMonth: month, invoiceDate }).expect(201);
  const detail = await agent.get(`/billing-runs/${run.body.id}`).expect(200);
  const ok = await agent.post(`/billing-runs/${run.body.id}/approve`).send({ fingerprint: detail.body.fingerprint, acknowledgeWarnings: true }).expect(201);
  expect(ok.body.ok).toBe(true);
  return run.body.id as string;
}

beforeAll(async () => {
  process.env.OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'utkorg-inkasso-'));
  delete process.env.SMTP_HOST;
  delete process.env.BREVO_API_KEY;
  ({ app, stop } = await startApp('fastighet_test_inkasso'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent
    .patch(`/companies/${companyA}`)
    .send({ bankgiro: '5050-1055', invoiceEmail: 'hyror@example.se', lateInterestFrom: '2026-01-01', lateInterestMin: 10 })
    .expect(200);
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential' }).expect(201);
  id.property = p.body.id;
  for (const [key, nr] of [['apt1', '1001'], ['apt2', '1002'], ['apt3', '1003']]) {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', objectNr: nr, type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 }).expect(201);
    id[key] = r.body.id;
  }
  const people: [string, string, string | null, string][] = [
    ['anna', 'Anna Testsson', 'anna@example.se', '191212121212'],
    ['bo', 'Bo Exempel', null, '198112189876'],
    ['cia', 'Cia Påhittad', 'cia@example.se', '197001011233'],
  ];
  for (const [key, name, email, nationalId] of people) {
    const r = await agent
      .post('/customers')
      .send({ kind: 'person', name, email, nationalId, deliveryMethod: email ? 'email' : 'post', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
      .expect(201);
    expect(r.status).toBe(201);
    id[key] = r.body.id;
  }
  for (const [k, c, o] of [['k1', 'anna', 'apt1'], ['k2', 'bo', 'apt2'], ['k3', 'cia', 'apt3']] as const) {
    const r = await agent.post('/contracts').send({ type: 'residential', customerId: id[c], startDate: '2026-12-01', objectIds: [id[o]] }).expect(201);
    id[k] = r.body.id;
    await agent.post(`/contracts/${r.body.id}/activate`).send({}).expect(201);
  }
  await approveRun('2027-01', '2026-12-10');
  await approveRun('2027-02', '2027-01-10');
  const list = await agent.get('/invoices').expect(200);
  for (const i of list.body) {
    const who = i.customerId === id.anna ? 'anna' : i.customerId === id.bo ? 'bo' : 'cia';
    inv[`${who}${i.periodFrom.slice(5, 7)}`] = i;
  }
  expect(Object.keys(inv).sort()).toEqual(['anna01', 'anna02', 'bo01', 'bo02', 'cia01', 'cia02']);
});

afterAll(async () => {
  await stop();
});

describe('dröjsmålsränta', () => {
  it('föreslår ränta på förfallna fakturor och på fakturor som betalats för sent', async () => {
    // Anna betalar januarihyran 20 dagar för sent
    const pay = buildBgMax({ bankgiro: '5050-1055', date: addDaysIso(inv.anna01.dueDate, 20), payments: [{ reference: inv.anna01.ocr, amountOre: inv.anna01.totalOre, serial: '1' }] });
    const f = await upload(pay, 'BGMAX_1.txt').expect(201);
    await agent.post(`/bank-files/${f.body.id}/book`).expect(201);

    const s = await agent.get('/late-interest/suggestion?date=2027-02-15').expect(200);
    expect(s.body.settings).toMatchObject({ useReference: true, marginBp: 800, minOre: 1000, method: 'next_notice' });
    expect(s.body.currentRate).toBe('10 %');
    const anna = s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.anna01.id);
    expect(anna).toMatchObject({ paidInFull: true, days: 19, fromDate: addDaysIso(inv.anna01.dueDate, 1), canUseNotice: true });
    expect(anna.amountOre).toBe(Math.round((inv.anna01.totalOre * 1000 * 19) / (10_000 * 365)));
    const bo = s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id);
    expect(bo).toMatchObject({ paidInFull: false, toDate: '2027-02-15' });
    expect(bo.days).toBe(daysBetweenIso(inv.bo01.dueDate, '2027-02-15'));
    id.annaInterest = String(anna.amountOre);
  });

  it('lägger räntan på nästa avi som momsfri rad på 8313', async () => {
    const r = await agent.post('/late-interest').send({ date: '2027-02-15', invoiceIds: [inv.anna01.id], method: 'next_notice' }).expect(201);
    expect(r.body).toMatchObject({ charged: 1, onNotice: 1, interestInvoiceIds: [] });
    // Samma dagar debiteras aldrig igen
    const again = await agent.get('/late-interest/suggestion?date=2027-02-20').expect(200);
    expect(again.body.candidates.some((c: { invoiceId: string }) => c.invoiceId === inv.anna01.id)).toBe(false);
    const charges = await agent.get(`/contracts/${id.k1}/charges`).expect(200);
    expect(charges.body[0]).toMatchObject({ article: 'interest', amountOre: Number(id.annaInterest), vatRateBp: 0 });

    await approveRun('2027-03', '2027-02-16');
    const list = await agent.get('/invoices').expect(200);
    const march = list.body.find((i: { customerId: string; periodFrom: string }) => i.customerId === id.anna && i.periodFrom === '2027-03-01');
    const detail = await agent.get(`/invoices/${march.id}`).expect(200);
    const line = detail.body.lines.find((l: { article: string }) => l.article === 'interest');
    expect(line).toMatchObject({ netOre: Number(id.annaInterest), vatOre: 0, accountNumber: '8313' });
    const hist = await agent.get(`/late-interest?invoiceId=${inv.anna01.id}`).expect(200);
    expect(hist.body[0]).toMatchObject({ method: 'next_notice', noticeNr: march.invoiceNr });
  });

  it('skickar räntefaktura och fortsätter nästa gång dagen efter förra debiteringen', async () => {
    const r = await agent.post('/late-interest').send({ date: '2027-02-15', invoiceIds: [inv.bo01.id], method: 'invoice' }).expect(201);
    expect(r.body.interestInvoiceIds).toHaveLength(1);
    const ri = await agent.get(`/invoices/${r.body.interestInvoiceIds[0]}`).expect(200);
    expect(ri.body).toMatchObject({ status: 'issued', vatOre: 0, kind: 'invoice' });
    expect(ri.body.lines[0]).toMatchObject({ article: 'interest', accountNumber: '8313', periodTo: '2027-02-15' });
    id.boInterestInvoice = ri.body.id;

    const later = await agent.get('/late-interest/suggestion?date=2027-02-25').expect(200);
    const bo = later.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id);
    expect(bo).toMatchObject({ fromDate: '2027-02-16', toDate: '2027-02-25', days: 10 });
    // Ingen ränta på räntefakturan
    expect(later.body.candidates.some((c: { invoiceId: string }) => c.invoiceId === id.boInterestInvoice)).toBe(false);
    // Under lägsta belopp hoppas över
    await agent.patch(`/companies/${companyA}`).send({ lateInterestMin: 1000 }).expect(200);
    const skip = await agent.post('/late-interest').send({ date: '2027-02-25', invoiceIds: [inv.bo01.id] }).expect(201);
    expect(skip.body.charged).toBe(0);
    expect(skip.body.skipped[0].reason).toMatch(/lägsta belopp/);
    await agent.patch(`/companies/${companyA}`).send({ lateInterestMin: 10 }).expect(200);
  });
});

describe('avbetalningsplan', () => {
  it('samlar skulden, pausar påminnelser och fördelar delbetalningar äldst först', async () => {
    const plan = await agent
      .post('/payment-plans')
      .send({ customerId: id.cia, invoiceIds: [inv.cia02.id, inv.cia01.id], firstDueDate: '2027-02-25', installments: 2, agreedDate: '2027-02-15' })
      .expect(201);
    const total = inv.cia01.totalOre + inv.cia02.totalOre;
    expect(plan.body).toMatchObject({ planNr: 1, state: 'active', totalOre: total, remainingOre: total, ocr: inv.cia01.ocr });
    expect(plan.body.installments).toHaveLength(2);
    id.plan = plan.body.id;

    const s = await agent.get('/reminders/suggestion?date=2027-02-20').expect(200);
    expect(s.body.candidates.some((c: { customerId: string }) => c.customerId === id.cia)).toBe(false);
    await agent.post('/payment-plans').send({ customerId: id.cia, invoiceIds: [inv.cia01.id], firstDueDate: '2027-03-01', installments: 1 }).expect(409);

    // Första delbetalningen och lite till på första fakturans OCR: överskottet går till nästa faktura i planen
    const first = plan.body.installments[0].amountOre;
    const pay = buildBgMax({ bankgiro: '5050-1055', date: '2027-02-24', payments: [{ reference: inv.cia01.ocr, amountOre: first + 50_000, serial: '2' }] });
    const f = await upload(pay, 'BGMAX_2.txt').expect(201);
    await agent.post(`/bank-files/${f.body.id}/book`).expect(201);
    const after = await agent.get(`/payment-plans/${id.plan}`).expect(200);
    expect(after.body.paidOre).toBe(first + 50_000);
    expect(after.body.installments[0].state).toBe('paid');
    const c2 = await agent.get(`/invoices/${inv.cia02.id}`).expect(200);
    expect(c2.body.paidOre).toBe(first + 50_000 - inv.cia01.totalOre);

    const pdf = await agent.get(`/payment-plans/${id.plan}/pdf`).buffer(true).parse(binary).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('släpper fakturorna när planen bryts', async () => {
    const r = await agent.post(`/payment-plans/${id.plan}/close`).send({ status: 'broken', date: '2027-04-01', reason: 'Andra delbetalningen kom inte' }).expect(201);
    expect(r.body.state).toBe('broken');
    const s = await agent.get('/reminders/suggestion?date=2027-04-01').expect(200);
    expect(s.body.candidates.some((c: { invoiceId: string }) => c.invoiceId === inv.cia02.id)).toBe(true);
  });
});

describe('inkasso', () => {
  it('skapar ett ärende med påminnelseavgifter, räntefakturor och upplupen ränta', async () => {
    const c = await agent
      .post('/collection-cases')
      .send({ customerId: id.bo, invoiceIds: [inv.bo01.id, inv.bo02.id], date: '2027-03-20', agency: 'Exempelinkasso AB' })
      .expect(201);
    expect(c.body).toMatchObject({ caseNr: 1, status: 'prepared', agency: 'Exempelinkasso AB' });
    // Båda hyresavierna och räntefakturan
    expect(c.body.claims).toHaveLength(3);
    expect(c.body.claims.find((x: { invoiceId: string }) => x.invoiceId === id.boInterestInvoice).isInterest).toBe(true);
    const bo01 = c.body.claims.find((x: { invoiceId: string }) => x.invoiceId === inv.bo01.id);
    expect(bo01.interestFrom).toBe('2027-02-16');
    expect(bo01.interestOre).toBeGreaterThan(0);
    expect(c.body.capitalOre).toBe(c.body.remainingOre);
    id.case = c.body.id;
    // Samma faktura kan inte ligga i två ärenden, och påminns inte
    await agent.post('/collection-cases').send({ customerId: id.bo, invoiceIds: [inv.bo01.id] }).expect(409);
    const s = await agent.get('/reminders/suggestion?date=2027-03-20').expect(200);
    expect(s.body.candidates.some((x: { invoiceId: string }) => x.invoiceId === inv.bo01.id)).toBe(false);
  });

  it('exporterar en ärendefil för inkassobolaget', async () => {
    const x = await agent.get(`/collection-cases/export.xlsx?ids=${id.case}`).buffer(true).parse(binary).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as never);
    const ws = wb.getWorksheet('Inkassoärenden')!;
    expect(ws.getRow(1).getCell(3).value).toBe('Gäldenär');
    expect(ws.rowCount).toBe(4);
    const csv = await agent.get(`/collection-cases/export.csv?ids=${id.case}`).expect(200);
    expect(csv.text).toContain('Bo Exempel');
    expect(csv.text).toContain('19811218-9876');
    expect(csv.text).toContain(String(inv.bo01.invoiceNr));
    expect(csv.text).toContain('Dröjsmålsränta');
    const pdf = await agent.get(`/collection-cases/${id.case}/pdf`).buffer(true).parse(binary).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('följer status: skickat, inkassobolaget räknar räntan', async () => {
    const r = await agent.post(`/collection-cases/${id.case}/status`).send({ status: 'sent', date: '2027-03-21', agencyReference: 'EX-123' }).expect(201);
    expect(r.body).toMatchObject({ status: 'sent', sentDate: '2027-03-21', agencyReference: 'EX-123' });
    expect(r.body.events.at(-1).description).toMatch(/Skickat till Exempelinkasso AB, ärende EX-123/);
    const s = await agent.get('/late-interest/suggestion?date=2027-04-30').expect(200);
    expect(s.body.candidates.some((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id)).toBe(false);
    await agent.post(`/collection-cases/${id.case}/status`).send({ status: 'prepared' }).expect(409);
  });

  it('skriver av det obetalda som kundförlust med kreditfaktura på 6350', async () => {
    const before = await agent.get(`/collection-cases/${id.case}`).expect(200);
    const r = await agent.post(`/collection-cases/${id.case}/write-off`).send({ date: '2027-06-30', reason: 'Kronofogden har inte hittat tillgångar' }).expect(201);
    expect(r.body).toMatchObject({ status: 'written_off', closedDate: '2027-06-30', remainingOre: 0 });
    const bo01 = await agent.get(`/invoices/${inv.bo01.id}`).expect(200);
    expect(bo01.body.balanceOre).toBe(0);
    const credit = await agent.get(`/invoices/${bo01.body.credits[0].id}`).expect(200);
    expect(credit.body.lines.every((l: { accountNumber: string }) => l.accountNumber === '6350')).toBe(true);
    expect(credit.body.deliveries).toEqual([]);
    const sum = r.body.claims.reduce((a: number, x: { capitalOre: number }) => a + x.capitalOre, 0);
    expect(sum).toBe(before.body.remainingOre);
    await agent.post(`/collection-cases/${id.case}/write-off`).send({ reason: 'igen' }).expect(409);
  });
});

describe('bokföring', () => {
  it('tar med ränta på 8313 och kundförlust på 6350 i SIE-exporten', async () => {
    const p = await agent.get('/accounting/sie/preview?from=2027-02-01&to=2027-06-30').expect(200);
    const accounts = p.body.summary.accounts as { account: string; debitOre: number; creditOre: number }[];
    const acc = (n: string) => accounts.find((a) => a.account === n);
    expect(acc('8313')?.creditOre).toBeGreaterThan(0);
    expect(acc('6350')?.debitOre).toBeGreaterThan(0);
    expect(p.body.summary.debitOre).toBe(accounts.reduce((a, x) => a + x.creditOre, 0));
  });
});

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetweenIso(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
