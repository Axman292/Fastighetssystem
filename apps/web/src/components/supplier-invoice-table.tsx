'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Table, Td } from './ui';
import { SUPPLIER_INVOICE_STATUS, fmtOre } from '@/lib/format';
import type { SupplierInvoiceRow } from '@/lib/suppliers';

export function SupplierInvoiceStatus({ row }: { row: Pick<SupplierInvoiceRow, 'status' | 'overdue' | 'paidOre' | 'balanceOre'> }) {
  const s = SUPPLIER_INVOICE_STATUS[row.status] ?? { label: row.status, tone: 'neutral' as const };
  return (
    <span className="inline-flex gap-1">
      <Badge tone={s.tone}>{row.status === 'approved' && row.paidOre ? 'Delbetald' : s.label}</Badge>
      {row.overdue && <Badge tone="bad">Förfallen</Badge>}
    </span>
  );
}

/** Lista med leverantörsfakturor. */
export function SupplierInvoiceTable({ rows, showSupplier = true, showCompany = false, empty }: { rows: SupplierInvoiceRow[]; showSupplier?: boolean; showCompany?: boolean; empty: string }) {
  const router = useRouter();
  return (
    <Table
      head={['Nr', ...(showSupplier ? ['Leverantör'] : []), ...(showCompany ? ['Bolag'] : []), 'Fakturanr', 'Fastighet', 'Fakturadatum', 'Förfaller', 'Belopp', 'Kvar', 'Status']}
      empty={empty}
    >
      {rows.map((r) => (
        <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/leverantorsfakturor/${r.id}`)}>
          <Td className="tabular text-ink-3">{r.entryNr}</Td>
          {showSupplier && (
            <Td className="font-medium">
              <Link href={`/leverantorsfakturor/${r.id}`}>{r.supplierName}</Link>
              {r.description && <div className="max-w-[220px] truncate text-[12px] font-normal text-ink-3">{r.description}</div>}
            </Td>
          )}
          {showCompany && <Td className="text-ink-2">{r.companyName}</Td>}
          <Td className="tabular">
            {r.invoiceNr}
            {r.kind === 'credit_note' && (
              <span className="ml-1.5">
                <Badge>Kredit</Badge>
              </span>
            )}
          </Td>
          <Td className="max-w-[180px] truncate text-ink-2">{r.properties ?? (r.fullyCoded ? 'Bolaget' : <span className="text-warn">Ej konterad</span>)}</Td>
          <Td className="tabular text-ink-2">{r.invoiceDate}</Td>
          <Td className={r.overdue ? 'tabular text-bad' : 'tabular text-ink-2'}>{r.dueDate}</Td>
          <Td className="tabular">{fmtOre(r.totalOre, true)}</Td>
          <Td className="tabular">{r.status === 'cancelled' || r.balanceOre === 0 ? '–' : fmtOre(r.balanceOre, true)}</Td>
          <Td>
            <SupplierInvoiceStatus row={r} />
          </Td>
        </tr>
      ))}
    </Table>
  );
}
