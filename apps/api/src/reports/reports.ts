import type { PoolClient } from 'pg';
import { today } from '../common/money';
import {
  Column,
  CONTRACT_TYPE,
  INVOICE_KIND,
  monthLabel,
  monthsIn,
  OBJECT_TYPE,
  Report,
  ReportFilters,
  ReportInfo,
  Row,
  Section,
  sumBy,
} from './report';

/** Det en rapport själv tar fram. Rubrik, bolag och filter läggs på av controllern. */
export type ReportBody = Pick<Report, 'sections' | 'notes'>;

interface BuildCtx {
  client: PoolClient;
  f: ReportFilters;
  /** Visas fler än ett bolag? Då får raderna en bolagskolumn. */
  multi: boolean;
}

interface ReportDef extends ReportInfo {
  build: (c: BuildCtx) => Promise<ReportBody>;
}

const companyCol: Column = { key: 'company', label: 'Bolag', type: 'text', width: 1.6 };
const withCompany = (multi: boolean, cols: Column[]): Column[] => (multi ? [companyCol, ...cols] : cols);

/** Första objektet i avtalet. Avtalsrader utan objekt räknas dit, så att de inte räknas två gånger. */
const firstObject = (c: string) =>
  `(select co3.object_id from contract_object co3 join rental_object o3 on o3.id = co3.object_id
     where co3.contract_id = ${c}.id order by o3.object_nr limit 1)`;

/** Hyreskonton 3910–3919. Saknas artikeln i registret används den gamla artikelkoden. */
const IS_RENT = `(a.account_number ~ '^391[0-9]$' or (a.id is null and l.article in ('rent','index','discount','parking','storage')))`;

/** Summa av avtalsrader för ett objekt i ett avtal en viss dag. */
function lineSum(c: string, o: string, day: string, what: 'rent' | 'other' | 'vat'): string {
  const value = what === 'vat' ? 'round(l.amount_ore * l.vat_rate_bp / 10000.0)' : 'l.amount_ore';
  const filter = what === 'rent' ? `and ${IS_RENT}` : what === 'other' ? `and not ${IS_RENT}` : '';
  return `(select coalesce(sum(${value}), 0)::float from contract_line l
            left join article a on a.company_id = l.company_id and a.code = l.article
           where l.contract_id = ${c}.id and l.valid_from <= ${day} and (l.valid_to is null or l.valid_to >= ${day})
             and (l.object_id = ${o}.id or (l.object_id is null and ${o}.id = ${firstObject(c)})) ${filter})`;
}

const pct = (a: number, b: number) => (b > 0 ? a / b : null);

// ---------------------------------------------------------------------
// Hyreslista
// ---------------------------------------------------------------------

async function rentRoll({ client, f, multi }: BuildCtx): Promise<ReportBody> {
  const day = f.to;
  const { rows } = await client.query(
    `select cmp.name as company, p.id as "propertyId", p.name as property, p.designation, o.object_nr as "objectNr", o.type,
            o.area_m2::float as area, o.address_line as address, o.active,
            cur.status as "contractStatus", cur.valid_to::text as until,
            c.contract_nr as "contractNr", c.start_date::text as "startDate", c.end_date::text as "endDate",
            c.termination_received::text as "terminationReceived",
            cu.customer_nr as "customerNr", cu.name as customer,
            nxt.valid_from::text as "nextFrom",
            (select pr.monthly_rent_ore::float from rental_object_price pr
              where pr.object_id = o.id and pr.valid_from <= $1::date and (pr.valid_to is null or pr.valid_to >= $1::date)
              order by pr.valid_from desc limit 1) as "listRent",
            case when c.id is null then 0 else ${lineSum('c', 'o', '$1::date', 'rent')} end as rent,
            case when c.id is null then 0 else ${lineSum('c', 'o', '$1::date', 'other')} end as other,
            case when c.id is null then 0 else ${lineSum('c', 'o', '$1::date', 'vat')} end as vat
     from rental_object o
     join property p on p.id = o.property_id
     join company cmp on cmp.id = o.company_id
     left join lateral (
       select co.contract_id, co.valid_to, c2.status from contract_object co join contract c2 on c2.id = co.contract_id
       where co.object_id = o.id and c2.status in ('active','terminated')
         and co.valid_from <= $1::date and (co.valid_to is null or co.valid_to >= $1::date)
       order by co.valid_from desc limit 1
     ) cur on true
     left join contract c on c.id = cur.contract_id
     left join customer cu on cu.id = c.customer_id
     left join lateral (
       select co.valid_from from contract_object co join contract c3 on c3.id = co.contract_id
       where co.object_id = o.id and c3.status in ('active','terminated','draft') and co.valid_from > $1::date
       order by co.valid_from limit 1
     ) nxt on true
     where (o.active or cur.contract_id is not null) and ($2::uuid is null or p.id = $2::uuid)
     order by cmp.name, p.name, o.object_nr`,
    [day, f.propertyId],
  );

  const detail: Row[] = rows.map((r) => {
    const vacant = !r.contractNr;
    const status = vacant ? (r.nextFrom ? `Kommande ${r.nextFrom}` : 'Vakant') : r.contractStatus === 'terminated' ? 'Uppsagd' : 'Uthyrd';
    const annual = r.rent * 12;
    return {
      company: r.company,
      property: r.property,
      objectNr: r.objectNr,
      type: OBJECT_TYPE[r.type] ?? r.type,
      area: r.area,
      customer: vacant ? null : `${r.customer} (${r.customerNr})`,
      contractNr: r.contractNr,
      startDate: r.startDate,
      endDate: r.until ?? r.endDate,
      status,
      rent: vacant ? null : r.rent,
      other: vacant ? null : r.other,
      vat: vacant ? null : r.vat,
      annual: vacant ? null : annual,
      perM2: !vacant && r.area ? Math.round(annual / r.area) : null,
      vacantAnnual: vacant && r.listRent !== null ? r.listRent * 12 : null,
    };
  });

  const byProperty = new Map<string, Row[]>();
  rows.forEach((r, i) => byProperty.set(r.propertyId, [...(byProperty.get(r.propertyId) ?? []), { ...detail[i], _vacant: r.contractNr ? 0 : 1 }]));
  const summary: Row[] = [...byProperty.values()].map((list) => {
    const let_ = list.filter((r) => !r._vacant);
    const annual = let_.reduce((s, r) => s + (r.annual as number), 0);
    const vacantAnnual = list.reduce((s, r) => s + ((r.vacantAnnual as number) ?? 0), 0);
    const area = list.reduce((s, r) => s + ((r.area as number) ?? 0), 0);
    const letArea = let_.reduce((s, r) => s + ((r.area as number) ?? 0), 0);
    return {
      company: list[0].company,
      property: list[0].property,
      objects: list.length,
      let: let_.length,
      vacant: list.length - let_.length,
      area,
      letArea,
      annual,
      vacantAnnual,
      occupancy: pct(annual, annual + vacantAnnual),
    };
  });
  const sTotals = sumBy(summary, ['objects', 'let', 'vacant', 'area', 'letArea', 'annual', 'vacantAnnual']);
  sTotals.occupancy = pct(sTotals.annual as number, (sTotals.annual as number) + (sTotals.vacantAnnual as number));
  const totals = sumBy(detail, ['area', 'rent', 'other', 'vat', 'annual', 'vacantAnnual']);

  return {
    sections: [
      {
        title: 'Sammanställning per fastighet',
        columns: withCompany(multi, [
          { key: 'property', label: 'Fastighet', type: 'text', width: 2 },
          { key: 'objects', label: 'Objekt', type: 'int' },
          { key: 'let', label: 'Uthyrda', type: 'int' },
          { key: 'vacant', label: 'Vakanta', type: 'int' },
          { key: 'area', label: 'Area', type: 'area' },
          { key: 'letArea', label: 'Uthyrd area', type: 'area' },
          { key: 'annual', label: 'Årshyra uthyrt', type: 'money', width: 1.3 },
          { key: 'vacantAnnual', label: 'Vakant hyra/år', type: 'money', width: 1.3 },
          { key: 'occupancy', label: 'Uthyrningsgrad', type: 'pct' },
        ]),
        rows: summary,
        totals: { ...sTotals, property: 'Summa' },
        empty: 'Inga objekt',
      },
      {
        title: 'Objekt',
        columns: withCompany(multi, [
          { key: 'property', label: 'Fastighet', type: 'text', width: 1.6 },
          { key: 'objectNr', label: 'Objekt', type: 'text', width: 0.9 },
          { key: 'type', label: 'Typ', type: 'text', width: 0.9 },
          { key: 'area', label: 'Area', type: 'area', width: 0.7 },
          { key: 'customer', label: 'Hyresgäst', type: 'text', width: 2 },
          { key: 'contractNr', label: 'Avtal', type: 'int', width: 0.6 },
          { key: 'startDate', label: 'Från', type: 'date' },
          { key: 'endDate', label: 'Till', type: 'date' },
          { key: 'status', label: 'Status', type: 'text', width: 1.1 },
          { key: 'rent', label: 'Hyra/mån', type: 'money' },
          { key: 'other', label: 'Tillägg/mån', type: 'money' },
          { key: 'vat', label: 'Moms/mån', type: 'money' },
          { key: 'annual', label: 'Årshyra', type: 'money' },
          { key: 'perM2', label: 'Kr/m²/år', type: 'money', width: 0.8 },
          { key: 'vacantAnnual', label: 'Vakant/år', type: 'money' },
        ]),
        rows: detail,
        totals: { ...totals, property: 'Summa' },
        empty: 'Inga objekt',
      },
    ],
    notes: [
      `Hyran är den som gäller ${day} enligt avtalens hyresrader, exklusive moms. Hyra är konton 3910–3919, tillägg är övriga artiklar.`,
      'Vakant hyra är objektets egen hyra i objektregistret. Uthyrningsgraden räknas på hyresvärdet.',
    ],
  };
}

// ---------------------------------------------------------------------
// Aviseringsjournal
// ---------------------------------------------------------------------

async function billingJournal({ client, f, multi }: BuildCtx): Promise<ReportBody> {
  const filtered = f.propertyId !== null;
  const { rows } = await client.query(
    `select cmp.name as company, i.kind, i.invoice_nr::float as "invoiceNr", i.invoice_date::text as "invoiceDate",
            i.due_date::text as "dueDate", i.period_from::text as "periodFrom", i.period_to::text as "periodTo",
            cu.customer_nr as "customerNr", cu.name as customer, c.contract_nr as "contractNr", i.ocr,
            sum(l.net_ore)::float as net, sum(l.vat_ore)::float as vat, i.rounding_ore::float as rounding, i.total_ore::float as total
     from invoice i
     join company cmp on cmp.id = i.company_id
     join customer cu on cu.id = i.customer_id
     left join contract c on c.id = i.contract_id
     join invoice_line l on l.invoice_id = i.id
     where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
     group by i.id, cmp.name, cu.customer_nr, cu.name, c.contract_nr
     order by cmp.name, i.invoice_nr`,
    [f.from, f.to, f.propertyId],
  );
  const journal: Row[] = rows.map((r) => ({
    company: r.company,
    invoiceNr: r.invoiceNr,
    kind: INVOICE_KIND[r.kind] ?? r.kind,
    invoiceDate: r.invoiceDate,
    dueDate: r.dueDate,
    period: r.periodFrom ? `${r.periodFrom} – ${r.periodTo}` : null,
    customer: `${r.customer} (${r.customerNr})`,
    contractNr: r.contractNr,
    ocr: r.ocr,
    net: r.net,
    vat: r.vat,
    rounding: filtered ? null : r.rounding,
    total: filtered ? r.net + r.vat : r.total,
  }));

  const byArticle = (
    await client.query(
      `select coalesce(a.name, l.article) as article, l.account_number as account, l.vat_rate_bp as "vatBp",
              count(distinct i.id)::int as invoices, sum(l.net_ore)::float as net, sum(l.vat_ore)::float as vat
       from invoice_line l join invoice i on i.id = l.invoice_id
       left join article a on a.company_id = l.company_id and a.code = l.article
       where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
       group by 1, 2, 3 order by 2 nulls last, 1, 3`,
      [f.from, f.to, f.propertyId],
    )
  ).rows.map((r) => ({ ...r, vatRate: r.vatBp / 100, gross: r.net + r.vat }));

  return {
    sections: [
      {
        title: 'Utfärdade avier och fakturor',
        columns: withCompany(multi, [
          { key: 'invoiceNr', label: 'Nr', type: 'int', width: 0.7 },
          { key: 'kind', label: 'Typ', type: 'text', width: 1 },
          { key: 'invoiceDate', label: 'Datum', type: 'date' },
          { key: 'dueDate', label: 'Förfaller', type: 'date' },
          { key: 'period', label: 'Period', type: 'text', width: 1.6 },
          { key: 'customer', label: 'Kund', type: 'text', width: 2.2 },
          { key: 'contractNr', label: 'Avtal', type: 'int', width: 0.6 },
          { key: 'ocr', label: 'OCR', type: 'text', width: 1 },
          { key: 'net', label: 'Netto', type: 'money' },
          { key: 'vat', label: 'Moms', type: 'money' },
          { key: 'rounding', label: 'Öresavr.', type: 'money', width: 0.7 },
          { key: 'total', label: 'Totalt', type: 'money' },
        ]),
        rows: journal,
        totals: { ...sumBy(journal, ['net', 'vat', 'rounding', 'total']), invoiceNr: null, kind: `${journal.length} st` },
        empty: 'Inga utfärdade avier eller fakturor under perioden',
      },
      {
        title: 'Per artikel och konto',
        columns: [
          { key: 'account', label: 'Konto', type: 'text', width: 0.7 },
          { key: 'article', label: 'Artikel', type: 'text', width: 2 },
          { key: 'vatRate', label: 'Moms %', type: 'number', width: 0.7 },
          { key: 'invoices', label: 'Fakturor', type: 'int', width: 0.7 },
          { key: 'net', label: 'Netto', type: 'money' },
          { key: 'vat', label: 'Moms', type: 'money' },
          { key: 'gross', label: 'Inkl. moms', type: 'money' },
        ],
        rows: byArticle,
        totals: { ...sumBy(byArticle, ['net', 'vat', 'gross']), article: 'Summa' },
        empty: 'Inga rader',
      },
    ],
    notes: filtered ? ['Med vald fastighet visas bara fakturaraderna för fastigheten. Öresavrundning visas då inte.'] : undefined,
  };
}

// ---------------------------------------------------------------------
// Månadsanalys
// ---------------------------------------------------------------------

async function monthlyAnalysis({ client, f }: BuildCtx): Promise<ReportBody> {
  const months = monthsIn(f.from, f.to);
  const billed = (
    await client.query(
      `select to_char(i.invoice_date, 'YYYY-MM') as ym,
              coalesce(sum(l.net_ore) filter (where i.kind <> 'credit_note' and ${IS_RENT}), 0)::float as rent,
              coalesce(sum(l.net_ore) filter (where i.kind <> 'credit_note' and not ${IS_RENT}), 0)::float as other,
              coalesce(sum(l.net_ore) filter (where i.kind = 'credit_note'), 0)::float as credited,
              coalesce(sum(l.vat_ore), 0)::float as vat
       from invoice_line l join invoice i on i.id = l.invoice_id
       left join article a on a.company_id = l.company_id and a.code = l.article
       where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
       group by 1`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;
  // Inbetalt: fördelade belopp per betalningsdag. Med fastighet räknas fakturans andel för fastigheten.
  const paid = (
    await client.query(
      `select to_char(p.payment_date, 'YYYY-MM') as ym,
              sum(case when $3::uuid is null then pa.amount_ore
                       else pa.amount_ore * coalesce((select sum(l.net_ore + l.vat_ore) from invoice_line l where l.invoice_id = i.id and l.property_id = $3::uuid), 0)
                            / nullif(i.total_ore, 0) end)::float as paid
       from payment_allocation pa join payment p on p.id = pa.payment_id join invoice i on i.id = pa.invoice_id
       where p.payment_date between $1::date and $2::date
       group by 1`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;
  const unallocated = f.propertyId
    ? []
    : (
        await client.query(
          `select to_char(p.payment_date, 'YYYY-MM') as ym, sum(b.unallocated_ore)::float as un
           from payment p join payment_balance b on b.payment_id = p.id
           where p.payment_date between $1::date and $2::date group by 1`,
          [f.from, f.to],
        )
      ).rows;
  // Hyresbortfall: dagar utan avtal gånger objektets hyra per dag.
  const vacancy = (
    await client.query(
      `select to_char(d, 'YYYY-MM') as ym,
              sum(pr.monthly_rent_ore::float / extract(day from (date_trunc('month', d) + interval '1 month - 1 day')))::float as lost
       from rental_object o
       join property p on p.id = o.property_id
       cross join generate_series($1::date, $2::date, interval '1 day') as d
       join lateral (
         select monthly_rent_ore from rental_object_price pr
         where pr.object_id = o.id and pr.valid_from <= d and (pr.valid_to is null or pr.valid_to >= d)
         order by pr.valid_from desc limit 1
       ) pr on true
       where o.active and ($3::uuid is null or p.id = $3::uuid)
         and not exists (
           select 1 from contract_object co join contract c on c.id = co.contract_id
           where co.object_id = o.id and c.status in ('active','terminated') and co.valid_from <= d and (co.valid_to is null or co.valid_to >= d))
       group by 1`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;

  const pick = <T extends { ym: string }>(list: T[], ym: string) => list.find((x) => x.ym === ym);
  const perMonth: Row[] = months.map((ym) => {
    const b = pick(billed, ym);
    const rent = b?.rent ?? 0;
    const other = b?.other ?? 0;
    const credited = b?.credited ?? 0;
    const vat = b?.vat ?? 0;
    return {
      month: monthLabel(ym),
      rent,
      other,
      credited,
      net: rent + other + credited,
      vat,
      gross: rent + other + credited + vat,
      paid: Math.round(pick(paid, ym)?.paid ?? 0) + (pick(unallocated, ym)?.un ?? 0),
      vacancy: Math.round(pick(vacancy, ym)?.lost ?? 0),
    };
  });

  const byProp = (
    await client.query(
      `select coalesce(p.name, 'Ej kopplat till fastighet') as property, to_char(i.invoice_date, 'YYYY-MM') as ym, sum(l.net_ore)::float as net
       from invoice_line l join invoice i on i.id = l.invoice_id left join property p on p.id = l.property_id
       where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
       group by 1, 2 order by 1`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;
  const props = [...new Set(byProp.map((r) => r.property as string))];
  const matrix: Row[] = props.map((name) => {
    const row: Row = { property: name };
    let sum = 0;
    for (const ym of months) {
      const v = byProp.find((r) => r.property === name && r.ym === ym)?.net ?? 0;
      row[ym] = v;
      sum += v;
    }
    row.total = sum;
    return row;
  });

  return {
    sections: [
      {
        title: 'Per månad',
        columns: [
          { key: 'month', label: 'Månad', type: 'text', width: 1.4 },
          { key: 'rent', label: 'Hyra', type: 'money' },
          { key: 'other', label: 'Tillägg och övrigt', type: 'money' },
          { key: 'credited', label: 'Krediterat', type: 'money' },
          { key: 'net', label: 'Netto', type: 'money' },
          { key: 'vat', label: 'Moms', type: 'money' },
          { key: 'gross', label: 'Fakturerat inkl. moms', type: 'money', width: 1.3 },
          { key: 'paid', label: 'Inbetalt', type: 'money' },
          { key: 'vacancy', label: 'Hyresbortfall vakans', type: 'money', width: 1.3 },
        ],
        rows: perMonth,
        totals: { ...sumBy(perMonth, ['rent', 'other', 'credited', 'net', 'vat', 'gross', 'paid', 'vacancy']), month: 'Summa' },
      },
      {
        title: 'Netto per fastighet och månad',
        columns: [
          { key: 'property', label: 'Fastighet', type: 'text', width: 2 },
          ...months.map((ym): Column => ({ key: ym, label: monthLabel(ym).replace(/^(\w{3})\w*/, '$1'), type: 'money' })),
          { key: 'total', label: 'Summa', type: 'money' },
        ],
        rows: matrix,
        totals: { ...sumBy(matrix, [...months, 'total']), property: 'Summa' },
        empty: 'Inget aviserat under perioden',
      },
    ],
    notes: [
      'Fakturerat räknas på fakturadatum. Inbetalt räknas på betalningsdag och tar med inbetalningar som ännu inte fördelats på en faktura.',
      'Hyresbortfall är objektets hyra för de dagar objektet saknat avtal.',
      ...(f.propertyId ? ['Med vald fastighet räknas inbetalt som fastighetens andel av varje faktura.'] : []),
    ],
  };
}

// ---------------------------------------------------------------------
// Avstämning kundfordran
// ---------------------------------------------------------------------

async function receivablesReconciliation({ client, f, multi }: BuildCtx): Promise<ReportBody> {
  const { rows } = await client.query(
    `with ev as (
       select i.customer_id, i.invoice_date as d,
              case when i.kind = 'credit_note' then 'credit' else 'invoice' end as kind, i.total_ore as amount
       from invoice i where i.status = 'issued'
       union all
       select p.customer_id, p.payment_date, 'payment', -p.amount_ore from payment p
       union all
       select p.customer_id, r.refund_date, 'refund', r.amount_ore from payment_refund r join payment p on p.id = r.payment_id
     )
     select cmp.name as company, cu.customer_nr as "customerNr", cu.name as customer,
            coalesce(sum(ev.amount) filter (where ev.d < $1::date), 0)::float as opening,
            coalesce(sum(ev.amount) filter (where ev.d between $1::date and $2::date and ev.kind = 'invoice'), 0)::float as invoiced,
            coalesce(sum(ev.amount) filter (where ev.d between $1::date and $2::date and ev.kind = 'credit'), 0)::float as credited,
            coalesce(sum(ev.amount) filter (where ev.d between $1::date and $2::date and ev.kind = 'payment'), 0)::float as paid,
            coalesce(sum(ev.amount) filter (where ev.d between $1::date and $2::date and ev.kind = 'refund'), 0)::float as refunded,
            coalesce(sum(ev.amount) filter (where ev.d <= $2::date), 0)::float as closing
     from ev join customer cu on cu.id = ev.customer_id join company cmp on cmp.id = cu.company_id
     group by cmp.name, cu.id
     having bool_or(ev.d <= $2::date)
     order by cmp.name, cu.customer_nr`,
    [f.from, f.to],
  );
  const list = rows.filter((r) => r.opening || r.invoiced || r.credited || r.paid || r.refunded || r.closing);
  const t = sumBy(list, ['opening', 'invoiced', 'credited', 'paid', 'refunded', 'closing']) as Record<string, number>;

  const summary: Row[] = [
    { item: `Ingående saldo ${f.from}`, amount: t.opening },
    { item: 'Fakturerat (avier och fakturor)', amount: t.invoiced },
    { item: 'Krediterat', amount: t.credited },
    { item: 'Inbetalt', amount: t.paid },
    { item: 'Återbetalt till kund', amount: t.refunded },
    { item: `Utgående saldo ${f.to}`, amount: t.closing },
  ];
  const notes = [
    'Saldot är kundernas skuld minus inbetalningar som inte fördelats. Ett negativt saldo betyder att kunden har betalat i förskott.',
    'Jämför utgående saldo med kundfordringar (1510) och förskott från kunder i bokföringen.',
  ];
  if (f.to >= today()) {
    const open = (
      await client.query(
        `select coalesce(sum(b.balance_ore), 0)::float as open from invoice i join invoice_balance b on b.invoice_id = i.id
         where i.status = 'issued' and i.kind <> 'credit_note' and b.balance_ore <> 0`,
      )
    ).rows[0].open as number;
    const future = (
      await client.query(
        `select coalesce(sum(amount), 0)::float as n from (
           select i.total_ore as amount from invoice i where i.status = 'issued' and i.invoice_date > $1::date
           union all select -p.amount_ore from payment p where p.payment_date > $1::date
           union all select r.amount_ore from payment_refund r where r.refund_date > $1::date) x`,
        [f.to],
      )
    ).rows[0].n as number;
    const un = (await client.query('select coalesce(sum(unallocated_ore), 0)::float as n from payment_balance')).rows[0].n as number;
    summary.push(
      { item: 'Kontroll: öppna poster i kundreskontran i dag', amount: open },
      { item: 'Kontroll: ej fördelade inbetalningar i dag', amount: -un },
      ...(future ? [{ item: `Kontroll: händelser efter ${f.to}`, amount: -future }] : []),
      { item: 'Differens (ska vara 0)', amount: open - un - future - t.closing },
    );
  } else {
    notes.push('Kontrollen mot öppna poster görs när perioden slutar i dag eller senare.');
  }
  if (f.propertyId) notes.push('Avstämningen gäller alltid hela bolaget. Fastighetsfiltret används inte.');

  return {
    sections: [
      { title: 'Avstämning', columns: [{ key: 'item', label: 'Post', type: 'text', width: 4 }, { key: 'amount', label: 'Belopp', type: 'money', width: 1.2 }], rows: summary },
      {
        title: 'Per kund',
        columns: withCompany(multi, [
          { key: 'customerNr', label: 'Kundnr', type: 'int', width: 0.7 },
          { key: 'customer', label: 'Kund', type: 'text', width: 2.4 },
          { key: 'opening', label: 'Ingående', type: 'money' },
          { key: 'invoiced', label: 'Fakturerat', type: 'money' },
          { key: 'credited', label: 'Krediterat', type: 'money' },
          { key: 'paid', label: 'Inbetalt', type: 'money' },
          { key: 'refunded', label: 'Återbetalt', type: 'money' },
          { key: 'closing', label: 'Utgående', type: 'money' },
        ]),
        rows: list,
        totals: { ...t, customer: 'Summa' },
        empty: 'Inga kundhändelser',
      },
    ],
    notes,
  };
}

// ---------------------------------------------------------------------
// Momsavstämning
// ---------------------------------------------------------------------

const OUT_BOX: Record<number, string> = { 2500: '10', 1200: '11', 600: '12' };

async function vatReconciliation({ client, f }: BuildCtx): Promise<ReportBody> {
  const out = (
    await client.query(
      `select l.vat_rate_bp as bp, sum(l.net_ore)::float as net, sum(l.vat_ore)::float as vat
       from invoice_line l join invoice i on i.id = l.invoice_id
       where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
       group by 1 order by 1 desc`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;
  const inp = (
    await client.query(
      `select coalesce(sum(l.vat_ore) filter (where l.vat_deductible), 0)::float as deductible,
              coalesce(sum(l.vat_ore) filter (where not l.vat_deductible), 0)::float as "nonDeductible",
              coalesce(sum(l.net_ore), 0)::float as net, count(distinct i.id)::int as invoices
       from supplier_invoice_line l join supplier_invoice i on i.id = l.supplier_invoice_id
       where i.status <> 'cancelled' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)`,
      [f.from, f.to, f.propertyId],
    )
  ).rows[0];
  const byAccount = (
    await client.query(
      `select coalesce(l.account_number, '') as account, coalesce(acc.name, '') as name, l.vat_rate_bp as bp,
              sum(l.net_ore)::float as net, sum(l.vat_ore)::float as vat
       from invoice_line l join invoice i on i.id = l.invoice_id
       left join account acc on acc.company_id = l.company_id and acc.number = l.account_number
       where i.status = 'issued' and i.invoice_date between $1::date and $2::date and ($3::uuid is null or l.property_id = $3::uuid)
       group by 1, 2, 3 order by 1, 3 desc`,
      [f.from, f.to, f.propertyId],
    )
  ).rows;

  const outRows: Row[] = out.map((r) => ({
    rate: r.bp === 0 ? 'Momsfritt' : `${r.bp / 100} %`,
    net: r.net,
    vat: r.vat,
    box: r.bp === 0 ? '42' : `05 / ${OUT_BOX[r.bp] ?? '–'}`,
  }));
  const taxable = out.filter((r) => r.bp > 0).reduce((s, r) => s + r.net, 0);
  const exempt = out.filter((r) => r.bp === 0).reduce((s, r) => s + r.net, 0);
  const vatAt = (bp: number) => out.find((r) => r.bp === bp)?.vat ?? 0;
  const outVat = out.reduce((s, r) => s + r.vat, 0);

  const declaration: Row[] = [
    { box: '05', item: 'Momspliktig försäljning (hyra med moms)', amount: taxable },
    { box: '10', item: 'Utgående moms 25 %', amount: vatAt(2500) },
    { box: '11', item: 'Utgående moms 12 %', amount: vatAt(1200) },
    { box: '12', item: 'Utgående moms 6 %', amount: vatAt(600) },
    { box: '42', item: 'Övrig försäljning, momsfri (bostäder m.m.)', amount: exempt },
    { box: '48', item: 'Ingående moms att dra av', amount: inp.deductible },
    { box: '49', item: outVat - inp.deductible >= 0 ? 'Moms att betala' : 'Moms att få tillbaka', amount: outVat - inp.deductible },
  ];

  return {
    sections: [
      {
        title: 'Förslag till momsdeklaration',
        columns: [
          { key: 'box', label: 'Ruta', type: 'text', width: 0.5 },
          { key: 'item', label: 'Post', type: 'text', width: 3.5 },
          { key: 'amount', label: 'Belopp', type: 'money', width: 1.2 },
        ],
        rows: declaration,
      },
      {
        title: 'Utgående moms per momssats',
        columns: [
          { key: 'rate', label: 'Momssats', type: 'text' },
          { key: 'net', label: 'Underlag', type: 'money' },
          { key: 'vat', label: 'Moms', type: 'money' },
          { key: 'box', label: 'Ruta', type: 'text' },
        ],
        rows: outRows,
        totals: { ...sumBy(outRows, ['net', 'vat']), rate: 'Summa' },
        empty: 'Inga utfärdade fakturor under perioden',
      },
      {
        title: 'Ingående moms från leverantörsfakturor',
        columns: [
          { key: 'item', label: 'Post', type: 'text', width: 3 },
          { key: 'amount', label: 'Belopp', type: 'money', width: 1.2 },
        ],
        rows: [
          { item: `Leverantörsfakturor (${inp.invoices} st), netto`, amount: inp.net },
          { item: 'Ingående moms som dras av', amount: inp.deductible },
          { item: 'Ingående moms som inte dras av (bostäder, ingår i kostnaden)', amount: inp.nonDeductible },
        ],
      },
      {
        title: 'Utgående moms per konto',
        columns: [
          { key: 'account', label: 'Konto', type: 'text', width: 0.7 },
          { key: 'name', label: 'Kontonamn', type: 'text', width: 2.4 },
          { key: 'rate', label: 'Momssats', type: 'text', width: 0.8 },
          { key: 'net', label: 'Underlag', type: 'money' },
          { key: 'vat', label: 'Moms', type: 'money' },
        ],
        rows: byAccount.map((r) => ({ account: r.account, name: r.name, rate: r.bp === 0 ? 'Momsfritt' : `${r.bp / 100} %`, net: r.net, vat: r.vat })),
        totals: { ...sumBy(byAccount, ['net', 'vat']), name: 'Summa' },
        empty: 'Inga rader',
      },
    ],
    notes: [
      'Utgående moms räknas på fakturadatum för utfärdade avier, fakturor och kreditfakturor. Ingående moms räknas på leverantörsfakturans datum.',
      'Förslaget ska stämmas av mot bokföringen innan deklarationen lämnas. Moms från annat än hyresintäkter och leverantörsfakturor i systemet finns inte med.',
    ],
  };
}

// ---------------------------------------------------------------------
// Frivillig skattskyldighet
// ---------------------------------------------------------------------

async function voluntaryVat({ client, f, multi }: BuildCtx): Promise<ReportBody> {
  const day = f.to;
  const { rows } = await client.query(
    `select cmp.name as company, p.id as "propertyId", p.name as property, o.object_nr as "objectNr", o.type, o.area_m2::float as area,
            v.vat_liable as liable, v.valid_from::text as "liableFrom",
            c.contract_nr as "contractNr", c.type as "contractType", cu.name as customer, cu.kind as "customerKind",
            case when c.id is null then 0 else ${lineSum('c', 'o', '$1::date', 'rent')} + ${lineSum('c', 'o', '$1::date', 'other')} end as rent,
            case when c.id is null then 0 else ${lineSum('c', 'o', '$1::date', 'vat')} end as vat,
            (select pr.monthly_rent_ore::float from rental_object_price pr
              where pr.object_id = o.id and pr.valid_from <= $1::date and (pr.valid_to is null or pr.valid_to >= $1::date)
              order by pr.valid_from desc limit 1) as "listRent"
     from rental_object o
     join property p on p.id = o.property_id
     join company cmp on cmp.id = o.company_id
     left join lateral (
       select vv.vat_liable, vv.valid_from from rental_object_vat vv
       where vv.object_id = o.id and vv.valid_from <= $1::date and (vv.valid_to is null or vv.valid_to >= $1::date)
       order by vv.valid_from desc limit 1
     ) v on true
     left join lateral (
       select co.contract_id from contract_object co join contract c2 on c2.id = co.contract_id
       where co.object_id = o.id and c2.status in ('active','terminated')
         and co.valid_from <= $1::date and (co.valid_to is null or co.valid_to >= $1::date)
       limit 1
     ) cur on true
     left join contract c on c.id = cur.contract_id
     left join customer cu on cu.id = c.customer_id
     where o.active and ($2::uuid is null or p.id = $2::uuid)
     order by cmp.name, p.name, o.object_nr`,
    [day, f.propertyId],
  );

  const flagged: Row[] = [];
  for (const r of rows) {
    const remarks: string[] = [];
    if (r.liable) {
      if (!r.contractNr) remarks.push('Vakant. Frivillig skattskyldighet kan behöva avslutas om objektet inte hyrs ut momspliktigt.');
      else {
        if (r.vat === 0 && r.rent > 0) remarks.push('Objektet är momspliktigt men avtalet saknar moms');
        if (r.customerKind === 'person') remarks.push('Hyresgästen är en privatperson');
      }
    } else if (r.vat > 0) {
      remarks.push('Avtalet har moms men objektet är inte momspliktigt');
    }
    if (!r.liable && !(r.vat > 0)) continue;
    flagged.push({
      company: r.company,
      property: r.property,
      objectNr: r.objectNr,
      type: OBJECT_TYPE[r.type] ?? r.type,
      area: r.area,
      liableFrom: r.liable ? r.liableFrom : null,
      customer: r.customer,
      contractNr: r.contractNr,
      rent: r.contractNr ? r.rent : null,
      vat: r.contractNr ? r.vat : null,
      remark: remarks.join('. ') || 'OK',
    });
  }

  const byProperty = new Map<string, typeof rows>();
  for (const r of rows) byProperty.set(r.propertyId, [...(byProperty.get(r.propertyId) ?? []), r]);
  const shares: Row[] = [...byProperty.values()].map((list) => {
    const area = list.reduce((s, r) => s + (r.area ?? 0), 0);
    const liableArea = list.filter((r) => r.liable).reduce((s, r) => s + (r.area ?? 0), 0);
    const rentOf = (r: (typeof list)[number]) => (r.contractNr ? r.rent : (r.listRent ?? 0)) * 12;
    const rent = list.reduce((s, r) => s + rentOf(r), 0);
    const liableRent = list.filter((r) => r.liable).reduce((s, r) => s + rentOf(r), 0);
    return {
      company: list[0].company,
      property: list[0].property,
      objects: list.length,
      liableObjects: list.filter((r) => r.liable).length,
      area,
      liableArea,
      areaShare: pct(liableArea, area),
      rent,
      liableRent,
      rentShare: pct(liableRent, rent),
    };
  });
  const st = sumBy(shares, ['objects', 'liableObjects', 'area', 'liableArea', 'rent', 'liableRent']) as Record<string, number>;

  return {
    sections: [
      {
        title: 'Momspliktig andel per fastighet',
        description: 'Underlag för hur stor del av den ingående momsen på gemensamma kostnader som får dras av.',
        columns: withCompany(multi, [
          { key: 'property', label: 'Fastighet', type: 'text', width: 2 },
          { key: 'objects', label: 'Objekt', type: 'int', width: 0.7 },
          { key: 'liableObjects', label: 'Momspliktiga', type: 'int', width: 0.9 },
          { key: 'area', label: 'Area', type: 'area' },
          { key: 'liableArea', label: 'Momspliktig area', type: 'area' },
          { key: 'areaShare', label: 'Andel av area', type: 'pct' },
          { key: 'rent', label: 'Hyresvärde/år', type: 'money' },
          { key: 'liableRent', label: 'Momspliktigt/år', type: 'money' },
          { key: 'rentShare', label: 'Andel av hyra', type: 'pct' },
        ]),
        rows: shares,
        totals: { ...st, property: 'Summa', areaShare: pct(st.liableArea, st.area), rentShare: pct(st.liableRent, st.rent) },
        empty: 'Inga objekt',
      },
      {
        title: 'Momspliktiga objekt och avvikelser',
        columns: withCompany(multi, [
          { key: 'property', label: 'Fastighet', type: 'text', width: 1.6 },
          { key: 'objectNr', label: 'Objekt', type: 'text', width: 0.8 },
          { key: 'type', label: 'Typ', type: 'text', width: 0.9 },
          { key: 'area', label: 'Area', type: 'area', width: 0.7 },
          { key: 'liableFrom', label: 'Momspliktig från', type: 'date' },
          { key: 'customer', label: 'Hyresgäst', type: 'text', width: 1.8 },
          { key: 'contractNr', label: 'Avtal', type: 'int', width: 0.6 },
          { key: 'rent', label: 'Hyra/mån', type: 'money' },
          { key: 'vat', label: 'Moms/mån', type: 'money' },
          { key: 'remark', label: 'Anmärkning', type: 'text', width: 3 },
        ]),
        rows: flagged,
        totals: { ...sumBy(flagged, ['area', 'rent', 'vat']), property: 'Summa' },
        empty: 'Inga momspliktiga objekt',
      },
    ],
    notes: [
      `Momsstatus och avtal som gäller ${day}. Vakanta objekt räknas med objektets egen hyra i hyresvärdet.`,
      'Frivillig skattskyldighet gäller bara lokaler som hyrs ut till någon som själv bedriver momspliktig verksamhet. Bostäder kan aldrig vara momspliktiga.',
    ],
  };
}

// ---------------------------------------------------------------------
// In- och avflyttningslista
// ---------------------------------------------------------------------

async function moves({ client, f, multi }: BuildCtx): Promise<ReportBody> {
  const { rows } = await client.query(
    `select * from (
       select 'in' as event, co.valid_from::text as day, cmp.name as company, p.name as property, o.object_nr as "objectNr", o.type,
              o.area_m2::float as area, cu.name as customer, cu.customer_nr as "customerNr", c.contract_nr as "contractNr", c.type as "contractType",
              c.status, null::text as "terminationReceived", null::text as "terminatedBy",
              ${lineSum('c', 'o', 'co.valid_from', 'rent')} + ${lineSum('c', 'o', 'co.valid_from', 'other')} as rent
       from contract_object co join contract c on c.id = co.contract_id join rental_object o on o.id = co.object_id
       join property p on p.id = o.property_id join company cmp on cmp.id = c.company_id join customer cu on cu.id = c.customer_id
       where c.status in ('draft','active','terminated') and co.valid_from between $1::date and $2::date and ($3::uuid is null or p.id = $3::uuid)
       union all
       select 'out', coalesce(co.valid_to, c.end_date)::text, cmp.name, p.name, o.object_nr, o.type,
              o.area_m2::float, cu.name, cu.customer_nr, c.contract_nr, c.type,
              c.status, c.termination_received::text, c.terminated_by,
              ${lineSum('c', 'o', 'coalesce(co.valid_to, c.end_date)', 'rent')} + ${lineSum('c', 'o', 'coalesce(co.valid_to, c.end_date)', 'other')}
       from contract_object co join contract c on c.id = co.contract_id join rental_object o on o.id = co.object_id
       join property p on p.id = o.property_id join company cmp on cmp.id = c.company_id join customer cu on cu.id = c.customer_id
       where c.status in ('active','terminated') and coalesce(co.valid_to, c.end_date) between $1::date and $2::date
         and ($3::uuid is null or p.id = $3::uuid)
     ) x order by day, event, property, "objectNr"`,
    [f.from, f.to, f.propertyId],
  );
  const BY: Record<string, string> = { tenant: 'hyresgästen', landlord: 'hyresvärden', mutual: 'överenskommelse' };
  const list: Row[] = rows.map((r) => ({
    company: r.company,
    day: r.day,
    event: r.event === 'in' ? 'Inflyttning' : 'Avflyttning',
    property: r.property,
    objectNr: r.objectNr,
    type: OBJECT_TYPE[r.type] ?? r.type,
    area: r.area,
    customer: `${r.customer} (${r.customerNr})`,
    contractNr: r.contractNr,
    contractType: (CONTRACT_TYPE[r.contractType] ?? r.contractType) + (r.status === 'draft' ? ' (utkast)' : ''),
    rent: r.rent,
    terminated: r.terminationReceived ? `${r.terminationReceived}${r.terminatedBy ? ` av ${BY[r.terminatedBy] ?? r.terminatedBy}` : ''}` : null,
  }));
  const ins = list.filter((r) => r.event === 'Inflyttning');
  const outs = list.filter((r) => r.event === 'Avflyttning');
  const s = (l: Row[]) => ({ count: l.length, area: l.reduce((a, r) => a + ((r.area as number) ?? 0), 0), rent: l.reduce((a, r) => a + ((r.rent as number) ?? 0), 0) });
  const si = s(ins);
  const so = s(outs);
  return {
    sections: [
      {
        title: 'Sammanställning',
        columns: [
          { key: 'event', label: 'Händelse', type: 'text', width: 2 },
          { key: 'count', label: 'Antal', type: 'int' },
          { key: 'area', label: 'Area', type: 'area' },
          { key: 'rent', label: 'Hyra/mån', type: 'money' },
        ],
        rows: [
          { event: 'Inflyttningar', ...si },
          { event: 'Avflyttningar', ...so },
          { event: 'Netto', count: si.count - so.count, area: si.area - so.area, rent: si.rent - so.rent },
        ],
      },
      {
        title: 'Händelser',
        columns: withCompany(multi, [
          { key: 'day', label: 'Datum', type: 'date' },
          { key: 'event', label: 'Händelse', type: 'text', width: 1 },
          { key: 'property', label: 'Fastighet', type: 'text', width: 1.6 },
          { key: 'objectNr', label: 'Objekt', type: 'text', width: 0.8 },
          { key: 'type', label: 'Typ', type: 'text', width: 0.9 },
          { key: 'area', label: 'Area', type: 'area', width: 0.7 },
          { key: 'customer', label: 'Hyresgäst', type: 'text', width: 2.2 },
          { key: 'contractNr', label: 'Avtal', type: 'int', width: 0.6 },
          { key: 'contractType', label: 'Avtalstyp', type: 'text', width: 1 },
          { key: 'rent', label: 'Hyra/mån', type: 'money' },
          { key: 'terminated', label: 'Uppsagd', type: 'text', width: 1.6 },
        ]),
        rows: list,
        empty: 'Inga in- eller avflyttningar under perioden',
      },
    ],
    notes: ['Inflyttning är dagen objektet ingår i avtalet från. Avflyttning är sista dagen i avtalet. Hyran är avtalets hyra exklusive moms den dagen.'],
  };
}

// ---------------------------------------------------------------------

export const REPORTS: ReportDef[] = [
  { key: 'hyreslista', title: 'Hyreslista', description: 'Alla objekt med hyresgäst, avtal, hyra och vakanser per ett datum.', mode: 'date', build: rentRoll },
  { key: 'aviseringsjournal', title: 'Aviseringsjournal', description: 'Utfärdade avier, fakturor och krediter under perioden, med summor per artikel och konto.', mode: 'period', build: billingJournal },
  { key: 'manadsanalys', title: 'Månadsanalys', description: 'Fakturerat, krediterat, inbetalt och hyresbortfall månad för månad.', mode: 'period', build: monthlyAnalysis },
  { key: 'kundfordran', title: 'Avstämning kundfordran', description: 'Ingående saldo, fakturerat, inbetalt och utgående saldo per kund, med kontroll mot reskontran.', mode: 'period', build: receivablesReconciliation },
  { key: 'moms', title: 'Momsavstämning', description: 'Utgående och ingående moms per momssats och konto, med förslag till momsdeklaration.', mode: 'period', build: vatReconciliation },
  { key: 'frivillig-skattskyldighet', title: 'Frivillig skattskyldighet', description: 'Momspliktiga lokaler, momspliktig andel per fastighet och avtal som inte stämmer med objektets momsstatus.', mode: 'date', build: voluntaryVat },
  { key: 'in-och-avflyttning', title: 'In- och avflyttningslista', description: 'Alla in- och avflyttningar under perioden med objekt, hyresgäst och hyra.', mode: 'period', build: moves },
];

export type { Section };
