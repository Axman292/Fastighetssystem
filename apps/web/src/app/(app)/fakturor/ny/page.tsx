'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { InvoiceForm } from '@/components/invoice-form';
import { ErrorNote, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewInvoicePage() {
  return (
    <Suspense>
      <NewInvoice />
    </Suspense>
  );
}

function NewInvoice() {
  const { active, can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/fakturor" className="hover:text-ink">
          Fakturor
        </Link>{' '}
        / Ny faktura
      </div>
      <PageHeader title="Ny faktura" description="En engångsfaktura, till exempel för en tjänst, en skada eller en avgift. Den sparas som utkast tills du utfärdar den." />
      {!active || !can('invoice.write') ? (
        <ErrorNote message="Välj ett bolag där du får skapa fakturor." />
      ) : (
        <InvoiceForm
          initial={{ customerId: params.get('customerId') ?? undefined, contractId: params.get('contractId') }}
          onSaved={(id) => router.push(`/fakturor/${id}`)}
          onCancel={() => router.back()}
        />
      )}
    </>
  );
}
