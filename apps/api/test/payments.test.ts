import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBgMax, parseBgMax } from '../src/payments/bgmax';
import { lateInterest } from '../src/payments/reminders';
import { namesMatch } from '../src/payments/payment-store';
import { login, startApp } from './helpers';

/**
 * Fas 5 är klar när bankens inbetalningsfiler kan läsas in och matchas mot fakturor,
 * omatchade och överskjutande belopp kan hanteras, förfallna fakturor kan påminnas
 * och kundreskontran visar vad varje kund är skyldig.
 */

describe('BgMax utan databas', () => {
  it('läser betalningar, namn och betalningsdag', () => {
    const text = buildBgMax({
      bankgiro: '5050-1055',
      date: '2027-01-05',
      payments: [
        { reference: '100164', amountOre: 900_000, name: 'Tolvan Tolvansson', serial: '000000000001' },
        { reference: 'HYRA JANUARI', amountOre: 50_000, serial: '000000000002' },
      ],
    });
    const f = parseBgMax(text);
    expect(f.bankgiro).toBe('5050-1055');
    expect(f.payments).toHaveLength(2);
    expect(f.payments[0]).toMatchObject({ reference: '100164', amountOre: 900_000, payerName: 'Tolvan Tolvansson', paymentDate: '2027-01-05', bgcSerial: '000000000001', referenceCode: '2' });
    expect(f.payments[1].reference).toBe('HYRA JANUARI');
    expect(f.deposits[0].amountOre).toBe(950_000);
  });

  it('stoppar filer som inte stämmer', () => {
    const ok = buildBgMax({ bankgiro: '5050-1055', date: '2027-01-05', payments: [{ reference: '1', amountOre: 100 }] });
    expect(() => parseBgMax('hej')).toThrow(/inte en BgMax-fil/);
    expect(() => parseBgMax(ok.split('\r\n').slice(0, -2).join('\r\n'))).toThrow(/Slutposten saknas/);
    const badSum = ok
      .split('\r\n')
      .map((l) => (l.startsWith('15') ? l.slice(0, 50) + '999'.padStart(18, '0') + l.slice(68) : l))
      .join('\r\n');
    expect(() => parseBgMax(badSum)).toThrow(/summerar/);
  });

  it('jämför inbetalarens namn med kundens innan fakturanummer i fritext används', () => {
    expect(namesMatch('BO EXEMPEL', 'Bo Exempel')).toBe(true);
    expect(namesMatch('FILIP PAHITTAD', 'Filip Påhittad')).toBe(true);
    expect(namesMatch('OKAND BETALARE', 'Bo Exempel')).toBe(false);
    expect(namesMatch(null, 'Bo Exempel')).toBe(false);
  });

  it('räknar dröjsmålsränta per dag', () => {
    expect(lateInterest(1_000_000, 1000, '2027-01-01', '2027-01-01')).toBe(0);
    expect(lateInterest(1_000_000, 1000, '2027-01-01', '2028-01-01')).toBe(100_000);
    expect(lateInterest(1_000_000, 1000, '2027-01-01', '2027-01-31')).toBe(8219);
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let db: Client;
const outbox = mkdtempSync(join(tmpdir(), 'utkorg-fas5-'));
const id: Record<string, string> = {};
const inv: Record<string, { id: string; invoiceNr: number; ocr: string; totalOre: number }> = {};

function upload(text: string, name = 'bgmax.txt') {
  return agent.post('/bank-files').attach('file', Buffer.from(text, 'latin1'), name);
}

beforeAll(async () => {
  process.env.OUTBOX_DIR = outbox;
  delete process.env.SMTP_HOST;
  ({ app, stop } = await startApp('fastighet_test_fas5'));
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent.patch(`/companies/${companyA}`).send({ bankgiro: '5050-1055', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential' }).expect(201);
  const mk = async (key: string, objectNr: string) => {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', objectNr, type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 }).expect(201);
    id[key] = r.body.id;
  };
  await mk('apt1', '1001');
  await mk('apt2', '1002');
  const cust = async (key: string, name: string, email: string | null) => {
    const r = await agent
      .post('/customers')
      .send({ kind: 'person', name, email, deliveryMethod: email ? 'email' : 'post', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
      .expect(201);
    id[key] = r.body.id;
  };
  await cust('anna', 'Anna Testsson', 'anna@example.se');
  await cust('bo', 'Bo Exempel', null);
  for (const [k, c, o] of [['k1', 'anna', 'apt1'], ['k2', 'bo', 'apt2']] as const) {
    const r = await agent.post('/contracts').send({ type: 'residential', customerId: id[c], startDate: '2026-12-01', objectIds: [id[o]] }).expect(201);
    id[k] = r.body.id;
    await agent.post(`/contracts/${r.body.id}/activate`).send({}).expect(201);
  }
  for (const [month, invoiceDate] of [['2027-01', '2026-12-10'], ['2027-02', '2027-01-10']]) {
    const run = await agent.post('/billing-runs').send({ periodMonth: month, invoiceDate }).expect(201);
    const detail = await agent.get(`/billing-runs/${run.body.id}`).expect(200);
    const ok = await agent.post(`/billing-runs/${run.body.id}/approve`).send({ fingerprint: detail.body.fingerprint, acknowledgeWarnings: true }).expect(201);
    expect(ok.body.ok).toBe(true);
  }
  const list = await agent.get('/invoices').expect(200);
  for (const i of list.body) {
    const who = i.customerId === id.anna ? 'anna' : 'bo';
    inv[`${who}${i.periodFrom.slice(5, 7)}`] = i;
  }
  expect(Object.keys(inv).sort()).toEqual(['anna01', 'anna02', 'bo01', 'bo02']);
});

afterAll(async () => {
  await db.end();
  await stop();
});

describe('inläsning av BgMax', () => {
  it('nekar en fil för ett annat bankgiro', async () => {
    const r = await upload(buildBgMax({ bankgiro: '123-4567', date: '2027-01-02', payments: [{ reference: inv.anna01.ocr, amountOre: 100 }] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/bankgiro 123-4567/);
  });

  it('matchar på OCR, på fakturanummer och lämnar resten omatchat', async () => {
    const text = buildBgMax({
      bankgiro: '5050-1055',
      date: '2027-01-02',
      payments: [
        { reference: inv.anna01.ocr, amountOre: inv.anna01.totalOre + 10_000, name: 'ANNA TESTSSON', serial: '270102000001' }, // 100 kr för mycket
        { reference: `Faktura ${inv.bo01.invoiceNr}`, amountOre: 400_000, name: 'BO EXEMPEL', serial: '270102000002' }, // delbetalning
        { reference: '999999', amountOre: 25_000, name: 'OKAND BETALARE', serial: '270102000003' },
      ],
    });
    const r = await upload(text, 'BGMAX_20270102.txt');
    expect(r.status).toBe(201);
    id.file1 = r.body.id;
    id.file1Text = text;
    const f = await agent.get(`/bank-files/${id.file1}`).expect(200);
    expect(f.body).toMatchObject({ status: 'draft', paymentCount: 3, bankgiro: '5050-1055' });
    const [a, b, c] = f.body.transactions;
    expect(a).toMatchObject({ status: 'matched', matchRule: 'ocr', invoiceId: inv.anna01.id, customerId: id.anna, paymentDate: '2027-01-02' });
    expect(b).toMatchObject({ status: 'matched', matchRule: 'invoice_nr', invoiceId: inv.bo01.id });
    expect(c).toMatchObject({ status: 'unmatched', customerId: null });
    id.unmatchedTx = c.id;
    // Inget är bokfört ännu
    const paid = await agent.get(`/invoices/${inv.anna01.id}`).expect(200);
    expect(paid.body.paidOre).toBe(0);
  });

  it('läser aldrig in samma fil två gånger', async () => {
    const r = await upload(id.file1Text, 'kopia.txt');
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/redan inläst/);
  });

  it('bokför matchade betalningar och fördelar dem', async () => {
    const r = await agent.post(`/bank-files/${id.file1}/book`).expect(201);
    expect(r.body).toEqual({ booked: 2, unmatched: 1 });
    const a = await agent.get(`/invoices/${inv.anna01.id}`).expect(200);
    expect(a.body).toMatchObject({ paidOre: inv.anna01.totalOre, balanceOre: 0, state: 'paid' });
    const b = await agent.get(`/invoices/${inv.bo01.id}`).expect(200);
    expect(b.body).toMatchObject({ paidOre: 400_000, balanceOre: inv.bo01.totalOre - 400_000 });
    // Överskottet ligger kvar som ej fördelat på Anna
    const pays = await agent.get(`/payments?customerId=${id.anna}`).expect(200);
    expect(pays.body[0]).toMatchObject({ amountOre: inv.anna01.totalOre + 10_000, unallocatedOre: 10_000 });
    id.annaPayment = pays.body[0].id;
    await agent.post(`/bank-files/${id.file1}/book`).expect(409);
    await agent.delete(`/bank-files/${id.file1}`).expect(409);
  });

  it('bokför aldrig samma betalning två gånger, även i en ny fil', async () => {
    const text = buildBgMax({
      bankgiro: '5050-1055',
      date: '2027-01-03',
      payments: [
        { reference: inv.anna01.ocr, amountOre: inv.anna01.totalOre + 10_000, serial: '270102000001' },
        { reference: inv.bo01.ocr, amountOre: 100_000, serial: '270103000001' },
      ],
    });
    const r = await upload(text, 'BGMAX_20270103.txt');
    expect(r.status).toBe(201);
    const f = await agent.get(`/bank-files/${r.body.id}`).expect(200);
    expect(f.body.transactions.map((t: { status: string }) => t.status)).toEqual(['duplicate', 'matched']);
    await agent.patch(`/bank-transactions/${f.body.transactions[0].id}`).send({ customerId: id.anna }).expect(409);
    // Fel fil kan tas bort innan den bokförs
    await agent.delete(`/bank-files/${r.body.id}`).expect(204);
  });

  it('föreslår kund och faktura på namn och belopp när OCR saknas, men bokför inte utan bekräftelse', async () => {
    const text = buildBgMax({
      bankgiro: '5050-1055',
      date: '2027-01-04',
      payments: [
        { amountOre: inv.anna02.totalOre, name: 'TESTSSON ANNA', serial: '270104000001' },
        { reference: 'HYRA', amountOre: 123_400, name: 'ANNA TESTSSON', serial: '270104000002' },
        { amountOre: inv.anna02.totalOre, name: 'NAGON ANNAN', serial: '270104000003' },
      ],
    });
    const r = await upload(text, 'BGMAX_20270104.txt').expect(201);
    const f = await agent.get(`/bank-files/${r.body.id}`).expect(200);
    const [exact, nameOnly, nobody] = f.body.transactions;
    expect(exact).toMatchObject({ status: 'unmatched', matchRule: 'name_amount', customerId: id.anna, invoiceId: inv.anna02.id });
    expect(exact.note).toMatch(/Namn och belopp stämmer/);
    expect(nameOnly).toMatchObject({ status: 'unmatched', matchRule: 'name_amount', customerId: id.anna, invoiceId: null });
    expect(nobody).toMatchObject({ status: 'unmatched', matchRule: null, customerId: null });
    // Bokför tar bara med säkra matchningar
    const b = await agent.post(`/bank-files/${r.body.id}/book`).expect(201);
    expect(b.body).toEqual({ booked: 0, unmatched: 3 });
    // Ett bekräftat förslag bokförs direkt
    await agent.patch(`/bank-transactions/${exact.id}`).send({ customerId: exact.customerId, invoiceId: exact.invoiceId }).expect(200);
    expect((await agent.get(`/invoices/${inv.anna02.id}`).expect(200)).body.balanceOre).toBe(0);
    // Ta tillbaka så att resten av testerna har samma utgångsläge
    const p = (await agent.get(`/payments?customerId=${id.anna}`).expect(200)).body.find((x: { bankTransactionId: string }) => x.bankTransactionId === exact.id);
    await agent.delete(`/payments/${p.id}`).expect(204);
    for (const t of f.body.transactions) await agent.patch(`/bank-transactions/${t.id}`).send({ ignore: true, note: 'Testdata' }).expect(200);
  });

  it('bokför en omatchad betalning när kunden pekats ut', async () => {
    const open = await agent.get('/bank-transactions?status=unmatched').expect(200);
    expect(open.body.map((t: { id: string }) => t.id)).toContain(id.unmatchedTx);
    const r = await agent.patch(`/bank-transactions/${id.unmatchedTx}`).send({ customerId: id.bo, note: 'Bo ringde och bekräftade' }).expect(200);
    expect(r.body).toMatchObject({ status: 'booked', matchRule: 'manual', customerName: 'Bo Exempel' });
    // Utan faktura fördelas betalningen på Bos äldsta obetalda faktura
    const b = await agent.get(`/invoices/${inv.bo01.id}`).expect(200);
    expect(b.body.paidOre).toBe(425_000);
  });

  it('kan ta bort en felbokad bankbetalning, som då väntar på ny hantering', async () => {
    const pays = await agent.get(`/payments?customerId=${id.bo}`).expect(200);
    const manual = pays.body.find((p: { amountOre: number }) => p.amountOre === 25_000);
    await agent.delete(`/payments/${manual.id}`).expect(204);
    const t = (await agent.get('/bank-transactions?status=unmatched').expect(200)).body.find((x: { id: string }) => x.id === id.unmatchedTx);
    expect(t).toMatchObject({ status: 'unmatched', customerId: null });
    await agent.patch(`/bank-transactions/${id.unmatchedTx}`).send({ ignore: true, note: 'Återbetald av banken' }).expect(200);
    const after = await agent.get('/bank-transactions?status=ignored').expect(200);
    expect(after.body.find((x: { id: string }) => x.id === id.unmatchedTx)).toMatchObject({ note: 'Återbetald av banken' });
  });
});

describe('överbetalning och återbetalning', () => {
  it('fördelar ej fördelat belopp på nästa faktura', async () => {
    const r = await agent.post(`/payments/${id.annaPayment}/allocate`).send({}).expect(201);
    expect(r.body.allocations).toEqual([{ invoiceId: inv.anna02.id, amountOre: 10_000 }]);
    expect(r.body.unallocatedOre).toBe(0);
    await agent.post(`/payments/${id.annaPayment}/allocate`).send({}).expect(409);
  });

  it('betalar tillbaka överskott men aldrig mer än det som är ej fördelat', async () => {
    await agent.delete(`/payments/${id.annaPayment}/allocations`).expect(204);
    await agent.post(`/payments/${id.annaPayment}/allocate`).send({ invoiceId: inv.anna01.id }).expect(201);
    await agent.post(`/payments/${id.annaPayment}/refunds`).send({ amount: 150, refundDate: '2027-01-10' }).expect(400);
    const r = await agent.post(`/payments/${id.annaPayment}/refunds`).send({ amount: 100, refundDate: '2027-01-10', note: 'Till kundens konto' }).expect(201);
    expect(r.body).toMatchObject({ refundedOre: 10_000, unallocatedOre: 0 });
    // Databasen stoppar överfördelning även om koden skulle försöka
    await expect(
      db.query(`insert into payment_allocation (company_id, payment_id, invoice_id, amount_ore) values ($1, $2, $3, 1)`, [companyA, id.annaPayment, inv.anna02.id]),
    ).rejects.toThrow(/räcker inte/);
    // En återbetald betalning kan inte tas bort
    await agent.delete(`/payments/${id.annaPayment}`).expect(409);
  });

  it('registrerar en kontant betalning på kunden', async () => {
    const r = await agent.post('/payments').send({ customerId: id.bo, amount: 1000, paymentDate: '2027-01-12', method: 'cash' }).expect(201);
    expect(r.body.allocations[0]).toMatchObject({ invoiceId: inv.bo01.id, amountOre: 100_000 });
    const b = await agent.get(`/invoices/${inv.bo01.id}`).expect(200);
    expect(b.body.balanceOre).toBe(inv.bo01.totalOre - 500_000);
  });
});

describe('påminnelser', () => {
  it('föreslår förfallna fakturor efter fristen', async () => {
    // Bo 01 förföll 2026-12-30. Fristen är 5 dagar.
    const early = await agent.get('/reminders/suggestion?date=2027-01-03').expect(200);
    expect(early.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id).action).toBe('wait');
    const s = await agent.get('/reminders/suggestion?date=2027-01-10').expect(200);
    const bo = s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id);
    expect(bo).toMatchObject({ action: 'remind', nextLevel: 1, feeOre: 6000, channel: 'post', balanceOre: inv.bo01.totalOre - 500_000 });
    expect(bo.interestOre).toBeGreaterThan(0);
    expect(s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.anna01.id)).toBeUndefined(); // betald
    expect(s.body.settings).toMatchObject({ feeOre: 6000, graceDays: 5, dueDays: 10, interestBp: 1000 });
  });

  it('skickar påminnelse med avgift på en egen avgiftsfaktura', async () => {
    // Anna får också en förfallen faktura att påminnas om
    const s = await agent.get('/reminders/suggestion?date=2027-02-10').expect(200);
    const anna = s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.anna02.id);
    expect(anna).toMatchObject({ action: 'remind', channel: 'email', recipient: 'anna@example.se' });
    const r = await agent.post('/reminders').send({ reminderDate: '2027-02-10', invoiceIds: [inv.anna02.id, inv.bo01.id, inv.anna01.id] }).expect(201);
    expect(r.body.created).toHaveLength(2);
    expect(r.body.skipped).toEqual([{ invoiceId: inv.anna01.id, reason: 'Fakturan är betald eller inte förfallen' }]);
    expect(r.body.delivery).toMatchObject({ test: 1, post: 1, failed: 0 });
    const eml = readdirSync(outbox).find((f) => f.includes('paminnelse'));
    expect(eml).toBeTruthy();
    const mail = readFileSync(join(outbox, eml!), 'utf8');
    expect(mail).toMatch(/Betalningsp=C3=A5minnelse|Betalningspåminnelse/);
    expect(mail).toContain(inv.anna02.ocr);

    const list = await agent.get(`/reminders?invoiceId=${inv.anna02.id}`).expect(200);
    expect(list.body[0]).toMatchObject({ level: 1, feeOre: 6000, status: 'test', dueDate: '2027-02-22' });
    const fee = await agent.get(`/invoices/${list.body[0].feeInvoiceId}`).expect(200);
    expect(fee.body).toMatchObject({ status: 'issued', totalOre: 6000, vatOre: 0, deliveries: [] });
    expect(fee.body.lines[0]).toMatchObject({ article: 'fee', objectId: id.apt1 });
    id.annaFeeInvoice = fee.body.id;

    // Samma nivå skickas inte två gånger
    const again = await agent.post('/reminders').send({ reminderDate: '2027-02-11', invoiceIds: [inv.anna02.id] }).expect(201);
    expect(again.body.created).toHaveLength(0);
  });

  it('skriver ut brevpåminnelser och markerar dem som skickade', async () => {
    const pdf = await agent.get('/reminders/print.pdf').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const queued = await agent.get('/reminders?status=queued').expect(200);
    expect(queued.body).toHaveLength(1);
    const m = await agent.post('/reminders/mark-printed').send({ ids: queued.body.map((r: { id: string }) => r.id) }).expect(201);
    expect(m.body.printed).toBe(1);
  });

  it('tar andra påminnelsen utan ny avgift och sedan inkasso', async () => {
    const s = await agent.get('/reminders/suggestion?date=2027-02-25').expect(200);
    const bo = s.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id);
    expect(bo).toMatchObject({ action: 'remind', nextLevel: 2, feeOre: 0 });
    // Avgiftsfakturan påminns inte i sin tur
    expect(s.body.candidates.some((c: { invoiceId: string }) => c.invoiceId === id.annaFeeInvoice)).toBe(false);
    await agent.post('/reminders').send({ reminderDate: '2027-02-25', invoiceIds: [inv.bo01.id] }).expect(201);
    const later = await agent.get('/reminders/suggestion?date=2027-03-20').expect(200);
    expect(later.body.candidates.find((c: { invoiceId: string }) => c.invoiceId === inv.bo01.id).action).toBe('collection');
  });

  it('fördelar en betalning på OCR först på fakturan och sedan på avgiften', async () => {
    const a = await agent.get(`/invoices/${inv.anna02.id}`).expect(200);
    const text = buildBgMax({ bankgiro: '5050-1055', date: '2027-02-15', payments: [{ reference: inv.anna02.ocr, amountOre: a.body.balanceOre + 6000, serial: '270215000001' }] });
    const f = await upload(text, 'BGMAX_20270215.txt').expect(201);
    await agent.post(`/bank-files/${f.body.id}/book`).expect(201);
    expect((await agent.get(`/invoices/${inv.anna02.id}`).expect(200)).body.balanceOre).toBe(0);
    expect((await agent.get(`/invoices/${id.annaFeeInvoice}`).expect(200)).body.balanceOre).toBe(0);
  });

  it('kräver giltig påminnelseavgift i bolagets inställningar', async () => {
    await agent.patch(`/companies/${companyA}`).send({ reminderFee: 75 }).expect(400);
    const r = await agent.patch(`/companies/${companyA}`).send({ reminderFee: 50, lateInterestRate: 10.5 }).expect(200);
    expect(r.body).toMatchObject({ reminderFeeOre: 5000, lateInterestBp: 1050 });
  });
});

describe('kundreskontra', () => {
  it('visar saldo per kund och ett kontoutdrag som går ihop', async () => {
    const l = await agent.get('/ledger').expect(200);
    const bo = l.body.customers.find((c: { customerId: string }) => c.customerId === id.bo);
    // Två obetalda hyresavier och påminnelseavgiften
    const boOpen = inv.bo01.totalOre - 500_000 + inv.bo02.totalOre + 6000;
    expect(bo).toMatchObject({ openCount: 3, openOre: boOpen, unallocatedOre: 0, balanceOre: boOpen, reminderLevel: 2 });
    expect(l.body.customers.find((c: { customerId: string }) => c.customerId === id.anna)).toBeUndefined(); // allt betalt
    expect(l.body.totals.openOre).toBe(boOpen);

    const s = await agent.get(`/ledger/customers/${id.bo}`).expect(200);
    expect(s.body.balanceOre).toBe(boOpen);
    expect(s.body.entries.at(-1).balanceOre).toBe(boOpen);
    expect(s.body.entries.filter((e: { type: string }) => e.type === 'payment')).toHaveLength(2);
    expect(s.body.open.map((o: { invoiceNr: number }) => o.invoiceNr).slice(0, 2)).toEqual([inv.bo01.invoiceNr, inv.bo02.invoiceNr]);
    expect(s.body.open).toHaveLength(3);

    const anna = await agent.get(`/ledger/customers/${id.anna}`).expect(200);
    // Fakturor + avgift − inbetalningar + återbetalning = 0
    expect(anna.body.balanceOre).toBe(0);
    expect(anna.body.entries.some((e: { type: string }) => e.type === 'refund')).toBe(true);
  });

  it('skapar kontoutdrag som PDF', async () => {
    const pdf = await agent.get(`/ledger/customers/${id.bo}/statement.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});
