'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Table, Td } from './ui';
import { INVOICE_KIND_LABEL, INVOICE_STATE, fmtOre, fmtPeriod } from '@/lib/format';

export interface InvoiceRow {
  id: string;
  companyId: string;
  companyName: string;
  kind: string;
  status: string;
  state: string;
  invoiceNr: number | null;
  ocr: string | null;
  invoiceDate: string;
  dueDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  customerId: string;
  customerName: string;
  customerNr: number;
  contractId: string | null;
  contractNr: number | null;
  billingRunId: string | null;
  netOre: number;
  vatOre: number;
  totalOre: number;
  paidOre: number;
  creditedOre: number;
  balanceOre: number;
  creditsInvoiceId: string | null;
  deliveryMethod: string;
  deliveryStatus: string | null;
  objects: string;
}

export function InvoiceStateBadge({ state }: { state: string }) {
  const s = INVOICE_STATE[state] ?? { label: state, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Fakturalista. Kolumner för kund och bolag kan döljas där de är givna. */
export function InvoiceTable({
  rows,
  showCustomer = true,
  showCompany = false,
  empty = 'Inga fakturor.',
}: {
  rows: InvoiceRow[];
  showCustomer?: boolean;
  showCompany?: boolean;
  empty?: string;
}) {
  const router = useRouter();
  return (
    <Table
      head={['Nr', 'Typ', ...(showCustomer ? ['Kund'] : []), ...(showCompany ? ['Bolag'] : []), 'Period', 'Förfaller', 'Belopp', 'Kvar att betala', 'Status']}
      empty={empty}
    >
      {rows.map((r) => (
        <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/fakturor/${r.id}`)}>
          <Td className="font-medium tabular">
            <Link href={`/fakturor/${r.id}`}>{r.invoiceNr ?? 'Utkast'}</Link>
          </Td>
          <Td className="text-ink-2">{INVOICE_KIND_LABEL[r.kind]}</Td>
          {showCustomer && (
            <Td>
              <div className="max-w-56 truncate">{r.customerName}</div>
              {r.objects && <div className="max-w-56 truncate text-[12px] text-ink-3">{r.objects}</div>}
            </Td>
          )}
          {showCompany && <Td className="text-ink-2">{r.companyName}</Td>}
          <Td className="text-ink-2">{fmtPeriod(r.periodFrom, r.periodTo) || r.invoiceDate}</Td>
          <Td className="tabular text-ink-2">{r.kind === 'credit_note' ? '–' : r.dueDate}</Td>
          <Td className="tabular">{fmtOre(r.totalOre, true)}</Td>
          <Td className="tabular">{r.kind === 'credit_note' || r.status === 'draft' ? '–' : fmtOre(r.balanceOre, true)}</Td>
          <Td>
            <InvoiceStateBadge state={r.state} />
          </Td>
        </tr>
      ))}
    </Table>
  );
}
