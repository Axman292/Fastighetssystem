import type { PoolClient } from 'pg';

/**
 * Datakontroll efter import: hur mycket som finns i bolaget, hur mycket
 * som kom från den här importen, och jämförelse med summorna i originalfilerna
 * och de kontrollsummor användaren hämtat ur originalsystemet.
 */

export interface Reconciliation {
  generatedAt: string;
  system: Metrics;
  batch: Metrics;
  comparison: { key: string; label: string; unit: 'count' | 'ore'; source: number | null; control: number | null; imported: number | null; system: number | null }[];
  issues: { errors: number; warnings: number; skipped: number; byEntity: Record<string, { errors: number; warnings: number; skipped: number }> };
  invoicesAvailable: boolean;
}

interface Metrics {
  properties: number;
  objects: number;
  customers: number;
  activeContracts: number;
  endedContracts: number;
  monthlyRentOre: number;
  annualRentOre: number;
  objectRentOre: number;
  unpaidInvoices: number | null;
  receivablesOre: number | null;
  accounts: number;
  suppliers: number;
  vouchers: number;
  documents: number;
}

const one = async (client: PoolClient, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];

async function metrics(client: PoolClient, scope: { batchId: string } | null, invoicesAvailable: boolean): Promise<Metrics> {
  // Med batchId räknas bara poster som importen har skapat eller kopplat
  const ids = (entity: string, col = 'id') =>
    scope ? `and ${col} in (select target_id from import_row where batch_id = $1 and entity = '${entity}' and target_id is not null)` : '';
  const c = await one(
    client,
    `select
       (select count(*) from property where true ${ids('property')})::int as properties,
       (select count(*) from rental_object where active ${ids('object')})::int as objects,
       (select count(*) from customer where true ${ids('customer')})::int as customers,
       (select count(*) from contract where status in ('active','terminated') and (end_date is null or end_date >= current_date) ${ids('contract')})::int as "activeContracts",
       (select count(*) from contract where status = 'terminated' and end_date < current_date ${ids('contract')})::int as "endedContracts",
       (select coalesce(sum(l.amount_ore), 0) from contract_line l join contract k on k.id = l.contract_id
          where k.status in ('active','terminated') and (k.end_date is null or k.end_date >= current_date)
            and l.valid_from <= greatest(current_date, k.start_date) and (l.valid_to is null or l.valid_to >= greatest(current_date, k.start_date))
            ${ids('contract', 'k.id')})::float as "monthlyRentOre",
       (select coalesce(sum(monthly_rent_ore), 0) from rental_object_current where true ${ids('object', 'object_id')})::float as "objectRentOre",
       (select count(*) from account where true ${ids('account')})::int as accounts,
       (select count(*) from supplier where true ${ids('supplier')})::int as suppliers,
       (select count(*) from legacy_voucher where true ${ids('voucher')})::int as vouchers,
       (select count(*) from document where true ${ids('document')})::int as documents`,
    scope ? [scope.batchId] : [],
  );
  let unpaidInvoices: number | null = null;
  let receivablesOre: number | null = null;
  if (invoicesAvailable) {
    // Aviseringsmodulen (fas 4) har vyn invoice_balance med kvarvarande belopp per faktura
    try {
      await client.query('savepoint inv');
      const r = await one(client, `select count(*) filter (where balance_ore > 0)::int as n, coalesce(sum(balance_ore) filter (where balance_ore > 0), 0)::float as s from invoice_balance where true ${ids('invoice', 'invoice_id')}`,
        scope ? [scope.batchId] : [],
      );
      await client.query('release savepoint inv');
      unpaidInvoices = r.n;
      receivablesOre = r.s;
    } catch {
      await client.query('rollback to savepoint inv');
    }
  }
  return { ...c, annualRentOre: c.monthlyRentOre * 12, unpaidInvoices, receivablesOre };
}

export async function reconcile(client: PoolClient, batchId: string): Promise<Reconciliation> {
  const invoicesAvailable = !!(await one(client, `select to_regclass('invoice_balance') is not null as ok`)).ok;
  const [system, batch] = [await metrics(client, null, invoicesAvailable), await metrics(client, { batchId }, invoicesAvailable)];

  const totals = (await client.query('select source_totals from import_table where batch_id = $1', [batchId])).rows.map((r) => r.source_totals ?? {});
  const sum = (k: string) => (totals.some((t) => t[k] !== undefined) ? totals.reduce((s, t) => s + (t[k] ?? 0), 0) : null);
  const control = (await one(client, 'select control_totals from import_batch where id = $1', [batchId]))?.control_totals ?? {};
  const counts = (
    await client.query(`select case when entity = 'contract' and coalesce(data->>'endDate', '9999-12-31') >= current_date::text then 'activeContract' else entity end as entity, count(*)::int as n from import_row where batch_id = $1 and status <> 'skipped' group by 1`, [batchId])
  ).rows.reduce((m: Record<string, number>, r) => ((m[r.entity] = r.n), m), {});
  const cv = (k: string) => (typeof control[k] === 'number' ? control[k] : null);

  const comparison: Reconciliation['comparison'] = [
    { key: 'properties', label: 'Fastigheter', unit: 'count', source: counts.property ?? null, control: cv('properties'), imported: batch.properties, system: system.properties },
    { key: 'objects', label: 'Objekt', unit: 'count', source: sum('objects'), control: cv('objects'), imported: batch.objects, system: system.objects },
    { key: 'customers', label: 'Hyresgäster', unit: 'count', source: counts.customer ?? null, control: cv('customers'), imported: batch.customers, system: system.customers },
    { key: 'activeContracts', label: 'Aktiva avtal', unit: 'count', source: counts.activeContract ?? null, control: cv('activeContracts'), imported: batch.activeContracts, system: system.activeContracts },
    { key: 'objectRentOre', label: 'Objektens månadshyra', unit: 'ore', source: sum('objectRentOre'), control: cv('objectRentOre'), imported: batch.objectRentOre, system: system.objectRentOre },
    { key: 'monthlyRentOre', label: 'Kontrakterad månadshyra', unit: 'ore', source: sum('contractRentOre'), control: cv('monthlyRentOre'), imported: batch.monthlyRentOre, system: system.monthlyRentOre },
    { key: 'unpaidInvoices', label: 'Obetalda fakturor', unit: 'count', source: sum('unpaidInvoices'), control: cv('unpaidInvoices'), imported: batch.unpaidInvoices, system: system.unpaidInvoices },
    { key: 'receivablesOre', label: 'Kundfordringar', unit: 'ore', source: sum('receivablesOre'), control: cv('receivablesOre'), imported: batch.receivablesOre, system: system.receivablesOre },
  ];

  const iss = (
    await client.query(
      `select entity,
              count(*) filter (where status = 'error')::int as errors,
              count(*) filter (where status = 'skipped')::int as skipped,
              count(*) filter (where status <> 'error' and issues @> '[{"level":"warning"}]')::int as warnings
       from import_row where batch_id = $1 group by entity`,
      [batchId],
    )
  ).rows;
  const byEntity: Reconciliation['issues']['byEntity'] = {};
  for (const r of iss) byEntity[r.entity] = { errors: r.errors, warnings: r.warnings, skipped: r.skipped };
  return {
    generatedAt: new Date().toISOString(),
    system,
    batch,
    comparison,
    issues: {
      errors: iss.reduce((s, r) => s + r.errors, 0),
      warnings: iss.reduce((s, r) => s + r.warnings, 0),
      skipped: iss.reduce((s, r) => s + r.skipped, 0),
      byEntity,
    },
    invoicesAvailable,
  };
}
