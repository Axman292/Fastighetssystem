import type { PoolClient } from 'pg';
import { INCOME_GROUPS, OPEX_GROUPS, REPORT_GROUP_LABEL, ReportGroup, RENT_ARTICLES, reportGroupOf } from './report-groups';

/**
 * Ekonomisk uppföljning per fastighet för en period.
 *
 * Intäkter: utfärdade kundfakturor och avier (rader med fastighet), fördelade
 * på den period raden avser. Kreditfakturor minskar intäkten.
 * Kostnader: leverantörsfakturor (ej makulerade), konterade på fastighet,
 * fördelade på kostnadsperioden eller fakturadatum. Ej avdragsgill moms är kostnad.
 * Saknas bokade kostnader för fastighetsskatt, försäkring eller räntor används
 * uppgifterna i fastighetsregistret (taxering, försäkringspremie och lån) som
 * beräknat värde, så att driftnettot inte blir för högt.
 */

type GroupKey = Exclude<ReportGroup, 'none'>;
export const STATEMENT_GROUPS: GroupKey[] = ['rent_income', 'other_income', 'operating', 'maintenance', 'property_tax', 'insurance', 'admin', 'interest', 'investment'];
const ESTIMATED_GROUPS: GroupKey[] = ['property_tax', 'insurance', 'interest'];

export interface Period {
  from: string;
  to: string;
}

export interface PropertyEconomy {
  propertyId: string;
  companyId: string;
  companyName: string;
  name: string;
  designation: string;
  category: string;
  areaM2: number;
  valueSek: number | null;
  /** Utfall per grupp i öre: intäkter och kostnader som positiva tal. */
  actual: Record<GroupKey, number>;
  /** Beräknat ur fastighetsregistret, för grupper utan bokat utfall. */
  estimated: Partial<Record<GroupKey, number>>;
  /** Utfall, eller beräknat värde när utfall saknas. */
  value: Record<GroupKey, number>;
  budget: Record<GroupKey, number>;
  hasBudget: boolean;
  rentValueOre: number;
  vacantRentOre: number;
  kpi: Kpi;
}

export interface Kpi {
  incomeOre: number;
  opexOre: number;
  netOperatingOre: number;
  resultAfterInterestOre: number;
  /** Driftnetto omräknat till helår. */
  netOperatingYearOre: number;
  yield: number | null;
  vacancyRate: number | null;
  rentPerM2: number | null;
  costPerM2: number | null;
  budgetNetOperatingOre: number | null;
}

const empty = (): Record<GroupKey, number> => Object.fromEntries(STATEMENT_GROUPS.map((g) => [g, 0])) as Record<GroupKey, number>;

export function periodDays(p: Period): number {
  return Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1;
}

/** Andel av en kostnad eller intäkt som faller inom perioden (pro rata per dag), som SQL-uttryck. */
const share = (amount: string, from: string, to: string) =>
  `round((${amount})::numeric * (least(${to}, $2::date) - greatest(${from}, $1::date) + 1) / (${to} - ${from} + 1))`;
const overlaps = (from: string, to: string) => `${from} <= $2::date and ${to} >= $1::date`;

export function computeKpi(e: Pick<PropertyEconomy, 'value' | 'budget' | 'hasBudget' | 'areaM2' | 'valueSek' | 'rentValueOre' | 'vacantRentOre'>, days: number): Kpi {
  const sum = (src: Record<GroupKey, number>, gs: ReportGroup[]) => gs.reduce((s, g) => s + (src[g as GroupKey] ?? 0), 0);
  const incomeOre = sum(e.value, INCOME_GROUPS);
  const opexOre = sum(e.value, OPEX_GROUPS);
  const netOperatingOre = incomeOre - opexOre;
  const factor = 365 / days;
  const netOperatingYearOre = Math.round(netOperatingOre * factor);
  return {
    incomeOre,
    opexOre,
    netOperatingOre,
    resultAfterInterestOre: netOperatingOre - e.value.interest,
    netOperatingYearOre,
    yield: e.valueSek ? netOperatingYearOre / 100 / e.valueSek : null,
    vacancyRate: e.rentValueOre > 0 ? e.vacantRentOre / e.rentValueOre : null,
    rentPerM2: e.areaM2 > 0 ? (e.value.rent_income * factor) / 100 / e.areaM2 : null,
    costPerM2: e.areaM2 > 0 ? (opexOre * factor) / 100 / e.areaM2 : null,
    budgetNetOperatingOre: e.hasBudget ? sum(e.budget, INCOME_GROUPS) - sum(e.budget, OPEX_GROUPS) : null,
  };
}

/** Räknar fram ekonomin för alla fastigheter som RLS släpper igenom, eller för en. */
export async function computeEconomy(client: PoolClient, period: Period, propertyId?: string): Promise<PropertyEconomy[]> {
  const days = periodDays(period);
  const params = [period.from, period.to, propertyId ?? null];
  const pf = `($3::uuid is null or p.id = $3::uuid)`;

  const props = (
    await client.query(
      `select p.id, p.company_id as "companyId", c.name as "companyName", p.name, p.designation, p.category,
              coalesce(nullif((select sum(o.area_m2) from rental_object o where o.property_id = p.id and o.active), 0),
                       coalesce(p.area_boa_m2, 0) + coalesce(p.area_loa_m2, 0))::float as "areaM2",
              (select v.value_sek::float from property_valuation v where v.property_id = p.id and v.valuation_date <= $2::date
                order by v.valuation_date desc limit 1) as "valueSek"
       from property p join company c on c.id = p.company_id
       where ${pf} and $1::date is not null
       order by c.name, p.name`,
      params,
    )
  ).rows;
  const map = new Map<string, PropertyEconomy>();
  for (const p of props) {
    map.set(p.id, {
      propertyId: p.id,
      companyId: p.companyId,
      companyName: p.companyName,
      name: p.name,
      designation: p.designation,
      category: p.category,
      areaM2: p.areaM2,
      valueSek: p.valueSek,
      actual: empty(),
      estimated: {},
      value: empty(),
      budget: empty(),
      hasBudget: false,
      rentValueOre: 0,
      vacantRentOre: 0,
      kpi: undefined as unknown as Kpi,
    });
  }
  if (!map.size) return [];

  // Intäkter från kundfakturor
  const pF = 'coalesce(l.period_from, i.invoice_date)';
  const pT = 'coalesce(l.period_to, l.period_from, i.invoice_date)';
  const income = (
    await client.query(
      `select l.property_id as id, (l.article = any ($4::text[])) as rent, sum(${share('l.net_ore', pF, pT)})::float as amount
       from invoice_line l join invoice i on i.id = l.invoice_id join property p on p.id = l.property_id
       where i.status = 'issued' and ${overlaps(pF, pT)} and ${pf}
       group by l.property_id, rent`,
      [...params, RENT_ARTICLES],
    )
  ).rows;
  for (const r of income) {
    const e = map.get(r.id);
    if (e) e.actual[r.rent ? 'rent_income' : 'other_income'] += r.amount;
  }

  // Kostnader från leverantörsfakturor
  const sF = 'coalesce(l.period_from, i.invoice_date)';
  const sT = 'coalesce(l.period_to, i.invoice_date)';
  const costs = (
    await client.query(
      `select l.property_id as id, l.account_number as account, a.report_group as "override",
              sum(${share('l.net_ore + case when l.vat_deductible then 0 else l.vat_ore end', sF, sT)})::float as amount
       from supplier_invoice_line l join supplier_invoice i on i.id = l.supplier_invoice_id join property p on p.id = l.property_id
       left join account a on a.company_id = l.company_id and a.number = l.account_number
       where i.status <> 'cancelled' and ${overlaps(sF, sT)} and ${pf}
       group by l.property_id, l.account_number, a.report_group`,
      params,
    )
  ).rows;
  for (const r of costs) {
    const e = map.get(r.id);
    const g = reportGroupOf(r.account, r.override);
    if (!e || g === 'none') continue;
    // Intäktskonton på leverantörsfakturor (t.ex. vidarefakturering) minskar inte kostnaden utan räknas som intäkt med omvänt tecken
    e.actual[g] += INCOME_GROUPS.includes(g) ? -r.amount : r.amount;
  }

  // Beräknade värden ur fastighetsregistret
  const est = (
    await client.query(
      `select p.id,
         (select coalesce(t.property_tax_ore, 0)::float from property_tax_assessment t where t.property_id = p.id
            and t.assessment_year <= extract(year from $2::date) order by t.assessment_year desc limit 1) * $4::float / 365 as "propertyTax",
         (select coalesce(sum(coalesce(f.premium_ore, 0) * (least(coalesce(f.valid_to, $2::date), $2::date) - greatest(f.valid_from, $1::date) + 1)), 0)::float / 365
            from property_insurance f where f.property_id = p.id and f.valid_from <= $2::date and coalesce(f.valid_to, $2::date) >= $1::date) as insurance,
         (select coalesce(sum(n.principal_ore::numeric * coalesce(n.interest_bp, 0) / 10000), 0)::float from property_loan n where n.property_id = p.id)
            * $4::float / 365 as interest
       from property p where ${pf}`,
      [...params, days],
    )
  ).rows;
  for (const r of est) {
    const e = map.get(r.id);
    if (!e) continue;
    const v: Partial<Record<GroupKey, number>> = { property_tax: r.propertyTax, insurance: r.insurance, interest: r.interest };
    for (const g of ESTIMATED_GROUPS) {
      const amount = Math.round(v[g] ?? 0);
      if (amount > 0 && e.actual[g] === 0) e.estimated[g] = amount;
    }
  }

  // Hyresvärde och vakanser: objektens hyra under perioden, och den del som inte täcks av ett avtal
  const rent = (
    await client.query(
      `with price as (
         select o.id as object_id, o.property_id, pr.monthly_rent_ore::numeric * 12 / 365 as per_day,
                greatest(pr.valid_from, $1::date) as f, least(coalesce(pr.valid_to, $2::date), $2::date) as t
         from rental_object_price pr join rental_object o on o.id = pr.object_id join property p on p.id = o.property_id
         where o.active and ${overlaps('pr.valid_from', 'coalesce(pr.valid_to, $2::date)')} and ${pf}
       ), covered as (
         select pr.*, coalesce((select sum(least(pr.t, coalesce(co.valid_to, pr.t)) - greatest(pr.f, co.valid_from) + 1)
                  from contract_object co join contract c on c.id = co.contract_id
                  where co.object_id = pr.object_id and c.status in ('active','terminated')
                    and co.valid_from <= pr.t and coalesce(co.valid_to, pr.t) >= pr.f), 0) as rented_days
         from price pr
       )
       select property_id as id, sum(per_day * (t - f + 1))::float as potential, sum(per_day * rented_days)::float as rented
       from covered group by property_id`,
      params,
    )
  ).rows;
  for (const r of rent) {
    const e = map.get(r.id);
    if (!e) continue;
    e.rentValueOre = Math.round(r.potential);
    e.vacantRentOre = Math.max(0, Math.round(r.potential - r.rented));
  }

  // Budget, fördelad per dag över de år perioden omfattar
  const budget = (
    await client.query(
      `select b.property_id as id, b.report_group as g,
              sum(b.amount_ore::numeric * (least($2::date, make_date(b.year, 12, 31)) - greatest($1::date, make_date(b.year, 1, 1)) + 1)
                  / (make_date(b.year, 12, 31) - make_date(b.year, 1, 1) + 1))::float as amount
       from property_budget b join property p on p.id = b.property_id
       where make_date(b.year, 1, 1) <= $2::date and make_date(b.year, 12, 31) >= $1::date and ${pf}
       group by b.property_id, b.report_group`,
      params,
    )
  ).rows;
  for (const r of budget) {
    const e = map.get(r.id);
    if (!e) continue;
    e.budget[r.g as GroupKey] += Math.round(r.amount);
    e.hasBudget = true;
  }

  for (const e of map.values()) {
    for (const g of STATEMENT_GROUPS) {
      e.actual[g] = Math.round(e.actual[g]);
      e.value[g] = e.actual[g] || e.estimated[g] || 0;
    }
    e.kpi = computeKpi(e, days);
  }
  return [...map.values()];
}

/** Summerar flera fastigheter, t.ex. per bolag eller för koncernen. */
export function sumEconomies(list: PropertyEconomy[], days: number) {
  const value = empty();
  const actual = empty();
  const budget = empty();
  let areaM2 = 0;
  let valueSek = 0;
  let hasValue = false;
  let rentValueOre = 0;
  let vacantRentOre = 0;
  let hasBudget = false;
  let budgetedCount = 0;
  for (const e of list) {
    for (const g of STATEMENT_GROUPS) {
      value[g] += e.value[g];
      actual[g] += e.actual[g];
      budget[g] += e.budget[g];
    }
    areaM2 += e.areaM2;
    if (e.valueSek) {
      valueSek += e.valueSek;
      hasValue = true;
    }
    rentValueOre += e.rentValueOre;
    vacantRentOre += e.vacantRentOre;
    hasBudget ||= e.hasBudget;
    if (e.hasBudget) budgetedCount += 1;
  }
  const base = { value, actual, budget, hasBudget, areaM2, valueSek: hasValue ? valueSek : null, rentValueOre, vacantRentOre };
  return { ...base, propertyCount: list.length, budgetedCount, kpi: computeKpi(base, days) };
}

export const GROUP_LABELS = REPORT_GROUP_LABEL;
