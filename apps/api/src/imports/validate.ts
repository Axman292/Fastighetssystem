import type { PoolClient } from 'pg';
import { normalizeOrgNr } from '../common/validation';
import { normalizePersonalId } from '../customers/customers.controller';
import { dayBefore, today } from '../common/money';
import { RESIDENTIAL_TYPES } from '../properties/property.schemas';
import { adapterFor, norm, splitAddress } from './adapters';
import { accountType, CONTRACT_TYPE, convert, OBJECT_TYPE, PROPERTY_CATEGORY } from './convert';
import { ENTITY, EntityKey, fieldDef } from './entities';
import type { Cell } from './formats';

/**
 * Kontroll av en import: filernas rader blir poster (fastigheter, objekt,
 * hyresgäster …) som jämförs med det som redan finns i bolaget.
 * Varje post får en status:
 *   new        skapas
 *   update     finns, men uppgifter skiljer sig. Skrivs bara över om användaren godkänner.
 *   unchanged  har importerats förut och är oförändrad
 *   link       finns redan (samma beteckning, objektsnummer, personnummer …) och kopplas ihop
 *   error      kan inte importeras förrän felet är rättat
 *   skipped    hoppas över (användarens val, annat bolag eller ännu inte möjligt)
 */

export type Level = 'error' | 'warning' | 'info';
export interface Issue {
  level: Level;
  message: string;
}
export interface Change {
  field: string;
  label: string;
  current: unknown;
  incoming: unknown;
}
export type Status = 'new' | 'update' | 'unchanged' | 'link' | 'error' | 'skipped';

export interface Rec {
  entity: EntityKey;
  key: string;
  label: string;
  data: Record<string, any>;
  tableId: string | null;
  fileId: string | null;
  sourceRow: number | null;
  issues: Issue[];
  changes: Change[];
  status: Status;
  targetId: string | null;
  /** Hittad via originalsystemets id (true) eller via beteckning/nummer (false). */
  viaExternalRef?: boolean;
}

export interface Decision {
  entity: string;
  recordKey: string;
  approveUpdate: boolean;
  skip: boolean;
  overrides: Record<string, any>;
}

interface BatchInfo {
  id: string;
  companyId: string;
  companyName: string;
  sourceSystem: string;
  defaultPropertyId: string | null;
}

const err = (r: Rec, message: string) => r.issues.push({ level: 'error', message });
const warn = (r: Rec, message: string) => r.issues.push({ level: 'warning', message });
const info = (r: Rec, message: string) => r.issues.push({ level: 'info', message });

function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function customerKey(d: Record<string, any>): string | null {
  if (txt(d.externalId)) return `ext:${txt(d.externalId)}`;
  const nid = d.nationalIdNormalized ?? null;
  if (nid) return `nid:${nid}`;
  if (!txt(d.name)) return null;
  return `name:${norm(d.name)}|${norm(d.email ?? '')}`;
}

function normalizeNationalId(raw: string, kindHint?: string | null): { value: string | null; kind: 'person' | 'organization' | null } {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  // Organisationsnummer har tredje siffran 2 eller högre
  const looksOrg = ten.length === 10 && Number(ten[2]) >= 2 && kindHint !== 'person';
  if (looksOrg || kindHint === 'organization') {
    const o = normalizeOrgNr(raw);
    if (o) return { value: o, kind: 'organization' };
  }
  const p = normalizePersonalId(raw);
  if (p) return { value: p, kind: 'person' };
  const o = normalizeOrgNr(raw);
  return o ? { value: o, kind: 'organization' } : { value: null, kind: null };
}

const COMPANY_WORDS = /\b(ab|hb|kb|aktiebolag|handelsbolag|kommanditbolag|ek för|ekonomisk förening|brf|bostadsrättsförening|kommun|region|stiftelse|förening|ltd|inc|gmbh|as|oy)\b/i;

// ---------------------------------------------------------------------
// 1. Filernas rader blir poster
// ---------------------------------------------------------------------

interface TableRow {
  id: string;
  file_id: string;
  name: string;
  profile: string;
  headers: string[];
  data: Cell[][];
  mapping: Record<string, string>;
}

export function buildRecords(batch: BatchInfo, tables: TableRow[], files: { id: string; file_name: string; format: string; sha256: string; size_bytes: string }[]) {
  const recs = new Map<string, Rec>();
  const sourceTotals: Record<string, Record<string, number>> = {};
  const adapter = adapterFor(batch.sourceSystem);

  const add = (r: Rec): Rec => {
    const id = `${r.entity}:${r.key}`;
    const existing = recs.get(id);
    if (!existing) {
      recs.set(id, r);
      return r;
    }
    merge(existing, r);
    return existing;
  };

  for (const t of tables) {
    if (t.profile === 'ignored') continue;
    const totals: Record<string, number> = { rows: 0 };
    sourceTotals[t.id] = totals;
    t.data.forEach((cells, i) => {
      const rowNr = i + 2; // rubrikraden är rad 1
      const raw: Record<string, Cell> = {};
      t.headers.forEach((h, j) => (raw[h] = cells[j] ?? null));
      const f: Record<string, Cell> = {};
      for (const [k, col] of Object.entries(t.mapping)) if (col) f[k] = raw[col] ?? null;
      adapter.derive?.(t.profile, f, raw, t.headers);

      // Gruppera fälten per typ av post och omvandla värdena
      const groups: Partial<Record<EntityKey, { data: Record<string, any>; issues: Issue[] }>> = {};
      for (const [k, v] of Object.entries(f)) {
        const [entity, field] = k.split('.') as [EntityKey | 'meta', string];
        if (entity === 'meta') continue;
        if (!ENTITY[entity]) continue;
        const g = (groups[entity] ??= { data: {}, issues: [] });
        const def = fieldDef(k);
        if (!def) {
          g.data[field] = v; // härlett fält, t.ex. contract.groupKey
          continue;
        }
        const c = convert(def.type, v);
        if (c.error) g.issues.push({ level: 'error', message: `${def.label}: ${c.error}` });
        g.data[field] = c.value;
      }
      for (const [entity, g] of Object.entries(groups) as [EntityKey, { data: Record<string, any>; issues: Issue[] }][]) {
        if (!Object.values(g.data).some((v) => v !== null && v !== undefined)) delete groups[entity];
      }

      // Rader som tillhör ett annat bolag hoppas över
      const rowCompany = txt(f['meta.company']);
      const otherCompany = rowCompany && norm(rowCompany) !== norm(batch.companyName) ? rowCompany : null;
      const tot: Record<string, number> = otherCompany ? {} : totals;
      if (!otherCompany) totals.rows++;

      const mk = (entity: EntityKey, key: string | null, label: string, g: { data: Record<string, any>; issues: Issue[] }): Rec | null => {
        const baseKey = key ?? `rad:${t.id.slice(0, 8)}:${rowNr}`;
        const r: Rec = {
          entity,
          // Rader från andra bolag får egen nyckel så att de aldrig blandas ihop med bolagets egna
          key: otherCompany ? `annat-bolag:${norm(otherCompany)}:${baseKey}` : baseKey,
          label,
          data: g.data,
          tableId: t.id,
          fileId: t.file_id,
          sourceRow: rowNr,
          issues: [...g.issues],
          changes: [],
          status: 'new',
          targetId: null,
        };
        for (const fd of ENTITY[entity].fields) {
          if ((entity as string) === 'voucher') break; // kontrolleras per rad nedan
          if (fd.required && (g.data[fd.key] === null || g.data[fd.key] === undefined)) {
            // Fastighet utan beteckning men med namn: namnet används
            if (entity === 'property' && fd.key === 'designation' && txt(g.data.name)) continue;
            r.issues.push({ level: 'error', message: `${fd.label} saknas` });
          }
        }
        if (otherCompany) {
          r.status = 'skipped';
          r.issues.push({ level: 'info', message: `Tillhör ${otherCompany}. Importera filen i det bolaget.` });
        }
        return add(r);
      };

      let propRec: Rec | null = null;
      let objRec: Rec | null = null;
      let custRec: Rec | null = null;

      if (groups.property) {
        const d = groups.property.data;
        const key = txt(d.externalId) ?? txt(d.designation) ?? txt(d.name);
        propRec = mk('property', key ? norm(key) : null, txt(d.designation) ?? txt(d.name) ?? 'Fastighet', groups.property);
      }
      if (groups.object) {
        const d = groups.object.data;
        if (propRec && !txt(d.propertyRef)) d.propertyRef = propRec.label;
        if (propRec) d._propertyKey = propRec.key;
        const key = txt(d.externalId) ?? txt(d.objectNr);
        objRec = mk('object', key, `Objekt ${txt(d.objectNr) ?? '?'}`, groups.object);
        tot.objects = (tot.objects ?? 0) + 1;
        if (typeof d.monthlyRent === 'number') tot.objectRentOre = (tot.objectRentOre ?? 0) + d.monthlyRent;
      }
      if (groups.rent) {
        const d = groups.rent.data;
        d.objectRef ??= objRec?.data.objectNr ?? null;
        mk('rent', `${txt(d.objectRef)}|${d.validFrom}`, `Hyra ${txt(d.objectRef) ?? '?'} från ${d.validFrom ?? '?'}`, groups.rent);
      }
      if (groups.customer) {
        const d = groups.customer.data;
        if (txt(d.nationalId)) {
          const n = normalizeNationalId(String(d.nationalId), d.kind);
          d.nationalIdNormalized = n.value;
          d._kindFromId = n.kind;
        }
        custRec = mk('customer', customerKey(d), txt(d.name) ?? 'Hyresgäst', groups.customer);
        tot.customers = (tot.customers ?? 0) + 1;
      }
      if (groups.cotenant && custRec) {
        const d = groups.cotenant.data;
        d._customerKey = custRec.key;
        mk('cotenant', `${custRec.key}|${norm(txt(d.nationalId) ?? txt(d.name) ?? '')}`, `${txt(d.name)} (medhyresgäst till ${custRec.label})`, groups.cotenant);
      }
      if (groups.contract) {
        const d = groups.contract.data;
        if (!txt(d.customerRef) && custRec) d._customerKey = custRec.key;
        d._objectKeys = txt(d.objectRef)
          ? String(d.objectRef)
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : objRec
            ? [objRec.key]
            : [];
        d._rentByObject = objRec && typeof d.monthlyRent === 'number' ? { [objRec.key]: d.monthlyRent } : {};
        // Tillägg (t.ex. bredband) blir en egen rad på avtalet. En rad i filen kan ha ett tillägg.
        d._addons = [];
        if (txt(d.addonDescription) || typeof d.addonAmount === 'number') {
          d._addons.push({
            objectKey: objRec?.key ?? null,
            description: txt(d.addonDescription) ?? 'Tillägg',
            amountOre: typeof d.addonAmount === 'number' ? d.addonAmount : null,
            vatLiable: d.addonVatLiable === true,
            sourceRow: rowNr,
          });
        }
        delete d.addonDescription;
        delete d.addonAmount;
        delete d.addonVatLiable;
        const ck = custRec?.key ?? norm(txt(d.customerRef) ?? '');
        const key = txt(d.externalId) ?? txt(d.groupKey) ?? `${ck}|${d.startDate}|${d._objectKeys.join('+')}`;
        mk('contract', key, `Avtal ${custRec?.label ?? txt(d.customerRef) ?? ''} från ${d.startDate ?? '?'}`.trim(), groups.contract);
        // Avslutade avtal räknas inte in i den kontrakterade hyran
        const ended = !!d.endDate && String(d.endDate) < today();
        tot.contracts = (tot.contracts ?? 0) + 1;
        if (typeof d.monthlyRent === 'number' && !ended) tot.contractRentOre = (tot.contractRentOre ?? 0) + d.monthlyRent;
      }
      if (groups.supplier) {
        const d = groups.supplier.data;
        const orgNr = txt(d.orgNr) ? normalizeOrgNr(String(d.orgNr)) : null;
        d.orgNrNormalized = orgNr;
        const key = txt(d.externalId) ? `ext:${txt(d.externalId)}` : orgNr ? `org:${orgNr}` : `name:${norm(txt(d.name) ?? '')}`;
        mk('supplier', key, txt(d.name) ?? 'Leverantör', groups.supplier);
      }
      if (groups.account) {
        const d = groups.account.data;
        mk('account', txt(d.number) ?? '', `${txt(d.number) ?? '?'} ${txt(d.name) ?? ''}`.trim(), groups.account);
      }
      if (groups.voucher) {
        const d = groups.voucher.data;
        const amount = typeof d.amount === 'number' ? d.amount : (d.debit ?? 0) - (d.credit ?? 0);
        if (!txt(d.account)) groups.voucher.issues.push({ level: 'error', message: `Konto saknas på rad ${rowNr}` });
        if (typeof d.amount !== 'number' && d.debit == null && d.credit == null) groups.voucher.issues.push({ level: 'error', message: `Belopp saknas på rad ${rowNr}` });
        if (!txt(d.voucherNr)) groups.voucher.issues.push({ level: 'error', message: 'Verifikationsnummer saknas' });
        if (!d.date) groups.voucher.issues.push({ level: 'error', message: 'Datum saknas' });
        const series = txt(d.series) ?? 'A';
        const line = { account: txt(d.account), amountOre: amount, costCenter: txt(d.costCenter), objectCode: txt(d.objectCode), text: txt(d.lineText) };
        const g = { data: { series, voucherNr: txt(d.voucherNr), date: d.date, text: txt(d.text), lines: [line] }, issues: groups.voucher.issues };
        mk('voucher', `${series}|${txt(d.voucherNr)}|${d.date}`, `Verifikation ${series}${txt(d.voucherNr) ?? ''} ${d.date ?? ''}`.trim(), g);
        tot.voucherLines = (tot.voucherLines ?? 0) + 1;
      }
      if (groups.invoice) {
        const d = groups.invoice.data;
        mk('invoice', txt(d.externalId) ?? txt(d.invoiceNr) ?? '', `Faktura ${txt(d.invoiceNr) ?? '?'}`, groups.invoice);
        tot.invoices = (tot.invoices ?? 0) + 1;
        if (typeof d.remaining === 'number') tot.receivablesOre = (tot.receivablesOre ?? 0) + d.remaining;
        if (typeof d.remaining === 'number' && d.remaining > 0) tot.unpaidInvoices = (tot.unpaidInvoices ?? 0) + 1;
      }
      if (groups.payment) {
        const d = groups.payment.data;
        mk('payment', txt(d.externalId) ?? `${d.paymentDate}|${d.amount}|${txt(d.ocr) ?? txt(d.invoiceRef) ?? rowNr}`, `Betalning ${d.paymentDate ?? ''}`, groups.payment);
        tot.payments = (tot.payments ?? 0) + 1;
      }
    });
  }

  // Dokument: varje PDF eller annan bilaga blir en post
  for (const f of files) {
    if (f.format !== 'pdf' && f.format !== 'document') continue;
    add({
      entity: 'document',
      key: f.sha256,
      label: f.file_name,
      data: { fileName: f.file_name, fileId: f.id, sizeBytes: Number(f.size_bytes) },
      tableId: null,
      fileId: f.id,
      sourceRow: null,
      issues: [],
      changes: [],
      status: 'new',
      targetId: null,
    });
  }
  return { recs: [...recs.values()], sourceTotals };
}

function merge(a: Rec, b: Rec) {
  a.issues.push(...b.issues.filter((i) => !a.issues.some((x) => x.message === i.message)));
  if (a.entity === 'voucher') {
    a.data.lines.push(...b.data.lines);
    return;
  }
  if (a.entity === 'contract') {
    for (const k of b.data._objectKeys ?? []) if (!a.data._objectKeys.includes(k)) a.data._objectKeys.push(k);
    Object.assign(a.data._rentByObject, b.data._rentByObject);
    a.data._addons = [...(a.data._addons ?? []), ...(b.data._addons ?? [])];
    if (typeof b.data.monthlyRent === 'number') a.data.monthlyRent = (a.data.monthlyRent ?? 0) + b.data.monthlyRent;
    for (const [k, v] of Object.entries(b.data)) if (a.data[k] == null && v != null) a.data[k] = v;
    return;
  }
  if (a.entity === 'object' && a.tableId === b.tableId) {
    err(a, `Objektsnummer ${a.data.objectNr} förekommer flera gånger i filen (rad ${a.sourceRow} och ${b.sourceRow})`);
  }
  for (const [k, v] of Object.entries(b.data)) {
    if (k.startsWith('_')) continue;
    if (a.data[k] == null) a.data[k] = v;
    else if (v != null && String(v) !== String(a.data[k]) && (a.entity === 'customer' || a.entity === 'object')) {
      const label = fieldDef(`${a.entity}.${k}`)?.label ?? k;
      warn(a, `Olika ${label.toLowerCase()} i filerna: "${a.data[k]}" och "${v}". Den första används.`);
    }
  }
}

// ---------------------------------------------------------------------
// 2. Jämför med det som finns i bolaget
// ---------------------------------------------------------------------

interface Existing {
  refs: Map<string, string>; // entity:external_id -> internal_id
  props: any[];
  objs: any[];
  customers: any[];
  contacts: any[];
  contracts: Map<string, any>;
  periods: any[];
  prices: any[];
  accounts: Map<string, any>;
  suppliers: any[];
  documents: Map<string, string>;
  vouchers: Map<string, any>;
  invoices: any[];
  articles: { code: string; name: string; active: boolean; vat_rate_bp: number | null }[];
}

async function loadExisting(client: PoolClient, sourceSystem: string): Promise<Existing> {
  const q = async (sql: string, p: unknown[] = []) => (await client.query(sql, p)).rows;
  const refs = new Map<string, string>(
    (await q('select entity, external_id, internal_id from external_ref where source_system = $1', [sourceSystem])).map((r) => [
      `${r.entity}:${r.external_id}`,
      r.internal_id,
    ]),
  );
  return {
    refs,
    props: await q(`select id, designation, name, category, address_line, postal_code, city, municipality, construction_year,
                           area_boa_m2::float, area_loa_m2::float, area_bta_m2::float, site_area_m2::float from property`),
    objs: await q(`select o.id, o.object_nr, o.property_id, o.type, o.area_m2::float, o.rooms::float, o.floor, o.apartment_nr,
                          o.address_line, o.description, c.monthly_rent_ore::float as rent, c.vat_liable
                   from rental_object o left join rental_object_current c on c.object_id = o.id`),
    customers: await q(`select id, customer_nr, kind, name, national_id, email, phone, address_line, care_of, postal_code, city,
                               invoice_reference from customer`),
    contacts: await q('select id, customer_id, name, email, phone from customer_contact'),
    contracts: new Map(
      (await q(`select id, contract_nr, customer_id, start_date::text, end_date::text, notice_months, status, termination_received::text
                from contract`)).map((r) => [r.id, r]),
    ),
    periods: await q(`select co.object_id, co.contract_id, co.valid_from::text, co.valid_to::text, k.contract_nr, k.status
                      from contract_object co join contract k on k.id = co.contract_id where k.status <> 'cancelled'`),
    prices: await q('select object_id, monthly_rent_ore::float, valid_from::text, valid_to::text from rental_object_price'),
    accounts: new Map((await q('select id, number, name, type, sru_code, vat_code from account')).map((r) => [r.number, r])),
    suppliers: await q('select id, supplier_nr, name, org_nr, bankgiro, plusgiro, email, phone, address_line, postal_code, city, payment_terms_days from supplier'),
    documents: new Map((await q('select sha256, id from document')).map((r) => [r.sha256, r.id])),
    articles: (await q(`select to_regclass('article') is not null as ok`))[0].ok
      ? await q('select code, name, active, vat_rate_bp from article order by position')
      : [],
    invoices: (await q(`select to_regclass('invoice') is not null as ok`))[0].ok
      ? await q(`select i.id, i.invoice_nr::text, i.customer_id, i.total_ore::float, i.ocr, b.balance_ore::float
                 from invoice i left join invoice_balance b on b.invoice_id = i.id`)
      : [],
    vouchers: new Map(
      (await q(`select v.id, v.series, v.voucher_nr, v.voucher_date::text, coalesce(sum(abs(l.amount_ore)), 0)::float as turnover
                from legacy_voucher v left join legacy_voucher_line l on l.voucher_id = v.id
                where v.source_system = $1 group by v.id`, [sourceSystem])).map((r) => [`${r.series}|${r.voucher_nr}|${r.voucher_date}`, r]),
    ),
  };
}

function compare(r: Rec, pairs: [string, string, unknown, unknown][]) {
  for (const [field, label, current, incoming] of pairs) {
    if (incoming === null || incoming === undefined || incoming === '') continue;
    const same =
      typeof incoming === 'number' && current !== null && current !== undefined
        ? Math.abs(Number(current) - incoming) < 0.001
        : String(current ?? '').trim().toLowerCase() === String(incoming).trim().toLowerCase();
    if (!same) r.changes.push({ field, label, current: current ?? null, incoming });
  }
}

function matchResult(r: Rec, id: string | null, viaRef: boolean) {
  if (!id) return;
  r.targetId = id;
  r.viaExternalRef = viaRef;
}

export async function validateBatch(client: PoolClient, batch: BatchInfo, decisions: Decision[]) {
  const tables = (
    await client.query(`select id, file_id, name, profile, headers, data, mapping from import_table where batch_id = $1 order by created_at, name`, [
      batch.id,
    ])
  ).rows as TableRow[];
  const files = (await client.query(`select id, file_name, format, sha256, size_bytes from import_file where batch_id = $1`, [batch.id])).rows;
  const { recs, sourceTotals } = buildRecords(batch, tables, files);
  const ex = await loadExisting(client, batch.sourceSystem);
  const dec = new Map(decisions.map((d) => [`${d.entity}:${d.recordKey}`, d]));
  const by = (e: EntityKey) => recs.filter((r) => r.entity === e);
  const byKey = new Map(recs.map((r) => [`${r.entity}:${r.key}`, r]));
  const ref = (entity: string, key: string) => ex.refs.get(`${entity}:${key}`) ?? null;
  const todayIso = today();

  // Användarens rättelser (t.ex. vald fastighet) läggs på före kontrollen
  for (const r of recs) {
    const d = dec.get(`${r.entity}:${r.key}`);
    if (d?.overrides) for (const [k, v] of Object.entries(d.overrides)) if (v !== undefined) r.data[k] = v;
    if (d?.skip) r.status = 'skipped';
  }

  // Objekt där användaren angett en ny fastighet: fastigheten skapas i importen
  for (const r of recs) {
    if (r.entity !== 'object' || r.status === 'skipped' || r.data.propertyId || !txt(r.data.propertyName)) continue;
    const name = txt(r.data.propertyName)!;
    const key = norm(name);
    if (!byKey.has(`property:${key}`)) {
      const t = OBJECT_TYPE[norm(txt(r.data.type) ?? '')] ?? '';
      const p: Rec = {
        entity: 'property',
        key,
        label: name,
        data: { designation: name, name, category: t === 'parking' ? 'Parkering' : RESIDENTIAL_TYPES.has(t) ? 'Bostad' : 'Kommersiell' },
        tableId: null,
        fileId: null,
        sourceRow: null,
        issues: [{ level: 'info', message: 'Ny fastighet som du lagt till i importen' }],
        changes: [],
        status: 'new',
        targetId: null,
      };
      recs.push(p);
      byKey.set(`property:${key}`, p);
    }
    r.data._propertyKey = key;
  }

  // ---- Fastigheter
  const propByName = new Map<string, any>();
  for (const p of ex.props) {
    propByName.set(norm(p.designation), p);
    if (!propByName.has(norm(p.name))) propByName.set(norm(p.name), p);
  }
  for (const r of by('property')) {
    const d = r.data;
    d.designation = txt(d.designation) ?? txt(d.name);
    d.name = txt(d.name) ?? d.designation;
    if (txt(d.category)) {
      const c = PROPERTY_CATEGORY[norm(String(d.category))] ?? (Object.values(PROPERTY_CATEGORY).includes(String(d.category)) ? String(d.category) : null);
      if (!c) warn(r, `Okänd kategori "${d.category}", sätts till Övrigt`);
      d.category = c ?? 'other';
    }
    const viaRef = ref('property', r.key);
    const m = viaRef ? ex.props.find((p) => p.id === viaRef) : (propByName.get(norm(d.designation ?? '')) ?? propByName.get(norm(d.name ?? '')));
    if (m) {
      matchResult(r, m.id, !!viaRef);
      compare(r, [
        ['name', 'Namn', m.name, d.name === d.designation && m.name !== m.designation ? null : d.name],
        ['category', 'Kategori', m.category, d.category],
        ['addressLine', 'Adress', m.address_line, d.addressLine],
        ['postalCode', 'Postnummer', m.postal_code, d.postalCode],
        ['city', 'Ort', m.city, d.city],
        ['municipality', 'Kommun', m.municipality, d.municipality],
        ['constructionYear', 'Byggår', m.construction_year, d.constructionYear],
        ['areaBoaM2', 'BOA', m.area_boa_m2, d.areaBoaM2],
        ['areaLoaM2', 'LOA', m.area_loa_m2, d.areaLoaM2],
        ['areaBtaM2', 'BTA', m.area_bta_m2, d.areaBtaM2],
        ['siteAreaM2', 'Tomtarea', m.site_area_m2, d.siteAreaM2],
      ]);
      // Fastigheter som skapas från en hyresexport får bara grunduppgifter; skriv inte över kategori och adress
      if (batch.sourceSystem === 'dinhyresvard') r.changes = r.changes.filter((c) => !['category', 'addressLine', 'postalCode', 'city', 'municipality'].includes(c.field));
    } else {
      d.category ??= 'other';
      if (d.designation === d.name && !/\d+:\d+/.test(d.designation ?? '')) {
        info(r, 'Exporten saknar fastighetsbeteckning. Namnet används tills vidare, rätta beteckningen efteråt.');
      }
    }
  }

  // ---- Objekt
  const objByNr = new Map(ex.objs.map((o) => [String(o.object_nr), o]));
  const propRecByName = new Map<string, Rec>();
  for (const p of by('property')) {
    for (const n of [p.key, norm(p.data.designation ?? ''), norm(p.data.name ?? '')]) if (n && !propRecByName.has(n)) propRecByName.set(n, p);
  }
  const streetKey = (s: string | null) => (s ? norm(splitAddress(s).street ?? s).replace(/\s(lgh|lag)\s?\S+$/, '').replace(/\s[a-z]$/, '') : '');
  const propByStreet = new Map<string, string>();
  for (const p of ex.props) if (p.address_line) propByStreet.set(streetKey(p.address_line), p.id);
  const objRecs = by('object');
  // Adresser från objekt som redan har fastighet hjälper objekt som saknar (t.ex. bilplatser och lokaler)
  const recPropByStreet = new Map<string, string>();
  for (const o of objRecs) if (o.data._propertyKey && o.data.addressLine) recPropByStreet.set(streetKey(o.data.addressLine), o.data._propertyKey);

  let defaultProp: any = null;
  if (batch.defaultPropertyId) defaultProp = ex.props.find((p) => p.id === batch.defaultPropertyId) ?? null;

  for (const r of objRecs) {
    const d = r.data;
    d.objectNr = txt(d.objectNr);
    const t = txt(d.type);
    const type = t ? (OBJECT_TYPE[norm(t)] ?? OBJECT_TYPE[t] ?? null) : null;
    if (t && !type) err(r, `Okänd objekttyp "${t}". Använd Lägenhet, Lokal, Kontor, Restaurang, Parkering, Förråd eller Övrigt.`);
    d.type = type;
    if (typeof d.monthlyRent === 'number' && d.monthlyRent < 0) err(r, 'Månadshyran kan inte vara negativ');
    if (d.monthlyRent == null) warn(r, 'Månadshyra saknas');
    if (d.vatLiable && type && RESIDENTIAL_TYPES.has(type)) err(r, 'Bostäder kan inte vara momspliktiga');
    if (d.vatLiable == null) d.vatLiable = false;
    d.rentFrom ??= todayIso;
    if (typeof d.floor === 'number') d.floor = Math.round(d.floor);

    // Koppla till fastighet: användarens val, fastigheten på raden, beteckning/namn, adress eller förvald fastighet
    d._propertyId = null;
    if (d.propertyId) {
      d._propertyId = d.propertyId;
      d._propertyKey = null;
    } else if (d._propertyKey && byKey.get(`property:${d._propertyKey}`)) {
      /* fastigheten finns på samma rad */
    } else if (txt(d.propertyRef)) {
      const pr = propRecByName.get(norm(d.propertyRef));
      const pe = propByName.get(norm(d.propertyRef)) ?? ex.props.find((p) => p.id === ref('property', norm(d.propertyRef)));
      if (pr) d._propertyKey = pr.key;
      else if (pe) d._propertyId = pe.id;
      else err(r, `Fastigheten "${d.propertyRef}" finns varken i filerna eller i bolaget`);
    } else {
      const sk = streetKey(d.addressLine);
      const viaFile = recPropByStreet.get(sk);
      const viaDb = propByStreet.get(sk);
      if (viaFile) {
        d._propertyKey = viaFile;
        info(r, `Kopplad till ${byKey.get(`property:${viaFile}`)?.label} efter adressen`);
      } else if (viaDb) {
        d._propertyId = viaDb;
        info(r, `Kopplad till ${ex.props.find((p) => p.id === viaDb)?.name} efter adressen`);
      } else if (defaultProp) {
        d._propertyId = defaultProp.id;
        info(r, `Kopplad till förvald fastighet ${defaultProp.name}`);
      } else err(r, 'Välj vilken fastighet objektet hör till');
    }

    const viaRef = ref('object', r.key);
    const m = viaRef ? ex.objs.find((o) => o.id === viaRef) : objByNr.get(String(d.objectNr));
    if (m) {
      matchResult(r, m.id, !!viaRef);
      if (!viaRef && objByNr.get(String(d.objectNr)) && d._propertyId && m.property_id !== d._propertyId) {
        err(r, `Objektsnummer ${d.objectNr} finns redan i en annan fastighet`);
      }
      compare(r, [
        ['type', 'Typ', m.type, d.type],
        ['areaM2', 'Area', m.area_m2, d.areaM2],
        ['rooms', 'Rum', m.rooms, d.rooms],
        ['floor', 'Våning', m.floor, d.floor],
        ['apartmentNr', 'Lägenhetsnummer', m.apartment_nr, d.apartmentNr],
        ['addressLine', 'Adress', m.address_line, d.addressLine],
        ['description', 'Beskrivning', m.description, d.description],
        ['monthlyRent', 'Månadshyra', m.rent, d.monthlyRent],
        ['vatLiable', 'Momspliktig', m.vat_liable ?? false, d.vatLiable],
      ]);
      const cur = ex.prices.filter((p) => p.object_id === m.id).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
      if (r.changes.some((c) => c.field === 'monthlyRent') && cur && d.rentFrom < cur.valid_from) {
        err(r, `Ny hyra från ${d.rentFrom} är tidigare än nuvarande hyra från ${cur.valid_from}`);
      }
    }
  }

  // ---- Hyreshistorik: perioderna kedjas ihop per objekt
  const rentByObj = new Map<string, Rec[]>();
  for (const r of by('rent')) {
    const o = txt(r.data.objectRef);
    if (!o) continue;
    rentByObj.set(o, [...(rentByObj.get(o) ?? []), r]);
  }
  for (const [objectNr, list] of rentByObj) {
    const objRec = objRecs.find((o) => o.data.objectNr === objectNr) ?? byKey.get(`object:${objectNr}`);
    const objDb = objByNr.get(objectNr);
    list.sort((a, b) => String(a.data.validFrom).localeCompare(String(b.data.validFrom)));
    list.forEach((r, i) => {
      const next = list[i + 1];
      if (!r.data.validTo && next?.data.validFrom) r.data.validTo = dayBefore(next.data.validFrom);
      // Sista historiska perioden slutar dagen före objektets aktuella hyra
      if (!r.data.validTo && objRec && objRec.data.monthlyRent != null && r.data.validFrom < objRec.data.rentFrom) r.data.validTo = dayBefore(objRec.data.rentFrom);
      if (r.data.validTo && r.data.validFrom && r.data.validTo < r.data.validFrom) err(r, 'Slutdatum är före startdatum');
      if (!objRec && !objDb) err(r, `Objekt ${objectNr} finns varken i filerna eller i bolaget`);
      if (objRec && objRec.data.monthlyRent != null && r.data.validFrom >= objRec.data.rentFrom) {
        if (r.data.validFrom === objRec.data.rentFrom && r.data.monthlyRent === objRec.data.monthlyRent) {
          r.status = 'unchanged';
          info(r, 'Samma som objektets aktuella hyra');
        } else err(r, `Överlappar objektets aktuella hyra från ${objRec.data.rentFrom}`);
      }
      r.data._objectKey = objRec?.key ?? null;
      r.data._objectId = objRec ? null : (objDb?.id ?? null);
      const dbObjId = objRec?.targetId ?? objDb?.id;
      if (dbObjId && r.status !== 'unchanged') {
        const same = ex.prices.find((p) => p.object_id === dbObjId && p.valid_from === r.data.validFrom);
        if (same && Math.abs(same.monthly_rent_ore - r.data.monthlyRent) < 1) {
          r.status = 'unchanged';
          r.targetId = dbObjId;
        } else {
          const overlap = ex.prices.find(
            (p) =>
              p.object_id === dbObjId &&
              p.valid_from <= (r.data.validTo ?? '9999-12-31') &&
              (p.valid_to ?? '9999-12-31') >= r.data.validFrom,
          );
          if (overlap) err(r, `Överlappar befintlig hyra ${overlap.valid_from} – ${overlap.valid_to ?? 'tills vidare'}`);
        }
      }
    });
  }

  // ---- Hyresgäster
  const custByNid = new Map(ex.customers.filter((c) => c.national_id).map((c) => [c.national_id, c]));
  for (const r of by('customer')) {
    const d = r.data;
    d.name = txt(d.name);
    if (txt(d.nationalId) && !d.nationalIdNormalized) {
      warn(r, `Ogiltigt person- eller organisationsnummer "${d.nationalId}". Importeras utan nummer.`);
    }
    const kindText = norm(txt(d.kind) ?? '');
    d.kind = ['foretag', 'organisation', 'organization', 'juridisk', 'bolag'].includes(kindText)
      ? 'organization'
      : ['person', 'privatperson', 'privat', 'fysisk'].includes(kindText)
        ? 'person'
        : (d._kindFromId ?? (COMPANY_WORDS.test(d.name ?? '') ? 'organization' : 'person'));
    if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) {
      warn(r, `Ogiltig e-postadress "${d.email}", importeras utan e-post`);
      d.email = null;
    }
    if (!d.email && !d.addressLine) warn(r, 'Varken e-post eller postadress. Avier kan inte skickas förrän en adress läggs in.');
    else if (!d.email) info(r, 'E-post saknas. Avier skickas med brev.');
    const viaRef = ref('customer', r.key);
    const m = viaRef
      ? ex.customers.find((c) => c.id === viaRef)
      : d.nationalIdNormalized
        ? custByNid.get(d.nationalIdNormalized)
        : ex.customers.find((c) => !c.national_id && norm(c.name) === norm(d.name ?? '') && norm(c.email ?? '') === norm(d.email ?? ''));
    if (m) {
      matchResult(r, m.id, !!viaRef);
      compare(r, [
        ['name', 'Namn', m.name, d.name],
        ['nationalId', 'Person/orgnr', m.national_id, d.nationalIdNormalized],
        ['email', 'E-post', m.email, d.email],
        ['phone', 'Telefon', m.phone, d.phone],
        ['addressLine', 'Adress', m.address_line, d.addressLine],
        ['careOf', 'c/o', m.care_of, d.careOf],
        ['postalCode', 'Postnummer', m.postal_code, d.postalCode],
        ['city', 'Ort', m.city, d.city],
        ['invoiceReference', 'Fakturareferens', m.invoice_reference, d.invoiceReference],
      ]);
    }
  }

  // ---- Medhyresgäster läggs som kontaktpersoner hos hyresgästen
  for (const r of by('cotenant')) {
    const c = byKey.get(`customer:${r.data._customerKey}`);
    if (c?.targetId) {
      const m = ex.contacts.find((x) => x.customer_id === c.targetId && norm(x.name) === norm(r.data.name ?? ''));
      if (m) {
        matchResult(r, m.id, false);
        compare(r, [
          ['email', 'E-post', m.email, r.data.email],
          ['phone', 'Telefon', m.phone, r.data.phone],
        ]);
      }
    }
  }

  // ---- Avtal
  const objectRecFor = (k: string) => byKey.get(`object:${k}`) ?? objRecs.find((o) => o.data.objectNr === k) ?? null;
  const batchPeriods: { objectKey: string; from: string; to: string; rec: Rec }[] = [];
  for (const r of by('contract')) {
    const d = r.data;
    if (d.endDate && d.startDate && d.endDate < d.startDate) err(r, 'Slutdatum är före startdatum');
    // Hyresgäst
    let cust: Rec | null = d._customerKey ? (byKey.get(`customer:${d._customerKey}`) ?? null) : null;
    d._customerId = null;
    if (!cust && txt(d.customerRef)) {
      const k = String(d.customerRef);
      cust = by('customer').find((c) => c.key === `ext:${k}` || c.data.nationalIdNormalized === k || norm(c.data.name ?? '') === norm(k)) ?? null;
      if (!cust) {
        const nid = normalizeNationalId(k);
        const m =
          ex.customers.find((c) => c.id === ref('customer', `ext:${k}`)) ??
          (nid.value ? custByNid.get(nid.value) : undefined) ??
          ex.customers.find((c) => String(c.customer_nr) === k || norm(c.name) === norm(k));
        if (m) d._customerId = m.id;
        else err(r, `Hyresgästen "${k}" finns varken i filerna eller i bolaget`);
      }
    }
    if (cust) d._customerKey = cust.key;
    else if (!d._customerId && !txt(d.customerRef)) err(r, 'Hyresgäst saknas');

    // Objekt
    const objects: { key: string | null; id: string | null; type: string | null; rent: number | null; vat: boolean; nr: string }[] = [];
    for (const k of d._objectKeys ?? []) {
      const o = objectRecFor(k);
      const db = o ? null : (objByNr.get(k) ?? ex.objs.find((x) => x.id === ref('object', k)));
      if (!o && !db) {
        err(r, `Objekt ${k} finns varken i filerna eller i bolaget`);
        continue;
      }
      objects.push({
        key: o?.key ?? null,
        id: o ? null : db.id,
        type: o ? o.data.type : db.type,
        rent: o ? (o.data.monthlyRent ?? null) : (db.rent ?? null),
        vat: o ? !!o.data.vatLiable : !!db.vat_liable,
        nr: o ? o.data.objectNr : db.object_nr,
      });
    }
    if (!objects.length && !r.issues.some((i) => i.level === 'error')) err(r, 'Avtalet saknar objekt');
    d._objects = objects;

    // Avtalstyp efter text eller efter första objektet
    const tt = txt(d.type);
    const fromObj = (t: string | null) =>
      t === 'apartment' || t === 'hotel_apartment' ? 'residential' : t === 'parking' ? 'parking' : t === 'storage' ? 'storage' : 'commercial';
    d.type = tt ? (CONTRACT_TYPE[norm(tt)] ?? null) : objects.length ? fromObj(objects[0].type) : 'other';
    if (tt && !d.type) {
      warn(r, `Okänd avtalstyp "${tt}", sätts efter objektet`);
      d.type = objects.length ? fromObj(objects[0].type) : 'other';
    }
    if (d.type === 'residential' && objects.some((o) => o.vat)) err(r, 'Bostadsavtal kan inte omfatta momspliktiga objekt');
    d.noticeMonths = typeof d.noticeMonths === 'number' ? Math.round(d.noticeMonths) : d.type === 'residential' ? 3 : d.type === 'commercial' ? 9 : 1;
    const bi = norm(txt(d.billingInterval) ?? '');
    d.billingInterval = bi.startsWith('kvartal') || bi === 'quarter' ? 'quarter' : 'month';
    d.status = d.terminationDate || (d.endDate && d.endDate < todayIso) ? 'terminated' : 'active';

    // Hyresrader: objektens hyra. Avtalets totala hyra används som kontroll.
    const sumObjects = objects.reduce((s, o) => s + (o.rent ?? 0), 0);
    d._lines = objects.map((o) => ({
      objectKey: o.key,
      objectId: o.id,
      objectNr: o.nr,
      amountOre: objects.length === 1 && typeof d.monthlyRent === 'number' && d.monthlyRent > 0 ? d.monthlyRent : (o.rent ?? 0),
      vatRateBp: o.vat && d.type !== 'residential' ? 2500 : 0,
    }));
    if (typeof d.monthlyRent === 'number' && objects.length > 1 && d.monthlyRent > 0 && Math.abs(d.monthlyRent - sumObjects) >= 100) {
      warn(
        r,
        `Avtalets hyra i originalsystemet är ${(d.monthlyRent / 100).toLocaleString('sv-SE')} kr men objektens hyror är ${(sumObjects / 100).toLocaleString('sv-SE')} kr. Objektens hyror används.`,
      );
    }
    if (d._lines.every((l: any) => l.amountOre === 0) && objects.length) warn(r, 'Avtalet saknar hyra');

    // Tillägg utöver hyran, t.ex. bredband eller vidarefakturerad fastighetsskatt
    for (const a of (d._addons ?? []) as { objectKey: string | null; description: string; amountOre: number | null; vatLiable: boolean; sourceRow: number }[]) {
      if (a.amountOre === null) {
        err(r, `Tillägget "${a.description}" saknar belopp (rad ${a.sourceRow})`);
        continue;
      }
      if (a.vatLiable && d.type === 'residential') {
        err(r, `Tillägget "${a.description}" kan inte vara momspliktigt på ett bostadsavtal (rad ${a.sourceRow})`);
        continue;
      }
      const o = a.objectKey ? objects.find((x) => x.key === a.objectKey) : null;
      d._lines.push({
        objectKey: o?.key ?? null,
        objectId: o?.id ?? null,
        objectNr: o?.nr ?? null,
        amountOre: a.amountOre,
        vatRateBp: a.vatLiable ? 2500 : 0,
        article: addonArticle(a.description, ex.articles),
        description: a.description,
        addon: true,
      });
    }
    if (d.status === 'terminated' && d.endDate && d.endDate < todayIso) info(r, `Avslutat ${d.endDate}`);

    // Redan importerat?
    const viaRef = ref('contract', r.key);
    const m = viaRef ? ex.contracts.get(viaRef) : null;
    if (m) {
      matchResult(r, m.id, true);
      compare(r, [
        ['endDate', 'Slutdatum', m.end_date, d.endDate],
        ['noticeMonths', 'Uppsägningstid', m.notice_months, txt(r.data.noticeMonths) ? d.noticeMonths : null],
      ]);
    } else {
      // Samma objekt får inte vara uthyrt två gånger samtidigt
      const from = d.startDate ?? '0001-01-01';
      const to = d.endDate ?? '9999-12-31';
      for (const o of objects) {
        const dbId = o.id ?? (o.key ? objectRecFor(o.key)?.targetId : null);
        if (dbId) {
          const clash = ex.periods.find((p) => p.object_id === dbId && p.valid_from <= to && (p.valid_to ?? '9999-12-31') >= from);
          if (clash) {
            // Samma hyresgäst och startdatum = avtalet finns redan, koppla ihop
            const k = ex.contracts.get(clash.contract_id);
            const custId = d._customerId ?? (d._customerKey ? byKey.get(`customer:${d._customerKey}`)?.targetId : null);
            if (k && k.start_date === d.startDate && custId && k.customer_id === custId) {
              matchResult(r, k.id, false);
            } else {
              err(r, `Objekt ${o.nr} är redan uthyrt i avtal ${clash.contract_nr} (${clash.valid_from} – ${clash.valid_to ?? 'tills vidare'})`);
            }
          }
        }
        const key = o.key ?? o.id!;
        const clash2 = batchPeriods.find((p) => p.objectKey === key && p.from <= to && p.to >= from);
        if (clash2) err(r, `Objekt ${o.nr} ingår också i ${clash2.rec.label} under samma period`);
        batchPeriods.push({ objectKey: key, from, to, rec: r });
      }
    }
  }

  // ---- Leverantörer
  for (const r of by('supplier')) {
    const d = r.data;
    if (txt(d.orgNr) && !d.orgNrNormalized) warn(r, `Ogiltigt organisationsnummer "${d.orgNr}", importeras utan nummer`);
    if (d.bankgiro && !/^\d{3,4}-?\d{4}$/.test(String(d.bankgiro).replace(/\s/g, ''))) warn(r, `Bankgironumret "${d.bankgiro}" ser felaktigt ut`);
    d.paymentTermsDays = typeof d.paymentTermsDays === 'number' ? Math.round(d.paymentTermsDays) : null;
    const viaRef = ref('supplier', r.key);
    const m = viaRef
      ? ex.suppliers.find((s) => s.id === viaRef)
      : d.orgNrNormalized
        ? ex.suppliers.find((s) => s.org_nr === d.orgNrNormalized)
        : ex.suppliers.find((s) => norm(s.name) === norm(d.name ?? ''));
    if (m) {
      matchResult(r, m.id, !!viaRef);
      compare(r, [
        ['name', 'Namn', m.name, d.name],
        ['bankgiro', 'Bankgiro', m.bankgiro, d.bankgiro],
        ['plusgiro', 'Plusgiro', m.plusgiro, d.plusgiro],
        ['email', 'E-post', m.email, d.email],
        ['phone', 'Telefon', m.phone, d.phone],
        ['addressLine', 'Adress', m.address_line, d.addressLine],
        ['postalCode', 'Postnummer', m.postal_code, d.postalCode],
        ['city', 'Ort', m.city, d.city],
        ['paymentTermsDays', 'Betalningsvillkor', m.payment_terms_days, d.paymentTermsDays],
      ]);
    }
  }

  // ---- Kontoplan
  for (const r of by('account')) {
    const d = r.data;
    d.number = txt(d.number);
    if (d.number && !/^\d{4}$/.test(d.number)) err(r, `Kontonummer "${d.number}" ska vara fyra siffror`);
    if (d.number) d.type = accountType(d.number, txt(d.type));
    const m = ex.accounts.get(d.number);
    if (m) {
      matchResult(r, m.id, false);
      compare(r, [
        ['name', 'Kontonamn', m.name, d.name],
        ['type', 'Kontotyp', m.type, d.type],
        ['sruCode', 'SRU', m.sru_code, d.sruCode],
      ]);
    }
  }

  // ---- Konteringar (historiska verifikationer)
  const accountsInBatch = new Set(by('account').map((a) => a.data.number));
  for (const r of by('voucher')) {
    const d = r.data;
    const sum = d.lines.reduce((s: number, l: any) => s + (l.amountOre ?? 0), 0);
    if (sum !== 0) err(r, `Verifikationen balanserar inte (differens ${(sum / 100).toLocaleString('sv-SE')} kr)`);
    for (const l of d.lines) {
      if (!l.account || !/^\d{4}$/.test(l.account)) err(r, `Ogiltigt konto "${l.account ?? ''}"`);
      else if (!accountsInBatch.has(l.account) && !ex.accounts.has(l.account)) warn(r, `Konto ${l.account} finns inte i kontoplanen`);
    }
    const m = ex.vouchers.get(r.key);
    if (m) {
      const turnover = d.lines.reduce((s: number, l: any) => s + Math.abs(l.amountOre ?? 0), 0);
      if (Math.abs(m.turnover - turnover) >= 1) err(r, 'Verifikationen finns redan med andra belopp');
      else {
        matchResult(r, m.id, true);
      }
    }
  }

  // ---- Hyresavier, kundfakturor och kundreskontra
  const resolveCustomer = (k: string): { key: string | null; id: string | null } => {
    const c = by('customer').find((x) => x.key === `ext:${k}` || x.data.nationalIdNormalized === k || norm(x.data.name ?? '') === norm(k));
    if (c) return { key: c.key, id: null };
    const nid = normalizeNationalId(k);
    const m =
      ex.customers.find((x) => x.id === ref('customer', `ext:${k}`)) ??
      (nid.value ? custByNid.get(nid.value) : undefined) ??
      ex.customers.find((x) => String(x.customer_nr) === k || norm(x.name) === norm(k));
    return { key: null, id: m?.id ?? null };
  };
  const invByNr = new Map(ex.invoices.map((i) => [i.invoice_nr, i]));
  const paymentsFor = new Map<string, number>();
  for (const r of by('payment')) if (txt(r.data.invoiceRef) && typeof r.data.amount === 'number') {
    paymentsFor.set(String(r.data.invoiceRef), (paymentsFor.get(String(r.data.invoiceRef)) ?? 0) + r.data.amount);
  }
  for (const r of by('invoice')) {
    const d = r.data;
    if (!ENTITY.invoice.available) {
      r.status = 'skipped';
      info(r, ENTITY.invoice.unavailableReason!);
      continue;
    }
    d.invoiceNr = txt(d.invoiceNr);
    if (d.invoiceNr && !/^\d{1,15}$/.test(d.invoiceNr)) err(r, `Fakturanummer "${d.invoiceNr}" måste vara ett heltal`);
    const c = txt(d.customerRef) ? resolveCustomer(String(d.customerRef)) : { key: null, id: null };
    d._customerKey = c.key;
    d._customerId = c.id;
    if (txt(d.customerRef) && !c.key && !c.id) err(r, `Kunden "${d.customerRef}" finns varken i filerna eller i bolaget`);
    if (!d.dueDate && d.invoiceDate) {
      const due = new Date(`${d.invoiceDate}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + 30);
      d.dueDate = due.toISOString().slice(0, 10);
      info(r, 'Förfallodatum saknas, satt till 30 dagar efter fakturadatum');
    }
    if (d.dueDate && d.invoiceDate && d.dueDate < d.invoiceDate) err(r, 'Förfallodatum är före fakturadatum');
    if (typeof d.total === 'number') {
      d.vat = typeof d.vat === 'number' ? d.vat : 0;
      d.net = d.total - d.vat;
      const pct = d.net !== 0 ? (d.vat / d.net) * 100 : 0;
      d.vatRateBp = [0, 6, 12, 25].reduce((best, x) => (Math.abs(x - pct) < Math.abs(best - pct) ? x : best), 0) * 100;
      if (d.vat !== 0 && Math.abs(Math.round((d.net * d.vatRateBp) / 10000) - d.vat) > 100) warn(r, 'Momsen stämmer inte med någon momssats. Beloppen importeras som de är.');
      if (d.total < 0) warn(r, 'Negativt belopp: importeras som faktura med minusbelopp');
      if (typeof d.remaining === 'number' && d.remaining > d.total && d.total >= 0) err(r, 'Kvar att betala är större än fakturabeloppet');
      const paid = paymentsFor.get(d.invoiceNr ?? '');
      d._paidFromRemaining = paid === undefined && typeof d.remaining === 'number' ? d.total - d.remaining : 0;
      if (paid !== undefined && typeof d.remaining === 'number' && Math.abs(d.total - paid - d.remaining) >= 100) {
        warn(r, `Kvar att betala i originalet är ${(d.remaining / 100).toLocaleString('sv-SE')} kr men betalningarna i filerna ger ${((d.total - paid) / 100).toLocaleString('sv-SE')} kr`);
      }
    }
    const k = norm(txt(d.kind) ?? '');
    d.kindValue = k.startsWith('avi') || k.startsWith('hyresavi') || (!k && d.periodFrom) ? 'rent_notice' : 'invoice';
    // Objektets avtal vid fakturadatum
    d._contractId = null;
    if (txt(d.objectRef)) {
      const o = objByNr.get(String(d.objectRef));
      const p = o && ex.periods.find((x) => x.object_id === o.id && x.valid_from <= d.invoiceDate && (x.valid_to ?? '9999-12-31') >= d.invoiceDate);
      if (p) d._contractId = p.contract_id;
      d._objectId = o?.id ?? null;
    }
    const viaRef = ref('invoice', r.key);
    const m = viaRef ? ex.invoices.find((i) => i.id === viaRef) : d.invoiceNr ? invByNr.get(d.invoiceNr) : null;
    if (m) {
      if (viaRef || (Math.abs(m.total_ore - (d.total ?? 0)) < 1 && (!c.id || c.id === m.customer_id))) matchResult(r, m.id, !!viaRef);
      else err(r, `Fakturanummer ${d.invoiceNr} finns redan i systemet med andra uppgifter`);
      if (m && typeof d.remaining === 'number' && m.balance_ore !== null && Math.abs(m.balance_ore - d.remaining) >= 100) {
        warn(r, `Kvar att betala skiljer sig: ${(m.balance_ore / 100).toLocaleString('sv-SE')} kr i systemet, ${(d.remaining / 100).toLocaleString('sv-SE')} kr i filen`);
      }
    }
  }

  // ---- Betalningshistorik
  for (const r of by('payment')) {
    const d = r.data;
    if (!ENTITY.payment.available) {
      r.status = 'skipped';
      info(r, ENTITY.payment.unavailableReason!);
      continue;
    }
    if (typeof d.amount === 'number' && d.amount <= 0) err(r, 'Beloppet måste vara större än noll');
    d._invoiceKey = null;
    d._invoiceId = null;
    if (txt(d.invoiceRef)) {
      const inv = by('invoice').find((i) => i.data.invoiceNr === String(d.invoiceRef));
      const invDb = inv ? null : invByNr.get(String(d.invoiceRef));
      if (inv) d._invoiceKey = inv.key;
      else if (invDb) d._invoiceId = invDb.id;
      else warn(r, `Faktura ${d.invoiceRef} hittades inte. Betalningen läggs utan koppling till faktura.`);
      if (inv) {
        d._customerKey = inv.data._customerKey;
        d._customerId = inv.data._customerId;
      } else if (invDb) d._customerId = invDb.customer_id;
    }
    if (!d._customerKey && !d._customerId) {
      const c = txt(d.customerRef) ? resolveCustomer(String(d.customerRef)) : { key: null, id: null };
      d._customerKey = c.key;
      d._customerId = c.id;
      if (!c.key && !c.id) err(r, 'Kunden kunde inte hittas. Ange fakturanummer eller kund.');
    }
    const viaRef = ref('payment', r.key);
    if (viaRef) matchResult(r, viaRef, true);
  }

  // ---- Dokument kopplas efter filnamnet
  const contractRecs = by('contract');
  for (const r of by('document')) {
    const d = r.data;
    const existing = ex.documents.get(r.key);
    if (existing) {
      matchResult(r, existing, true);
      continue;
    }
    const plain = d.linkTo ? String(d.linkTo) : String(d.fileName).replace(/\.[^.]+$/, '');
    const tokens = new Set(plain.split(/[^0-9A-Za-zÅÄÖåäö-]+/).filter(Boolean));
    d._link = null;
    for (const o of objRecs) {
      if (o.data.objectNr && (tokens.has(o.data.objectNr) || plain === o.data.objectNr)) {
        const k = contractRecs.find((c) => c.data._objects?.some((x: any) => x.key === o.key) && c.data.status === 'active');
        d._link = k ? { entity: 'contract', key: k.key, label: k.label.toLowerCase() } : { entity: 'object', key: o.key, label: o.label.toLowerCase() };
        break;
      }
    }
    if (!d._link) {
      const o = ex.objs.find((x) => tokens.has(String(x.object_nr)));
      if (o) {
        const p = ex.periods
          .filter((x) => x.object_id === o.id && ['active', 'terminated'].includes(x.status))
          .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
        d._link = p
          ? { entity: 'contract', id: p.contract_id, label: `avtal ${p.contract_nr} (objekt ${o.object_nr})` }
          : { entity: 'rental_object', id: o.id, label: `objekt ${o.object_nr}` };
      }
    }
    if (!d._link) {
      const k = [...ex.contracts.values()].find((c) => tokens.has(String(c.contract_nr)));
      if (k) d._link = { entity: 'contract', id: k.id, label: `avtal ${k.contract_nr}` };
    }
    if (d._link) info(r, `Kopplas till ${d._link.label}`);
    else warn(r, 'Hittade inget objekt eller avtal i filnamnet. Sparas som lös bilaga, eller ange koppling.');
  }

  // ---- Beroenden: en post med fel stoppar de poster som hänvisar till den
  for (let pass = 0; pass < 2; pass++) {
    for (const r of recs) {
      if (r.status === 'skipped') continue;
      const bad = (entity: string, key: string | null | undefined) => {
        if (!key) return false;
        const p = byKey.get(`${entity}:${key}`);
        return p && (p.status === 'error' || p.status === 'skipped' || p.issues.some((i) => i.level === 'error'));
      };
      if (r.entity === 'object' && String(r.data._propertyKey ?? '').startsWith('annat-bolag:')) {
        r.status = 'skipped';
        r.issues = r.issues.filter((i) => !/efter adressen/.test(i.message));
        info(r, `Adressen hör till ${byKey.get(`property:${r.data._propertyKey}`)?.label} i ett annat bolag. Välj fastighet om objektet ska med.`);
        continue;
      }
      if (r.entity === 'object' && bad('property', r.data._propertyKey)) err(r, 'Fastigheten kan inte importeras');
      if (r.entity === 'contract') {
        if (bad('customer', r.data._customerKey)) err(r, 'Hyresgästen kan inte importeras');
        for (const o of r.data._objects ?? []) if (bad('object', o.key)) err(r, `Objekt ${o.nr} kan inte importeras`);
      }
      if (r.entity === 'cotenant' && bad('customer', r.data._customerKey)) err(r, 'Hyresgästen kan inte importeras');
      if ((r.entity === 'invoice' || r.entity === 'payment') && bad('customer', r.data._customerKey)) err(r, 'Kunden kan inte importeras');
      if (r.entity === 'payment' && bad('invoice', r.data._invoiceKey)) err(r, 'Fakturan kan inte importeras');
      if (r.entity === 'rent' && bad('object', r.data._objectKey)) err(r, 'Objektet kan inte importeras');
      if (r.issues.some((i) => i.level === 'error') && !dec.get(`${r.entity}:${r.key}`)?.skip) r.status = 'error';
    }
  }

  // ---- Status
  for (const r of recs) {
    r.issues = dedupe(r.issues);
    if (dec.get(`${r.entity}:${r.key}`)?.skip) r.status = 'skipped';
    else if (r.status === 'skipped') {
      /* annat bolag eller ännu inte möjligt */
    } else if (r.issues.some((i) => i.level === 'error')) r.status = 'error';
    else if (r.status === 'unchanged') {
      /* redan satt */
    }
    else if (!r.targetId) r.status = 'new';
    else if (r.changes.length) r.status = 'update';
    else r.status = r.viaExternalRef ? 'unchanged' : 'link';
  }
  return { recs, sourceTotals };
}

function dedupe(issues: Issue[]) {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
}

export function summarize(recs: Rec[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const r of recs) {
    const e = (out[r.entity] ??= { total: 0, new: 0, update: 0, unchanged: 0, link: 0, error: 0, skipped: 0, warnings: 0 });
    e.total++;
    e[r.status]++;
    if (r.issues.some((i) => i.level === 'warning')) e.warnings++;
  }
  return out;
}

/**
 * Artikel för ett tillägg på avtalet, efter texten. En artikel i bolagets
 * artikelregister med samma namn väljs först, annars gissas artikeln av
 * texten. Finns den gissade artikeln inte i registret blir det Övrigt.
 */
export function addonArticle(description: string, articles?: { code: string; name: string; active: boolean }[]): string {
  const t = norm(description);
  const byName = articles?.find((a) => a.active && norm(a.name) === t) ?? articles?.find((a) => norm(a.name) === t);
  if (byName) return byName.code;
  const guess = (() => {
    if (/bredband|internet|fiber/.test(t)) return ['broadband', 'service'];
    if (/kabel|\btv\b/.test(t)) return ['cable_tv', 'service'];
    if (/fastighetsskatt|fastighetsavgift/.test(t)) return ['property_tax', 'other'];
    if (/^el\b|elektricitet|hushallsel/.test(t)) return ['electricity'];
    if (/varme|uppvarmning/.test(t)) return ['heating'];
    if (/vatten/.test(t)) return ['water'];
    if (/parkering|p plats|garage/.test(t)) return ['parking'];
    if (/forrad/.test(t)) return ['storage'];
    return [];
  })();
  if (!articles) return guess[0] ?? 'other';
  return guess.find((c) => articles.some((a) => a.code === c)) ?? 'other';
}
