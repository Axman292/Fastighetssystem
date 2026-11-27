import type { PoolClient } from 'pg';
import { dayBefore, today } from '../common/money';
import { APPLY_ORDER, ENTITY } from './entities';

/**
 * Sparar en kontrollerad import. Används både för testimport (allt rullas
 * tillbaka efteråt) och skarp import. Varje skapad eller ändrad rad skrivs
 * i import_change så att importen kan ångras, och originalsystemets id
 * sparas i external_ref så att importen kan köras igen utan dubbletter.
 */

export interface ApplyError {
  entity: string;
  recordKey: string;
  label: string;
  message: string;
}

export interface ApplyResult {
  created: Record<string, number>;
  updated: Record<string, number>;
  linked: Record<string, number>;
  errors: ApplyError[];
}

interface Row {
  id: string;
  entity: string;
  record_key: string;
  label: string;
  data: Record<string, any>;
  status: string;
  target_id: string | null;
  changes: { field: string; incoming: unknown }[];
  approve_update: boolean | null;
}

const COLUMN: Record<string, Record<string, string>> = {
  property: {
    name: 'name',
    category: 'category',
    addressLine: 'address_line',
    postalCode: 'postal_code',
    city: 'city',
    municipality: 'municipality',
    constructionYear: 'construction_year',
    areaBoaM2: 'area_boa_m2',
    areaLoaM2: 'area_loa_m2',
    areaBtaM2: 'area_bta_m2',
    siteAreaM2: 'site_area_m2',
  },
  object: {
    type: 'type',
    areaM2: 'area_m2',
    rooms: 'rooms',
    floor: 'floor',
    apartmentNr: 'apartment_nr',
    addressLine: 'address_line',
    description: 'description',
  },
  customer: {
    name: 'name',
    nationalId: 'national_id',
    email: 'email',
    phone: 'phone',
    addressLine: 'address_line',
    careOf: 'care_of',
    postalCode: 'postal_code',
    city: 'city',
    invoiceReference: 'invoice_reference',
  },
  cotenant: { email: 'email', phone: 'phone' },
  supplier: {
    name: 'name',
    bankgiro: 'bankgiro',
    plusgiro: 'plusgiro',
    email: 'email',
    phone: 'phone',
    addressLine: 'address_line',
    postalCode: 'postal_code',
    city: 'city',
    paymentTermsDays: 'payment_terms_days',
  },
  account: { name: 'name', type: 'type', sruCode: 'sru_code' },
  contract: { endDate: 'end_date', noticeMonths: 'notice_months' },
};

const TABLE: Record<string, string> = {
  property: 'property',
  object: 'rental_object',
  customer: 'customer',
  cotenant: 'customer_contact',
  supplier: 'supplier',
  account: 'account',
  contract: 'contract',
};

class Tracker {
  constructor(
    private client: PoolClient,
    private companyId: string,
    private batchId: string,
  ) {}

  async insert(table: string, values: Record<string, unknown>): Promise<string> {
    const cols = Object.keys(values);
    const { rows } = await this.client.query(
      `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      cols.map((c) => values[c]),
    );
    await this.client.query(`insert into import_change (company_id, batch_id, table_name, row_id, action) values ($1, $2, $3, $4, 'insert')`, [
      this.companyId,
      this.batchId,
      table,
      rows[0].id,
    ]);
    return rows[0].id;
  }

  async update(table: string, id: string, values: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(values);
    if (!cols.length) return;
    const before = (await this.client.query(`select to_jsonb(t) as row from ${table} t where id = $1`, [id])).rows[0]?.row;
    if (!before) throw new Error('Posten finns inte längre');
    await this.client.query(
      `update ${table} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
      [id, ...cols.map((c) => values[c])],
    );
    await this.client.query(
      `insert into import_change (company_id, batch_id, table_name, row_id, action, before) values ($1, $2, $3, $4, 'update', $5)`,
      [this.companyId, this.batchId, table, id, before],
    );
  }
}

export async function applyBatch(
  client: PoolClient,
  batch: { id: string; companyId: string; sourceSystem: string; batchNr: number; sourceLabel: string },
  mode: 'test' | 'commit',
): Promise<ApplyResult> {
  const t = new Tracker(client, batch.companyId, batch.id);
  const rows = (
    await client.query(
      `select r.id, r.entity, r.record_key, r.label, r.data, r.status, r.target_id, r.changes, d.approve_update
       from import_row r left join import_decision d on d.batch_id = r.batch_id and d.entity = r.entity and d.record_key = r.record_key
       where r.batch_id = $1 and r.status in ('new','update','link','unchanged')`,
      [batch.id],
    )
  ).rows as Row[];
  rows.sort((a, b) => APPLY_ORDER.indexOf(a.entity as never) - APPLY_ORDER.indexOf(b.entity as never));

  const ids = new Map<string, string>();
  for (const r of rows) if (r.target_id) ids.set(`${r.entity}:${r.record_key}`, r.target_id);
  const result: ApplyResult = { created: {}, updated: {}, linked: {}, errors: [] };
  const bump = (m: Record<string, number>, e: string) => (m[e] = (m[e] ?? 0) + 1);
  const failed = new Set<string>();
  const note = `Importerat från ${batch.sourceLabel} (import ${batch.batchNr})`;
  const todayIso = today();

  const saveRef = async (entity: string, key: string, internalId: string) => {
    if (entity === 'rent' || entity === 'cotenant') return;
    const exists = await client.query(
      'select 1 from external_ref where source_system = $1 and entity = $2 and external_id = $3',
      [batch.sourceSystem, entity, key],
    );
    if (!exists.rowCount) {
      await t.insert('external_ref', {
        company_id: batch.companyId,
        source_system: batch.sourceSystem,
        entity,
        external_id: key,
        internal_id: internalId,
        batch_id: batch.id,
      });
    }
  };

  const nextNr = async (table: string, column: string, start: number) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, [`${table}.${column}`, batch.companyId]);
    const { rows: r } = await client.query(`select coalesce(max(${column}), ${start}) + 1 as nr from ${table} where company_id = $1`, [batch.companyId]);
    return Number(r[0].nr);
  };

  for (const r of rows) {
    const d = r.data;
    const id = `${r.entity}:${r.record_key}`;
    const need = (entity: string, key: string | null | undefined, direct?: string | null): string => {
      if (direct) return direct;
      const v = key ? ids.get(`${entity}:${key}`) : undefined;
      if (!v) throw new Error(`${(ENTITY as Record<string, { label: string }>)[entity]?.label ?? entity} som posten hänvisar till kunde inte sparas`);
      return v;
    };
    await client.query('savepoint rec');
    try {
      if (r.status === 'new') {
        const newId = await create(r, d, need);
        ids.set(id, newId);
        await saveRef(r.entity, r.record_key, newId);
        bump(result.created, r.entity);
      } else if (r.status === 'update' && r.approve_update) {
        await update(r, d);
        await saveRef(r.entity, r.record_key, r.target_id!);
        bump(result.updated, r.entity);
      } else if (r.target_id) {
        await saveRef(r.entity, r.record_key, r.target_id);
        bump(result.linked, r.entity);
      }
      await client.query('release savepoint rec');
    } catch (e) {
      await client.query('rollback to savepoint rec');
      failed.add(id);
      result.errors.push({ entity: r.entity, recordKey: r.record_key, label: r.label, message: dbMessage(e) });
      if (mode === 'commit') break;
    }
    if (!failed.has(id) && ids.get(id)) {
      await client.query('update import_row set target_id = $2 where id = $1', [r.id, ids.get(id)]);
    }
  }
  return result;

  async function create(r: Row, d: Record<string, any>, need: (e: string, k: string | null | undefined, direct?: string | null) => string) {
    const c = batch.companyId;
    switch (r.entity) {
      case 'property':
        return t.insert('property', {
          company_id: c,
          designation: d.designation,
          name: d.name,
          category: d.category ?? 'other',
          address_line: d.addressLine ?? null,
          postal_code: d.postalCode ?? null,
          city: d.city ?? null,
          municipality: d.municipality ?? null,
          construction_year: d.constructionYear != null ? Math.round(d.constructionYear) : null,
          area_boa_m2: d.areaBoaM2 ?? null,
          area_loa_m2: d.areaLoaM2 ?? null,
          area_bta_m2: d.areaBtaM2 ?? null,
          site_area_m2: d.siteAreaM2 ?? null,
          notes: note,
        });
      case 'object': {
        const objId = await t.insert('rental_object', {
          company_id: c,
          property_id: need('property', d._propertyKey, d._propertyId),
          object_nr: d.objectNr,
          type: d.type,
          area_m2: d.areaM2 ?? null,
          rooms: d.rooms ?? null,
          floor: d.floor ?? null,
          apartment_nr: d.apartmentNr ?? null,
          address_line: d.addressLine ?? null,
          description: d.description ?? null,
        });
        if (d.monthlyRent != null) {
          await t.insert('rental_object_price', { company_id: c, object_id: objId, monthly_rent_ore: d.monthlyRent, valid_from: d.rentFrom, reason: 'Import' });
        }
        await t.insert('rental_object_vat', { company_id: c, object_id: objId, vat_liable: !!d.vatLiable, valid_from: d.rentFrom, note: 'Import' });
        return objId;
      }
      case 'rent':
        return t.insert('rental_object_price', {
          company_id: c,
          object_id: need('object', d._objectKey, d._objectId),
          monthly_rent_ore: d.monthlyRent,
          valid_from: d.validFrom,
          valid_to: d.validTo ?? null,
          reason: d.reason ?? 'Import av hyreshistorik',
        });
      case 'customer':
        return t.insert('customer', {
          company_id: c,
          customer_nr: await nextNr('customer', 'customer_nr', 1000),
          kind: d.kind,
          name: d.name,
          national_id: d.nationalIdNormalized ?? null,
          email: d.email ?? null,
          phone: d.phone ?? null,
          address_line: d.addressLine ?? null,
          care_of: d.careOf ?? null,
          postal_code: d.postalCode ?? null,
          city: d.city ?? null,
          invoice_reference: d.invoiceReference ?? null,
          delivery_method: d.email ? 'email' : 'post',
          notes: [d.notes, note].filter(Boolean).join('\n'),
        });
      case 'cotenant':
        return t.insert('customer_contact', {
          company_id: c,
          customer_id: need('customer', d._customerKey),
          name: d.name,
          role: 'Medhyresgäst',
          email: d.email ?? null,
          phone: d.phone ?? null,
        });
      case 'contract': {
        const contractId = await t.insert('contract', {
          company_id: c,
          contract_nr: await nextNr('contract', 'contract_nr', 1000),
          type: d.type,
          customer_id: need('customer', d._customerKey, d._customerId),
          start_date: d.startDate,
          end_date: d.endDate ?? null,
          notice_months: d.noticeMonths,
          billing_interval: d.billingInterval,
          status: d.status,
          signed_date: d.signedDate ?? null,
          termination_received: d.terminationDate ?? null,
          notes: note,
        });
        for (const l of d._lines ?? []) {
          const objectId = l.objectKey || l.objectId ? need('object', l.objectKey, l.objectId) : null;
          // Tillägg (bredband m.m.) är egna rader på avtalet men inga egna objekt
          if (!l.addon) {
            await t.insert('contract_object', { company_id: c, contract_id: contractId, object_id: objectId, valid_from: d.startDate, valid_to: d.endDate ?? null });
          }
          await t.insert('contract_line', {
            company_id: c,
            contract_id: contractId,
            object_id: objectId,
            article: l.addon ? l.article : 'rent',
            description: l.addon ? l.description : `Hyra ${l.objectNr}`,
            amount_ore: l.amountOre,
            vat_rate_bp: l.vatRateBp,
            valid_from: d.startDate,
            valid_to: d.endDate ?? null,
            reason: 'Import',
          });
        }
        await t.insert('contract_event', {
          company_id: c,
          contract_id: contractId,
          kind: 'created',
          event_date: todayIso,
          description: note,
        });
        return contractId;
      }
      case 'supplier':
        return t.insert('supplier', {
          company_id: c,
          supplier_nr: await nextNr('supplier', 'supplier_nr', 100),
          name: d.name,
          org_nr: d.orgNrNormalized ?? null,
          vat_nr: d.vatNr ?? null,
          bankgiro: d.bankgiro ?? null,
          plusgiro: d.plusgiro ?? null,
          email: d.email ?? null,
          phone: d.phone ?? null,
          address_line: d.addressLine ?? null,
          postal_code: d.postalCode ?? null,
          city: d.city ?? null,
          payment_terms_days: d.paymentTermsDays ?? 30,
          default_account: d.defaultAccount && /^\d{4}$/.test(d.defaultAccount) ? d.defaultAccount : null,
        });
      case 'account':
        return t.insert('account', {
          company_id: c,
          number: d.number,
          name: d.name,
          type: d.type,
          sru_code: d.sruCode ?? null,
          vat_code: d.vatCode ?? null,
          source: 'import',
        });
      case 'voucher': {
        const vId = await t.insert('legacy_voucher', {
          company_id: c,
          source_system: batch.sourceSystem,
          series: d.series,
          voucher_nr: d.voucherNr,
          voucher_date: d.date,
          description: d.text ?? null,
        });
        let n = 0;
        for (const l of d.lines) {
          await t.insert('legacy_voucher_line', {
            company_id: c,
            voucher_id: vId,
            line_nr: ++n,
            account_number: l.account,
            amount_ore: l.amountOre,
            cost_center: l.costCenter ?? null,
            object_code: l.objectCode ?? null,
            description: l.text ?? null,
          });
        }
        return vId;
      }
      case 'invoice': {
        const customerId = need('customer', d._customerKey, d._customerId);
        const cust = (await client.query('select name, delivery_method, address_line, postal_code, city, email from customer where id = $1', [customerId])).rows[0];
        const invId = await t.insert('invoice', {
          company_id: c,
          kind: d.kindValue,
          status: 'draft',
          ocr: d.ocr ?? null,
          customer_id: customerId,
          contract_id: d._contractId ?? null,
          invoice_date: d.invoiceDate,
          due_date: d.dueDate,
          period_from: d.periodFrom ?? null,
          period_to: d.periodTo ?? null,
          bill_to: JSON.stringify({ name: cust.name, addressLine: cust.address_line, postalCode: cust.postal_code, city: cust.city, email: cust.email }),
          delivery_method: cust.delivery_method,
          message: note,
          net_ore: d.net,
          vat_ore: d.vat,
          total_ore: d.total,
        });
        await t.insert('invoice_line', {
          company_id: c,
          invoice_id: invId,
          position: 1,
          line_kind: 'manual',
          contract_id: d._contractId ?? null,
          object_id: d._objectId ?? null,
          article: d.kindValue === 'rent_notice' ? 'rent' : 'other',
          description: d.kindValue === 'rent_notice' ? `Hyra enligt avi ${d.invoiceNr} (${batch.sourceLabel})` : `Faktura ${d.invoiceNr} (${batch.sourceLabel})`,
          period_from: d.periodFrom ?? null,
          period_to: d.periodTo ?? null,
          unit_price_ore: d.net,
          net_ore: d.net,
          vat_rate_bp: d.vatRateBp ?? 0,
          vat_ore: d.vat,
        });
        // Utfärdad med originalets nummer. Övergången från utkast loggas inte som ändring, den ångras genom att fakturan tas bort.
        await client.query(`update invoice set status = 'issued', invoice_nr = $2, issued_at = $3::date, issued_by = app.current_user_id() where id = $1`, [
          invId,
          d.invoiceNr,
          d.invoiceDate,
        ]);
        // Nästa egna fakturanummer fortsätter efter de importerade
        await client.query(
          `insert into invoice_series (company_id, next_nr) values ($1, $2::bigint + 1)
           on conflict (company_id) do update set next_nr = greatest(invoice_series.next_nr, excluded.next_nr)`,
          [c, d.invoiceNr],
        );
        if (d._paidFromRemaining > 0) {
          const payId = await t.insert('payment', {
            company_id: c,
            customer_id: customerId,
            amount_ore: d._paidFromRemaining,
            payment_date: d.dueDate,
            method: 'other',
            reference: d.invoiceNr,
            note: `Betalt enligt ${batch.sourceLabel} (import ${batch.batchNr}). Betaldatum okänt.`,
          });
          await t.insert('payment_allocation', { company_id: c, payment_id: payId, invoice_id: invId, amount_ore: d._paidFromRemaining });
        }
        return invId;
      }
      case 'payment': {
        const payId = await t.insert('payment', {
          company_id: c,
          customer_id: need('customer', d._customerKey, d._customerId),
          amount_ore: d.amount,
          payment_date: d.paymentDate,
          method: 'other',
          reference: d.ocr ?? d.invoiceRef ?? null,
          note: [d.payerName, note].filter(Boolean).join(' · '),
        });
        const invoiceId = d._invoiceKey || d._invoiceId ? need('invoice', d._invoiceKey, d._invoiceId) : null;
        if (invoiceId) await t.insert('payment_allocation', { company_id: c, payment_id: payId, invoice_id: invoiceId, amount_ore: d.amount });
        return payId;
      }
      case 'document': {
        const f = (await client.query('select file_name, mime_type, size_bytes, sha256, content from import_file where id = $1', [d.fileId])).rows[0];
        let entityType: string | null = null;
        let entityId: string | null = null;
        if (d._link) {
          entityType = d._link.entity === 'object' ? 'rental_object' : d._link.entity;
          entityId = d._link.id ?? ids.get(`${d._link.entity}:${d._link.key}`) ?? null;
          if (!entityId) entityType = null;
        }
        const docId = await t.insert('document', {
          company_id: c,
          kind: entityType === 'contract' ? 'contract' : 'attachment',
          file_name: f.file_name,
          mime_type: f.mime_type ?? 'application/octet-stream',
          sha256: f.sha256,
          size_bytes: f.size_bytes,
          entity_type: entityType,
          entity_id: entityId,
          description: note,
        });
        await client.query('insert into document_content (id, company_id, content) values ($1, $2, $3)', [docId, c, f.content]);
        return docId;
      }
    }
    throw new Error(`${r.entity} kan inte importeras ännu`);
  }

  async function update(r: Row, d: Record<string, any>) {
    const table = TABLE[r.entity];
    const cols = COLUMN[r.entity] ?? {};
    const values: Record<string, unknown> = {};
    for (const ch of r.changes) {
      const col = cols[ch.field];
      if (!col) continue;
      values[col] = r.entity === 'customer' && ch.field === 'nationalId' ? d.nationalIdNormalized : ch.incoming;
    }
    if (r.entity === 'contract' && values.end_date !== undefined) {
      values.status = (values.end_date as string) < todayIso ? 'terminated' : 'active';
    }
    if (table && Object.keys(values).length) await t.update(table, r.target_id!, values);
    if (r.entity === 'contract' && values.end_date !== undefined) {
      const objs = await client.query('select id from contract_object where contract_id = $1', [r.target_id]);
      for (const o of objs.rows) await t.update('contract_object', o.id, { valid_to: values.end_date });
    }
    if (r.entity === 'object') {
      const rent = r.changes.find((c) => c.field === 'monthlyRent');
      const vat = r.changes.find((c) => c.field === 'vatLiable');
      if (rent) await newPeriod('rental_object_price', r.target_id!, d.rentFrom, { monthly_rent_ore: rent.incoming, reason: 'Import' });
      if (vat) await newPeriod('rental_object_vat', r.target_id!, d.rentFrom, { vat_liable: vat.incoming, note: 'Import' });
    }
  }

  /** Ny period från ett datum: den öppna perioden avslutas dagen före (eller ändras om den börjar samma dag). */
  async function newPeriod(table: string, objectId: string, from: string, values: Record<string, unknown>) {
    const open = (
      await client.query(`select id, valid_from::text from ${table} where object_id = $1 and (valid_to is null or valid_to >= $2) order by valid_from desc`, [
        objectId,
        from,
      ])
    ).rows;
    for (const p of open) {
      if (p.valid_from >= from) {
        if (p.valid_from === from) {
          await t.update(table, p.id, values);
          return;
        }
        throw new Error(`Det finns redan en period från ${p.valid_from}`);
      }
      await t.update(table, p.id, { valid_to: dayBefore(from) });
    }
    await t.insert(table, { company_id: batch.companyId, object_id: objectId, valid_from: from, ...values });
  }
}

export function dbMessage(e: unknown): string {
  const err = e as { code?: string; message?: string; table?: string; detail?: string; constraint?: string };
  switch (err.code) {
    case '23505':
      return `Finns redan (${err.detail ?? err.constraint ?? 'dubblett'})`;
    case '23P01':
      return err.table === 'contract_object' ? 'Objektet ingår redan i ett annat avtal under perioden' : 'Perioden överlappar en befintlig period';
    case '23503':
      return 'Hänvisar till något som inte finns';
    case '23514':
      return err.message?.includes('violates check constraint') ? `Ogiltigt värde (${err.constraint})` : (err.message ?? 'Ogiltigt värde');
    case '22P02':
    case '22007':
    case '22008':
      return 'Ogiltigt värde';
    default:
      return err.message ?? 'Okänt fel';
  }
}

/**
 * Ångrar en skarp import: skapade rader tas bort och ändrade rader får
 * tillbaka sina tidigare värden, i omvänd ordning. Om något som importen
 * skapade har börjat användas (t.ex. en avi på ett importerat avtal)
 * stoppas ångringen och ingenting ändras.
 */
export async function rollbackBatch(client: PoolClient, batchId: string, committedAt: string) {
  const changes = (await client.query('select id, table_name, row_id, action, before from import_change where batch_id = $1 order by id desc', [batchId]))
    .rows;
  const blockers: string[] = [];
  // Rader som ändrats efter importen ska inte tyst återställas
  const withUpdatedAt = new Set(
    (await client.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'updated_at'`)).rows.map(
      (r) => r.table_name,
    ),
  );
  for (const c of changes) {
    if (!withUpdatedAt.has(c.table_name)) continue;
    const r = (await client.query(`select updated_at > $2::timestamptz + interval '1 second' as changed from ${c.table_name} where id = $1`, [c.row_id, committedAt]))
      .rows[0];
    if (r?.changed && c.table_name !== 'external_ref') blockers.push(`${c.table_name} ${c.row_id} har ändrats efter importen`);
  }
  if (blockers.length) return { ok: false as const, blockers: [...new Set(blockers)].slice(0, 20) };

  let deleted = 0;
  let restored = 0;
  for (const c of changes) {
    await client.query('savepoint undo');
    try {
      if (c.action === 'insert') {
        const r = await client.query(`delete from ${c.table_name} where id = $1`, [c.row_id]);
        deleted += r.rowCount ?? 0;
      } else {
        const cols = Object.keys(c.before).filter((k) => !['id', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(k));
        await client.query(
          `update ${c.table_name} t set (${cols.join(', ')}) = (select ${cols.map((k) => `r.${k}`).join(', ')} from jsonb_populate_record(null::${c.table_name}, $2) r) where t.id = $1`,
          [c.row_id, c.before],
        );
        restored++;
      }
      await client.query('release savepoint undo');
    } catch (e) {
      await client.query('rollback to savepoint undo');
      const code = (e as { code?: string }).code;
      blockers.push(
        code === '23503'
          ? `${c.table_name} ${c.row_id} används av poster som skapats efter importen`
          : `${c.table_name} ${c.row_id}: ${dbMessage(e)}`,
      );
    }
  }
  if (blockers.length) return { ok: false as const, blockers: [...new Set(blockers)].slice(0, 20) };
  return { ok: true as const, deleted, restored };
}
