'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, use, useCallback, useEffect, useRef, useState } from 'react';
import { SupplierInvoiceForm } from '@/components/supplier-invoice-form';
import { SupplierInvoiceStatus } from '@/components/supplier-invoice-table';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { SUPPLIER_PAYMENT_METHOD_LABEL, fmtOre, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';
import { EVENT_LABEL, SupplierInvoiceDetail } from '@/lib/suppliers';

export default function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { can } = useSession();
  const [inv, setInv] = useState<SupplierInvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<SupplierInvoiceDetail>(`/supplier-invoices/${id}`).then(setInv).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (!inv) return error ? <ErrorNote message={error} /> : null;
  const co = inv.companyId;
  const act = async (path: string, body: unknown = {}) => {
    setError(null);
    try {
      await api(`/supplier-invoices/${id}/${path}`, { method: 'POST', body, companyId: co });
      load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (editing) {
    return (
      <>
        <PageHeader title={`Ändra faktura ${inv.invoiceNr}`} description={`${inv.supplierName} · löpnummer ${inv.entryNr}`} />
        <SupplierInvoiceForm
          initial={inv}
          onSaved={() => {
            setEditing(false);
            load();
          }}
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }

  const registered = inv.status === 'registered';
  const credit = inv.kind === 'credit_note';

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/leverantorsfakturor" className="hover:text-ink">
          Leverantörsfakturor
        </Link>{' '}
        / {inv.entryNr}
      </div>
      <PageHeader
        title={`${credit ? 'Kreditfaktura' : 'Faktura'} ${inv.invoiceNr} från ${inv.supplierName}`}
        description={`Löpnummer ${inv.entryNr} · ${inv.companyName} · registrerad ${formatDateTime(inv.createdAt)}${inv.createdByName ? ` av ${inv.createdByName}` : ''}`}
        actions={
          <>
            {registered && can('supplier_invoice.write', co) && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Ändra
              </Button>
            )}
            {registered && can('supplier_invoice.approve', co) && <Button onClick={() => act('approve')}>Attestera</Button>}
            {inv.status === 'approved' && can('supplier_invoice.approve', co) && !inv.paidOre && (
              <Button variant="secondary" onClick={() => act('unapprove')}>
                Ta bort attest
              </Button>
            )}
            {inv.status === 'approved' && can('supplier_invoice.pay', co) && <Button onClick={() => setPaying(true)}>Registrera betalning</Button>}
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SupplierInvoiceStatus row={inv} />
        {!inv.fullyCoded && inv.status !== 'cancelled' && <Badge tone="warn">Konteringen stämmer inte med beloppet</Badge>}
        {inv.approvedAt && (
          <span className="text-[12px] text-ink-3">
            Attesterad {formatDateTime(inv.approvedAt)}
            {inv.approvedByName ? ` av ${inv.approvedByName}` : ''}
          </span>
        )}
        {inv.cancelReason && <span className="text-[12px] text-ink-3">Makulerad: {inv.cancelReason}</span>}
      </div>
      <ErrorNote message={error} />

      <div className="mb-8 mt-4 grid grid-cols-3 gap-4">
        <Card className="col-span-2 grid grid-cols-3 gap-x-6 gap-y-3 p-5 text-[13px]">
          <Info label="Fakturadatum" value={inv.invoiceDate} />
          <Info label="Förfallodatum" value={<span className={inv.overdue ? 'text-bad' : ''}>{inv.dueDate}</span>} />
          <Info label="OCR eller meddelande" value={inv.ocr ?? '–'} />
          <Info label="Betalas till" value={inv.supplierBankgiro ? `Bankgiro ${inv.supplierBankgiro}` : inv.supplierPlusgiro ? `Plusgiro ${inv.supplierPlusgiro}` : '–'} />
          <Info label="Leverantör" value={<Link className="text-accent hover:underline" href={`/leverantorer/${inv.supplierId}`}>{inv.supplierName}</Link>} />
          <Info label="Beskrivning" value={inv.description ?? '–'} />
          <Info label="Ärende" value={<LinkedWorkOrders supplierInvoiceId={inv.id} />} />
        </Card>
        <Card className="space-y-1.5 p-5 text-[13px]">
          <Row label="Belopp exkl. moms" value={fmtOre(inv.netOre, true)} />
          <Row label="Moms" value={fmtOre(inv.vatOre, true)} />
          {inv.roundingOre !== 0 && <Row label="Öresavrundning" value={fmtOre(inv.roundingOre, true)} />}
          <Row label="Att betala" value={fmtOre(inv.totalOre, true)} strong />
          {inv.paidOre !== 0 && <Row label="Betalt" value={fmtOre(inv.paidOre, true)} />}
          {inv.status !== 'cancelled' && <Row label="Kvar att betala" value={fmtOre(inv.balanceOre, true)} strong />}
        </Card>
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-end justify-between">
          <h2 className="text-[14px] font-semibold">Fakturan</h2>
          {inv.status !== 'cancelled' && can('supplier_invoice.write', co) && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const fd = new FormData();
                  fd.append('file', f);
                  const res = await fetch(`/api/supplier-invoices/${id}/document`, { method: 'POST', body: fd, headers: { 'x-company-id': co } });
                  if (!res.ok) setError((await res.json().catch(() => ({}))).message ?? 'Filen kunde inte bifogas');
                  e.target.value = '';
                  load();
                }}
              />
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                {inv.documentName ? 'Byt fil' : 'Bifoga PDF'}
              </Button>
            </>
          )}
        </div>
        <Card className="px-5 py-4 text-[13px]">
          {inv.documentName ? (
            <a className="text-accent hover:underline" href={`/api/supplier-invoices/${id}/document`} target="_blank" rel="noreferrer">
              {inv.documentName}
            </a>
          ) : (
            <span className="text-ink-3">Ingen fil bifogad. Spara fakturan som PDF eller bild här, så finns underlaget kvar i sju år.</span>
          )}
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-[14px] font-semibold">Kontering</h2>
        <Table head={['Konto', 'Fastighet', 'Objekt', 'Kostnadsställe', 'Text', 'Period', 'Netto', 'Moms', '']} empty="Fakturan är inte konterad.">
          {inv.lines.map((l) => (
            <tr key={l.id}>
              <Td className="tabular">
                <span className="font-medium">{l.accountNumber}</span> <span className="text-ink-2">{l.accountName}</span>
              </Td>
              <Td>{l.propertyId ? <Link className="hover:underline" href={`/fastigheter/${l.propertyId}`}>{l.propertyName}</Link> : <span className="text-ink-3">Bolaget</span>}</Td>
              <Td className="tabular text-ink-2">{l.objectNr ?? '–'}</Td>
              <Td className="text-ink-2">{l.costCenter ?? '–'}</Td>
              <Td className="text-ink-2">{l.description ?? ''}</Td>
              <Td className="tabular text-ink-2">{l.periodFrom ? `${l.periodFrom} – ${l.periodTo}` : '–'}</Td>
              <Td className="tabular">{fmtOre(l.netOre, true)}</Td>
              <Td className="tabular">{fmtOre(l.vatOre, true)}</Td>
              <Td>{!l.vatDeductible && l.vatOre !== 0 && <Badge>Ej avdragsgill</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </section>

      {inv.verification.length > 0 && inv.status !== 'cancelled' && (
        <section className="mb-8">
          <h2 className="mb-1 text-[14px] font-semibold">Bokföringsunderlag</h2>
          <p className="mb-2 text-[12px] text-ink-3">Så här bokförs fakturan när den förs över till bokföringen. Inget skickas till Hogia ännu.</p>
          <Table head={['Konto', 'Fastighet', 'Kostnadsställe', 'Debet', 'Kredit']}>
            {inv.verification.map((v, i) => (
              <tr key={i}>
                <Td className="tabular">
                  <span className="font-medium">{v.account}</span> <span className="text-ink-2">{v.accountName}</span>
                </Td>
                <Td className="text-ink-2">{v.propertyName ?? ''}</Td>
                <Td className="text-ink-2">{v.costCenter ?? ''}</Td>
                <Td className="tabular">{v.debitOre ? fmtOre(v.debitOre, true) : ''}</Td>
                <Td className="tabular">{v.creditOre ? fmtOre(v.creditOre, true) : ''}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {inv.payments.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-[14px] font-semibold">Betalningar</h2>
          <Table head={['Betaldag', 'Belopp', 'Sätt', 'Referens', 'Registrerad av', '']}>
            {inv.payments.map((p) => (
              <tr key={p.id}>
                <Td className="tabular">{p.paidDate}</Td>
                <Td className="tabular">{fmtOre(p.amountOre, true)}</Td>
                <Td className="text-ink-2">{SUPPLIER_PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                <Td className="text-ink-2">{p.reference ?? ''}</Td>
                <Td className="text-ink-2">{p.createdByName ?? ''}</Td>
                <Td className="text-right">
                  {can('supplier_invoice.pay', co) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!window.confirm('Ta bort betalningen?')) return;
                        await api(`/supplier-invoices/${id}/payments/${p.id}`, { method: 'DELETE', companyId: co }).catch((e: ApiError) => setError(e.message));
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
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-[14px] font-semibold">Historik</h2>
        <Card className="divide-y divide-line">
          {inv.events.map((e, i) => (
            <div key={i} className="flex gap-4 px-5 py-2.5 text-[13px]">
              <span className="w-36 shrink-0 tabular text-ink-3">{formatDateTime(e.createdAt)}</span>
              <span className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>
              {e.note && <span className="text-ink-2">{e.note}</span>}
              <span className="ml-auto text-ink-3">{e.userName}</span>
            </div>
          ))}
        </Card>
      </section>

      {inv.status !== 'cancelled' && inv.status !== 'paid' && can('supplier_invoice.write', co) && (
        <div className="flex gap-2">
          {!inv.paidOre && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Makulera
            </Button>
          )}
          {registered && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (!window.confirm('Ta bort fakturan helt? Gör bara detta om den registrerats av misstag.')) return;
                await api(`/supplier-invoices/${id}`, { method: 'DELETE', companyId: co });
                router.push('/leverantorsfakturor');
              }}
            >
              Ta bort
            </Button>
          )}
        </div>
      )}

      <PayDialog open={paying} inv={inv} onClose={() => setPaying(false)} onDone={() => { setPaying(false); load(); }} />
      <CancelDialog open={cancelling} inv={inv} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); load(); }} />
    </>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between font-semibold' : 'flex justify-between text-ink-2'}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}

function PayDialog({ open, inv, onClose, onDone }: { open: boolean; inv: SupplierInvoiceDetail; onClose: () => void; onDone: () => void }) {
  const [paidDate, setPaidDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(inv.supplierBankgiro ? 'bankgiro' : inv.supplierPlusgiro ? 'plusgiro' : 'bank_transfer');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const n = amount.trim() ? Number(amount.replace(/\s/g, '').replace(',', '.')) * (inv.kind === 'credit_note' ? -1 : 1) : undefined;
      await api(`/supplier-invoices/${inv.id}/payments`, { method: 'POST', body: { paidDate, amount: n, method, reference: reference || null }, companyId: inv.companyId });
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Registrera betalning">
      <form onSubmit={submit} className="space-y-3.5">
        <Field label="Betaldag">
          <Input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} required />
        </Field>
        <Field label="Belopp (kr)" hint={`Tomt = hela det som är kvar, ${fmtOre(Math.abs(inv.balanceOre), true)}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Betalningssätt">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(SUPPLIER_PAYMENT_METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Referens" hint="Till exempel verifikationsnummer i banken">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit">Registrera</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ open, inv, onClose, onDone }: { open: boolean; inv: SupplierInvoiceDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="Makulera fakturan">
      <form
        className="space-y-3.5"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api(`/supplier-invoices/${inv.id}/cancel`, { method: 'POST', body: { reason }, companyId: inv.companyId });
            onDone();
          } catch (err) {
            setError((err as ApiError).message);
          }
        }}
      >
        <p className="text-[13px] text-ink-2">Fakturan finns kvar men räknas inte med i reskontran eller i fastighetens kostnader.</p>
        <Field label="Varför makuleras fakturan?">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Till exempel Felaktig faktura, ersätts av kreditfaktura" required />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" variant="danger">
            Makulera
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Felanmälningar och ärenden som fakturan är kopplad till som kostnad. */
function LinkedWorkOrders({ supplierInvoiceId }: { supplierInvoiceId: string }) {
  const [rows, setRows] = useState<{ id: string; orderNr: number; title: string }[] | null>(null);
  useEffect(() => {
    api<{ id: string; orderNr: number; title: string }[]>(`/work-orders/by-supplier-invoice/${supplierInvoiceId}`).then(setRows).catch(() => setRows([]));
  }, [supplierInvoiceId]);
  if (!rows) return null;
  if (!rows.length) return <span className="text-ink-3">–</span>;
  return (
    <span className="flex flex-col">
      {rows.map((r) => (
        <Link key={r.id} href={`/arenden/${r.id}`} className="truncate text-accent hover:underline">
          {r.orderNr} {r.title}
        </Link>
      ))}
    </span>
  );
}
