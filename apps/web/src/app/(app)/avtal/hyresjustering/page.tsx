'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, PageHeader, Table, Td, formatDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtOre, formatDate } from '@/lib/format';
import { changeLabel, RentAdjustment } from '@/lib/rent-adjustments';
import { useSession } from '@/lib/session';

export default function RentAdjustmentsPage() {
  const { active, can, version } = useSession();
  const [rows, setRows] = useState<RentAdjustment[] | null>(null);

  useEffect(() => {
    api<RentAdjustment[]>('/rent-adjustments').then(setRows);
  }, [version]);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        / Hyresjustering
      </div>
      <PageHeader
        title="Hyresjustering"
        description="Ändra hyran för många avtal och objekt på en gång, till exempel årets hyreshöjning för bostäderna. Du ser alltid före och efter innan något sparas."
        actions={
          active &&
          can('contract.write') && (
            <Link href="/avtal/hyresjustering/ny">
              <Button>Ny hyresjustering</Button>
            </Link>
          )
        }
      />
      {!active && <p className="mb-3 text-[12px] text-ink-3">Välj ett bolag för att göra en ny hyresjustering. Listan visar hela koncernen.</p>}
      <Table
        head={['Nr', 'Namn', 'Gäller från', 'Ändring', 'Avtalsrader', 'Hyra per månad', 'Gjord', 'Status']}
        empty="Inga hyresjusteringar är gjorda ännu."
      >
        {rows?.map((r) => (
          <tr key={r.id} className="hover:bg-subtle/50">
            <Td className="tabular text-ink-2">{r.adjustmentNr}</Td>
            <Td className="font-medium">
              <Link href={`/avtal/hyresjustering/${r.id}`} className="hover:underline">
                {r.name}
              </Link>
              {!active && <div className="text-[12px] font-normal text-ink-3">{r.companyName}</div>}
            </Td>
            <Td className="tabular">{formatDate(r.effectiveDate)}</Td>
            <Td className="tabular">{changeLabel(r)}</Td>
            <Td className="tabular">
              {r.lineCount}
              {r.objectCount > 0 && <span className="text-ink-3"> · {r.objectCount} objekt</span>}
            </Td>
            <Td className="tabular">
              {fmtOre(r.beforeOre)} → <span className="font-medium">{fmtOre(r.afterOre)}</span>
            </Td>
            <Td className="text-[12px] text-ink-2">
              {formatDateTime(r.createdAt)}
              {r.createdByName && <div className="text-ink-3">{r.createdByName}</div>}
            </Td>
            <Td>{r.status === 'applied' ? <Badge tone="good">Genomförd</Badge> : <Badge>Ångrad</Badge>}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
