'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormDialog } from '@/components/form';
import { Badge, Button, Card, Input, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { customerFields } from '@/lib/fields';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface CustomerRow {
  id: string;
  companyName: string;
  customerNr: number;
  kind: string;
  name: string;
  nationalId: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  active: boolean;
  activeContracts: number;
  monthlyOre: number;
}

const createFields = [
  ...customerFields,
  {
    key: 'deliveryMethod',
    label: 'Fakturor skickas med',
    type: 'select' as const,
    options: { email: 'E-post', post: 'Brev', e_invoice: 'E-faktura (Peppol)' },
    required: true,
    half: true,
  },
  { key: 'peppolId', label: 'Peppol-id', half: true, hint: 'Krävs för e-faktura' },
];

export default function CustomersPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(
      () => api<CustomerRow[]>(`/customers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(setRows),
      q ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [q, version]);

  const withContract = rows?.filter((r) => r.activeContracts > 0).length ?? 0;
  const monthly = rows?.reduce((s, r) => s + r.monthlyOre, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Hyresgäster"
        description={active ? `Kunder i ${active.companyName}.` : 'Kunder i hela koncernen. Varje bolag har sitt eget kundregister.'}
        actions={can('customer.write') && <Button onClick={() => setCreating(true)}>Ny hyresgäst</Button>}
      />
      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat label="Hyresgäster" value={rows?.length ?? '–'} />
        <Stat label="Med gällande avtal" value={withContract} />
        <Stat label="Hyra per månad" value={fmtOre(monthly)} sub="exkl. moms, gällande avtal" />
      </div>
      <div className="mb-3 flex gap-2">
        <Input className="max-w-sm" placeholder="Sök namn, kundnummer, person-/orgnr eller e-post" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto self-center text-[12px] text-ink-3">{rows?.length ?? 0} hyresgäster</div>
      </div>
      {rows && rows.length === 0 && !q ? (
        <Card className="px-6 py-12 text-center">
          <div className="text-[14px] font-medium">Inga hyresgäster ännu</div>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
            {active ? 'Lägg till privatpersoner och företag som hyr av bolaget.' : 'Välj ett bolag i menyn uppe till vänster för att lägga till hyresgäster.'}
          </p>
        </Card>
      ) : (
        <Table head={['Nr', 'Hyresgäst', ...(active ? [] : ['Bolag']), 'Kontakt', 'Ort', 'Avtal', 'Hyra/mån']} empty="Ingen hyresgäst matchar.">
          {rows?.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/kunder/${r.id}`)}>
              <Td className="tabular text-ink-3">{r.customerNr}</Td>
              <Td className="font-medium">
                <Link href={`/kunder/${r.id}`}>{r.name}</Link>
                {!r.active && (
                  <span className="ml-2">
                    <Badge>Inaktiv</Badge>
                  </span>
                )}
                <div className="text-[12px] font-normal text-ink-3 tabular">
                  {r.kind === 'person' ? 'Privatperson' : 'Företag'}
                  {r.nationalId ? ` · ${r.nationalId}` : ''}
                </div>
              </Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="text-ink-2">
                {r.email ?? ''}
                {r.phone && <div className="text-[12px] text-ink-3">{r.phone}</div>}
              </Td>
              <Td className="text-ink-2">{r.city ?? ''}</Td>
              <Td className="tabular">{r.activeContracts || <span className="text-ink-3">–</span>}</Td>
              <Td className="tabular">{r.monthlyOre ? fmtOre(r.monthlyOre) : '–'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <FormDialog
        open={creating}
        title={`Ny hyresgäst i ${active?.companyName ?? ''}`}
        fields={createFields}
        onClose={() => setCreating(false)}
        submit={async (body) => {
          const c = await api<{ id: string }>('/customers', { method: 'POST', body });
          router.push(`/kunder/${c.id}`);
        }}
        submitLabel="Lägg till"
      />
    </>
  );
}
