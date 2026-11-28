'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Input, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { REMINDER_LEVEL_LABEL, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Row {
  customerId: string;
  customerNr: number;
  customerName: string;
  companyName: string;
  openCount: number;
  openOre: number;
  notDueOre: number;
  d1to30Ore: number;
  d31to60Ore: number;
  d61to90Ore: number;
  over90Ore: number;
  overdueOre: number;
  unallocatedOre: number;
  balanceOre: number;
  oldestOverdue: string | null;
  reminderLevel: number;
}

interface Ledger {
  asOf: string;
  totals: Omit<Row, 'customerId' | 'customerNr' | 'customerName' | 'companyName' | 'openCount' | 'oldestOverdue' | 'reminderLevel'>;
  customers: Row[];
}

const cell = (ore: number) => (ore ? fmtOre(ore) : <span className="text-ink-3">–</span>);

export default function LedgerPage() {
  const { active, version } = useSession();
  const router = useRouter();
  const [l, setL] = useState<Ledger | null>(null);
  const [q, setQ] = useState('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  useEffect(() => {
    api<Ledger>('/ledger').then(setL);
  }, [version]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (l?.customers ?? []).filter(
      (r) => (!needle || r.customerName.toLowerCase().includes(needle) || String(r.customerNr) === needle) && (!onlyOverdue || r.overdueOre > 0),
    );
  }, [l, q, onlyOverdue]);
  const t = l?.totals;

  return (
    <>
      <PageHeader
        title="Kundreskontra"
        description={`Vad hyresgästerna är skyldiga ${active ? active.companyName : 'i hela koncernen'} per ${l?.asOf ?? 'i dag'}, uppdelat efter hur länge det varit förfallet.`}
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Kundfordringar" value={t ? fmtOre(t.openOre) : '–'} sub={l ? `${l.customers.filter((c) => c.openCount).length} kunder med obetalt` : undefined} />
        <Stat label="Förfallet" value={t ? fmtOre(t.overdueOre) : '–'} sub={t && t.openOre ? `${Math.round((t.overdueOre / t.openOre) * 100)} % av fordringarna` : undefined} />
        <Stat label="Förfallet mer än 60 dagar" value={t ? fmtOre(t.d61to90Ore + t.over90Ore) : '–'} sub="bör lämnas till inkasso" />
        <Stat label="Ej fördelade inbetalningar" value={t ? fmtOre(t.unallocatedOre) : '–'} sub={<Link href="/inbetalningar" className="hover:underline">hantera under Inbetalningar</Link>} />
      </div>

      <div className="mb-3 flex items-center gap-4">
        <div className="w-72">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Sök kund" />
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={onlyOverdue} onChange={(e) => setOnlyOverdue(e.target.checked)} />
          Bara kunder med förfallet
        </label>
      </div>

      <Table
        head={['Kund', ...(active ? [] : ['Bolag']), 'Ej förfallet', '1–30 dagar', '31–60', '61–90', 'Över 90', 'Ej fördelat', 'Saldo', '']}
        foot={
          t && rows.length > 0 && !q && !onlyOverdue && (
            <tr className="bg-subtle/60 font-medium">
              <Td>Summa</Td>
              {!active && <Td />}
              <Td className="tabular">{fmtOre(t.notDueOre)}</Td>
              <Td className="tabular">{fmtOre(t.d1to30Ore)}</Td>
              <Td className="tabular">{fmtOre(t.d31to60Ore)}</Td>
              <Td className="tabular">{fmtOre(t.d61to90Ore)}</Td>
              <Td className="tabular">{fmtOre(t.over90Ore)}</Td>
              <Td className="tabular">{t.unallocatedOre ? `−${fmtOre(t.unallocatedOre)}` : '–'}</Td>
              <Td className="tabular">{fmtOre(t.balanceOre)}</Td>
              <Td />
            </tr>
          )
        }
        empty={l ? 'Inga kunder har obetalda fakturor.' : undefined}
      >
        {rows.map((r) => (
          <tr key={r.customerId} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/kunder/${r.customerId}#reskontra`)}>
            <Td>
              <Link href={`/kunder/${r.customerId}#reskontra`} className="font-medium">
                {r.customerName}
              </Link>
              <div className="text-[12px] text-ink-3">
                kund {r.customerNr} · {r.openCount} {r.openCount === 1 ? 'obetald faktura' : 'obetalda fakturor'}
              </div>
            </Td>
            {!active && <Td className="text-ink-2">{r.companyName}</Td>}
            <Td className="tabular">{cell(r.notDueOre)}</Td>
            <Td className="tabular">{cell(r.d1to30Ore)}</Td>
            <Td className="tabular">{cell(r.d31to60Ore)}</Td>
            <Td className="tabular">{cell(r.d61to90Ore)}</Td>
            <Td className="tabular">{r.over90Ore ? <span className="text-bad">{fmtOre(r.over90Ore)}</span> : cell(0)}</Td>
            <Td className="tabular">{r.unallocatedOre ? <span className="text-warn">−{fmtOre(r.unallocatedOre)}</span> : cell(0)}</Td>
            <Td className="tabular font-medium">{fmtOre(r.balanceOre)}</Td>
            <Td>{r.reminderLevel > 0 && <Badge tone={r.reminderLevel === 2 ? 'bad' : 'warn'}>{REMINDER_LEVEL_LABEL[r.reminderLevel]}</Badge>}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
