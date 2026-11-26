'use client';

import { Fragment, useEffect, useState } from 'react';
import { Badge, PageHeader, Table, Td, formatDateTime } from '@/components/ui';
import { api, AuditRow } from '@/lib/api';
import { useSession } from '@/lib/session';

const tableNames: Record<string, string> = {
  company: 'Bolag',
  bank_account: 'Bankkonto',
  cost_center: 'Kostnadsställe',
  membership: 'Behörighet',
  app_user: 'Användare',
};
const actionTone = { insert: 'good', update: 'accent', delete: 'bad' } as const;
const actionName: Record<string, string> = { insert: 'Skapad', update: 'Ändrad', delete: 'Borttagen' };
const hidden = new Set(['created_at', 'updated_at', 'created_by', 'updated_by']);

export default function AuditPage() {
  const { me, version } = useSession();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api<AuditRow[]>('/audit-log').then(setRows);
  }, [version]);

  const companyName = (id: string) => me.companies.find((c) => c.companyId === id)?.companyName ?? '';

  return (
    <>
      <PageHeader title="Revisionslogg" description="Varje ändring sparas med vem, när och vad. Loggen kan inte ändras i efterhand." />
      <Table head={['Tid', 'Användare', 'Bolag', 'Typ', 'Händelse', 'Ändrade fält']} empty="Inga händelser, eller saknad behörighet att läsa loggen.">
        {rows.map((r) => {
          const changed = changedFields(r);
          return (
            <Fragment key={r.id}>
              <tr className="cursor-pointer hover:bg-subtle/60" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <Td className="tabular whitespace-nowrap text-ink-2">{formatDateTime(r.occurredAt)}</Td>
                <Td>{r.userName ?? 'System'}</Td>
                <Td className="whitespace-nowrap text-ink-2">{companyName(r.companyId)}</Td>
                <Td>{tableNames[r.tableName] ?? r.tableName}</Td>
                <Td>
                  <Badge tone={actionTone[r.action as keyof typeof actionTone] ?? 'neutral'}>{actionName[r.action] ?? r.action}</Badge>
                </Td>
                <Td className="text-ink-2">{changed.map((c) => c.key).join(', ')}</Td>
              </tr>
              {open === r.id && (
                <tr>
                  <td colSpan={6} className="bg-subtle/50 px-4 py-3">
                    <table className="text-[12.5px]">
                      <tbody>
                        {changed.map((c) => (
                          <tr key={c.key}>
                            <td className="py-0.5 pr-6 font-mono text-ink-3">{c.key}</td>
                            <td className="py-0.5 pr-3 text-bad line-through">{fmt(c.before)}</td>
                            <td className="py-0.5 text-good">{fmt(c.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </Table>
    </>
  );
}

function changedFields(r: AuditRow) {
  const keys = new Set([...Object.keys(r.before ?? {}), ...Object.keys(r.after ?? {})]);
  return [...keys]
    .filter((k) => !hidden.has(k) && JSON.stringify(r.before?.[k]) !== JSON.stringify(r.after?.[k]))
    .map((k) => ({ key: k, before: r.before?.[k], after: r.after?.[k] }));
}

function fmt(v: unknown) {
  if (v === null || v === undefined) return '–';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
