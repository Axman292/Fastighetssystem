'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormDialog } from '@/components/form';
import { Button, Card, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { propertyFields } from '@/lib/fields';
import { CATEGORY_LABEL, fmtM2, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface PropertyListRow {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  designation: string;
  city: string | null;
  category: string;
  constructionYear: number | null;
  objectCount: number;
  objectAreaM2: number;
  monthlyRentOre: number;
}

export default function PropertiesPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<PropertyListRow[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<PropertyListRow[]>('/properties').then(setRows);
  }, [version]);

  const totals = (rows ?? []).reduce(
    (t, r) => ({ objects: t.objects + r.objectCount, area: t.area + r.objectAreaM2, rent: t.rent + r.monthlyRentOre }),
    { objects: 0, area: 0, rent: 0 },
  );
  const showCompany = !active;

  return (
    <>
      <PageHeader
        title="Fastigheter"
        description={active ? `Fastigheter som ägs av ${active.companyName}.` : 'Alla fastigheter i koncernen.'}
        actions={
          <>
            {can('property.import') && (
              <Link href="/fastigheter/import">
                <Button variant="secondary">Importera från Excel</Button>
              </Link>
            )}
            {can('property.write') && <Button onClick={() => setCreating(true)}>Ny fastighet</Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Fastigheter" value={rows?.length ?? '–'} />
        <Stat label="Uthyrningsbara objekt" value={totals.objects} />
        <Stat label="Uthyrningsbar area" value={fmtM2(totals.area)} />
        <Stat label="Hyresvärde per år" value={fmtOre(totals.rent * 12)} sub={`${fmtOre(totals.rent)} per månad`} />
      </div>
      {rows && rows.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <div className="text-[14px] font-medium">Inga fastigheter ännu</div>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
            {active
              ? 'Lägg till en fastighet, eller läs in alla fastigheter och objekt på en gång från en Excel-fil.'
              : 'Välj ett bolag i menyn uppe till vänster för att lägga till fastigheter.'}
          </p>
        </Card>
      ) : (
        <Table head={['Fastighet', 'Beteckning', ...(showCompany ? ['Bolag'] : []), 'Kategori', 'Objekt', 'Area', 'Hyresvärde/mån']}>
          {rows?.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/fastigheter/${r.id}`)}>
              <Td className="font-medium">
                <Link href={`/fastigheter/${r.id}`}>{r.name}</Link>
                {r.city && <div className="text-[12px] font-normal text-ink-3">{r.city}</div>}
              </Td>
              <Td className="text-ink-2">{r.designation}</Td>
              {showCompany && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="text-ink-2">{CATEGORY_LABEL[r.category]}</Td>
              <Td className="tabular">{r.objectCount}</Td>
              <Td className="tabular">{fmtM2(r.objectAreaM2)}</Td>
              <Td className="tabular">{fmtOre(r.monthlyRentOre)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <FormDialog
        open={creating}
        title={`Ny fastighet i ${active?.companyName ?? ''}`}
        fields={propertyFields}
        onClose={() => setCreating(false)}
        submit={async (body) => {
          const p = await api<{ id: string }>('/properties', { method: 'POST', body });
          router.push(`/fastigheter/${p.id}`);
        }}
        submitLabel="Skapa fastighet"
      />
    </>
  );
}
