'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SectionHeader } from './edit-form';
import { FieldDef, FormDialog } from './form';
import { InvoiceRow, InvoiceTable } from './invoice-table';
import { Badge, Button, Table, Td } from './ui';
import { api } from '@/lib/api';
import { articleDefaults, articleOptions, useArticles } from '@/lib/articles';
import { VAT_LABEL, fmtMonth, fmtOre, todayIso } from '@/lib/format';

interface Charge {
  id: string;
  article: string;
  description: string;
  amountOre: number;
  vatRateBp: number;
  objectNr: string | null;
  billFrom: string;
  invoiceId: string | null;
  invoiceNr: number | null;
}

/** Extra debiteringar och fakturor på ett avtal. */
export function ContractBilling({
  contract,
  canWrite,
  onChange,
}: {
  contract: { id: string; companyId: string; customerId: string; type: string; status: string; objects: { objectId: string; objectNr: string }[] };
  canWrite: boolean;
  onChange: () => void;
}) {
  const [charges, setCharges] = useState<Charge[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [open, setOpen] = useState(false);
  const opts = { companyId: contract.companyId };
  const { articles } = useArticles();

  const load = useCallback(() => {
    api<Charge[]>(`/contracts/${contract.id}/charges`, opts).then(setCharges);
    api<InvoiceRow[]>(`/invoices?contractId=${contract.id}`, opts).then(setInvoices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id]);
  useEffect(load, [load]);

  const residential = contract.type === 'residential';
  const fields: FieldDef[] = [
    {
      key: 'article',
      label: 'Artikel',
      type: 'select',
      options: articleOptions(articles, contract.companyId),
      required: true,
      half: true,
      onSelect: (code, values) => {
        const d = articleDefaults(articles, contract.companyId, code, values, { residential });
        // Avinstexten fylls bara i om den är tom
        if (typeof values.description === 'string' && values.description.trim()) delete d.description;
        return d;
      },
    },
    { key: 'description', label: 'Text på avin', required: true, half: true, placeholder: 'Till exempel Extra nyckel' },
    { key: 'amount', label: 'Belopp (kr, exkl. moms)', type: 'kronor', required: true, half: true, hint: 'Negativt för avdrag' },
    ...(residential ? [] : [{ key: 'vatRateBp', label: 'Moms', type: 'select' as const, options: VAT_LABEL, required: true, half: true }]),
    { key: 'billFrom', label: 'Med avin för månaden', type: 'date', required: true, half: true, hint: 'Följer med första avisering från denna månad' },
    ...(contract.objects.length > 1
      ? [{ key: 'objectId', label: 'Objekt', type: 'select' as const, options: Object.fromEntries(contract.objects.map((o) => [o.objectId, o.objectNr])), half: true }]
      : []),
  ];
  const active = contract.status === 'active' || contract.status === 'terminated';

  return (
    <>
      <section className="mt-10">
        <SectionHeader
          title="Extra debiteringar"
          description="Engångsbelopp som följer med nästa hyresavi, till exempel nycklar, skador eller avgifter."
          actions={
            canWrite &&
            active && (
              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                Ny debitering
              </Button>
            )
          }
        />
        <Table head={['Text', 'Med avin för', 'Moms', 'Belopp', 'Status', '']} empty="Inga extra debiteringar.">
          {charges.map((c) => (
            <tr key={c.id}>
              <Td>
                {c.objectNr && <span className="mr-2 text-ink-3">{c.objectNr}</span>}
                {c.description}
              </Td>
              <Td className="text-ink-2" sortValue={c.billFrom}>
                {fmtMonth(c.billFrom)}
              </Td>
              <Td className="text-ink-2">{VAT_LABEL[String(c.vatRateBp)]}</Td>
              <Td className="tabular">{fmtOre(c.amountOre, true)}</Td>
              <Td>
                {c.invoiceId ? (
                  <Link href={`/fakturor/${c.invoiceId}`}>
                    <Badge tone="good">Fakturerad på {c.invoiceNr}</Badge>
                  </Link>
                ) : (
                  <Badge tone="accent">Väntar på avisering</Badge>
                )}
              </Td>
              <Td className="text-right">
                {canWrite && !c.invoiceId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-ink-3 hover:text-bad"
                    onClick={async () => {
                      await api(`/contracts/${contract.id}/charges/${c.id}`, { method: 'DELETE', ...opts });
                      load();
                    }}
                  >
                    Ta bort
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="mt-10">
        <SectionHeader
          title="Avier och fakturor"
          actions={
            canWrite && (
              <Link href={`/fakturor/ny?customerId=${contract.customerId}&contractId=${contract.id}`}>
                <Button size="sm" variant="secondary">
                  Ny faktura
                </Button>
              </Link>
            )
          }
        />
        <InvoiceTable rows={invoices} showCustomer={false} empty="Avtalet har inte aviserats ännu." />
      </section>

      <FormDialog
        open={open}
        title="Ny extra debitering"
        fields={fields}
        initial={{ article: 'fee', vatRateBp: residential ? 0 : 2500, billFrom: todayIso().slice(0, 8) + '01' }}
        onClose={() => setOpen(false)}
        submit={async (body) => {
          await api(`/contracts/${contract.id}/charges`, { method: 'POST', body: { ...body, vatRateBp: Number(body.vatRateBp ?? 0) }, ...opts });
          setOpen(false);
          load();
          onChange();
        }}
      />
    </>
  );
}
