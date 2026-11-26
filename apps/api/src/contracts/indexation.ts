import type { PoolClient } from 'pg';
import { dayBefore } from '../common/money';
import { indexSupplement } from './contract-rules';

export interface IndexationRow {
  contractId: string;
  companyId: string;
  companyName: string;
  contractNr: number;
  customerName: string;
  adjustDate: string;
  kpiYear: number;
  kpiMonth: number;
  baseValue: number;
  newValue: number | null;
  sharePct: number;
  floorAtBase: boolean;
  baseAmountOre: number;
  currentIndexOre: number;
  newIndexOre: number | null;
  vatRateBp: number;
  status: 'ready' | 'missing_kpi' | 'done' | 'no_lines';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/**
 * Indexuppräkning för ett år. KPI för klausulens basmånad året före jämförs med
 * basvärdet, och tillägget läggs som en egen rad (artikel index) från
 * uppräkningsdatumet. Bashyran ändras inte, så historiken går att följa.
 */
export async function previewIndexation(client: PoolClient, year: number, contractIds?: string[]): Promise<IndexationRow[]> {
  const { rows } = await client.query(
    `with base as (
       select k.id, k.company_id, co.name as company_name, k.contract_nr, c.name as customer_name,
              ic.base_value::float as base_value, ic.share_pct::float as share_pct, ic.floor_at_base, ic.base_month,
              make_date($1, ic.adjust_month, 1) as adjust_date
       from contract k
       join contract_index_clause ic on ic.contract_id = k.id
       join customer c on c.id = k.customer_id
       join company co on co.id = k.company_id
       where k.status in ('active','terminated') and ($2::uuid[] is null or k.id = any($2))
     )
     select b.id as "contractId", b.company_id as "companyId", b.company_name as "companyName",
            b.contract_nr as "contractNr", b.customer_name as "customerName", b.adjust_date::text as "adjustDate",
            $1 - 1 as "kpiYear", b.base_month as "kpiMonth", b.base_value as "baseValue",
            (select value::float from kpi_value where year = $1 - 1 and month = b.base_month) as "newValue",
            b.share_pct as "sharePct", b.floor_at_base as "floorAtBase",
            coalesce((select sum(coalesce(l.base_amount_ore, l.amount_ore)) from contract_line l
               where l.contract_id = b.id and l.indexed and l.article <> 'index'
                 and l.valid_from <= b.adjust_date and (l.valid_to is null or l.valid_to >= b.adjust_date)), 0)::bigint::float as "baseAmountOre",
            coalesce((select sum(l.amount_ore) from contract_line l
               where l.contract_id = b.id and l.article = 'index'
                 and l.valid_from < b.adjust_date and (l.valid_to is null or l.valid_to >= b.adjust_date)), 0)::bigint::float as "currentIndexOre",
            coalesce((select max(l.vat_rate_bp) from contract_line l where l.contract_id = b.id and l.indexed), 0) as "vatRateBp",
            exists (select 1 from contract_line l where l.contract_id = b.id and l.article = 'index' and l.valid_from >= b.adjust_date) as done
     from base b
     join contract k on k.id = b.id
     where k.start_date <= b.adjust_date and (k.end_date is null or k.end_date >= b.adjust_date)
     order by b.company_name, b.contract_nr`,
    [year, contractIds ?? null],
  );
  return rows.map((r) => {
    const status: IndexationRow['status'] = r.done
      ? 'done'
      : r.newValue === null
        ? 'missing_kpi'
        : r.baseAmountOre === 0
          ? 'no_lines'
          : 'ready';
    const newIndexOre =
      r.newValue === null
        ? null
        : indexSupplement({
            baseValue: r.baseValue,
            newValue: r.newValue,
            sharePct: r.sharePct,
            floorAtBase: r.floorAtBase,
            baseAmountOre: r.baseAmountOre,
          });
    const { done: _done, ...rest } = r;
    return { ...rest, newIndexOre, status };
  });
}

export async function applyIndexation(client: PoolClient, year: number, contractIds?: string[]) {
  const preview = await previewIndexation(client, year, contractIds);
  const out: (IndexationRow & { result: 'applied' | 'skipped'; message: string })[] = [];
  for (const r of preview) {
    if (r.status !== 'ready' || r.newIndexOre === null) {
      const message = {
        done: `Redan uppräknat från ${r.adjustDate}`,
        missing_kpi: `KPI saknas för ${MONTHS[r.kpiMonth - 1]} ${r.kpiYear}`,
        no_lines: 'Inga indexerade rader',
        ready: '',
      }[r.status];
      out.push({ ...r, result: 'skipped', message });
      continue;
    }
    await client.query(
      `update contract_line set valid_to = $3 where contract_id = $1 and article = 'index'
         and valid_from < $2 and (valid_to is null or valid_to >= $2)`,
      [r.contractId, r.adjustDate, dayBefore(r.adjustDate)],
    );
    const { rows: k } = await client.query('select end_date::text as "endDate" from contract where id = $1', [r.contractId]);
    if (r.newIndexOre !== 0) {
      await client.query(
        `insert into contract_line (company_id, contract_id, article, description, amount_ore, vat_rate_bp, valid_from, valid_to, reason)
         values ($1, $2, 'index', $3, $4, $5, $6, $7, $8)`,
        [
          r.companyId,
          r.contractId,
          `Indextillägg ${year}`,
          r.newIndexOre,
          r.vatRateBp,
          r.adjustDate,
          k[0].endDate,
          `KPI ${MONTHS[r.kpiMonth - 1]} ${r.kpiYear} ${fmtKpi(r.newValue!)} mot bas ${fmtKpi(r.baseValue)}, andel ${r.sharePct} %`,
        ],
      );
    }
    await client.query('update contract_index_clause set last_adjusted = $2 where contract_id = $1', [r.contractId, r.adjustDate]);
    const message = `Indexuppräkning ${year}: tillägg ${fmtKr(r.newIndexOre)} per månad (tidigare ${fmtKr(r.currentIndexOre)})`;
    await client.query(
      `insert into contract_event (company_id, contract_id, kind, event_date, description) values ($1, $2, 'index_adjusted', $3, $4)`,
      [r.companyId, r.contractId, r.adjustDate, message],
    );
    out.push({ ...r, result: 'applied', message });
  }
  return out;
}

function fmtKpi(v: number) {
  return v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtKr(ore: number) {
  return `${(ore / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;
}
