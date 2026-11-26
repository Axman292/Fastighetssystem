import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { addDays, addMonths, lastDayOfMonth } from '../contracts/contract-rules';
import { RESIDENTIAL_TYPES } from '../properties/property.schemas';
import {
  bankDayOnOrAfter,
  billingPeriod,
  lastBankDayBefore,
  monthLabel,
  overlap,
  Period,
  periodAmount,
  periodLabel,
  previousPeriod,
  vatFor,
} from './billing-rules';
import { billToFor, insertLines, NewLine, recalcInvoice, resolveChannel } from './invoice-store';

/** Hur långt bakåt retroaktiva ändringar räknas fram automatiskt. */
export const RETRO_MONTHS = 24;

export interface RunRow {
  id: string;
  companyId: string;
  periodMonth: string;
  invoiceDate: string;
  dueDate: string | null;
  propertyIds: string[] | null;
  objectIds: string[] | null;
  excludedContractIds: string[];
}

type Severity = 'blocking' | 'warning' | 'info';
interface Issue {
  kind: string;
  severity: Severity;
  message: string;
  contractId?: string | null;
  objectId?: string | null;
  customerId?: string | null;
  invoiceKey?: string;
}

interface ContractRow {
  id: string;
  contractNr: number;
  type: string;
  status: string;
  customerId: string;
  customerKind: string;
  customerName: string;
  startDate: string;
  endDate: string | null;
  billingInterval: 'month' | 'quarter';
  billingInAdvance: boolean;
  paymentTermsDays: number | null;
}

interface LineRow {
  id: string;
  contractId: string;
  objectId: string | null;
  article: string;
  description: string;
  amountOre: number;
  vatRateBp: number;
  validFrom: string;
  validTo: string | null;
}

interface ObjRow {
  contractId: string;
  objectId: string;
  objectNr: string;
  type: string;
  active: boolean;
  propertyId: string;
  costCenterId: string | null;
  validFrom: string;
  validTo: string | null;
}

interface BilledRow {
  invoiceId: string;
  contractId: string;
  contractLineId: string;
  lineKind: string;
  rebill: boolean;
  periodFrom: string;
  periodTo: string;
  netOre: number;
  vatRateBp: number;
  article: string;
  description: string;
  objectId: string | null;
  invPeriodFrom: string | null;
  invPeriodTo: string | null;
}

const ARTICLE_ORDER = ['rent', 'parking', 'storage', 'heating', 'electricity', 'water', 'service', 'index', 'discount', 'fee', 'other'];

/**
 * Bygger om underlaget för en körning: alla utkast och kontroller tas bort och
 * skapas på nytt ur avtalen. Utfärdade fakturor påverkas aldrig.
 */
export async function generateRun(client: PoolClient, run: RunRow): Promise<{ invoices: number; totalOre: number; fingerprint: string }> {
  await client.query(`select pg_advisory_xact_lock(hashtext('billing:' || $1))`, [run.companyId]);
  await client.query(`delete from invoice where billing_run_id = $1 and status = 'draft'`, [run.id]);
  await client.query(`delete from billing_run_issue where billing_run_id = $1`, [run.id]);

  const monthFrom = run.periodMonth;
  const monthTo = lastDayOfMonth(monthFrom);
  const lookback = addMonths(monthFrom, -RETRO_MONTHS);
  const issues: Issue[] = [];

  const company = (
    await client.query('select bankgiro, plusgiro from company where id = $1', [run.companyId])
  ).rows[0];
  if (!company?.bankgiro && !company?.plusgiro) {
    issues.push({
      kind: 'no_bankgiro',
      severity: 'blocking',
      message: 'Bolaget saknar bankgiro och plusgiro. Lägg in det under Bolag innan avierna godkänns.',
    });
  }

  // Avtal i urvalet: aktiva eller uppsagda som har något objekt bland valda fastigheter och objekt.
  const scope = `
    exists (select 1 from contract_object x join rental_object o on o.id = x.object_id
            where x.contract_id = k.id
              and ($2::uuid[] is null or o.property_id = any($2))
              and ($3::uuid[] is null or o.id = any($3)))`;
  const contracts: ContractRow[] = (
    await client.query(
      `select k.id, k.contract_nr as "contractNr", k.type, k.status, k.customer_id as "customerId",
              c.kind as "customerKind", c.name as "customerName",
              k.start_date::text as "startDate", k.end_date::text as "endDate",
              k.billing_interval as "billingInterval", k.billing_in_advance as "billingInAdvance",
              k.payment_terms_days as "paymentTermsDays"
       from contract k join customer c on c.id = k.customer_id
       where k.company_id = $1 and k.status in ('active','terminated')
         and k.start_date <= $4 and (k.end_date is null or k.end_date >= $5)
         and not (k.id = any($6)) and ${scope}
       order by c.customer_nr, k.contract_nr`,
      [run.companyId, run.propertyIds, run.objectIds, addDays(monthTo, 92), lookback, run.excludedContractIds],
    )
  ).rows;
  const ids = contracts.map((k) => k.id);

  const lines: LineRow[] = (
    await client.query(
      `select id, contract_id as "contractId", object_id as "objectId", article, description, amount_ore::float as "amountOre",
              vat_rate_bp as "vatRateBp", valid_from::text as "validFrom", valid_to::text as "validTo"
       from contract_line where contract_id = any($1) order by valid_from, created_at`,
      [ids],
    )
  ).rows;
  const objects: ObjRow[] = (
    await client.query(
      `select x.contract_id as "contractId", x.object_id as "objectId", o.object_nr as "objectNr", o.type, o.active,
              o.property_id as "propertyId", p.cost_center_id as "costCenterId",
              x.valid_from::text as "validFrom", x.valid_to::text as "validTo"
       from contract_object x join rental_object o on o.id = x.object_id join property p on p.id = o.property_id
       where x.contract_id = any($1) order by o.object_nr`,
      [ids],
    )
  ).rows;
  const vatRows: { objectId: string; vatLiable: boolean; validFrom: string; validTo: string | null }[] = (
    await client.query(
      `select object_id as "objectId", vat_liable as "vatLiable", valid_from::text as "validFrom", valid_to::text as "validTo"
       from rental_object_vat where object_id = any($1)`,
      [objects.map((o) => o.objectId)],
    )
  ).rows;
  // Det som redan är aviserat (utfärdat) för avtalen
  const billed: BilledRow[] = (
    await client.query(
      `select l.invoice_id as "invoiceId", l.contract_id as "contractId", l.contract_line_id as "contractLineId",
              l.line_kind as "lineKind", l.rebill, l.period_from::text as "periodFrom", l.period_to::text as "periodTo",
              l.net_ore::float as "netOre", l.vat_rate_bp as "vatRateBp", l.article, l.description, l.object_id as "objectId",
              i.period_from::text as "invPeriodFrom", i.period_to::text as "invPeriodTo"
       from invoice_line l join invoice i on i.id = l.invoice_id
       where i.status = 'issued' and l.contract_id = any($1) and l.contract_line_id is not null
         and l.line_kind in ('regular','retroactive','credit')
         and l.period_to >= $2`,
      [ids, lookback],
    )
  ).rows;
  // Föregående avis nettobelopp per avtal, för kontroll av avvikande belopp
  const previous: { contractId: string; netOre: number; periodFrom: string; periodTo: string }[] = (
    await client.query(
      `select distinct on (i.contract_id) i.contract_id as "contractId", i.period_from::text as "periodFrom", i.period_to::text as "periodTo",
              (select coalesce(sum(l.net_ore), 0) from invoice_line l where l.invoice_id = i.id and l.line_kind = 'regular')::float as "netOre"
       from invoice i
       where i.status = 'issued' and i.kind = 'rent_notice' and i.contract_id = any($1) and i.period_from is not null
       order by i.contract_id, i.period_from desc`,
      [ids],
    )
  ).rows;
  const charges: { id: string; contractId: string; objectId: string | null; article: string; description: string; amountOre: number; vatRateBp: number; billFrom: string }[] = (
    await client.query(
      `select ch.id, ch.contract_id as "contractId", ch.object_id as "objectId", ch.article, ch.description,
              ch.amount_ore::float as "amountOre", ch.vat_rate_bp as "vatRateBp", ch.bill_from::text as "billFrom"
       from contract_charge ch
       where ch.contract_id = any($1) and ch.bill_from <= $2
         and not exists (select 1 from invoice_line l join invoice i on i.id = l.invoice_id
                         where l.contract_charge_id = ch.id and i.status = 'issued')
       order by ch.bill_from, ch.created_at`,
      [ids, monthTo],
    )
  ).rows;

  const byContract = <T extends { contractId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.contractId, [...(m.get(r.contractId) ?? []), r]);
    return m;
  };
  const linesBy = byContract(lines);
  const objectsBy = byContract(objects);
  const billedBy = byContract(billed);
  const chargesBy = byContract(charges);
  const prevBy = new Map(previous.map((p) => [p.contractId, p]));

  const vatLiable = (objectId: string, p: Period): boolean | null => {
    const v = vatRows.find((r) => r.objectId === objectId && r.validFrom <= p.to && (!r.validTo || r.validTo >= p.from));
    return v ? v.vatLiable : null;
  };

  let invoiceCount = 0;
  let total = 0;
  const fp: string[] = [];

  for (const k of contracts) {
    const P = billingPeriod(monthFrom, k.billingInterval, k.billingInAdvance);
    const kLines = linesBy.get(k.id) ?? [];
    const kObjects = objectsBy.get(k.id) ?? [];
    const kAll = billedBy.get(k.id) ?? [];
    // Krediteringar räknas bara som ej debiterat när perioden ska aviseras på nytt
    const kBilled = kAll.filter((b) => b.lineKind !== 'credit' || b.rebill);
    const kWaived = kAll.filter((b) => b.lineKind === 'credit' && !b.rebill);
    const objOf = (id: string | null) => (id ? kObjects.find((o) => o.objectId === id) : undefined);
    const firstObj = kObjects[0];
    const base = { contractId: k.id, customerId: k.customerId };
    const label = `Avtal ${k.contractNr} (${k.customerName})`;
    const out: NewLine[] = [];

    const regularBilled = kBilled.filter((b) => b.lineKind === 'regular');
    const overlapping = regularBilled.filter((b) => b.periodFrom <= P.to && b.periodTo >= P.from);
    const contractEnded = !!k.endDate && k.endDate < P.from;

    // 1. Ordinarie debitering för perioden
    if (!contractEnded && k.startDate <= P.to) {
      const active = kLines.filter((l) => overlap(l.validFrom, l.validTo, P));
      if (overlapping.length) {
        const exact = overlapping.every((b) => b.invPeriodFrom === P.from && b.invPeriodTo === P.to);
        if (!exact) {
          issues.push({
            ...base,
            kind: 'partially_billed',
            severity: 'warning',
            message: `${label}: perioden ${periodLabel(P)} är delvis aviserad tidigare (till exempel efter byte av aviseringsintervall). Kontrollera och fakturera resten manuellt.`,
          });
        } else if (k.billingInterval === 'month' || P.from >= monthFrom) {
          issues.push({
            ...base,
            kind: 'already_billed',
            severity: 'info',
            message: `${label}: ${periodLabel(P)} är redan aviserad och tas inte med igen.`,
          });
        }
      } else if (k.billingInterval === 'quarter' && monthFrom !== addMonths(P.from, k.billingInAdvance ? 0 : 3) && k.startDate < P.from) {
        // Kvartalsavtal aviseras i kvartalets första månad (efterskott: månaden efter kvartalet).
        // Har det inte gjorts då aviseras det inte automatiskt mitt i kvartalet, så att inget dubbeldebiteras vid byte från ett annat system.
        if (active.length) {
          issues.push({
            ...base,
            kind: 'missing_previous',
            severity: 'warning',
            message: `${label}: ${periodLabel(P)} har inte aviserats i systemet. Gör en körning för ${monthLabel(addMonths(P.from, k.billingInAdvance ? 0 : 3))} om kvartalet ska debiteras härifrån.`,
          });
        }
      } else if (!active.length) {
        issues.push({
          ...base,
          kind: 'no_lines',
          severity: 'warning',
          message: `${label}: avtalet saknar hyresrader för ${periodLabel(P)} och aviseras inte.`,
        });
      } else {
        for (const l of active) {
          const ov = overlap(l.validFrom, l.validTo, P)!;
          const net = periodAmount(l.amountOre, l.validFrom, l.validTo, P);
          if (net === 0) continue;
          const o = objOf(l.objectId);
          const partial = ov.from !== P.from || ov.to !== P.to;
          out.push({
            lineKind: 'regular',
            contractId: k.id,
            contractLineId: l.id,
            objectId: l.objectId,
            propertyId: o?.propertyId ?? firstObj?.propertyId ?? null,
            costCenterId: o?.costCenterId ?? firstObj?.costCenterId ?? null,
            article: l.article,
            description: partial ? `${l.description} ${ov.from} – ${ov.to}` : l.description,
            periodFrom: ov.from,
            periodTo: ov.to,
            unitPriceOre: net,
            netOre: net,
            vatRateBp: l.vatRateBp,
            vatOre: vatFor(net, l.vatRateBp),
          });
          // Kontroll: objektet ska ingå i avtalet hela den aviserade tiden
          if (l.objectId) {
            if (!o) {
              issues.push({ ...base, objectId: l.objectId, kind: 'vacant_billed', severity: 'blocking', message: `${label}: raden "${l.description}" gäller ett objekt som inte ingår i avtalet.` });
            } else if (o.validFrom > ov.from || (o.validTo && o.validTo < ov.to)) {
              issues.push({ ...base, objectId: o.objectId, kind: 'vacant_billed', severity: 'blocking', message: `${label}: ${o.objectNr} ingår inte i avtalet hela perioden ${ov.from} – ${ov.to} men debiteras.` });
            } else if (!o.active) {
              issues.push({ ...base, objectId: o.objectId, kind: 'vacant_billed', severity: 'blocking', message: `${label}: ${o.objectNr} är inaktiverat men debiteras.` });
            }
          }
          // Kontroll: moms mot objektets momsstatus och avtalstyp
          if (o && l.vatRateBp > 0 && RESIDENTIAL_TYPES.has(o.type)) {
            issues.push({ ...base, objectId: o.objectId, kind: 'vat_mismatch', severity: 'blocking', message: `${label}: ${o.objectNr} är en bostad men raden "${l.description}" har moms.` });
          } else if (o && ['rent', 'parking', 'storage'].includes(l.article)) {
            const liable = vatLiable(o.objectId, ov);
            if (liable === false && l.vatRateBp > 0) {
              issues.push({ ...base, objectId: o.objectId, kind: 'vat_mismatch', severity: 'warning', message: `${label}: "${l.description}" har moms men ${o.objectNr} är inte momspliktigt.` });
            } else if (liable === true && l.vatRateBp === 0 && k.type !== 'residential') {
              issues.push({ ...base, objectId: o.objectId, kind: 'vat_mismatch', severity: 'warning', message: `${label}: ${o.objectNr} är momspliktigt men "${l.description}" saknar moms.` });
            }
          }
          if (l.vatRateBp > 0 && k.customerKind === 'person') {
            issues.push({ ...base, kind: 'vat_mismatch', severity: 'warning', message: `${label}: hyresgästen är en privatperson men "${l.description}" har moms. Frivillig skattskyldighet förutsätter en momsregistrerad hyresgäst.` });
          }
        }
      }

      // Föregående period ska vara aviserad
      const prev = previousPeriod(P, k.billingInterval);
      const hasHistory = regularBilled.length > 0;
      const prevActive = k.startDate <= prev.to && kLines.some((l) => overlap(l.validFrom, l.validTo, prev));
      if (prevActive && prev.from >= lookback) {
        const prevBilled = regularBilled.some((b) => b.periodFrom <= prev.to && b.periodTo >= prev.from);
        if (!prevBilled && hasHistory) {
          issues.push({ ...base, kind: 'missing_previous', severity: 'warning', message: `${label}: föregående period ${periodLabel(prev)} har inte aviserats. Gör en körning för ${monthLabel(prev.from)} om den ska debiteras.` });
        } else if (!prevBilled && !hasHistory && out.length) {
          issues.push({ ...base, kind: 'first_billing', severity: 'info', message: `${label}: första aviseringen i systemet. Perioder före ${periodLabel(P)} tas inte med automatiskt.` });
        }
      }
    }

    // 2. Retroaktiva justeringar för perioder som redan aviserats
    const periods = new Map<string, Period>();
    for (const b of regularBilled) {
      if (b.invPeriodFrom && b.invPeriodTo) periods.set(`${b.invPeriodFrom}|${b.invPeriodTo}`, { from: b.invPeriodFrom, to: b.invPeriodTo });
    }
    for (const Q of [...periods.values()].sort((a, b) => a.from.localeCompare(b.from))) {
      const within = kBilled.filter((b) => b.periodFrom >= Q.from && b.periodTo <= Q.to);
      const lineIds = new Set([...kLines.filter((l) => overlap(l.validFrom, l.validTo, Q)).map((l) => l.id), ...within.map((b) => b.contractLineId)]);
      for (const lineId of lineIds) {
        const l = kLines.find((x) => x.id === lineId);
        const expected = l ? periodAmount(l.amountOre, l.validFrom, l.validTo, Q) : 0;
        const done = within.filter((b) => b.contractLineId === lineId).reduce((s, b) => s + b.netOre, 0);
        const diff = expected - done;
        if (diff === 0) continue;
        const ref = within.find((b) => b.contractLineId === lineId);
        if (kWaived.some((b) => b.contractLineId === lineId && b.periodFrom <= Q.to && b.periodTo >= Q.from)) {
          issues.push({
            ...base,
            kind: 'credited_period',
            severity: 'warning',
            message: `${label}: ${periodLabel(Q)} har krediterats tidigare och justeras nu igen (${fmtKr(diff)} för "${l?.description ?? ref?.description}"). Kontrollera att hyresgästen inte krediteras två gånger.`,
          });
        }
        const ov = (l && overlap(l.validFrom, l.validTo, Q)) ?? Q;
        const vatRate = l?.vatRateBp ?? ref?.vatRateBp ?? 0;
        const objectId = l?.objectId ?? ref?.objectId ?? null;
        const o = objOf(objectId);
        out.push({
          lineKind: 'retroactive',
          contractId: k.id,
          contractLineId: lineId,
          objectId,
          propertyId: o?.propertyId ?? firstObj?.propertyId ?? null,
          costCenterId: o?.costCenterId ?? firstObj?.costCenterId ?? null,
          article: l?.article ?? ref?.article ?? 'other',
          description: `Justering ${periodLabel(Q)}: ${l?.description ?? ref?.description ?? 'borttagen rad'}`,
          periodFrom: ov.from,
          periodTo: ov.to,
          unitPriceOre: diff,
          netOre: diff,
          vatRateBp: vatRate,
          vatOre: vatFor(diff, vatRate),
        });
      }
    }

    // 3. Extra debiteringar
    for (const ch of chargesBy.get(k.id) ?? []) {
      const o = objOf(ch.objectId);
      out.push({
        lineKind: 'charge',
        contractId: k.id,
        contractChargeId: ch.id,
        objectId: ch.objectId,
        propertyId: o?.propertyId ?? firstObj?.propertyId ?? null,
        costCenterId: o?.costCenterId ?? firstObj?.costCenterId ?? null,
        article: ch.article,
        description: ch.description,
        unitPriceOre: ch.amountOre,
        netOre: ch.amountOre,
        vatRateBp: ch.vatRateBp,
        vatOre: vatFor(ch.amountOre, ch.vatRateBp),
      });
    }

    if (!out.length) continue;
    const hasRegular = out.some((l) => l.lineKind === 'regular');
    // Kvartalsavtal: justeringar och tillägg väntar till nästa kvartalsavi, så länge avtalet löper
    if (!hasRegular && !contractEnded && k.billingInterval === 'quarter') {
      issues.push({ ...base, kind: 'postponed', severity: 'info', message: `${label}: justeringar och extra debiteringar följer med nästa kvartalsavi.` });
      continue;
    }

    out.sort((a, b) => {
      const kind = (x: NewLine) => ['regular', 'charge', 'retroactive'].indexOf(x.lineKind);
      if (kind(a) !== kind(b)) return kind(a) - kind(b);
      const oa = objOf(a.objectId ?? null)?.objectNr ?? '';
      const ob = objOf(b.objectId ?? null)?.objectNr ?? '';
      if (oa !== ob) return oa.localeCompare(ob, 'sv');
      return ARTICLE_ORDER.indexOf(a.article) - ARTICLE_ORDER.indexOf(b.article);
    });

    const net = out.reduce((s, l) => s + l.netOre, 0);
    const vat = out.reduce((s, l) => s + l.vatOre, 0);
    if (net + vat === 0) {
      issues.push({ ...base, kind: 'zero_total', severity: 'info', message: `${label}: avin blir 0 kr och skapas inte.` });
      continue;
    }

    // Negativt belopp (till exempel en utflyttning efter betald period) blir en kreditfaktura
    let kind = 'rent_notice';
    let creditsId: string | null = null;
    if (net + vat < 0) {
      const charged = kBilled.filter((b) => b.lineKind !== 'credit').sort((a, b) => b.periodFrom.localeCompare(a.periodFrom));
      creditsId = charged[0]?.invoiceId ?? null;
      if (creditsId) {
        kind = 'credit_note';
        issues.push({ ...base, kind: 'credit_note', severity: 'info', message: `${label}: beloppet blir negativt och skapas som en kreditfaktura.` });
      }
    }

    // Förfallodag
    const { billTo, deliveryMethod, termsDays } = await billToFor(client, k.customerId);
    let due: string;
    if (kind === 'credit_note') due = run.invoiceDate;
    else if (run.dueDate) due = run.dueDate;
    else if (k.paymentTermsDays !== null) due = bankDayOnOrAfter(addDays(run.invoiceDate, k.paymentTermsDays));
    else if (k.billingInAdvance && hasRegular) due = lastBankDayBefore(P.from);
    else due = bankDayOnOrAfter(addDays(run.invoiceDate, termsDays));
    if (due < run.invoiceDate) {
      due = bankDayOnOrAfter(addDays(run.invoiceDate, 10));
      issues.push({ ...base, kind: 'late', severity: 'info', message: `${label}: perioden har redan börjat. Förfallodagen sätts till ${due}.` });
    }

    const inv = (
      await client.query(
        `insert into invoice (company_id, kind, customer_id, contract_id, billing_run_id, invoice_date, due_date,
                              period_from, period_to, bill_to, delivery_method, credits_invoice_id, credit_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [
          run.companyId,
          kind,
          k.customerId,
          k.id,
          run.id,
          run.invoiceDate,
          due,
          hasRegular ? P.from : null,
          hasRegular ? P.to : null,
          JSON.stringify(billTo),
          deliveryMethod,
          creditsId,
          creditsId ? 'Justering av tidigare aviserad hyra' : null,
        ],
      )
    ).rows[0];
    await insertLines(client, run.companyId, inv.id, out);
    const sums = await recalcInvoice(client, inv.id);
    invoiceCount += 1;
    total += sums.totalOre;
    fp.push(`${k.id}:${out.map((l) => `${l.contractLineId ?? l.contractChargeId}/${l.periodFrom}/${l.netOre}/${l.vatOre}`).join(',')}:${due}`);

    // Kontroller på hela avin
    for (const i of issues) if (i.contractId === k.id && !i.invoiceKey) i.invoiceKey = inv.id;
    if (sums.totalOre < 0 && kind !== 'credit_note') {
      issues.push({ ...base, invoiceKey: inv.id, kind: 'negative_total', severity: 'blocking', message: `${label}: avin blir negativ (${(sums.totalOre / 100).toLocaleString('sv-SE')} kr). Gör en kreditfaktura i stället, eller ta bort avtalet ur körningen.` });
    }
    const prev = prevBy.get(k.id);
    const regularNet = out.filter((l) => l.lineKind === 'regular').reduce((s, l) => s + l.netOre, 0);
    if (prev && hasRegular && prev.netOre > 0) {
      const sameLength = monthsIn(prev) === monthsIn(P);
      const diff = regularNet - prev.netOre;
      if (sameLength && Math.abs(diff) > 10_000 && Math.abs(diff) / prev.netOre > 0.1) {
        issues.push({
          ...base,
          invoiceKey: inv.id,
          kind: 'deviating_amount',
          severity: 'warning',
          message: `${label}: hyran för ${periodLabel(P)} är ${fmtKr(regularNet)}, ${diff > 0 ? 'högre' : 'lägre'} än förra avin (${fmtKr(prev.netOre)} för ${periodLabel({ from: prev.periodFrom, to: prev.periodTo })}).`,
        });
      }
    }
    const ch = resolveChannel(deliveryMethod, billTo);
    if (ch.channel === 'post' && (!billTo.addressLine || !billTo.postalCode || !billTo.city)) {
      issues.push({ ...base, invoiceKey: inv.id, kind: 'missing_address', severity: 'blocking', message: `${label}: avin ska skickas med brev men hyresgästen saknar fullständig adress.` });
    } else if (deliveryMethod === 'email' && ch.channel !== 'email') {
      issues.push({ ...base, invoiceKey: inv.id, kind: 'missing_email', severity: 'warning', message: `${label}: hyresgästen saknar e-post. Avin skickas med brev.` });
    } else if (deliveryMethod === 'e_invoice' && ch.channel !== 'e_invoice') {
      issues.push({ ...base, invoiceKey: inv.id, kind: 'missing_peppol', severity: 'warning', message: `${label}: hyresgästen saknar Peppol-id. Avin skickas med ${ch.channel === 'email' ? 'e-post' : 'brev'}.` });
    }
  }

  // Objekt som används men vars avtal fortfarande är utkast
  const drafts = (
    await client.query(
      `select k.id, k.contract_nr as "contractNr", k.customer_id as "customerId", c.name as "customerName", k.start_date::text as "startDate",
              string_agg(o.object_nr, ', ' order by o.object_nr) as objects
       from contract k join customer c on c.id = k.customer_id
       join contract_object x on x.contract_id = k.id join rental_object o on o.id = x.object_id
       where k.company_id = $1 and k.status = 'draft' and k.start_date <= $4 and ${scope}
       group by k.id, c.name`,
      [run.companyId, run.propertyIds, run.objectIds, monthTo],
    )
  ).rows;
  for (const d of drafts) {
    issues.push({
      contractId: d.id,
      customerId: d.customerId,
      kind: 'draft_contract',
      severity: 'warning',
      message: `Avtal ${d.contractNr} (${d.customerName}) för ${d.objects} började ${d.startDate} men är fortfarande ett utkast och aviseras inte. Aktivera avtalet om hyresgästen har flyttat in.`,
    });
  }

  for (const i of issues) {
    await client.query(
      `insert into billing_run_issue (company_id, billing_run_id, kind, severity, contract_id, object_id, customer_id, invoice_id, message)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [run.companyId, run.id, i.kind, i.severity, i.contractId ?? null, i.objectId ?? null, i.customerId ?? null, i.invoiceKey ?? null, i.message],
    );
  }

  const fingerprint = createHash('sha256').update(fp.sort().join('\n')).digest('hex');
  await client.query('update billing_run set generated_at = now(), fingerprint = $2 where id = $1', [run.id, fingerprint]);
  return { invoices: invoiceCount, totalOre: total, fingerprint };
}

function monthsIn(p: { from?: string; to?: string; periodFrom?: string; periodTo?: string }): number {
  const from = p.from ?? p.periodFrom!;
  const to = p.to ?? p.periodTo!;
  const [y1, m1] = from.split('-').map(Number);
  const [y2, m2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

function fmtKr(ore: number): string {
  return `${Math.round(ore / 100).toLocaleString('sv-SE')} kr`;
}
