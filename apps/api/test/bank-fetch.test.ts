import type { INestApplication } from '@nestjs/common';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Server, utils as sshUtils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCamt054, parseCamt } from '../src/payments/camt';
import { parseBankFile } from '../src/payments/bank-import';
import { patternMatches, runDue } from '../src/payments/bank-fetch';
import { buildBgMax } from '../src/payments/bgmax';
import { login, startApp } from './helpers';

/**
 * Automatisk inläsning av inbetalningar: camt.054 (som ersätter BgMax från 28 november 2026),
 * hämtning från bankens SFTP-server och från en mapp, automatisk bokföring av matchade
 * betalningar och rapport över det som återstår.
 */

describe('camt.054 utan databas', () => {
  it('läser OCR, fritext, inbetalare och uttag', () => {
    const f = parseCamt(
      buildCamt054({
        bankgiro: '5050-1055',
        date: '2027-01-05',
        payments: [
          { reference: '0010016', amountOre: 900_050, name: 'Tolvan Tolvansson', serial: 'A1' },
          { text: 'HYRA JANUARI LGH 1001', amountOre: 50_000, serial: 'A2' },
          { amountOre: 1_500, debit: true, serial: 'A3' },
        ],
      }),
    );
    expect(f.format).toBe('camt054');
    expect(f.accounts).toHaveLength(1);
    expect(f.accounts[0].bankgiro).toBe('5050-1055');
    const [a, b, c] = f.accounts[0].payments;
    expect(a).toMatchObject({ kind: 'payment', reference: '0010016', referenceCode: 'SCOR', amountOre: 900_050, payerName: 'Tolvan Tolvansson', paymentDate: '2027-01-05', bgcSerial: 'A1' });
    expect(b).toMatchObject({ kind: 'payment', reference: 'HYRA JANUARI LGH 1001', referenceCode: 'USTRD', payerName: null });
    expect(c).toMatchObject({ kind: 'deduction', amountOre: 1_500 });
  });

  it('läser äldre version med namnrymdsprefix, flera transaktioner per post och IBAN', () => {
    const xml = `<?xml version="1.0"?>
<ns:Document xmlns:ns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"><ns:BkToCstmrDbtCdtNtfctn>
<ns:GrpHdr><ns:MsgId>X1</ns:MsgId><ns:CreDtTm>2027-02-01T07:00:00</ns:CreDtTm></ns:GrpHdr>
<ns:Ntfctn><ns:Acct><ns:Id><ns:IBAN>SE45 1200 0000 0121 2345 6789</ns:IBAN></ns:Id></ns:Acct>
<ns:Ntry><ns:Amt Ccy="SEK">300.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:Sts>BOOK</ns:Sts><ns:BookgDt><ns:Dt>2027-02-01</ns:Dt></ns:BookgDt>
<ns:AcctSvcrRef>E9</ns:AcctSvcrRef>
<ns:NtryDtls>
 <ns:TxDtls><ns:AmtDtls><ns:TxAmt><ns:Amt Ccy="SEK">100.00</ns:Amt></ns:TxAmt></ns:AmtDtls>
  <ns:RltdPties><ns:Dbtr><ns:Nm>Bo Exempel</ns:Nm><ns:Id><ns:OrgId><ns:Othr><ns:Id>5560000001</ns:Id></ns:Othr></ns:OrgId></ns:Id></ns:Dbtr></ns:RltdPties>
  <ns:RmtInf><ns:Strd><ns:CdtrRefInf><ns:Ref>111</ns:Ref></ns:CdtrRefInf></ns:Strd><ns:Strd><ns:RfrdDocAmt><ns:RmtdAmt Ccy="SEK">50.00</ns:RmtdAmt></ns:RfrdDocAmt><ns:CdtrRefInf><ns:Ref>222</ns:Ref></ns:CdtrRefInf></ns:Strd></ns:RmtInf></ns:TxDtls>
 <ns:TxDtls><ns:AmtDtls><ns:TxAmt><ns:Amt Ccy="SEK">200.00</ns:Amt></ns:TxAmt></ns:AmtDtls></ns:TxDtls>
</ns:NtryDtls></ns:Ntry>
<ns:Ntry><ns:Amt Ccy="SEK">5.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:Sts>PDNG</ns:Sts><ns:BookgDt><ns:Dt>2027-02-01</ns:Dt></ns:BookgDt></ns:Ntry>
</ns:Ntfctn></ns:BkToCstmrDbtCdtNtfctn></ns:Document>`;
    const f = parseCamt(xml);
    expect(f.accounts[0]).toMatchObject({ iban: 'SE4512000000012123456789', bankgiro: null });
    const p = f.accounts[0].payments;
    expect(p).toHaveLength(2); // väntande post hoppas över
    expect(p[0]).toMatchObject({ amountOre: 10_000, reference: '111', payerName: 'Bo Exempel', payerOrgNr: '556000-0001', bgcSerial: 'E9-1' });
    expect(p[0].extraReferences).toEqual([{ reference: '222', amountOre: 5_000, negative: false }]);
    expect(p[1]).toMatchObject({ amountOre: 20_000, bgcSerial: 'E9-2' });
  });

  it('känner igen formatet och förklarar fel', () => {
    expect(parseBankFile(Buffer.from(buildCamt054({ bankgiro: '5050-1055', date: '2027-01-05', payments: [] }))).format).toBe('camt054');
    expect(parseBankFile(Buffer.from(buildBgMax({ bankgiro: '5050-1055', date: '2027-01-05', payments: [{ reference: '1', amountOre: 100 }] }), 'latin1')).format).toBe('bgmax');
    expect(() => parseBankFile(Buffer.from('hej'))).toThrow(/varken en BgMax-fil eller en camt/);
    expect(() => parseBankFile(Buffer.from('-----BEGIN PGP MESSAGE-----\n'))).toThrow(/krypterad/);
    expect(patternMatches('*.xml', 'camt054_1.XML')).toBe(true);
    expect(patternMatches('*.xml', 'kvitto.txt')).toBe(false);
    expect(patternMatches(null, 'vad-som-helst')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// En liten SFTP-server som spelar bank
// ---------------------------------------------------------------------

function fakeBank(files: Map<string, Buffer>, allowedKey: () => string | null) {
  const hostKey = sshUtils.generateKeyPairSync('ed25519').private;
  const { OPEN_MODE, STATUS_CODE } = sshUtils.sftp;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      const pub = allowedKey();
      if (ctx.method === 'publickey' && ctx.username === 'kund123' && pub) {
        const allowed = sshUtils.parseKey(pub);
        if (!(allowed instanceof Error) && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())) {
          if (!ctx.signature) return ctx.accept();
          if (ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
        }
      }
      ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { kind: 'dir'; done: boolean } | { kind: 'file'; name: string }>();
          let next = 1;
          const h = (n: number) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(n);
            return b;
          };
          const attrs = (size: number) => ({ mode: 0o100644, uid: 0, gid: 0, size, atime: 1_800_000_000, mtime: 1_800_000_000 });
          const nameOf = (p: string) => p.replace(/^.*\//, '');
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? '/' : p, longname: p, attrs: {} as never }]));
          sftp.on('STAT', (id, p) => {
            if (p === '/' || p === '/Outbox') return sftp.attrs(id, { ...attrs(0), mode: 0o040755 });
            const f = files.get(nameOf(p));
            return f ? sftp.attrs(id, attrs(f.length)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
          });
          sftp.on('LSTAT', (id, p) => sftp.emit('STAT', id, p));
          sftp.on('OPENDIR', (id) => {
            const n = next++;
            handles.set(n, { kind: 'dir', done: false });
            sftp.handle(id, h(n));
          });
          sftp.on('READDIR', (id, handle) => {
            const d = handles.get(handle.readUInt32BE());
            if (!d || d.kind !== 'dir') return sftp.status(id, STATUS_CODE.FAILURE);
            if (d.done) return sftp.status(id, STATUS_CODE.EOF);
            d.done = true;
            sftp.name(id, [...files].map(([name, b]) => ({ filename: name, longname: `-rw-r--r-- 1 bank bank ${b.length} Jan 1 00:00 ${name}`, attrs: attrs(b.length) as never })));
          });
          sftp.on('OPEN', (id, p, flags) => {
            const name = nameOf(p);
            if (!(flags & OPEN_MODE.READ) || !files.has(name)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            const n = next++;
            handles.set(n, { kind: 'file', name });
            sftp.handle(id, h(n));
          });
          sftp.on('FSTAT', (id, handle) => {
            const f = handles.get(handle.readUInt32BE());
            if (!f || f.kind !== 'file') return sftp.status(id, STATUS_CODE.FAILURE);
            sftp.attrs(id, attrs(files.get(f.name)!.length));
          });
          sftp.on('READ', (id, handle, offset, length) => {
            const f = handles.get(handle.readUInt32BE());
            if (!f || f.kind !== 'file') return sftp.status(id, STATUS_CODE.FAILURE);
            const b = files.get(f.name)!;
            if (offset >= b.length) return sftp.status(id, STATUS_CODE.EOF);
            sftp.data(id, b.subarray(offset, offset + length));
          });
          sftp.on('REMOVE', (id, p) => {
            files.delete(nameOf(p));
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on('CLOSE', (id, handle) => {
            handles.delete(handle.readUInt32BE());
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      });
    });
    client.on('error', () => undefined);
  });
  return server;
}

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;
let bank: Server;
let bankPort: number;
const bankFiles = new Map<string, Buffer>();
let bankKey: string | null = null;
const folderRoot = mkdtempSync(join(tmpdir(), 'bankfiler-'));
const outbox = mkdtempSync(join(tmpdir(), 'utkorg-bankfil-'));
const inv: Record<string, { id: string; invoiceNr: number; ocr: string; totalOre: number; customerId: string }> = {};

beforeAll(async () => {
  process.env.OUTBOX_DIR = outbox;
  process.env.BANK_FOLDER_ROOT = folderRoot;
  process.env.APP_SECRET_KEY = 'test-hemlighet-som-ar-lang-nog';
  delete process.env.SMTP_HOST;
  delete process.env.BREVO_API_KEY;
  bank = fakeBank(bankFiles, () => bankKey);
  await new Promise<void>((r) => bank.listen(0, '127.0.0.1', () => r()));
  bankPort = (bank.address() as AddressInfo).port;

  ({ app, stop } = await startApp('fastighet_test_bankfil'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('Fastighet AB Hemporten K');
  companyB = byName('Fastighets AB Hardebergabanan');
  await agent.patch(`/companies/${companyA}`).send({ bankgiro: '5050-1055', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.patch(`/companies/${companyB}`).send({ bankgiro: '5050-1063', invoiceEmail: 'hyror@example.se' }).expect(200);
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  // Bolag A har också ett hyreskonto hos Danske Bank, för filer som anger IBAN
  await agent.post('/bank-accounts').send({ purpose: 'rent', bankName: 'Danske Bank', clearingNr: '1200', accountNr: '0121234567', iban: 'SE4512000000012123456789' }).expect(201);

  const p = await agent.post('/properties').send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'residential' }).expect(201);
  const ids: Record<string, string> = {};
  for (const [k, nr] of [['o1', '1001'], ['o2', '1002'], ['o3', '1003']]) {
    ids[k] = (await agent.post('/objects').send({ propertyId: p.body.id, rentValidFrom: '2024-01-01', objectNr: nr, type: 'apartment', areaM2: 60, rooms: 2, monthlyRent: 9000 }).expect(201)).body.id;
  }
  for (const [k, name] of [['anna', 'Anna Testsson'], ['bo', 'Bo Exempel'], ['cia', 'Cia Prov']]) {
    ids[k] = (
      await agent.post('/customers').send({ kind: 'person', name, email: null, deliveryMethod: 'post', addressLine: 'Kvarngatan 4', postalCode: '211 11', city: 'Malmö' }).expect(201)
    ).body.id;
  }
  for (const [c, o] of [['anna', 'o1'], ['bo', 'o2'], ['cia', 'o3']]) {
    const r = await agent.post('/contracts').send({ type: 'residential', customerId: ids[c], startDate: '2026-12-01', objectIds: [ids[o]] }).expect(201);
    await agent.post(`/contracts/${r.body.id}/activate`).send({}).expect(201);
  }
  const run = await agent.post('/billing-runs').send({ periodMonth: '2027-01', invoiceDate: '2026-12-10' }).expect(201);
  const detail = await agent.get(`/billing-runs/${run.body.id}`).expect(200);
  await agent.post(`/billing-runs/${run.body.id}/approve`).send({ fingerprint: detail.body.fingerprint, acknowledgeWarnings: true }).expect(201);
  for (const i of (await agent.get('/invoices').expect(200)).body) {
    const who = Object.entries(ids).find(([, v]) => v === i.customerId)![0];
    inv[who] = i;
  }
  expect(Object.keys(inv).sort()).toEqual(['anna', 'bo', 'cia']);
});

afterAll(async () => {
  await stop();
  await new Promise((r) => bank.close(r));
});

describe('uppladdning av camt.054', () => {
  it('läser in och matchar på OCR som en BgMax-fil', async () => {
    const xml = buildCamt054({
      bankgiro: '5050-1055',
      date: '2027-01-02',
      messageId: 'UPP1',
      payments: [
        { reference: inv.anna.ocr, amountOre: inv.anna.totalOre, name: 'ANNA TESTSSON', serial: 'U1' },
        { text: 'hyra', amountOre: 12_300, name: 'OKAND BETALARE', serial: 'U2' },
      ],
    });
    const r = await agent.post('/bank-files').attach('file', Buffer.from(xml), 'camt054.xml').expect(201);
    const f = await agent.get(`/bank-files/${r.body.id}`).expect(200);
    expect(f.body.transactions.map((t: { status: string; matchRule: string | null }) => [t.status, t.matchRule])).toEqual([
      ['matched', 'ocr'],
      ['unmatched', null],
    ]);
    const list = (await agent.get('/bank-files').expect(200)).body;
    expect(list[0]).toMatchObject({ id: r.body.id });
    await agent.post(`/bank-files/${r.body.id}/book`).expect(201);
    expect((await agent.get(`/invoices/${inv.anna.id}`).expect(200)).body.balanceOre).toBe(0);
  });

  it('nekar en fil för ett konto som inte hör till bolaget', async () => {
    const xml = buildCamt054({ iban: 'SE3550000000054910000003', date: '2027-01-02', payments: [{ reference: '1', amountOre: 100 }] });
    const r = await agent.post('/bank-files').attach('file', Buffer.from(xml), 'fel.xml').expect(400);
    expect(r.body.message).toMatch(/SE3550000000054910000003/);
  });
});

describe('automatisk hämtning', () => {
  let conn: string;
  let folderConn: string;

  it('kräver koncernadministratör och en nyckel innan hämtningen slås på', async () => {
    const r = await agent
      .post('/bank-connections')
      .send({ name: 'Danske Bank', kind: 'sftp', host: '127.0.0.1', port: bankPort, username: 'kund123', remoteDir: '/Outbox', filePattern: '*.xml', notifyEmail: 'axel@example.se' })
      .expect(201);
    conn = r.body.id;
    expect(r.body).toMatchObject({ enabled: false, hasKey: false, autoBook: true });
    const bad = await agent.patch(`/bank-connections/${conn}`).send({ ...r.body, enabled: true }).expect(400);
    expect(bad.body.message).toMatch(/nyckel/);
  });

  it('skapar en nyckel vars privata del aldrig visas', async () => {
    const r = await agent.post(`/bank-connections/${conn}/key`).expect(201);
    expect(r.body.publicKey).toMatch(/^ssh-rsa AAAA/);
    expect(r.body.hasKey).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE/);
    bankKey = r.body.publicKey;
  });

  it('testar anslutningen, sparar bankens värdnyckel och listar filer utan att läsa in', async () => {
    bankFiles.set('camt054_20270103.xml', Buffer.from(buildCamt054({ bankgiro: '5050-1055', date: '2027-01-03', messageId: 'M1', payments: [
      { reference: inv.bo.ocr, amountOre: inv.bo.totalOre, name: 'BO EXEMPEL', serial: 'S1' },
      { text: 'Hyra Cia', amountOre: 1_000, name: 'NAGON ANNAN', serial: 'S2' },
    ] })));
    bankFiles.set('kvitto.txt', Buffer.from('kvittens'));
    const r = await agent.post(`/bank-connections/${conn}/test`).expect(200);
    expect(r.body).toMatchObject({ status: 'ok', filesFound: 1 });
    const c = (await agent.get('/bank-connections').expect(200)).body.connections[0];
    expect(c.hostFingerprint).toMatch(/^SHA256:/);
    expect((await agent.get(`/invoices/${inv.bo.id}`).expect(200)).body.paidOre).toBe(0);
  });

  it('hämtar, läser in och bokför matchade betalningar, en gång', async () => {
    const r = await agent.post(`/bank-connections/${conn}/run`).expect(200);
    expect(r.body).toMatchObject({ status: 'ok', filesFound: 1, filesImported: 1, payments: 2, booked: 1, unmatched: 1 });
    expect((await agent.get(`/invoices/${inv.bo.id}`).expect(200)).body.balanceOre).toBe(0);
    const files = (await agent.get('/bank-files').expect(200)).body;
    expect(files[0]).toMatchObject({ filename: 'camt054_20270103.xml', status: 'booked', unmatchedCount: 1 });
    // Påminnelse om det omatchade skickas till e-postadressen (testläge: sparas som fil)
    expect(readdirSync(outbox).some((f) => f.startsWith('bankfil-'))).toBe(true);
    const again = await agent.post(`/bank-connections/${conn}/run`).expect(200);
    expect(again.body).toMatchObject({ status: 'ok', filesFound: 0, message: 'Inga nya filer.' });
  });

  it('läser in en fil till flera bolag efter konto och varnar för okända konton', async () => {
    const two = buildCamt054({ bankgiro: '5050-1063', date: '2027-01-04', messageId: 'M2', payments: [{ text: 'hyra', amountOre: 5_000, serial: 'B1' }] })
      .replace('</BkToCstmrDbtCdtNtfctn>', `${buildCamt054({ iban: 'SE4512000000012123456789', date: '2027-01-04', payments: [{ reference: inv.cia.ocr, amountOre: inv.cia.totalOre, serial: 'C1' }] }).match(/<Ntfctn>[\s\S]*<\/Ntfctn>/)![0]}
${buildCamt054({ bankgiro: '9999-9999', date: '2027-01-04', payments: [{ text: 'x', amountOre: 100, serial: 'X1' }] }).match(/<Ntfctn>[\s\S]*<\/Ntfctn>/)![0]}</BkToCstmrDbtCdtNtfctn>`);
    bankFiles.clear();
    bankFiles.set('camt054_20270104.xml', Buffer.from(two));
    const r = await agent.post(`/bank-connections/${conn}/run`).expect(200);
    expect(r.body.status).toBe('error');
    expect(r.body.message).toMatch(/bankgiro 9999-9999/);
    expect(r.body).toMatchObject({ payments: 2, booked: 1 });
    expect((await agent.get(`/invoices/${inv.cia.id}`).expect(200)).body.balanceOre).toBe(0);
    await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
    const b = (await agent.get('/bank-files').expect(200)).body;
    expect(b[0]).toMatchObject({ companyId: companyB, filename: 'camt054_20270104.xml', unmatchedCount: 1 });
    await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
  });

  it('nekar en server vars värdnyckel har bytts', async () => {
    const r0 = (await agent.get('/bank-connections').expect(200)).body.connections[0];
    await agent.patch(`/bank-connections/${conn}`).send({ ...r0, hostFingerprint: `SHA256:${'A'.repeat(43)}` }).expect(200);
    const r = await agent.post(`/bank-connections/${conn}/test`).expect(200);
    expect(r.body.status).toBe('error');
    expect(r.body.message).toMatch(/annan nyckel/);
  });

  it('hämtar från en mapp på servern enligt schemat och tar bort hämtade filer', async () => {
    const r = await agent
      .post('/bank-connections')
      .send({ name: 'Mapp', kind: 'folder', remoteDir: 'danske', intervalMinutes: 5, deleteAfterFetch: true, enabled: true })
      .expect(201);
    folderConn = r.body.id;
    expect(r.body.enabled).toBe(true);
    await agent.post('/bank-connections').send({ name: 'Utanför', kind: 'folder', remoteDir: '../../etc' }).expect(400);
    const dir = join(folderRoot, 'danske');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'in.xml'), buildCamt054({ bankgiro: '5050-1055', date: '2027-01-06', messageId: 'F1', payments: [{ text: 'okänd', amountOre: 7_700, serial: 'F1' }] }));
    expect(await runDue()).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir)).toEqual([]);
    const list = (await agent.get('/bank-connections').expect(200)).body;
    const c = list.connections.find((x: { id: string }) => x.id === folderConn);
    expect(c).toMatchObject({ lastStatus: 'ok' });
    expect(list.runs.find((x: { connectionId: string }) => x.connectionId === folderConn)).toMatchObject({ trigger: 'schedule', payments: 1, unmatched: 1 });
    // Inte på tur igen förrän intervallet passerat
    const before = list.runs.length;
    await runDue();
    expect((await agent.get('/bank-connections').expect(200)).body.runs.length).toBe(before);
  });

  it('visar omatchade inbetalningar i en rapport', async () => {
    const r = await agent.get('/reports/omatchade-inbetalningar?to=2027-01-31').expect(200);
    const rows = r.body.sections[0].rows;
    expect(rows.map((x: { amount: number }) => x.amount).sort((a: number, b: number) => a - b)).toEqual([1_000, 7_700, 12_300]);
    expect(rows.find((x: { amount: number }) => x.amount === 7_700).file).toMatch(/automatisk/);
  });

  it('lagrar aldrig den privata nyckeln okrypterat eller i revisionsloggen', async () => {
    const { Client } = await import('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const k = (await db.query('select private_key_enc from bank_connection_key')).rows[0].private_key_enc;
    expect(k).toMatch(/^v1:/);
    expect(k).not.toMatch(/PRIVATE/);
    const logged = (await db.query(`select count(*)::int as n from audit_log where after::text ilike '%private%' or after::text like '%v1:%'`)).rows[0].n;
    expect(logged).toBe(0);
    await db.end();
  });
});
