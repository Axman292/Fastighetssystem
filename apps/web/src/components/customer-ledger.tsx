'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { PaymentRow, UnallocatedDialog } from '@/components/payments';
import { Button, Card, Dialog, ErrorNote, Field, Input, Select, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { PAYMENT_METHOD_LABEL, fmtOre, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Entry {
  date: string;
  type: 'invoice' | 'credit_note' | 'payment' | 'refund';
  text: string;
  amountOre: number;
  balanceOre: number;
}

interface Statement {
  asOf: string;
  entries: Entry[];
  open: { invoiceId: string; invoiceNr: number; dueDate: string; balanceOre: number; reminderLevel: number }[];
  unallocatedOre: number;
  balanceOre: number;
  overdueOre: number;
}

/** Kundreskontra för en hyresgäst: saldo, kontoutdrag och ej fördelade inbetalningar. */
export function CustomerLedger({ customerId, companyId, onChange }: { customerId: string; companyId: string; onChange?: () => void }) {
  const { can } = useSession();
  const [s, setS] = useState<Statement | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [spread, setSpread] = useState<PaymentRow | null>(null);
  const [newPayment, setNewPayment] = useState(false);
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    api<Statement>(`/ledger/customers/${customerId}`).then(setS);
    api<PaymentRow[]>(`/payments?customerId=${customerId}&unallocated=1`).then(setPayments);
  }, [customerId]);
  useEffect(load, [load]);

  if (!s) return null;
  const canWrite = can('payment.write', companyId);
  const entries = all ? s.entries : s.entries.slice(-12);
  const reload = () => {
    load();
    onChange?.();
  };

  return (
    <section className="mb-10" id="reskontra">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold">Kundreskontra</h2>
          <p className="text-[12.5px] text-ink-2">
            Saldo {fmtOre(s.balanceOre, true)}
            {s.overdueOre ? `, varav ${fmtOre(s.overdueOre, true)} förfallet` : ''}
            {s.unallocatedOre ? `. ${fmtOre(s.unallocatedOre, true)} inbetalt som inte är fördelat.` : '.'}
          </p>
        </div>
        <div className="flex gap-2">
          <a href={`/api/ledger/customers/${customerId}/statement.pdf`} target="_blank" rel="noreferrer">
            <Button size="sm" variant="secondary">
              Kontoutdrag (PDF)
            </Button>
          </a>
          {canWrite && (
            <Button size="sm" variant="secondary" onClick={() => setNewPayment(true)}>
              Registrera inbetalning
            </Button>
          )}
        </div>
      </div>

      {payments.length > 0 && (
        <Card className="mb-3 divide-y divide-line">
          {payments.map((p) => (
            <div key={p.id} className="flex items-center gap-4 px-4 py-2.5 text-[13px]">
              <div className="flex-1">
                <span className="font-medium text-warn">{fmtOre(p.unallocatedOre, true)} ej fördelat</span>
                <span className="text-ink-2">
                  {' '}
                  · inbetalt {p.paymentDate} via {PAYMENT_METHOD_LABEL[p.method]?.toLowerCase() ?? p.method}
                  {p.invoices ? ` · fördelat på ${p.invoices}` : ''}
                </span>
              </div>
              {canWrite && (
                <Button size="sm" variant="ghost" onClick={() => setSpread(p)}>
                  Fördela eller betala tillbaka
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      <Table head={['Datum', 'Händelse', 'Belopp', 'Saldo']} empty="Inga fakturor eller inbetalningar ännu.">
        {entries.map((e, i) => (
          <tr key={i}>
            <Td className="tabular text-ink-2">{e.date}</Td>
            <Td>{e.text}</Td>
            <Td className={`tabular ${e.amountOre < 0 ? 'text-good' : ''}`}>{fmtOre(e.amountOre, true)}</Td>
            <Td className="tabular font-medium">{fmtOre(e.balanceOre, true)}</Td>
          </tr>
        ))}
      </Table>
      {s.entries.length > 12 && (
        <button className="mt-2 text-[12.5px] text-accent hover:underline" onClick={() => setAll(!all)}>
          {all ? 'Visa bara de senaste' : `Visa alla ${s.entries.length} händelser`}
        </button>
      )}
      {s.open.some((o) => o.reminderLevel > 0) && (
        <p className="mt-2 text-[12.5px] text-ink-2">
          Påminnelse skickad för faktura{' '}
          {s.open
            .filter((o) => o.reminderLevel > 0)
            .map((o, i) => (
              <span key={o.invoiceId}>
                {i > 0 && ', '}
                <Link href={`/fakturor/${o.invoiceId}`} className="hover:underline">
                  {o.invoiceNr}
                </Link>
              </span>
            ))}
          . Se <Link href="/paminnelser" className="text-accent hover:underline">Påminnelser</Link>.
        </p>
      )}

      <UnallocatedDialog
        payment={spread}
        onClose={() => setSpread(null)}
        onDone={() => {
          setSpread(null);
          reload();
        }}
      />
      <NewPaymentDialog
        open={newPayment}
        customerId={customerId}
        companyId={companyId}
        onClose={() => setNewPayment(false)}
        onDone={() => {
          setNewPayment(false);
          reload();
        }}
      />
    </section>
  );
}

function NewPaymentDialog({ open, customerId, companyId, onClose, onDone }: { open: boolean; customerId: string; companyId: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('swish');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setAmount('');
    setReference('');
    setDate(todayIso());
    setError(null);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/payments', {
        method: 'POST',
        companyId,
        body: { customerId, amount: Number(amount.replace(',', '.').replace(/\s/g, '')), paymentDate: date, method, reference: reference || null },
      });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  return (
    <Dialog open={open} onClose={onClose} title="Registrera inbetalning">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[13px] text-ink-2">
          För betalningar som inte kommer via bankgirofilen, till exempel Swish eller kontant. Beloppet fördelas på kundens äldsta obetalda fakturor.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Belopp (kr)" error={fe('amount')}>
            <Input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Betalningsdag" error={fe('paymentDate')}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Betalsätt">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Referens (valfritt)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy || !amount}>
            Registrera
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
