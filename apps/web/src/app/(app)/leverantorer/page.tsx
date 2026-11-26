'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormDialog } from '@/components/form';
import { Badge, Button, Card, Input, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Supplier, supplierFields } from '@/lib/suppliers';

export default function SuppliersPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => api<Supplier[]>(`/suppliers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, version]);

  const unpaid = rows?.reduce((s, r) => s + (r.unpaidOre ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Leverantörer"
        description={active ? `Leverantörsregister för ${active.companyName}.` : 'Leverantörer i hela koncernen. Varje bolag har sitt eget register.'}
        actions={
          <>
            <Link href="/leverantorsfakturor">
              <Button variant="secondary">Leverantörsfakturor</Button>
            </Link>
            {can('supplier.write') && <Button onClick={() => setCreating(true)}>Ny leverantör</Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat label="Leverantörer" value={rows?.filter((r) => r.active).length ?? '–'} sub="aktiva" />
        <Stat label="Obetalt till leverantörer" value={fmtOre(unpaid)} sub="registrerade och attesterade fakturor" />
        <Stat label="Med fakturor" value={rows?.filter((r) => (r.invoiceCount ?? 0) > 0).length ?? '–'} />
      </div>
      <div className="mb-3 flex gap-2">
        <Input className="max-w-sm" placeholder="Sök namn, nummer, organisationsnummer eller bankgiro" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto self-center text-[12px] text-ink-3">{rows?.length ?? 0} leverantörer</div>
      </div>
      {rows && rows.length === 0 && !q ? (
        <Card className="px-6 py-12 text-center">
          <div className="text-[14px] font-medium">Inga leverantörer ännu</div>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
            {active ? 'Lägg till de företag som skickar fakturor till bolaget, till exempel energibolag, fastighetsskötare och hantverkare.' : 'Välj ett bolag i menyn uppe till vänster för att lägga till leverantörer.'}
          </p>
        </Card>
      ) : (
        <Table head={['Nr', 'Leverantör', ...(active ? [] : ['Bolag']), 'Bankgiro', 'Villkor', 'Fakturor', 'Senaste', 'Obetalt']} empty="Ingen leverantör matchar.">
          {rows?.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/leverantorer/${r.id}`)}>
              <Td className="tabular text-ink-3">{r.supplierNr}</Td>
              <Td className="font-medium">
                <Link href={`/leverantorer/${r.id}`}>{r.name}</Link>
                {!r.active && (
                  <span className="ml-2">
                    <Badge>Inaktiv</Badge>
                  </span>
                )}
                {r.orgNr && <div className="text-[12px] font-normal tabular text-ink-3">{r.orgNr}</div>}
              </Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="tabular text-ink-2">{r.bankgiro ?? r.plusgiro ?? '–'}</Td>
              <Td className="tabular text-ink-2">{r.paymentTermsDays} dagar</Td>
              <Td className="tabular">{r.invoiceCount || <span className="text-ink-3">–</span>}</Td>
              <Td className="tabular text-ink-2">{r.lastInvoiceDate ?? '–'}</Td>
              <Td className="tabular">{r.unpaidOre ? fmtOre(r.unpaidOre) : '–'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <FormDialog
        open={creating}
        title={`Ny leverantör i ${active?.companyName ?? ''}`}
        fields={supplierFields}
        onClose={() => setCreating(false)}
        submit={async (body) => {
          const s = await api<{ id: string }>('/suppliers', { method: 'POST', body: { ...body, paymentTermsDays: body.paymentTermsDays ?? undefined } });
          router.push(`/leverantorer/${s.id}`);
        }}
        submitLabel="Lägg till"
      />
    </>
  );
}
