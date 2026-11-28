'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, PageHeader, Select, Stat, Table, Tabs, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { CONTRACT_TYPE_LABEL, contractStatus, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface ContractListRow {
  id: string;
  companyId: string;
  companyName: string;
  contractNr: number;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  customerId: string;
  customerName: string;
  monthlyOre: number;
  objects: string;
}

interface AttentionItem {
  key: string;
  kind: string;
  label: string;
  overdue: boolean;
  date: string;
  severity: 'high' | 'normal';
  message: string;
  contractId: string;
  contractNr: number;
  customerName: string;
  companyName: string;
  objects: string;
}

type Tab = 'attention' | 'all';

export default function ContractsPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('attention');
  const [rows, setRows] = useState<ContractListRow[] | null>(null);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api<AttentionItem[]>('/contracts/attention').then(setItems);
  }, [version]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    const t = setTimeout(() => api<ContractListRow[]>(`/contracts?${p}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, status, version]);

  const all = rows ?? [];
  const live = all.filter((r) => ['Aktivt', 'Uppsagt'].includes(contractStatus(r).label));
  const monthly = live.reduce((s, r) => s + r.monthlyOre, 0);
  const terminated = all.filter((r) => contractStatus(r).label === 'Uppsagt').length;

  return (
    <>
      <PageHeader
        title="Avtal"
        description={active ? `Hyresavtal i ${active.companyName}.` : 'Hyresavtal i hela koncernen.'}
        actions={
          <>
            <Link href="/avtal/bevakning">
              <Button variant="secondary">Bevakning</Button>
            </Link>
            <Link href="/avtal/hyresjustering">
              <Button variant="secondary">Hyresjustering</Button>
            </Link>
            <Link href="/avtal/indexering">
              <Button variant="secondary">Indexuppräkning</Button>
            </Link>
            {can('contract.write') && <Button onClick={() => router.push('/avtal/nytt')}>Nytt avtal</Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Gällande avtal" value={rows ? live.length : '–'} />
        <Stat label="Kontrakterad hyra per år" value={fmtOre(monthly * 12)} sub={`${fmtOre(monthly)} per månad exkl. moms`} />
        <Stat label="Uppsagda" value={rows ? terminated : '–'} sub="löper ut inom uppsägningstiden" />
        <Stat
          label="Att hantera"
          value={items ? items.length : '–'}
          sub={items ? `${items.filter((i) => i.severity === 'high').length} brådskande` : undefined}
        />
      </div>

      <Tabs
        tabs={[
          { key: 'attention', label: 'Att hantera', count: items?.length },
          { key: 'all', label: 'Alla avtal', count: rows?.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'attention' ? (
        items && items.length === 0 ? (
          <Card className="px-6 py-12 text-center">
            <div className="text-[14px] font-medium">Inget att hantera just nu</div>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
              Här visas sista dag för uppsägning, avtal som löper ut, omförhandlingar, KPI-uppräkningar, hyresändringar och säkerheter. Framförhållning och
              e-postsammanfattning ställs in under Bevakning.
            </p>
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {items?.map((i) => (
              <Link key={i.key} href={`/avtal/${i.contractId}`} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/60">
                <div className="w-40 shrink-0">
                  <Badge tone={i.overdue ? 'bad' : i.severity === 'high' ? 'warn' : 'neutral'}>{i.label}</Badge>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {i.customerName} <span className="font-normal text-ink-3">· avtal {i.contractNr}</span>
                  </div>
                  <div className="text-[12px] text-ink-2">{i.message}</div>
                </div>
                <div className="text-right text-[12px] text-ink-3">
                  <div className="tabular">{i.date}</div>
                  <div>{i.objects}</div>
                </div>
              </Link>
            ))}
          </Card>
        )
      ) : (
        <>
          <div className="mb-3 flex gap-2">
            <Input className="max-w-xs" placeholder="Sök hyresgäst, avtals- eller objektsnummer" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="max-w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Alla statusar</option>
              <option value="draft">Utkast</option>
              <option value="active">Aktiva</option>
              <option value="terminated">Uppsagda</option>
              <option value="cancelled">Makulerade</option>
            </Select>
          </div>
          <Table
            head={['Avtal', 'Hyresgäst', ...(active ? [] : ['Bolag']), 'Typ', 'Objekt', 'Period', 'Hyra/mån', 'Status']}
            empty="Inga avtal."
          >
            {all.map((r) => {
              const s = contractStatus(r);
              return (
                <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/avtal/${r.id}`)}>
                  <Td className="font-medium tabular">
                    <Link href={`/avtal/${r.id}`}>{r.contractNr}</Link>
                  </Td>
                  <Td>{r.customerName}</Td>
                  {!active && <Td className="text-ink-2">{r.companyName}</Td>}
                  <Td className="text-ink-2">{CONTRACT_TYPE_LABEL[r.type]}</Td>
                  <Td className="max-w-56 truncate text-ink-2">{r.objects || '–'}</Td>
                  <Td className="tabular text-ink-2">
                    {r.startDate} – {r.endDate ?? 'tills vidare'}
                  </Td>
                  <Td className="tabular">{fmtOre(r.monthlyOre)}</Td>
                  <Td>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </Td>
                </tr>
              );
            })}
          </Table>
        </>
      )}
    </>
  );
}
