'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { EditForm, SectionHeader } from '@/components/edit-form';
import { FormDialog } from '@/components/form';
import { Badge, Button, ErrorNote, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { contactFields, customerFields, customerInvoiceFields } from '@/lib/fields';
import { CONTRACT_TYPE_LABEL, DELIVERY_LABEL, contractStatus, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Contact {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

interface CustomerDetail {
  id: string;
  companyId: string;
  companyName: string;
  customerNr: number;
  kind: string;
  name: string;
  nationalId: string | null;
  email: string | null;
  deliveryMethod: string;
  paymentTermsDays: number;
  active: boolean;
  contacts: Contact[];
  contracts: {
    id: string;
    contractNr: number;
    type: string;
    status: string;
    startDate: string;
    endDate: string | null;
    monthlyOre: number;
    objects: string;
  }[];
  [k: string]: unknown;
}

const allFields = [...customerFields, ...customerInvoiceFields];

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [c, setC] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact | 'new' | null>(null);
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(() => {
    api<CustomerDetail>(`/customers/${id}`).then(setC).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!c) return null;
  const editable = can('customer.write', c.companyId);
  const live = c.contracts.filter((k) => ['Aktivt', 'Uppsagt', 'Kommande'].includes(contractStatus(k).label));
  const monthly = live.reduce((s, k) => s + k.monthlyOre, 0);
  const opts = { companyId: c.companyId };

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/kunder" className="hover:text-ink">
          Hyresgäster
        </Link>{' '}
        / {c.name}
      </div>
      <PageHeader
        title={c.name}
        description={`Kund ${c.customerNr} · ${c.kind === 'person' ? 'Privatperson' : 'Företag'}${c.nationalId ? ` · ${c.nationalId}` : ''} · ${c.companyName}`}
        actions={
          <>
            {!c.active && <Badge>Inaktiv</Badge>}
            {can('contract.write', c.companyId) && (
              <Button onClick={() => router.push(`/avtal/nytt?customerId=${c.id}`)}>Nytt avtal</Button>
            )}
          </>
        }
      />
      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Gällande avtal" value={live.length} />
        <Stat label="Hyra per månad" value={fmtOre(monthly)} sub="exkl. moms" />
        <Stat label="Fakturor skickas med" value={<span className="text-[16px]">{DELIVERY_LABEL[c.deliveryMethod]}</span>} sub={`${c.paymentTermsDays} dagars betalningsvillkor`} />
        <Stat label="Obetalt" value={<span className="text-[16px] text-ink-3">Fas 5</span>} sub="Reskontra kommer med ekonomin" />
      </div>

      <section className="mb-10">
        <SectionHeader title="Avtal" />
        <Table head={['Avtal', 'Typ', 'Objekt', 'Period', 'Hyra/mån', 'Status']} empty="Hyresgästen har inga avtal.">
          {c.contracts.map((k) => {
            const s = contractStatus(k);
            return (
              <tr key={k.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/avtal/${k.id}`)}>
                <Td className="font-medium tabular">
                  <Link href={`/avtal/${k.id}`}>{k.contractNr}</Link>
                </Td>
                <Td className="text-ink-2">{CONTRACT_TYPE_LABEL[k.type]}</Td>
                <Td className="text-ink-2">{k.objects || '–'}</Td>
                <Td className="tabular text-ink-2">
                  {k.startDate} – {k.endDate ?? 'tills vidare'}
                </Td>
                <Td className="tabular">{fmtOre(k.monthlyOre)}</Td>
                <Td>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </Td>
              </tr>
            );
          })}
        </Table>
      </section>

      <div className="grid grid-cols-[3fr_2fr] gap-6">
        <section>
          <SectionHeader title="Uppgifter" />
          <EditForm
            key={formKey}
            fields={allFields}
            row={c}
            editable={editable}
            save={async (body) => {
              await api(`/customers/${id}`, { method: 'PATCH', body, ...opts });
              load();
            }}
          />
        </section>
        <section>
          <SectionHeader
            title="Kontaktpersoner"
            actions={
              editable && (
                <Button size="sm" variant="secondary" onClick={() => setContact('new')}>
                  Lägg till
                </Button>
              )
            }
          />
          <Table head={['Namn', 'Kontakt', '']} empty="Inga kontaktpersoner.">
            {c.contacts.map((p) => (
              <tr key={p.id}>
                <Td>
                  <div className="font-medium">{p.name}</div>
                  {p.role && <div className="text-[12px] text-ink-3">{p.role}</div>}
                </Td>
                <Td className="text-ink-2">
                  {p.email}
                  {p.phone && <div className="text-[12px] text-ink-3">{p.phone}</div>}
                </Td>
                <Td className="text-right">
                  {editable && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setContact(p)}>
                        Ändra
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-bad"
                        onClick={async () => {
                          await api(`/customers/${id}/contacts/${p.id}`, { method: 'DELETE', ...opts });
                          load();
                        }}
                      >
                        Ta bort
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      </div>

      <FormDialog
        open={contact !== null}
        title={contact === 'new' ? 'Ny kontaktperson' : 'Ändra kontaktperson'}
        fields={contactFields}
        initial={contact === 'new' ? null : (contact as unknown as Record<string, unknown> | null)}
        onClose={() => setContact(null)}
        submit={async (body) => {
          if (contact === 'new') await api(`/customers/${id}/contacts`, { method: 'POST', body, ...opts });
          else if (contact) await api(`/customers/${id}/contacts/${contact.id}`, { method: 'PATCH', body, ...opts });
          setContact(null);
          setFormKey((k) => k + 1);
          load();
        }}
      />
    </>
  );
}
