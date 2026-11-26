import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { addDays, extendedEndDate, noticeDeadline } from './contract-rules';

export type AttentionKind =
  | 'notice_deadline'
  | 'auto_extended'
  | 'ending'
  | 'renegotiate'
  | 'draft'
  | 'no_lines'
  | 'deposit_missing';

export interface AttentionItem {
  kind: AttentionKind;
  /** Datum som posten gäller, för sortering. */
  date: string;
  severity: 'high' | 'normal';
  message: string;
  contractId: string;
  contractNr: number;
  customerName: string;
  companyName: string;
  objects: string;
}

const NOTICE_HORIZON = 120;
const ENDING_HORIZON = 90;

/**
 * Bevakningslista för avtal. Räknas fram vid varje anrop ur avtalens datum.
 * Viktigast är sista dag för uppsägning av tidsbestämda avtal: missas den
 * förlängs avtalet automatiskt.
 */
export async function attentionItems(client: PoolClient): Promise<AttentionItem[]> {
  const now = today();
  const { rows } = await client.query(
    `select k.id, k.contract_nr as "contractNr", k.status, k.start_date::text as "startDate", k.end_date::text as "endDate",
            k.notice_months as "noticeMonths", k.extension_months as "extensionMonths",
            k.renegotiate_by::text as "renegotiateBy", c.name as "customerName", co.name as "companyName",
            coalesce((select string_agg(o.object_nr, ', ' order by o.object_nr) from contract_object x
               join rental_object o on o.id = x.object_id where x.contract_id = k.id), '') as objects,
            exists (select 1 from contract_line l where l.contract_id = k.id
               and l.valid_from <= greatest(current_date, k.start_date)
               and (l.valid_to is null or l.valid_to >= greatest(current_date, k.start_date))) as "hasLines",
            (select min(d.due_date)::text from contract_deposit d where d.contract_id = k.id
               and d.received_date is null and d.due_date < current_date) as "depositDue"
     from contract k
     join customer c on c.id = k.customer_id
     join company co on co.id = k.company_id
     where k.status in ('draft','active','terminated') and (k.end_date is null or k.end_date >= current_date - 7)`,
  );
  const items: AttentionItem[] = [];
  for (const r of rows) {
    const base = {
      contractId: r.id,
      contractNr: r.contractNr,
      customerName: r.customerName,
      companyName: r.companyName,
      objects: r.objects,
    };
    const push = (kind: AttentionKind, date: string, message: string, severity: 'high' | 'normal' = 'normal') =>
      items.push({ ...base, kind, date, message, severity });

    if (r.status === 'draft') {
      push('draft', r.startDate, `Utkast som ska börja gälla ${r.startDate}`, r.startDate <= addDays(now, 14) ? 'high' : 'normal');
      continue;
    }
    if (r.status === 'active' && r.endDate) {
      const deadline = noticeDeadline(r.endDate, r.noticeMonths)!;
      if (deadline >= now && deadline <= addDays(now, NOTICE_HORIZON)) {
        push(
          'notice_deadline',
          deadline,
          `Sista dag för uppsägning ${deadline}. Avtalet löper till ${r.endDate}` +
            (r.extensionMonths ? ` och förlängs annars med ${r.extensionMonths} månader.` : '.'),
          deadline <= addDays(now, 30) ? 'high' : 'normal',
        );
      } else if (deadline < now && r.extensionMonths && r.endDate < now) {
        push(
          'auto_extended',
          r.endDate,
          `Avtalstiden gick ut ${r.endDate} utan uppsägning. Förläng till ${extendedEndDate(r.endDate, r.extensionMonths)}.`,
          'high',
        );
      } else if (deadline < now && r.extensionMonths && r.endDate <= addDays(now, NOTICE_HORIZON)) {
        push(
          'auto_extended',
          r.endDate,
          `Sista dag för uppsägning var ${deadline}. Avtalet förlängs från ${addDays(r.endDate, 1)} till ${extendedEndDate(r.endDate, r.extensionMonths)}.`,
        );
      }
    }
    if (r.status === 'terminated' && r.endDate && r.endDate <= addDays(now, ENDING_HORIZON)) {
      push('ending', r.endDate, `Uppsagt, upphör ${r.endDate}`, r.endDate <= addDays(now, 30) ? 'high' : 'normal');
    }
    if (r.status === 'active' && r.endDate && !r.extensionMonths && r.endDate <= addDays(now, ENDING_HORIZON)) {
      push('ending', r.endDate, `Tidsbestämt avtal utan förlängning, upphör ${r.endDate}`, 'high');
    }
    if (r.renegotiateBy && r.renegotiateBy <= addDays(now, NOTICE_HORIZON)) {
      push('renegotiate', r.renegotiateBy, `Omförhandling senast ${r.renegotiateBy}`, r.renegotiateBy <= now ? 'high' : 'normal');
    }
    if (!r.hasLines) push('no_lines', r.startDate, 'Aktivt avtal utan gällande hyresrader', 'high');
    if (r.depositDue) push('deposit_missing', r.depositDue, `Säkerhet skulle ha lämnats ${r.depositDue}`, 'high');
  }
  return items.sort((a, b) => (a.severity === b.severity ? a.date.localeCompare(b.date) : a.severity === 'high' ? -1 : 1));
}
