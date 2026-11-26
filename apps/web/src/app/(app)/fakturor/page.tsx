'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InvoiceRow, InvoiceTable } from '@/components/invoice-table';
import { Button, Input, PageHeader, Stat, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Summary {
  openOre: number;
  openCount: number;
  overdueOre: number;
  overdueCount: number;
  billedThisMonthOre: number;
  invoicedThisMonthNetOre: number;
  draftCount: number;
}

type Tab = 'all' | 'open' | 'overdue' | 'draft' | 'credit_note';

export default function InvoicesPage() {
  const { active, can, version } = useSession();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    api<Summary>('/invoices/summary').then(setSummary);
  }, [version]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (tab === 'open' || tab === 'overdue' || tab === 'draft') p.set('state', tab);
    if (tab === 'credit_note') p.set('kind', 'credit_note');
    const t = setTimeout(() => api<InvoiceRow[]>(`/invoices?${p}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, tab, version]);

  return (
    <>
      <PageHeader
        title="Fakturor"
        description={active ? `Hyresavier, fakturor och krediteringar i ${active.companyName}.` : 'Hyresavier, fakturor och krediteringar i hela koncernen.'}
        actions={
          <>
            <Link href="/avisering">
              <Button variant="secondary">Avisering</Button>
            </Link>
            {can('invoice.write') && (
              <Link href="/fakturor/ny">
                <Button>Ny faktura</Button>
              </Link>
            )}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Obetalt" value={summary ? fmtOre(summary.openOre) : '–'} sub={summary ? `${summary.openCount} fakturor` : undefined} />
        <Stat label="Förfallet" value={summary ? fmtOre(summary.overdueOre) : '–'} sub={summary ? `${summary.overdueCount} fakturor efter förfallodagen` : undefined} />
        <Stat label="Aviserad hyra denna månad" value={summary ? fmtOre(summary.billedThisMonthOre) : '–'} sub="inkl. moms" />
        <Stat label="Utkast" value={summary ? summary.draftCount : '–'} sub="manuella fakturor som inte utfärdats" />
      </div>
      <Tabs
        tabs={[
          { key: 'all', label: 'Alla' },
          { key: 'open', label: 'Obetalda' },
          { key: 'overdue', label: 'Förfallna' },
          { key: 'draft', label: 'Utkast' },
          { key: 'credit_note', label: 'Krediteringar' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mb-3">
        <Input className="max-w-xs" placeholder="Sök kund, fakturanummer, OCR eller avtal" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <InvoiceTable rows={rows ?? []} showCompany={!active} empty={rows ? 'Inga fakturor.' : 'Laddar…'} />
    </>
  );
}
