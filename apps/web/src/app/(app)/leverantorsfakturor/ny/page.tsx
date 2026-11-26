'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SupplierInvoiceForm } from '@/components/supplier-invoice-form';
import { Card, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewSupplierInvoicePage() {
  return (
    <Suspense>
      <NewInvoice />
    </Suspense>
  );
}

function NewInvoice() {
  const router = useRouter();
  const search = useSearchParams();
  const { active, can } = useSession();
  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/leverantorsfakturor" className="hover:text-ink">
          Leverantörsfakturor
        </Link>{' '}
        / Registrera
      </div>
      <PageHeader title="Registrera leverantörsfaktura" description="Fyll i uppgifterna från fakturan och kontera den. Fakturan kan bifogas som PDF när den är registrerad." />
      {!active || !can('supplier_invoice.write') ? (
        <Card className="px-6 py-10 text-center text-[13px] text-ink-2">Välj ett bolag där du får registrera fakturor.</Card>
      ) : (
        <SupplierInvoiceForm
          key={active.companyId}
          initialSupplierId={search.get('supplierId') ?? undefined}
          onSaved={(id) => router.push(`/leverantorsfakturor/${id}`)}
          onCancel={() => router.back()}
        />
      )}
    </>
  );
}
