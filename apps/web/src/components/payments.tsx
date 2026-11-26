'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre, todayIso } from '@/lib/format';

export interface PaymentRow {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  customerNr: number;
  amountOre: number;
  paymentDate: string;
  method: string;
  reference: string | null;
  note: string | null;
  allocatedOre: number;
  refundedOre: number;
  unallocatedOre: number;
  bankTransactionId: string | null;
  bankFileId: string | null;
  invoices: string;
}

export interface BankTx {
  id: string;
  bankFileId: string;
  position: number;
  kind: 'payment' | 'deduction';
  amountOre: number;
  paymentDate: string;
  reference: string | null;
  referenceCode: string;
  senderBankgiro: string | null;
  payerName: string | null;
  payerAddress: string | null;
  payerOrgNr: string | null;
  information: string | null;
  extraReferences: { reference: string; amountOre: number; negative: boolean }[];
  status: string;
  matchRule: string | null;
  note: string | null;
  customerId: string | null;
  customerName: string | null;
  customerNr: number | null;
  invoiceId: string | null;
  invoiceNr: number | null;
  invoiceKind: string | null;
  invoiceBalanceOre: number | null;
  invoiceTotalOre: number | null;
  paymentId: string | null;
  unallocatedOre: number | null;
  filename: string;
  fileStatus: string;
}

interface OpenInvoice {
  id: string;
  invoiceNr: number;
  kind: string;
  dueDate: string;
  balanceOre: number;
  customerId: string;
  customerName: string;
  ocr: string | null;
}

/** Hur en inbetalning förhåller sig till fakturan den matchats mot. */
export function matchNote(t: BankTx): { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } | null {
  if (t.status === 'booked' && t.unallocatedOre) return { text: `${fmtOre(t.unallocatedOre, true)} ej fördelat`, tone: 'warn' };
  if (t.status !== 'matched' || !t.invoiceId || t.invoiceBalanceOre === null) return null;
  if (t.invoiceBalanceOre <= 0) return { text: 'Fakturan är redan betald, hela beloppet blir ej fördelat', tone: 'warn' };
  const diff = t.amountOre - t.invoiceBalanceOre;
  if (diff === 0) return { text: 'Betalar fakturan', tone: 'good' };
  if (diff > 0) return { text: `${fmtOre(diff, true)} för mycket`, tone: 'warn' };
  return { text: `Delbetalning, ${fmtOre(-diff, true)} kvar`, tone: 'neutral' };
}

/** Välj kund och faktura för en inbetalning, eller markera den som hanterad utanför systemet. */
export function AssignDialog({ tx, companyId, onClose, onDone }: { tx: BankTx | null; companyId: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'assign' | 'ignore'>('assign');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string; customerNr: number }[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tx) return;
    setMode(tx.kind === 'deduction' ? 'ignore' : 'assign');
    setQ(tx.payerName ?? '');
    setCustomerId(tx.customerId);
    setCustomerName(tx.customerName ?? '');
    setInvoiceId(tx.invoiceId ?? '');
    setNote('');
    setError(null);
  }, [tx]);

  useEffect(() => {
    if (!tx || customerId || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ id: string; name: string; customerNr: number }[]>(`/customers?q=${encodeURIComponent(q.trim())}`, { companyId })
        .then((r) => setHits(r.slice(0, 8)))
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, customerId, tx, companyId]);

  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      return;
    }
    api<OpenInvoice[]>(`/invoices?customerId=${customerId}&state=open`, { companyId }).then(setInvoices);
  }, [customerId, companyId]);

  if (!tx) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/bank-transactions/${tx!.id}`, {
        method: 'PATCH',
        companyId,
        body: mode === 'ignore' ? { ignore: true, note } : { customerId, invoiceId: invoiceId || null, note: note || null },
      });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!tx} onClose={onClose} title={`Inbetalning ${fmtOre(tx.amountOre, true)} den ${tx.paymentDate}`} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md bg-subtle px-3 py-2.5 text-[13px]">
          <div>
            <span className="text-ink-3">Inbetalare:</span> {tx.payerName ?? 'okänd'}
            {tx.payerOrgNr ? ` · ${tx.payerOrgNr}` : ''}
            {tx.senderBankgiro ? ` · bankgiro ${tx.senderBankgiro}` : ''}
          </div>
          <div>
            <span className="text-ink-3">Referens:</span> {tx.reference ?? 'ingen'}
            {tx.information ? ` · ${tx.information}` : ''}
          </div>
          {tx.extraReferences.length > 0 && (
            <div>
              <span className="text-ink-3">Fler referenser:</span> {tx.extraReferences.map((r) => `${r.reference} (${fmtOre(r.amountOre, true)})`).join(', ')}
            </div>
          )}
          {tx.note && <div className="mt-1 text-ink-2">{tx.note}</div>}
        </div>

        {tx.kind === 'payment' && (
          <div className="flex gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'assign'} onChange={() => setMode('assign')} className="accent-[var(--color-accent)]" />
              Bokför på en kund
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'ignore'} onChange={() => setMode('ignore')} className="accent-[var(--color-accent)]" />
              Hanterad utanför systemet
            </label>
          </div>
        )}

        {mode === 'assign' ? (
          <>
            <Field label="Kund">
              {customerId ? (
                <div className="flex h-8 items-center justify-between rounded-md border border-line-strong px-2.5 text-[13px]">
                  <span>{customerName}</span>
                  <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => { setCustomerId(null); setInvoiceId(''); }}>
                    Byt
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Sök på namn, kundnummer eller personnummer" />
                  {hits.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md bg-surface shadow-pop">
                      {hits.map((h) => (
                        <button
                          type="button"
                          key={h.id}
                          className="block w-full px-3 py-2 text-left text-[13px] hover:bg-subtle"
                          onClick={() => { setCustomerId(h.id); setCustomerName(h.name); }}
                        >
                          {h.name} <span className="text-ink-3">kund {h.customerNr}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Field>
            {customerId && (
              <Field label="Faktura" hint="Utan faktura fördelas beloppet på kundens äldsta obetalda fakturor.">
                <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">Äldsta obetalda först</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.invoiceNr} · förfaller {i.dueDate} · {fmtOre(i.balanceOre, true)} kvar
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Anteckning (valfritt)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Till exempel: kunden ringde och bekräftade" />
            </Field>
          </>
        ) : (
          <Field label="Varför hanteras den utanför?" error={error?.fields.find((f) => f.path === 'note')?.message}>
            <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Till exempel: betald tillbaka av banken, inte en hyresbetalning" />
          </Field>
        )}

        {tx.fileStatus === 'booked' && mode === 'assign' && (
          <p className="text-[12px] text-ink-3">Filen är redan bokförd, så betalningen bokförs direkt när du sparar.</p>
        )}
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy || (mode === 'assign' ? !customerId : note.trim().length < 2)}>
            {mode === 'assign' ? (tx.fileStatus === 'booked' ? 'Bokför' : 'Spara') : 'Markera som hanterad'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Fördela eller betala tillbaka det som inte är fördelat på en betalning. */
export function UnallocatedDialog({ payment, onClose, onDone }: { payment: PaymentRow | null; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'allocate' | 'refund'>('allocate');
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!payment) return;
    setError(null);
    setInvoiceId('');
    setNote('');
    setDate(todayIso());
    setAmount(String(payment.unallocatedOre / 100));
    api<OpenInvoice[]>(`/invoices?customerId=${payment.customerId}&state=open`, { companyId: payment.companyId }).then((r) => {
      setInvoices(r);
      setMode(r.length ? 'allocate' : 'refund');
    });
  }, [payment]);

  if (!payment) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const opts = { method: 'POST', companyId: payment!.companyId };
      if (mode === 'allocate') await api(`/payments/${payment!.id}/allocate`, { ...opts, body: { invoiceId: invoiceId || null } });
      else await api(`/payments/${payment!.id}/refunds`, { ...opts, body: { amount: Number(amount.replace(',', '.')), refundDate: date, note: note || null } });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!payment} onClose={onClose} title={`${fmtOre(payment.unallocatedOre, true)} ej fördelat · ${payment.customerName}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[13px] text-ink-2">
          Inbetalt {payment.paymentDate}, {fmtOre(payment.amountOre, true)}
          {payment.invoices ? `, fördelat på faktura ${payment.invoices}` : ''}.
        </p>
        <div className="flex gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'allocate'} disabled={!invoices.length} onChange={() => setMode('allocate')} className="accent-[var(--color-accent)]" />
            Använd till obetald faktura
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'refund'} onChange={() => setMode('refund')} className="accent-[var(--color-accent)]" />
            Betala tillbaka
          </label>
        </div>
        {mode === 'allocate' ? (
          <Field label="Faktura">
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Äldsta obetalda först</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoiceNr} · förfaller {i.dueDate} · {fmtOre(i.balanceOre, true)} kvar
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <p className="text-[12px] text-ink-3">Registrera återbetalningen här när pengarna har skickats till kunden från banken.</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Belopp (kr)" error={error?.fields.find((f) => f.path === 'amount')?.message}>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Utbetalningsdag">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <Field label="Anteckning (valfritt)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Till exempel kontonummer eller Swish" />
            </Field>
          </>
        )}
        {invoices.length === 0 && mode === 'allocate' && <p className="text-[12px] text-ink-3">Kunden har inga obetalda fakturor.</p>}
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy}>
            {mode === 'allocate' ? 'Fördela' : 'Registrera återbetalning'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
