import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { dayBefore, isoDate, kronorToOre } from '../common/money';
import { articleCode } from '../articles/articles.controller';
import { CONTRACT_TYPES } from '../contracts/contract.schemas';
import { OBJECT_TYPES } from '../properties/property.schemas';

// -------------------------------------------------------------------- urval och regler

export const criteriaSchema = z
  .object({
    effectiveDate: isoDate,
    method: z.enum(['percent', 'amount']),
    /** Procent, till exempel 3,25. Negativt för sänkning. */
    percent: z.number().finite().min(-50).max(100).nullable().optional(),
    /** Kronor per månad. Negativt för sänkning. */
    amount: z.number().finite().min(-1e7).max(1e7).nullable().optional(),
    rounding: z.enum(['none', 'krona', 'ten']).default('krona'),
    propertyIds: z.array(z.string().uuid()).max(500).default([]),
    objectTypes: z.array(z.enum(OBJECT_TYPES)).max(20).default([]),
    contractTypes: z.array(z.enum(CONTRACT_TYPES)).max(10).default([]),
    articles: z.array(articleCode).min(1, 'Välj minst en artikel').max(30).default(['rent']),
    /** Avtal med indexklausul räknas normalt upp med KPI och tas inte med. */
    includeIndexed: z.boolean().default(false),
    /** Ändra också objektens hyra (även lediga objekt) från samma datum. */
    updateObjectRent: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'percent' && (v.percent === null || v.percent === undefined || v.percent === 0)) {
      ctx.addIssue({ code: 'custom', path: ['percent'], message: 'Ange hur många procent' });
    }
    if (v.method === 'amount' && (v.amount === null || v.amount === undefined || v.amount === 0)) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Ange ett belopp per månad' });
    }
  });

export const applySchema = z.intersection(
  criteriaSchema,
  z.object({
    name: z.string().trim().min(1, 'Ge justeringen ett namn').max(200),
    reason: z.string().trim().max(1000).nullable().optional(),
    /** Rader i förhandsvisningen som inte ska ändras. */
    excludeKeys: z.array(z.string().max(80)).max(20000).default([]),
  }),
);

export type Criteria = z.output<typeof criteriaSchema>;

export type RowStatus = 'ready' | 'indexed' | 'same_day' | 'later_change' | 'negative' | 'unchanged';

export interface PreviewRow {
  /** line:<avtalsrad> eller object:<objekt>. Används för att välja bort rader. */
  key: string;
  kind: 'line' | 'object';
  companyId: string;
  contractId: string | null;
  contractNr: number | null;
  contractType: string | null;
  customerName: string | null;
  objectId: string | null;
  objectNr: string | null;
  objectType: string | null;
  propertyName: string | null;
  article: string | null;
  description: string;
  currentOre: number;
  newOre: number;
  status: RowStatus;
  /** Perioden från datumet är redan aviserad. Skillnaden läggs på nästa avi. */
  invoiced: boolean;
  /** Raden eller priset som ändras. */
  sourceId: string;
  sourceValidFrom: string;
  sourceValidTo: string | null;
  indexed: boolean;
}

/** Ny hyra enligt justeringen, avrundad. Belopp i öre. */
export function adjustedAmount(oldOre: number, c: Pick<Criteria, 'method' | 'percent' | 'amount' | 'rounding'>): number {
  if (c.method === 'amount') return oldOre + kronorToOre(c.amount ?? 0);
  const raw = (oldOre * (100 + (c.percent ?? 0))) / 100;
  const step = c.rounding === 'ten' ? 1000 : c.rounding === 'krona' ? 100 : 1;
  return Math.round(raw / step) * step;
}

function statusFor(r: { validFrom: string; laterChange: boolean; hasIndex: boolean }, c: Criteria, oldOre: number, newOre: number): RowStatus {
  if (r.hasIndex && !c.includeIndexed) return 'indexed';
  if (r.validFrom >= c.effectiveDate) return 'same_day';
  if (r.laterChange) return 'later_change';
  if (newOre < 0) return 'negative';
  if (newOre === oldOre) return 'unchanged';
  return 'ready';
}

const LINES_SQL = `
  select l.id, l.company_id as "companyId", k.id as "contractId", k.contract_nr as "contractNr", k.type as "contractType",
         c.name as "customerName", l.object_id as "lineObjectId", o.id as "objectId", o.object_nr as "objectNr", o.type as "objectType",
         p.name as "propertyName", l.article, l.description, l.amount_ore::float as "amountOre", l.indexed,
         l.valid_from::text as "validFrom", l.valid_to::text as "validTo",
         (l.valid_to is not null and (k.end_date is null or l.valid_to < k.end_date)) as "laterChange",
         exists (select 1 from contract_index_clause ic where ic.contract_id = k.id) as "hasIndex",
         exists (select 1 from invoice_line il join invoice i on i.id = il.invoice_id
                 where il.contract_line_id = l.id and i.status = 'issued' and il.period_to >= $1) as invoiced
  from contract_line l
  join contract k on k.id = l.contract_id
  join customer c on c.id = k.customer_id
  join rental_object o on o.id = coalesce(l.object_id,
       (select x.object_id from contract_object x join rental_object y on y.id = x.object_id
        where x.contract_id = k.id order by y.object_nr limit 1))
  join property p on p.id = o.property_id
  where k.status in ('active','terminated')
    and k.start_date <= $1 and (k.end_date is null or k.end_date >= $1)
    and l.valid_from <= $1 and (l.valid_to is null or l.valid_to >= $1)
    and l.article = any($2::text[])
    and (cardinality($3::uuid[]) = 0 or o.property_id = any($3::uuid[]))
    and (cardinality($4::text[]) = 0 or o.type = any($4::text[]))
    and (cardinality($5::text[]) = 0 or k.type = any($5::text[]))
  order by p.name, o.object_nr, k.contract_nr, l.description`;

const PRICES_SQL = `
  select pr.id, o.company_id as "companyId", o.id as "objectId", o.object_nr as "objectNr", o.type as "objectType",
         p.name as "propertyName", pr.monthly_rent_ore::float as "amountOre",
         pr.valid_from::text as "validFrom", pr.valid_to::text as "validTo",
         (pr.valid_to is not null) as "laterChange",
         (select c.name from contract_object x join contract k on k.id = x.contract_id join customer c on c.id = k.customer_id
          where x.object_id = o.id and k.status in ('active','terminated')
            and x.valid_from <= $1 and (x.valid_to is null or x.valid_to >= $1) limit 1) as "customerName"
  from rental_object o
  join property p on p.id = o.property_id
  join rental_object_price pr on pr.object_id = o.id and pr.valid_from <= $1 and (pr.valid_to is null or pr.valid_to >= $1)
  where o.active
    and (cardinality($2::uuid[]) = 0 or o.property_id = any($2::uuid[]))
    and (cardinality($3::text[]) = 0 or o.type = any($3::text[]))
  order by p.name, o.object_nr`;

export interface Preview {
  rows: PreviewRow[];
  /** Objektens egen hyra för objekt som också har en avtalsrad i urvalet. */
  linkedPrices: Map<string, PreviewRow>;
}

/** Räknar fram vad justeringen skulle ändra, utan att spara något. */
export async function previewAdjustment(client: PoolClient, c: Criteria): Promise<Preview> {
  const { rows: lines } = await client.query(LINES_SQL, [c.effectiveDate, c.articles, c.propertyIds, c.objectTypes, c.contractTypes]);
  const rows: PreviewRow[] = lines.map((l) => {
    const newOre = adjustedAmount(l.amountOre, c);
    return {
      key: `line:${l.id}`,
      kind: 'line',
      companyId: l.companyId,
      contractId: l.contractId,
      contractNr: l.contractNr,
      contractType: l.contractType,
      customerName: l.customerName,
      objectId: l.objectId,
      objectNr: l.objectNr,
      objectType: l.objectType,
      propertyName: l.propertyName,
      article: l.article,
      description: l.description,
      currentOre: l.amountOre,
      newOre,
      status: statusFor(l, c, l.amountOre, newOre),
      invoiced: l.invoiced,
      sourceId: l.id,
      sourceValidFrom: l.validFrom,
      sourceValidTo: l.validTo,
      indexed: l.indexed,
    };
  });

  const linkedPrices = new Map<string, PreviewRow>();
  if (c.updateObjectRent) {
    // Objekt vars avtalsrad justeras får samma ändring av sin egen hyra.
    // Övriga objekt i urvalet (till exempel lediga) visas som egna rader.
    const withLine = new Set(rows.map((r) => r.objectId));
    const { rows: prices } = await client.query(PRICES_SQL, [c.effectiveDate, c.propertyIds, c.objectTypes]);
    for (const p of prices) {
      const newOre = adjustedAmount(p.amountOre, c);
      const row: PreviewRow = {
        key: `object:${p.objectId}`,
        kind: 'object',
        companyId: p.companyId,
        contractId: null,
        contractNr: null,
        contractType: null,
        customerName: p.customerName,
        objectId: p.objectId,
        objectNr: p.objectNr,
        objectType: p.objectType,
        propertyName: p.propertyName,
        article: null,
        description: 'Objektets hyra',
        currentOre: p.amountOre,
        newOre,
        status: statusFor({ ...p, hasIndex: false }, c, p.amountOre, newOre),
        invoiced: false,
        sourceId: p.id,
        sourceValidFrom: p.validFrom,
        sourceValidTo: p.validTo,
        indexed: false,
      };
      if (withLine.has(p.objectId)) linkedPrices.set(p.objectId, row);
      else rows.push(row);
    }
  }
  return { rows, linkedPrices };
}

/** Förhandsvisningen som den skickas till webben. */
export function previewResponse(p: Preview) {
  const ready = p.rows.filter((r) => r.status === 'ready');
  const lines = ready.filter((r) => r.kind === 'line');
  return {
    rows: p.rows.map(publicRow),
    summary: {
      ready: ready.length,
      contracts: new Set(lines.map((r) => r.contractId)).size,
      beforeOre: lines.reduce((s, r) => s + r.currentOre, 0),
      afterOre: lines.reduce((s, r) => s + r.newOre, 0),
      linkedObjects: p.linkedPrices.size,
    },
  };
}

function publicRow(r: PreviewRow) {
  const { sourceId: _s, sourceValidFrom: _f, sourceValidTo: _t, ...rest } = r;
  return rest;
}

// -------------------------------------------------------------------- genomföra och ångra

/** Genomför justeringen i en transaktion och sparar varje ändring. */
export async function applyAdjustment(client: PoolClient, companyId: string, input: z.output<typeof applySchema>) {
  const { name, reason, excludeKeys, ...c } = input;
  const preview = await previewAdjustment(client, c);
  const skip = new Set(excludeKeys);
  const chosen = preview.rows.filter((r) => r.status === 'ready' && !skip.has(r.key) && r.companyId === companyId);
  if (!chosen.length) throw new BadRequestException('Inga rader att justera');

  const { rows: nr } = await client.query(
    'select coalesce(max(adjustment_nr), 0) + 1 as nr from rent_adjustment where company_id = $1',
    [companyId],
  );
  const lines = chosen.filter((r) => r.kind === 'line');
  const { rows: adj } = await client.query(
    `insert into rent_adjustment (company_id, adjustment_nr, name, effective_date, method, percent, amount_ore, rounding, criteria, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, adjustment_nr as "adjustmentNr"`,
    [
      companyId,
      nr[0].nr,
      name,
      c.effectiveDate,
      c.method,
      c.method === 'percent' ? c.percent : null,
      c.method === 'amount' ? kronorToOre(c.amount ?? 0) : null,
      c.rounding,
      JSON.stringify({
        propertyIds: c.propertyIds,
        objectTypes: c.objectTypes,
        contractTypes: c.contractTypes,
        articles: c.articles,
        includeIndexed: c.includeIndexed,
        updateObjectRent: c.updateObjectRent,
      }),
      reason ?? null,
    ],
  );
  const adjustmentId: string = adj[0].id;
  const label = `Hyresjustering ${adj[0].adjustmentNr} ${name}`;
  const prevDay = dayBefore(c.effectiveDate);

  const events = new Map<string, string[]>();
  for (const r of lines) {
    await client.query('update contract_line set valid_to = $2 where id = $1', [r.sourceId, prevDay]);
    const { rows: nl } = await client.query(
      `insert into contract_line (company_id, contract_id, object_id, article, description, amount_ore, vat_rate_bp,
                                  indexed, base_amount_ore, valid_from, valid_to, reason)
       select company_id, contract_id, object_id, article, description, $2::bigint, vat_rate_bp,
              indexed, case when indexed then $2::bigint end, $3, $4, $5
       from contract_line where id = $1 returning id`,
      [r.sourceId, r.newOre, c.effectiveDate, r.sourceValidTo, reason ? `${label}: ${reason}` : label],
    );
    await insertItem(client, companyId, adjustmentId, r, { oldLineId: r.sourceId, newLineId: nl[0].id });
    const list = events.get(r.contractId!) ?? [];
    list.push(`${r.description}: ${kr(r.currentOre)} → ${kr(r.newOre)}`);
    events.set(r.contractId!, list);
  }
  for (const [contractId, changes] of events) {
    await client.query(
      `insert into contract_event (company_id, contract_id, kind, event_date, description) values ($1, $2, 'rent_changed', $3, $4)`,
      [companyId, contractId, c.effectiveDate, `${label}: ${changes.join(', ')} per månad från ${c.effectiveDate}`],
    );
  }

  // Objektens hyra: dels objekt vars avtalsrad justerades, dels valda objekt utan avtalsrad.
  const prices: PreviewRow[] = chosen.filter((r) => r.kind === 'object');
  const done = new Set<string>();
  for (const r of lines) {
    const p = r.objectId ? preview.linkedPrices.get(r.objectId) : undefined;
    if (p && p.status === 'ready' && !done.has(p.objectId!)) {
      done.add(p.objectId!);
      prices.push(p);
    }
  }
  for (const p of prices) {
    await client.query('update rental_object_price set valid_to = $2 where id = $1', [p.sourceId, prevDay]);
    const { rows: np } = await client.query(
      `insert into rental_object_price (company_id, object_id, monthly_rent_ore, valid_from, valid_to, reason)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [companyId, p.objectId, p.newOre, c.effectiveDate, p.sourceValidTo, label],
    );
    await insertItem(client, companyId, adjustmentId, p, { oldPriceId: p.sourceId, newPriceId: np[0].id });
  }

  const before = lines.reduce((s, r) => s + r.currentOre, 0);
  const after = lines.reduce((s, r) => s + r.newOre, 0);
  await client.query(
    `update rent_adjustment set line_count = $2, object_count = $3, total_before_ore = $4, total_after_ore = $5 where id = $1`,
    [adjustmentId, lines.length, prices.length, before, after],
  );
  return { id: adjustmentId, adjustmentNr: adj[0].adjustmentNr, lineCount: lines.length, objectCount: prices.length, beforeOre: before, afterOre: after };
}

async function insertItem(
  client: PoolClient,
  companyId: string,
  adjustmentId: string,
  r: PreviewRow,
  ids: { oldLineId?: string; newLineId?: string; oldPriceId?: string; newPriceId?: string },
) {
  await client.query(
    `insert into rent_adjustment_item (company_id, adjustment_id, kind, contract_id, object_id, old_line_id, new_line_id,
                                       old_price_id, new_price_id, old_valid_to, description, old_amount_ore, new_amount_ore)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      companyId,
      adjustmentId,
      r.kind,
      r.contractId,
      r.objectId,
      ids.oldLineId ?? null,
      ids.newLineId ?? null,
      ids.oldPriceId ?? null,
      ids.newPriceId ?? null,
      r.sourceValidTo,
      r.description,
      r.currentOre,
      r.newOre,
    ],
  );
}

/** Skäl till att en justering inte kan ångras, eller null om den kan det. */
export async function revertBlocker(client: PoolClient, adjustmentId: string): Promise<string | null> {
  const { rows: a } = await client.query('select status from rent_adjustment where id = $1', [adjustmentId]);
  if (!a[0]) throw new NotFoundException('Justeringen finns inte i valt bolag');
  if (a[0].status === 'reverted') return 'Justeringen är redan ångrad';
  const { rows } = await client.query(
    `select
       count(*) filter (where i.kind = 'line' and exists (select 1 from invoice_line il where il.contract_line_id = i.new_line_id)) as invoiced,
       count(*) filter (where i.kind = 'line' and (nl.id is null or ol.id is null or nl.valid_to is distinct from i.old_valid_to)) as lines_changed,
       count(*) filter (where i.kind = 'object' and (np.id is null or op.id is null or np.valid_to is distinct from i.old_valid_to)) as prices_changed
     from rent_adjustment_item i
     left join contract_line nl on nl.id = i.new_line_id
     left join contract_line ol on ol.id = i.old_line_id
     left join rental_object_price np on np.id = i.new_price_id
     left join rental_object_price op on op.id = i.old_price_id
     where i.adjustment_id = $1`,
    [adjustmentId],
  );
  const r = rows[0];
  if (Number(r.invoiced) > 0) return `Den nya hyran finns redan på ${r.invoiced} avi${Number(r.invoiced) === 1 ? '' : 'er'}. Ändra hyran på avtalen i stället.`;
  if (Number(r.lines_changed) > 0) return `${r.lines_changed} avtalsrad${Number(r.lines_changed) === 1 ? '' : 'er'} har ändrats efter justeringen`;
  if (Number(r.prices_changed) > 0) return `Hyran på ${r.prices_changed} objekt har ändrats efter justeringen`;
  return null;
}

/** Tar bort de nya raderna och priserna och återställer de gamla. */
export async function revertAdjustment(client: PoolClient, adjustmentId: string) {
  const blocker = await revertBlocker(client, adjustmentId);
  if (blocker) throw new ConflictException(blocker);
  const { rows: a } = await client.query(
    'select company_id as "companyId", adjustment_nr as nr, name, effective_date::text as "effectiveDate" from rent_adjustment where id = $1',
    [adjustmentId],
  );
  const { rows: items } = await client.query(
    `select kind, contract_id as "contractId", old_line_id as "oldLineId", new_line_id as "newLineId",
            old_price_id as "oldPriceId", new_price_id as "newPriceId", old_valid_to::text as "oldValidTo"
     from rent_adjustment_item where adjustment_id = $1`,
    [adjustmentId],
  );
  const contracts = new Set<string>();
  for (const i of items) {
    if (i.kind === 'line') {
      await client.query('delete from contract_line where id = $1', [i.newLineId]);
      await client.query('update contract_line set valid_to = $2 where id = $1', [i.oldLineId, i.oldValidTo]);
      contracts.add(i.contractId);
    } else {
      await client.query('delete from rental_object_price where id = $1', [i.newPriceId]);
      await client.query('update rental_object_price set valid_to = $2 where id = $1', [i.oldPriceId, i.oldValidTo]);
    }
  }
  for (const contractId of contracts) {
    await client.query(
      `insert into contract_event (company_id, contract_id, kind, description) values ($1, $2, 'rent_changed', $3)`,
      [a[0].companyId, contractId, `Hyresjustering ${a[0].nr} ${a[0].name} från ${a[0].effectiveDate} ångrad. Tidigare hyra gäller igen.`],
    );
  }
  await client.query(`update rent_adjustment set status = 'reverted', reverted_at = now(), reverted_by = app.current_user_id() where id = $1`, [
    adjustmentId,
  ]);
  return { reverted: items.length };
}

function kr(ore: number): string {
  return `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`;
}
