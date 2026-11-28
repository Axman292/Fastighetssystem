import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMandateFile, buildPaymentFile, mandateOutcome, parseAutogiroFile } from '../src/autogiro/autogiro-format';
import { holderId, splitClearing } from '../src/autogiro/autogiro.controller';
import { login, startApp } from './helpers';

/**
 * Autogiro är klart när medgivanden kan registreras och skickas till Bankgirot,
 * avier dras på förfallodagen via en betalningsfil, Bankgirots svar läses in och
 * bokförs, och hyresgästen får en vanlig avi när dragningen inte går igenom.
 */

const pad = (s: string | number, n: number, ch = '0') => String(s).padStart(n, ch);
const right = (s: string, n: number) => s.padEnd(n, ' ');

/** Bankgirots medgivandeavisering (AG-MEDAVI) i nya formatet. */
function mandateAdvice(customerNr: string, bg: string, rows: { payerNr: string; info: string; comment: string }[]) {
  const lines = [
    `01${right('AUTOGIRO', 20)}  20261201${' '.repeat(12)}${right('AG-MEDAVI', 20)}${pad(customerNr, 6)}${pad(bg, 10)}`,
    ...rows.map((r) => `73${pad(bg, 10)}${pad(r.payerNr, 16)}${pad('', 16)}${pad('', 12)}${' '.repeat(5)}${r.info}${r.comment}20261201${' '.repeat(7)}`),
    `0920261201${'9900'}${pad(rows.length, 7)}${' '.repeat(59)}`,
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Bankgirots betalningsspecifikation (BET. SPEC & STOPP TK). */
function paymentSpec(customerNr: string, bg: string, rows: { payerNr: string; amountOre: number; date: string; ref: string; status: string }[]) {
  const ok = rows.filter((r) => r.status === '0');
  const lines = [
    `01${right('AUTOGIRO', 20)}  ${'20261231120000000000'}${right('BET. SPEC & STOPP TK', 20)}${pad(customerNr, 6)}${pad(bg, 10)}`,
    `15${pad('12345678', 35)}20261231${pad(1, 5)}${pad(ok.reduce((s, r) => s + r.amountOre, 0), 18)}   ${pad(ok.length, 8)} `,
    ...rows.map((r) => `82${r.date.replace(/-/g, '')}0   ${' '}${pad(r.payerNr, 16)}${pad(r.amountOre, 12)}${pad(bg, 10)}${right(r.ref, 16)}${' '.repeat(10)}${r.status}`),
    `0920261231${'9900'}${pad(1, 6)}${pad(ok.length, 12)}${pad(0, 6)}${pad(0, 12)}${pad(0, 6)}${pad(0, 12)}${' '.repeat(12)}`,
  ];
  for (const l of lines) expect(l).toHaveLength(80);
  return lines.join('\r\n') + '\r\n';
}

describe('Autogirofiler utan databas', () => {
  it('skriver medgivanden och makuleringar med 80 tecken per post', () => {
    const f = buildMandateFile({
      date: '2026-11-30',
      customerNr: '4711',
      bankgiro: '5050-1055',
      orders: [
        { action: 'cancel', payerNr: '7' },
        { action: 'add', payerNr: '1001', clearingNr: '1234', accountNr: '1234567', holderId: '191212121212' },
        { action: 'reject', payerNr: '1002' },
      ],
    });
    const lines = f.split('\r\n').filter(Boolean);
    expect(lines.every((l) => l.length === 80)).toBe(true);
    expect(lines[0]).toBe(`0120261130AUTOGIRO${' '.repeat(44)}0047110050501055  `);
    expect(lines[1]).toBe(`0400505010550000000000001001123400000123456719121212121${'2'}${' '.repeat(24)}`);
    expect(lines[2].slice(76, 78)).toBe('AV');
    // Makuleringar kommer sist
    expect(lines[3]).toBe(`0300505010550000000000000007${' '.repeat(52)}`);
  });

  it('skriver dragningar med belopp i öre och OCR som referens', () => {
    const f = buildPaymentFile({
      date: '2026-11-30',
      customerNr: '4711',
      bankgiro: '5050-1055',
      payments: [{ payerNr: '1001', amountOre: 912_345, paymentDate: '2026-12-31', reference: '100164' }],
    });
    const l = f.split('\r\n')[1];
    expect(l).toHaveLength(80);
    expect(l.slice(0, 2)).toBe('82');
    expect(l.slice(2, 10)).toBe('20261231');
    expect(l.slice(10, 11)).toBe('0');
    expect(l.slice(15, 31)).toBe('0000000000001001');
    expect(l.slice(31, 43)).toBe('000000912345');
    expect(l.slice(43, 53)).toBe('0050501055');
    expect(l.slice(53, 69)).toBe('100164          ');
  });

  it('läser medgivandeavisering och betalningsspecifikation', () => {
    const m = parseAutogiroFile(mandateAdvice('4711', '50501055', [{ payerNr: '1001', info: '04', comment: '32' }]));
    expect(m).toMatchObject({ kind: 'mandate_advice', customerNr: '4711', bankgiro: '5050-1055' });
    expect(m.mandates[0]).toMatchObject({ payerNr: '1001', infoCode: '04', commentCode: '32', date: '2026-12-01' });
    const p = parseAutogiroFile(paymentSpec('4711', '50501055', [{ payerNr: '1001', amountOre: 500, date: '2026-12-31', ref: '123', status: '1' }]));
    expect(p.kind).toBe('payment_spec');
    expect(p.payments[0]).toMatchObject({ payerNr: '1001', amountOre: 500, reference: '123', code: '1', ok: false });
    expect(() => parseAutogiroFile('hej')).toThrow(/inte en Autogirofil/);
    const cut = mandateAdvice('4711', '50501055', [{ payerNr: '1001', info: '04', comment: '32' }]).split('\r\n').slice(0, 2).join('\r\n');
    expect(() => parseAutogiroFile(cut)).toThrow(/Slutposten/);
  });

  it('tolkar Bankgirots koder', () => {
    expect(mandateOutcome('04', '32')).toBe('active');
    expect(mandateOutcome('42', '32')).toBe('active');
    expect(mandateOutcome('04', '23')).toBe('rejected');
    expect(mandateOutcome('46', '02')).toBe('cancelled');
    expect(mandateOutcome('03', '33')).toBe('cancelled');
    expect(mandateOutcome('04', '10')).toBe('pending');
  });

  it('gör om personnummer, organisationsnummer och femsiffriga clearingnummer', () => {
    expect(holderId('19121212-1212')).toBe('191212121212');
    expect(holderId('121212+1212')).toBe('191212121212');
    expect(holderId('121212-1212')).toBe('201212121212');
    expect(holderId('556036-0793')).toBe('005560360793');
    expect(holderId('121212-1213')).toBeNull();
    expect(splitClearing('81234', '9876543')).toEqual({ clearingNr: '8123', accountNr: '49876543' });
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
const outbox = mkdtempSync(join(tmpdir(), 'utkorg-autogiro-'));
const id: Record<string, string> = {};
const nr: Record<string, number> = {};
const inv: Record<string, { id: string; ocr: string; totalOre: number; dueDate: string }> = {};

function upload(text: string, name = 'autogiro.txt') {
  return agent.post('/autogiro/files/incoming').attach('file', Buffer.from(text, 'latin1'), name);
}

beforeAll(async () => {
  process.env.OUTBOX_DIR = outbox;
  delete process.env.SMTP_HOST;
  delete process.env.BREVO_API_KEY;
  ({ app, stop } = await startApp('fastighet_test_autogiro'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const companyId = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent.patch(`/companies/${companyId}`).send({ bankgiro: '5050-1055', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.post('/auth/switch-company').send({ companyId }).expect(200);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential' }).expect(201);
  for (const [key, objectNr] of [['apt1', '1001'], ['apt2', '1002']]) {
    const r = await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', objectNr, type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 }).expect(201);
    id[key] = r.body.id;
  }
  for (const [key, name, email] of [['anna', 'Anna Testsson', 'anna@example.se'], ['bo', 'Bo Exempel', 'bo@example.se']]) {
    const r = await agent
      .post('/customers')
      .send({ kind: 'person', name, email, deliveryMethod: 'email', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' })
      .expect(201);
    id[key] = r.body.id;
    nr[key] = r.body.customerNr;
  }
  for (const [c, o] of [['anna', 'apt1'], ['bo', 'apt2']]) {
    const r = await agent.post('/contracts').send({ type: 'residential', customerId: id[c], startDate: '2026-12-01', objectIds: [id[o]] }).expect(201);
    await agent.post(`/contracts/${r.body.id}/activate`).send({}).expect(201);
  }
});

afterAll(async () => {
  await stop();
});

describe('Autogiro', () => {
  it('kräver kundnummer hos Bankgirot för att slås på', async () => {
    const r = await agent.put('/autogiro/settings').send({ enabled: true, customerNr: '' });
    expect(r.status).toBe(400);
    const ok = await agent.put('/autogiro/settings').send({ enabled: true, customerNr: '4711', bankgiro: '' }).expect(200);
    expect(ok.body).toMatchObject({ enabled: true, customerNr: '4711', bankgiro: null, companyBankgiro: '5050-1055' });
  });

  it('registrerar medgivanden och stoppar dubbletter', async () => {
    const a = await agent
      .post('/autogiro/mandates')
      .send({ customerId: id.anna, clearingNr: '1234', accountNr: '123 456-7', holderId: '19121212-1212', signedDate: '2026-11-20' })
      .expect(201);
    expect(a.body).toMatchObject({ status: 'new', payerNr: String(nr.anna), clearingNr: '1234', accountNr: '1234567', holderId: '191212121212' });
    id.mandateAnna = a.body.id;
    const b = await agent.post('/autogiro/mandates').send({ customerId: id.bo, clearingNr: '81234', accountNr: '9876543', holderId: '121212-1212' }).expect(201);
    expect(b.body).toMatchObject({ clearingNr: '8123', accountNr: '49876543' });
    id.mandateBo = b.body.id;
    const dup = await agent.post('/autogiro/mandates').send({ customerId: id.anna, clearingNr: '1234', accountNr: '1', holderId: '19121212-1212' });
    expect(dup.status).toBe(409);
    const bad = await agent.post('/autogiro/mandates').send({ customerId: id.anna, clearingNr: '1234', accountNr: '1', holderId: '121212-1213' });
    expect(bad.status).toBe(400);
  });

  it('skapar en medgivandefil och läser Bankgirots svar', async () => {
    const f = await agent.post('/autogiro/files/mandates').expect(201);
    expect(f.body.count).toBe(2);
    const dl = await agent.get(`/autogiro/files/${f.body.id}/download`).expect(200);
    const lines = dl.text.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.every((l: string) => l.length === 80)).toBe(true);
    const again = await agent.post('/autogiro/files/mandates');
    expect(again.status).toBe(409);
    await agent.post(`/autogiro/files/${f.body.id}/uploaded`).expect(201);

    const advice = mandateAdvice('4711', '50501055', [
      { payerNr: String(nr.anna), info: '04', comment: '32' },
      { payerNr: String(nr.bo), info: '04', comment: '32' },
    ]);
    const r = await upload(advice).expect(201);
    expect(r.body.lines.map((l: { outcome: string }) => l.outcome)).toEqual(['Godkänt', 'Godkänt']);
    expect((await upload(advice)).status).toBe(409);
    const list = await agent.get('/autogiro/mandates').expect(200);
    expect(list.body.every((m: { status: string }) => m.status === 'active')).toBe(true);
  });

  it('nekar svarsfiler för ett annat kundnummer', async () => {
    const r = await upload(mandateAdvice('999', '50501055', [{ payerNr: '1', info: '04', comment: '32' }]));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/kundnummer 999/);
  });

  it('planerar dragningar när aviseringskörningen godkänns och skriver det på avin', async () => {
    const run = await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-10' }).expect(201);
    const detail = await agent.get(`/billing-runs/${run.body.id}`).expect(200);
    await agent.post(`/billing-runs/${run.body.id}/approve`).send({ fingerprint: detail.body.fingerprint, acknowledgeWarnings: true }).expect(201);
    const list = await agent.get('/invoices').expect(200);
    for (const i of list.body) inv[i.customerId === id.anna ? 'anna' : 'bo'] = i;
    const planned = await agent.get('/autogiro/payments?status=planned').expect(200);
    expect(planned.body).toHaveLength(2);
    expect(planned.body.find((p: { invoiceId: string }) => p.invoiceId === inv.anna.id)).toMatchObject({
      amountOre: inv.anna.totalOre,
      paymentDate: inv.anna.dueDate,
      reference: inv.anna.ocr,
    });
    // Avin säger att den dras via autogiro
    await agent.post(`/billing-runs/${run.body.id}/send`).expect(201);
    const mail = readdirSync(outbox).map((f) => readFileSync(join(outbox, f), 'latin1')).join('\n');
    expect(mail).toMatch(/Dras via autogiro/);
  });

  it('skapar en betalningsfil med dragningarna', async () => {
    const f = await agent.post('/autogiro/files/payments').expect(201);
    expect(f.body).toMatchObject({ count: 2, totalOre: inv.anna.totalOre + inv.bo.totalOre });
    const dl = await agent.get(`/autogiro/files/${f.body.id}/download`).expect(200);
    const tk82 = dl.text.split('\r\n').filter((l: string) => l.startsWith('82'));
    expect(tk82).toHaveLength(2);
    expect(tk82.map((l: string) => l.slice(53, 69).trim()).sort()).toEqual([inv.anna.ocr, inv.bo.ocr].sort());
    const sent = await agent.get('/autogiro/payments?status=sent').expect(200);
    expect(sent.body).toHaveLength(2);
    // Inget planerat kvar
    expect((await agent.post('/autogiro/files/payments')).status).toBe(409);
  });

  it('bokför dragna betalningar och skickar vanlig avi när dragningen misslyckas', async () => {
    const beforeFiles = new Set(readdirSync(outbox));
    const before = beforeFiles.size;
    const spec = paymentSpec('4711', '50501055', [
      { payerNr: String(nr.anna), amountOre: inv.anna.totalOre, date: inv.anna.dueDate, ref: inv.anna.ocr, status: '0' },
      { payerNr: String(nr.bo), amountOre: inv.bo.totalOre, date: inv.bo.dueDate, ref: inv.bo.ocr, status: '1' },
    ]);
    const r = await upload(spec).expect(201);
    expect(r.body).toMatchObject({ paid: 1, failed: 1, fallbacks: 1, unmatched: 0 });
    const a = await agent.get(`/invoices/${inv.anna.id}`).expect(200);
    expect(a.body).toMatchObject({ balanceOre: 0, state: 'paid' });
    expect(a.body.payments[0]).toMatchObject({ method: 'autogiro' });
    const b = await agent.get(`/invoices/${inv.bo.id}`).expect(200);
    expect(b.body.balanceOre).toBe(inv.bo.totalOre);
    expect(b.body.deliveries).toHaveLength(2);
    const newMail = readdirSync(outbox)
      .filter((f) => !beforeFiles.has(f))
      .map((f) => readFileSync(join(outbox, f), 'latin1'))
      .join('\n');
    expect(readdirSync(outbox).length).toBe(before + 1);
    expect(newMail).toMatch(/gick inte igenom/);
    const failed = await agent.get('/autogiro/payments?status=failed').expect(200);
    expect(failed.body[0]).toMatchObject({ invoiceId: inv.bo.id, statusCode: '1', fallbackChannel: 'email' });
    // Samma betalning bokförs aldrig två gånger, även i en ny fil
    const again = await upload(spec.replace('20261231120000000000', '20261231130000000000')).expect(201);
    expect(again.body.paid).toBe(0);
    expect((await agent.get(`/invoices/${inv.anna.id}`).expect(200)).body.payments).toHaveLength(1);
  });

  it('makulerar ett medgivande och skickar makuleringen till Bankgirot', async () => {
    const r = await agent.post(`/autogiro/mandates/${id.mandateBo}/cancel`).expect(201);
    expect(r.body.status).toBe('cancel_new');
    const f = await agent.post('/autogiro/files/mandates').expect(201);
    const dl = await agent.get(`/autogiro/files/${f.body.id}/download`).expect(200);
    expect(dl.text.split('\r\n')[1].slice(0, 2)).toBe('03');
    await upload(mandateAdvice('4711', '50501055', [{ payerNr: String(nr.bo), info: '03', comment: '33' }])).expect(201);
    const m = await agent.get(`/autogiro/mandates?customerId=${id.bo}`).expect(200);
    expect(m.body[0].status).toBe('cancelled');
  });

  it('tar emot medgivanden från internetbanken för granskning', async () => {
    const bg = '0050501055';
    const lines = [
      `5120261202${'9900'}${bg}${right('AG-EMEDGIV', 20)}${' '.repeat(36)}`,
      `52${bg}${pad(nr.bo, 16)}${pad('5555', 4)}${pad('1112223', 12)}191212121212${' '.repeat(5)}0${' '.repeat(18)}`,
      `54${right('BO EXEMPEL', 36)}${right('KVARNGATAN 4', 36)}${' '.repeat(6)}`,
      `5621111${right('MALMO', 31)}${' '.repeat(42)}`,
      `5920261202${'9900'}${pad(5, 7)}${' '.repeat(59)}`,
    ];
    for (const l of lines) expect(l).toHaveLength(80);
    const r = await upload(lines.join('\r\n') + '\r\n').expect(201);
    expect(r.body.lines[0].outcome).toBe('Att granska');
    const m = (await agent.get(`/autogiro/mandates?customerId=${id.bo}`).expect(200)).body.find((x: { status: string }) => x.status === 'review');
    expect(m).toMatchObject({ source: 'internet_bank', clearingNr: '5555', accountNr: '1112223' });
    await agent.post(`/autogiro/mandates/${m.id}/respond`).send({ approve: true }).expect(201);
    const f = await agent.post('/autogiro/files/mandates').expect(201);
    const dl = await agent.get(`/autogiro/files/${f.body.id}/download`).expect(200);
    const tk04 = dl.text.split('\r\n')[1];
    expect(tk04.slice(0, 2)).toBe('04');
    expect(tk04.slice(76, 78)).toBe('  ');
  });

  it('ger en medgivandeblankett som PDF', async () => {
    const r = await agent.get(`/autogiro/mandate-form.pdf?customerId=${id.anna}`).buffer(true).expect(200);
    expect(r.headers['content-type']).toMatch(/pdf/);
  });
});
