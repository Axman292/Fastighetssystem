'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Input, PageHeader, Select, Stat, Table, Tabs, Td } from '@/components/ui';
import { WorkOrderForm, useWorkOrderOptions } from '@/components/work-order-form';
import { api } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, WorkOrderRow, WorkOrderSummary, ago } from '@/lib/work-orders';

type Tab = 'open' | 'new' | 'assigned' | 'late' | 'done' | 'all';

export default function WorkOrdersPage() {
  const router = useRouter();
  const { active, can, version } = useSession();
  const [tab, setTab] = useState<Tab>('open');
  const [q, setQ] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [rows, setRows] = useState<WorkOrderRow[] | null>(null);
  const [sum, setSum] = useState<WorkOrderSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const opts = useWorkOrderOptions(version);

  useEffect(() => {
    api<WorkOrderSummary>('/work-orders/summary').then(setSum);
  }, [version]);

  useEffect(() => {
    const p = new URLSearchParams({ status: tab });
    if (q.trim()) p.set('q', q.trim());
    if (propertyId) p.set('propertyId', propertyId);
    setRows(null);
    const t = setTimeout(() => api<WorkOrderRow[]>(`/work-orders?${p}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [tab, q, propertyId, version]);

  const canWrite = !!active && can('work_order.manage');

  return (
    <>
      <PageHeader
        title="Felanmälan och ärenden"
        description={
          active
            ? `Felanmälningar och arbetsordrar i ${active.companyName}. Hyresgästerna anmäler fel via fastighetens länk eller QR-kod.`
            : 'Felanmälningar och arbetsordrar i hela koncernen.'
        }
        actions={
          <>
            <Link href="/arenden/formular">
              <Button variant="secondary">Formulär och länkar</Button>
            </Link>
            {canWrite && <Button onClick={() => setCreating(true)}>Nytt ärende</Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Nya, ej hanterade" value={sum?.new ?? '–'} sub={sum ? `${sum.open} öppna totalt` : undefined} />
        <Stat label="Akuta" value={sum?.urgent ?? '–'} sub="öppna med prioritet akut" />
        <Stat label="Försenade" value={sum?.late ?? '–'} sub="öppna efter klart-datum" />
        <Stat
          label="Snitt till åtgärd"
          value={sum?.avgDays !== null && sum?.avgDays !== undefined ? `${String(sum.avgDays).replace('.', ',')} dagar` : '–'}
          sub={sum ? `${sum.last30} nya senaste 30 dagarna` : undefined}
        />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'open', label: 'Öppna', count: sum?.open },
          { key: 'new', label: 'Nya', count: sum?.new },
          { key: 'assigned', label: 'Hos hantverkare', count: sum?.atSupplier },
          { key: 'late', label: 'Försenade', count: sum?.late },
          { key: 'done', label: 'Åtgärdade, att avsluta', count: sum?.toClose },
          { key: 'all', label: 'Alla' },
        ]}
      />
      <div className="mb-4 flex gap-2">
        <Input className="max-w-xs" placeholder="Sök på fel, anmälare, objekt eller nummer" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="max-w-[240px]" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
          <option value="">Alla fastigheter</option>
          {opts?.properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>

      {rows && (
        <Table
          head={['Nr', 'Fel', ...(active ? [] : ['Bolag']), 'Fastighet och objekt', 'Prioritet', 'Status', 'Ansvarig', 'Klart senast', 'Inkom']}
          empty={tab === 'open' ? 'Inga öppna ärenden. Skönt!' : 'Inga ärenden här.'}
        >
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/arenden/${r.id}`)}>
              <Td className="tabular text-ink-3">{r.orderNr}</Td>
              <Td className="font-medium">
                <Link href={`/arenden/${r.id}`}>{r.title}</Link>
                <div className="max-w-[260px] truncate text-[12px] font-normal text-ink-3">
                  {CATEGORY_LABEL[r.category] ?? r.category}
                  {r.reporterName ? ` · ${r.reporterName}` : ''}
                  {r.photoCount ? ` · ${r.photoCount} bild${r.photoCount > 1 ? 'er' : ''}` : ''}
                </div>
              </Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="text-ink-2">
                {r.propertyName}
                {r.objectNr && <div className="text-[12px] text-ink-3">{r.objectNr}{r.customerName ? ` · ${r.customerName}` : ''}</div>}
              </Td>
              <Td sortValue={{ urgent: 0, high: 1, normal: 2, low: 3 }[r.priority]}>
                <Badge tone={PRIORITY_LABEL[r.priority].tone}>{PRIORITY_LABEL[r.priority].label}</Badge>
              </Td>
              <Td>
                <span className="inline-flex gap-1">
                  <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge>
                  {r.overdue && <Badge tone="bad">Försenad</Badge>}
                </span>
                {r.supplierName && <div className="mt-0.5 max-w-[160px] truncate text-[12px] text-ink-3">{r.supplierName}</div>}
              </Td>
              <Td className="text-ink-2">{r.assigneeName ?? '–'}</Td>
              <Td className={r.overdue ? 'tabular text-bad' : 'tabular text-ink-2'}>{r.dueDate ?? '–'}</Td>
              <Td className="whitespace-nowrap text-ink-2" sortValue={r.createdAt}>
                {ago(r.createdAt)}
                {r.costOre > 0 && <div className="text-[12px] text-ink-3">{fmtOre(r.costOre)}</div>}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Nytt ärende" wide>
        <WorkOrderForm propertyId={propertyId || undefined} onCancel={() => setCreating(false)} onSaved={(id) => router.push(`/arenden/${id}`)} />
      </Dialog>
    </>
  );
}
