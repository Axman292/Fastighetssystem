import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, bookkeepingKeepUntil } from '../src/gdpr/gdpr';
import { login, startApp } from './helpers';

/**
 * GDPR-gallring: tidigare hyresgäster anonymiseras när lagringstiden gått,
 * bokföringsunderlag rensas först efter bokföringslagens sju år, och
 * personuppgifterna försvinner även ur revisionsloggen.
 */

describe('datum', () => {
  it('räknar månader och bokföringstid', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2022-06-30', 24)).toBe('2024-06-30');
    expect(bookkeepingKeepUntil('2022-06-01', 1, 7)).toBe('2029-12-31');
    // Brutet räkenskapsår maj–april: 2022-06 hör till året som slutar 2023-04-30
    expect(bookkeepingKeepUntil('2022-06-01', 5, 7)).toBe('2030-12-31');
    expect(bookkeepingKeepUntil('2022-03-01', 5, 7)).toBe('2029-12-31');
  });
});

let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let sql: Client;
let companyA: string;
const cust: Record<string, string> = {};
let invoiceNr = 1;

async function addContract(customerId: string, status: string, start: string, end: string | null) {
  const nr = (await sql.query('select coalesce(max(contract_nr), 0) + 1 as n from contract where company_id = $1', [companyA])).rows[0].n;
  return (
    await sql.query(
      `insert into contract (company_id, contract_nr, type, customer_id, start_date, end_date, status, notes, termination_reason)
       values ($1, $2, 'residential', $3, $4, $5, $6, 'Har hund, ring innan besök', 'Flyttar till sin sambo') returning id`,
      [companyA, nr, customerId, start, end, status],
    )
  ).rows[0].id as string;
}

async function addInvoice(customerId: string, date: string, totalOre: number, paid: boolean) {
  const nr = invoiceNr++;
  const id = (
    await sql.query(
      `insert into invoice (company_id, kind, customer_id, invoice_date, due_date, delivery_method, bill_to, total_ore, net_ore, invoice_nr, ocr, your_reference)
       values ($1, 'invoice', $2, $3, $3, 'email', $4, $5, $5, $6, $7, 'Kalle') returning id`,
      [companyA, customerId, date, JSON.stringify({ name: 'Riktigt Namn', addressLine: 'Gatan 1' }), totalOre, 9000 + nr, `9000${nr}`],
    )
  ).rows[0].id as string;
  await sql.query(`update invoice set status = 'issued', issued_at = now() where id = $1`, [id]);
  await sql.query(`insert into invoice_delivery (company_id, invoice_id, channel, status, recipient) values ($1, $2, 'email', 'sent', 'privat@example.se')`, [
    companyA,
    id,
  ]);
  if (paid) {
    const p = (
      await sql.query(
        `insert into payment (company_id, customer_id, amount_ore, payment_date, note) values ($1, $2, $3, $4, 'Betalade kontant') returning id`,
        [companyA, customerId, totalOre, date],
      )
    ).rows[0].id;
    await sql.query('insert into payment_allocation (company_id, payment_id, invoice_id, amount_ore) values ($1, $2, $3, $4)', [companyA, p, id, totalOre]);
  }
  return id;
}

const ago = (months: number) => addMonths(new Date().toISOString().slice(0, 10), -months);

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_gdpr'));
  sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  companyA = me.body.companies.find((c: { companyName: string }) => c.companyName === 'Fastighet AB Hemporten K').companyId;
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);

  const mk = async (key: string, name: string, nationalId: string) => {
    cust[key] = (
      await agent
        .post('/customers')
        .send({ kind: 'person', name, nationalId, email: `${key}@example.se`, phone: '070-1234567', addressLine: 'Storgatan 1', city: 'Malmö', notes: 'Känslig anteckning' })
        .expect(201)
    ).body.id;
    // Kunderna ska se ut att ha funnits länge
    await sql.query(`update customer set created_at = '2010-01-01' where id = $1`, [cust[key]]);
  };
  await mk('anna', 'Anna Andersson', '191212121212');
  await mk('olle', 'Olle Olsson', '198112189876');
  await mk('bo', 'Bo Berg', '196408233234');
  await mk('cia', 'Cia Carlsson', '199001012385');
  await mk('dan', 'Dan Dahl', '197001018683');
  await agent.post(`/customers/${cust.anna}/contacts`).send({ name: 'Annas Kontakt', email: 'kontakt@example.se' }).expect(201);

  // Anna flyttade för tre år sedan, allt betalt
  await addContract(cust.anna, 'terminated', '2018-01-01', ago(36));
  await addInvoice(cust.anna, ago(37), 500_000, true);
  // Olle flyttade 2015: även bokföringstiden har gått
  await addContract(cust.olle, 'terminated', '2010-01-01', '2015-06-30');
  await addInvoice(cust.olle, '2015-06-01', 400_000, true);
  // Bo flyttade för tre år sedan men har en obetald faktura
  await addContract(cust.bo, 'terminated', '2018-01-01', ago(36));
  await addInvoice(cust.bo, ago(37), 300_000, false);
  // Cia bor kvar
  await addContract(cust.cia, 'active', '2018-01-01', null);
  // Dan flyttade förra månaden
  await addContract(cust.dan, 'terminated', '2018-01-01', ago(1));

  // En gammal genomförd import med personuppgifter
  const batch = (
    await sql.query(
      `insert into import_batch (company_id, batch_nr, name, source_system, status, committed_at)
       values ($1, 1, 'DinHyresvärd', 'generic', 'committed', now() - interval '2 years') returning id`,
      [companyA],
    )
  ).rows[0].id;
  const file = (
    await sql.query(
      `insert into import_file (company_id, batch_id, file_name, format, size_bytes, sha256, content)
       values ($1, $2, 'kunder.xlsx', 'xlsx', 3, 'abc', '\\x010203') returning id`,
      [companyA, batch],
    )
  ).rows[0].id;
  await sql.query(
    `insert into import_row (company_id, batch_id, file_id, entity, record_key, label, data, status)
     values ($1, $2, $3, 'customer', '1', 'Anna Andersson', '{"personnummer":"19121212-1212"}', 'new')`,
    [companyA, batch, file],
  );
  await sql.query(`update import_batch set updated_at = now() - interval '2 years' where id = $1`, [batch]);
});

afterAll(async () => {
  await sql?.end();
  await stop();
});

describe('förhandsgranskning', () => {
  it('visar vilka som gallras, vilka som stoppas och vilka som står på tur', async () => {
    const p = (await agent.get('/gdpr/preview').expect(200)).body;
    expect(p.settings).toMatchObject({ autoEnabled: false, retentionMonths: 24, bookkeepingYears: 7 });
    const nrs = (list: { id: string }[]) => list.map((x) => x.id).sort();
    expect(nrs(p.anonymize)).toEqual([cust.anna, cust.olle].sort());
    expect(p.anonymize.find((a: { id: string }) => a.id === cust.anna)).toMatchObject({ contacts: 1, mode: 'full' });
    expect(nrs(p.accounting)).toEqual([cust.olle]);
    expect(p.blocked).toHaveLength(1);
    expect(p.blocked[0]).toMatchObject({ id: cust.bo });
    expect(p.blocked[0].blockers[0]).toMatch(/Obetalt 3 000,00/);
    expect(nrs(p.upcoming)).toEqual([cust.dan]);
    expect(p.imports).toHaveLength(1);
    expect(p.imports[0]).toMatchObject({ action: 'purge' });
    // Inget ändrades
    const anna = (await agent.get(`/customers/${cust.anna}`).expect(200)).body;
    expect(anna.name).toBe('Anna Andersson');
  });

  it('kräver bokföringstid på minst sju år', async () => {
    const r = await agent
      .put('/gdpr/settings')
      .send({ autoEnabled: true, retentionMonths: 24, bookkeepingYears: 5, importRetentionMonths: 12, includeOrganizations: false })
      .expect(400);
    expect(JSON.stringify(r.body)).toMatch(/minst 7 år/);
  });
});

describe('registerutdrag', () => {
  it('ger PDF och JSON med kundens uppgifter och loggar utdraget', async () => {
    const pdf = await agent.get(`/gdpr/customers/${cust.anna}/extract.pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const json = await agent.get(`/gdpr/customers/${cust.anna}/extract.json`).expect(200);
    const e = JSON.parse(json.text);
    expect(e.customer).toMatchObject({ name: 'Anna Andersson', nationalId: '19121212-1212' });
    expect(e.contacts).toHaveLength(1);
    expect(e.invoices).toHaveLength(1);
    expect(e.purposes.length).toBeGreaterThan(0);
    const log = (await agent.get('/gdpr/log').expect(200)).body;
    expect(log.extracts.length).toBe(2);
  });
});

describe('gallra nu', () => {
  it('anonymiserar, rensar gammalt bokföringsunderlag och importfiler', async () => {
    const r = (await agent.post('/gdpr/run').expect(200)).body;
    expect(r).toMatchObject({ anonymized: 2, accounting: 1, imports: 1 });

    const anna = (await agent.get(`/customers/${cust.anna}`).expect(200)).body;
    expect(anna).toMatchObject({ name: expect.stringMatching(/^Anonymiserad kund \d+$/), nationalId: null, email: null, phone: null, notes: null, active: false });
    expect(anna.anonymizedAt).toBeTruthy();
    expect(anna.accountingPurgedAt).toBeNull();
    expect(anna.contacts).toHaveLength(0);

    // Annas faktura är fortfarande räkenskapsinformation och behåller mottagaren
    const annaInv = (await sql.query('select bill_to from invoice where customer_id = $1', [cust.anna])).rows[0];
    expect(annaInv.bill_to.name).toBe('Riktigt Namn');
    // men e-postadressen i utskicksloggen är borta
    expect((await sql.query(`select recipient from invoice_delivery d join invoice i on i.id = d.invoice_id where i.customer_id = $1`, [cust.anna])).rows[0].recipient).toBeNull();
    const contract = (await sql.query('select notes, termination_reason from contract where customer_id = $1', [cust.anna])).rows[0];
    expect(contract).toEqual({ notes: null, termination_reason: null });

    // Olles fakturor är äldre än bokföringstiden: även mottagaren är borta
    const olleInv = (await sql.query('select bill_to, your_reference from invoice where customer_id = $1', [cust.olle])).rows[0];
    expect(olleInv.bill_to).toEqual({ name: expect.stringMatching(/^Anonymiserad kund/) });
    expect(olleInv.your_reference).toBeNull();
    expect((await sql.query('select note from payment where customer_id = $1', [cust.olle])).rows[0].note).toBeNull();

    // Bo (obetalt), Cia (bor kvar) och Dan (nyss flyttat) är orörda
    for (const k of ['bo', 'cia', 'dan']) {
      expect((await sql.query('select anonymized_at from customer where id = $1', [cust[k]])).rows[0].anonymized_at).toBeNull();
    }

    // Importen är rensad och kan inte ångras
    const b = (await sql.query('select purged_at, id from import_batch where company_id = $1', [companyA])).rows[0];
    expect(b.purged_at).toBeTruthy();
    expect((await sql.query('select count(*)::int as n from import_file where batch_id = $1', [b.id])).rows[0].n).toBe(0);
    expect((await sql.query('select data, label from import_row where batch_id = $1', [b.id])).rows[0]).toEqual({ data: {}, label: '(gallrad)' });
    const rb = await agent.post(`/imports/${b.id}/rollback`);
    expect(rb.status).toBe(400);
  });

  it('lämnar inga personuppgifter kvar i revisionsloggen', async () => {
    const { rows } = await sql.query(
      `select table_name, before, after from audit_log
       where (before::text || coalesce(after::text, '')) ~ '19121212-1212|Anna Andersson|anna@example.se|Annas Kontakt|Känslig anteckning|Har hund|privat@example.se'
         and row_id in (select id::text from customer where id = $1
                        union select id::text from contract where customer_id = $1
                        union select d.id::text from invoice_delivery d join invoice i on i.id = d.invoice_id where i.customer_id = $1)
          or (table_name = 'customer_contact' and (before::text || coalesce(after::text, '')) like '%Annas Kontakt%')`,
      [cust.anna],
    );
    expect(rows).toEqual([]);
    // Ändringen syns fortfarande, men värdena är maskerade
    const masked = (await sql.query(`select before from audit_log where table_name = 'customer' and row_id = $1 and action = 'update' order by id desc limit 1`, [cust.anna]))
      .rows[0];
    expect(masked.before.name).toBe('[gallrad]');
  });

  it('loggar gallringen utan personuppgifter', async () => {
    const log = (await agent.get('/gdpr/log').expect(200)).body;
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]).toMatchObject({ trigger: 'manual', anonymized: 2, accounting: 1, imports: 1 });
    expect(JSON.stringify(log.runs)).not.toMatch(/Anna|Olle|19121212/);
  });

  it('gör ingenting andra gången', async () => {
    const r = (await agent.post('/gdpr/run').expect(200)).body;
    expect(r).toMatchObject({ anonymized: 0, accounting: 0, imports: 0, runId: null });
  });
});

describe('på begäran', () => {
  it('anonymiserar en tidigare hyresgäst före lagringstiden, men inte med obetalt eller gällande avtal', async () => {
    const s = (await agent.get(`/gdpr/customers/${cust.dan}/status`).expect(200)).body;
    expect(s).toMatchObject({ canAnonymize: true, blockers: [] });
    const bo = (await agent.get(`/gdpr/customers/${cust.bo}/status`).expect(200)).body;
    expect(bo.canAnonymize).toBe(false);
    expect(bo.blockers[0]).toMatch(/Obetalt/);
    await agent.post(`/gdpr/customers/${cust.bo}/anonymize`).expect(400);
    await agent.post(`/gdpr/customers/${cust.cia}/anonymize`).expect(400);

    const r = (await agent.post(`/gdpr/customers/${cust.dan}/anonymize`).expect(200)).body;
    expect(r.anonymized).toBe(1);
    const dan = (await agent.get(`/customers/${cust.dan}`).expect(200)).body;
    expect(dan.name).toMatch(/^Anonymiserad kund/);
    const log = (await agent.get('/gdpr/log').expect(200)).body;
    expect(log.runs[0].trigger).toBe('request');
  });
});

describe('automatisk gallring', () => {
  it('körs bara för bolag där den är påslagen, en gång per dag', async () => {
    const { runDueCompanies } = await import('../src/gdpr/gdpr-scheduler');
    expect(await runDueCompanies()).toBe(0);
    await agent
      .put('/gdpr/settings')
      .send({ autoEnabled: true, retentionMonths: 24, bookkeepingYears: 7, importRetentionMonths: 12, includeOrganizations: false })
      .expect(200);
    expect(await runDueCompanies()).toBe(1);
    expect(await runDueCompanies()).toBe(0);
    const s = (await agent.get('/gdpr/settings').expect(200)).body;
    expect(s.lastAutoRunAt).toBeTruthy();
  });
});
