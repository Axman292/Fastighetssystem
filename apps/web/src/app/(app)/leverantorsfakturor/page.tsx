'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SupplierInvoiceTable } from '@/components/supplier-invoice-table';
import { Button, Input, PageHeader, Stat, Table, Tabs, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { SupplierInvoiceRow } from '@/lib/suppliers';

interface Ledger {
  counts: { toApprove: number; toApproveOre: number; toPay: number; toPayOre: number; overdue: number; overdueOre: number; dueThisWeek: number; dueThisWeekOre: number };
  suppliers: {
    supplierId: string;
    supplierName: string;
    supplierNr: number;
    companyName: string;
    invoiceCount: number;
    balanceOre: number;
    notDueOre: number;
    d1to30Ore: number;
    d31to60Ore: number;
    over60Ore: number;
    nextDueDate: string;
  }[];
}

type Tab = 'to_approve' | 'to_pay' | 'overdue' | 'paid' | 'cancelled' | 'all' | 'ledger';

export default function SupplierInvoicesPage() {
  const { active, can, version } = useSession();
  const [tab, setTab] = useState<Tab>('to_approve');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SupplierInvoiceRow[] | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);

  useEffect(() => {
    api<Ledger>('/supplier-invoices/ledger').then(setLedger);
  }, [version]);

  useEffect(() => {
    if (tab === 'ledger') return;
    const p = new URLSearchParams();
    if (tab !== 'all') p.set('status', tab);
    if (q.trim()) p.set('q', q.trim());
    setRows(null);
    const t = setTimeout(() => api<SupplierInvoiceRow[]>(`/supplier-invoices?${p}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [tab, q, version]);

  const c = ledger?.counts;
  const total = ledger?.suppliers.reduce(
    (s, r) => ({ b: s.b + r.balanceOre, n: s.n + r.notDueOre, a: s.a + r.d1to30Ore, m: s.m + r.d31to60Ore, o: s.o + r.over60Ore }),
    { b: 0, n: 0, a: 0, m: 0, o: 0 },
  );

  return (
    <>
      <PageHeader
        title="Leverantörsfakturor"
        description={active ? `Fakturor till ${active.companyName}: registrera, kontera, attestera och betala.` : 'Leverantörsfakturor i hela koncernen.'}
        actions={
          <>
            <Link href="/leverantorer">
              <Button variant="secondary">Leverantörer</Button>
            </Link>
            {can('supplier_invoice.write') && (
              <Link href="/leverantorsfakturor/ny">
                <Button>Registrera faktura</Button>
              </Link>
            )}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Att attestera" value={c ? fmtOre(c.toApproveOre) : '–'} sub={c ? `${c.toApprove} fakturor` : undefined} />
        <Stat label="Att betala" value={c ? fmtOre(c.toPayOre) : '–'} sub={c ? `${c.toPay} attesterade fakturor` : undefined} />
        <Stat label="Förfaller inom en vecka" value={c ? fmtOre(c.dueThisWeekOre) : '–'} sub={c ? `${c.dueThisWeek} fakturor` : undefined} />
        <Stat label="Förfallet" value={c ? fmtOre(c.overdueOre) : '–'} sub={c ? `${c.overdue} fakturor efter förfallodagen` : undefined} />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'to_approve', label: 'Att attestera', count: c?.toApprove },
          { key: 'to_pay', label: 'Att betala', count: c?.toPay },
          { key: 'overdue', label: 'Förfallna', count: c?.overdue },
          { key: 'paid', label: 'Betalda' },
          { key: 'cancelled', label: 'Makulerade' },
          { key: 'all', label: 'Alla' },
          { key: 'ledger', label: 'Leverantörsreskontra' },
        ]}
      />
      {tab === 'ledger' ? (
        <Table head={['Leverantör', ...(active ? [] : ['Bolag']), 'Fakturor', 'Ej förfallet', '1–30 dagar', '31–60 dagar', 'Över 60 dagar', 'Obetalt']} empty="Inga obetalda leverantörsfakturor.">
          {ledger?.suppliers.map((r) => (
            <tr key={r.supplierId}>
              <Td className="font-medium">
                <Link href={`/leverantorer/${r.supplierId}`}>{r.supplierName}</Link>
                <div className="text-[12px] font-normal text-ink-3">Nästa förfallodag {r.nextDueDate}</div>
              </Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="tabular">{r.invoiceCount}</Td>
              <Td className="tabular">{fmtOre(r.notDueOre)}</Td>
              <Td className={r.d1to30Ore ? 'tabular text-warn' : 'tabular'}>{fmtOre(r.d1to30Ore)}</Td>
              <Td className={r.d31to60Ore ? 'tabular text-bad' : 'tabular'}>{fmtOre(r.d31to60Ore)}</Td>
              <Td className={r.over60Ore ? 'tabular text-bad' : 'tabular'}>{fmtOre(r.over60Ore)}</Td>
              <Td className="tabular font-medium">{fmtOre(r.balanceOre)}</Td>
            </tr>
          ))}
          {total && ledger && ledger.suppliers.length > 1 && (
            <tr className="bg-subtle/60 font-medium">
              <Td>Summa</Td>
              {!active && <Td />}
              <Td />
              <Td className="tabular">{fmtOre(total.n)}</Td>
              <Td className="tabular">{fmtOre(total.a)}</Td>
              <Td className="tabular">{fmtOre(total.m)}</Td>
              <Td className="tabular">{fmtOre(total.o)}</Td>
              <Td className="tabular">{fmtOre(total.b)}</Td>
            </tr>
          )}
        </Table>
      ) : (
        <>
          <div className="mb-3">
            <Input className="max-w-xs" placeholder="Sök leverantör, fakturanummer eller OCR" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <SupplierInvoiceTable rows={rows ?? []} showCompany={!active} empty={rows ? 'Inga fakturor här.' : 'Laddar…'} />
        </>
      )}
    </>
  );
}
