'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { FormFields, fromRow, toBody } from '@/components/form';
import { SupplierInvoiceTable } from '@/components/supplier-invoice-table';
import { Badge, Button, Card, ErrorNote, PageHeader, Stat, Tabs } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Supplier, SupplierInvoiceRow, supplierFields } from '@/lib/suppliers';

type Tab = 'fakturor' | 'uppgifter';

export default function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const [s, setS] = useState<Supplier | null>(null);
  const [invoices, setInvoices] = useState<SupplierInvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('fakturor');

  const load = useCallback(() => {
    api<Supplier>(`/suppliers/${id}`).then(setS).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (s) api<SupplierInvoiceRow[]>(`/supplier-invoices?supplierId=${id}`, { companyId: s.companyId }).then(setInvoices);
  }, [id, s]);

  if (error) return <ErrorNote message={error} />;
  if (!s) return null;
  const editable = can('supplier.write', s.companyId);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/leverantorer" className="hover:text-ink">
          Leverantörer
        </Link>{' '}
        / {s.name}
      </div>
      <PageHeader
        title={s.name}
        description={[`Leverantör ${s.supplierNr}`, s.orgNr, s.bankgiro && `bankgiro ${s.bankgiro}`, s.companyName].filter(Boolean).join(' · ')}
        actions={
          can('supplier_invoice.write', s.companyId) && (
            <Link href={`/leverantorsfakturor/ny?supplierId=${s.id}`}>
              <Button>Registrera faktura</Button>
            </Link>
          )
        }
      />
      {!s.active && (
        <div className="mb-4">
          <Badge>Inaktiv</Badge>
        </div>
      )}
      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Obetalt" value={fmtOre(s.unpaidOre)} sub={`${s.invoiceCount ?? 0} fakturor totalt`} />
        <Stat label="Förfallet" value={fmtOre(s.overdueOre)} />
        <Stat label="Inköp i år" value={fmtOre(s.thisYearOre)} sub="inkl. moms" />
        <Stat label="Inköp förra året" value={fmtOre(s.lastYearOre)} sub="inkl. moms" />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'fakturor', label: 'Fakturor', count: invoices?.length },
          { key: 'uppgifter', label: 'Uppgifter' },
        ]}
      />
      {tab === 'fakturor' && <SupplierInvoiceTable rows={invoices ?? []} showSupplier={false} empty={invoices ? 'Inga fakturor från leverantören.' : 'Laddar…'} />}
      {tab === 'uppgifter' && <SupplierForm supplier={s} editable={editable} onSaved={load} />}
    </>
  );
}

function SupplierForm({ supplier, editable, onSaved }: { supplier: Supplier; editable: boolean; onSaved: () => void }) {
  const fields = [...supplierFields, { key: 'active', label: 'Aktiv', type: 'checkbox' as const }];
  const [values, setValues] = useState(() => fromRow(fields, supplier as unknown as Record<string, unknown>));
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <Card className="p-5">
      <FormFields
        fields={fields}
        values={values}
        onChange={(v) => {
          setSaved(false);
          setValues(v);
        }}
        error={error}
        disabled={!editable}
      />
      {editable && (
        <div className="mt-5 flex items-center justify-end gap-3">
          {saved && <span className="text-[12px] text-good">Sparat</span>}
          {error && !error.fields.length && <ErrorNote message={error.message} />}
          <Button
            onClick={async () => {
              setError(null);
              try {
                const body = toBody(fields, values);
                await api(`/suppliers/${supplier.id}`, { method: 'PATCH', body: { ...body, paymentTermsDays: body.paymentTermsDays ?? undefined }, companyId: supplier.companyId });
                setSaved(true);
                onSaved();
              } catch (e) {
                setError(e as ApiError);
              }
            }}
          >
            Spara
          </Button>
        </div>
      )}
    </Card>
  );
}
