'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { SectionHeader } from '@/components/edit-form';
import { InvoiceForm } from '@/components/invoice-form';
import { InvoiceRow, InvoiceStateBadge } from '@/components/invoice-table';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Td, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import {
  DELIVERY_LABEL,
  DELIVERY_STATUS,
  INVOICE_KIND_LABEL,
  LINE_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  fmtOre,
  fmtPeriod,
  formatDate,
  todayIso,
  REMINDER_LEVEL_LABEL,
  REMINDER_STATUS,
} from '@/lib/format';
import { useSession } from '@/lib/session';

interface Line {
  id: string;
  lineKind: string;
  contractId: string | null;
  objectId: string | null;
  objectNr: string | null;
  propertyName: string | null;
  costCenterCode: string | null;
  article: string;
  description: string;
  periodFrom: string | null;
  periodTo: string | null;
  quantity: number;
  unitPriceOre: number;
  netOre: number;
  vatRateBp: number;
  vatOre: number;
  creditedNetOre: number;
}

interface Detail extends InvoiceRow {
  billTo: { name: string; careOf: string | null; addressLine: string | null; postalCode: string | null; city: string | null; email: string | null; reference: string | null; customerNr: number };
  ourReference: string | null;
  yourReference: string | null;
  message: string | null;
  roundingOre: number;
  creditReason: string | null;
  issuedAt: string | null;
  issuedByName: string | null;
  lines: Line[];
  payments: { id: string; paymentId: string; amountOre: number; paymentAmountOre: number; paymentDate: string; method: string; reference: string | null; note: string | null }[];
  credits: InvoiceRow[];
  credited: InvoiceRow | null;
  deliveries: { id: string; channel: string; status: string; recipient: string | null; sentAt: string | null; error: string | null; createdAt: string }[];
  company: { name: string; bankgiro: string | null; plusgiro: string | null };
}

type DialogKind = 'pay' | 'credit' | 'email' | 'delete' | 'issue' | null;

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const [reminders, setReminders] = useState<{ id: string; level: number; reminderDate: string; dueDate: string; feeOre: number; status: string; channel: string; feeInvoiceId: string | null; feeInvoiceNr: number | null }[]>([]);
  const load = useCallback(() => {
    api<Detail>(`/invoices/${id}`)
      .then(setD)
      .catch((e: ApiError) => setError(e.message));
    api<typeof reminders>(`/reminders?invoiceId=${id}`).then(setReminders).catch(() => setReminders([]));
  }, [id]);
  useEffect(load, [load]);

  if (error && !d) return <ErrorNote message={error} />;
  if (!d) return null;

  const opts = { companyId: d.companyId };
  const draft = d.status === 'draft';
  const issued = d.status === 'issued';
  const credit = d.kind === 'credit_note';
  const manualDraft = draft && !d.billingRunId;
  const title = `${INVOICE_KIND_LABEL[d.kind]} ${d.invoiceNr ?? ''}`.trim();

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  const actions = (
    <>
      <a href={`/api/invoices/${id}/pdf`} target="_blank" rel="noreferrer">
        <Button variant="secondary">{draft ? 'Förhandsgranska PDF' : 'PDF'}</Button>
      </a>
      {manualDraft && can('invoice.write', d.companyId) && !editing && (
        <>
          <Button variant="ghost" onClick={() => setDialog('delete')}>
            Ta bort
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Ändra
          </Button>
        </>
      )}
      {manualDraft && can('invoice.issue', d.companyId) && !editing && <Button onClick={() => setDialog('issue')}>Utfärda</Button>}
      {issued && (
        <>
          <a href={`/api/invoices/${id}/peppol.xml`}>
            <Button variant="ghost">E-faktura (XML)</Button>
          </a>
          {can('invoice.issue', d.companyId) && (
            <Button variant="secondary" onClick={() => setDialog('email')}>
              Skicka
            </Button>
          )}
          {!credit && can('invoice.issue', d.companyId) && d.creditedOre < d.totalOre && (
            <Button variant="secondary" onClick={() => setDialog('credit')}>
              Kreditera
            </Button>
          )}
          {!credit && can('payment.write', d.companyId) && d.balanceOre > 0 && <Button onClick={() => setDialog('pay')}>Registrera betalning</Button>}
        </>
      )}
    </>
  );

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/fakturor" className="hover:text-ink">
          Fakturor
        </Link>{' '}
        / {d.invoiceNr ?? 'Utkast'}
      </div>
      <PageHeader title={draft ? `${INVOICE_KIND_LABEL[d.kind]}, utkast` : title} description={`${d.customerName} · ${d.companyName}`} actions={actions} />
      <div className="-mt-3 mb-6 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <InvoiceStateBadge state={d.state} />
        {d.deliveries.length > 0 && (
          <Badge tone={DELIVERY_STATUS[d.deliveries[d.deliveries.length - 1].status]?.tone}>
            {DELIVERY_STATUS[d.deliveries[d.deliveries.length - 1].status]?.label}
          </Badge>
        )}
        {draft && d.billingRunId && (
          <span>
            Ingår i en aviseringskörning som inte är godkänd.{' '}
            <Link href={`/avisering/${d.billingRunId}`} className="text-accent hover:underline">
              Öppna körningen
            </Link>
          </span>
        )}
        {manualDraft && <span>Utkast. Fakturan får nummer och OCR när den utfärdas och kan sedan inte ändras.</span>}
        {credit && d.credited && (
          <span>
            Krediterar{' '}
            <Link href={`/fakturor/${d.credited.id}`} className="text-accent hover:underline">
              {INVOICE_KIND_LABEL[d.credited.kind].toLowerCase()} {d.credited.invoiceNr}
            </Link>
            {d.creditReason ? `. ${d.creditReason}` : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}
      {notice && <div className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{notice}</div>}

      {editing ? (
        <InvoiceForm
          initial={{
            id: d.id,
            customerId: d.customerId,
            contractId: d.contractId,
            invoiceDate: d.invoiceDate,
            dueDate: d.dueDate,
            deliveryMethod: d.deliveryMethod,
            ourReference: d.ourReference,
            yourReference: d.yourReference,
            message: d.message,
            lines: d.lines,
          }}
          onSaved={() => {
            setEditing(false);
            load();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="mb-8 grid grid-cols-4 gap-3">
            <Stat label={credit ? 'Krediterat belopp' : 'Fakturabelopp'} value={fmtOre(credit ? -d.totalOre : d.totalOre, true)} sub={`varav moms ${fmtOre(credit ? -d.vatOre : d.vatOre, true)}`} />
            {credit ? (
              <Stat label="Datum" value={<span className="text-[16px]">{d.invoiceDate}</span>} />
            ) : (
              <>
                <Stat label="Betalt" value={fmtOre(d.paidOre, true)} sub={d.payments.length ? `${d.payments.length} inbetalningar` : 'ingen inbetalning'} />
                <Stat label="Krediterat" value={fmtOre(d.creditedOre, true)} sub={d.credits.length ? `${d.credits.length} kreditfakturor` : undefined} />
              </>
            )}
            {!credit && (
              <Stat
                label="Kvar att betala"
                value={<span className={cx(d.state === 'overdue' && 'text-bad')}>{draft ? '–' : fmtOre(d.balanceOre, true)}</span>}
                sub={d.balanceOre < 0 ? 'tillgodo för kunden' : `förfaller ${d.dueDate}`}
              />
            )}
          </div>

          <div className="grid grid-cols-[1fr_300px] gap-6">
            <div className="space-y-8">
              <section>
                <SectionHeader title="Rader" />
                <Table head={['Text', 'Period', 'Moms', 'Belopp']}>
                  {d.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        <div>
                          {l.objectNr && <span className="mr-2 text-ink-3">{l.objectNr}</span>}
                          {l.description}
                          {l.lineKind !== 'regular' && l.lineKind !== 'manual' && (
                            <span className="ml-2">
                              <Badge tone={l.lineKind === 'retroactive' ? 'warn' : 'neutral'}>{LINE_KIND_LABEL[l.lineKind]}</Badge>
                            </span>
                          )}
                          {l.creditedNetOre !== 0 && (
                            <span className="ml-2">
                              <Badge>krediterad {fmtOre(l.creditedNetOre, true)}</Badge>
                            </span>
                          )}
                        </div>
                        {(l.propertyName || l.costCenterCode || l.quantity !== 1) && (
                          <div className="text-[12px] text-ink-3">
                            {[l.quantity !== 1 ? `${l.quantity.toLocaleString('sv-SE')} à ${fmtOre(l.unitPriceOre, true)}` : null, l.propertyName, l.costCenterCode ? `kostnadsställe ${l.costCenterCode}` : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </Td>
                      <Td className="text-ink-2">{l.periodFrom ? fmtPeriod(l.periodFrom, l.periodTo) : ''}</Td>
                      <Td className="text-ink-2">{l.vatRateBp ? `${l.vatRateBp / 100} %` : 'Momsfri'}</Td>
                      <Td className="text-right tabular">{fmtOre(l.netOre, true)}</Td>
                    </tr>
                  ))}
                </Table>
                <div className="mt-3 ml-auto w-72 space-y-1 text-[13px]">
                  <Row label="Summa exkl. moms" value={fmtOre(d.netOre, true)} />
                  <Row label="Moms" value={fmtOre(d.vatOre, true)} />
                  {d.roundingOre !== 0 && <Row label="Öresavrundning" value={fmtOre(d.roundingOre, true)} />}
                  <Row label={credit ? 'Att kreditera' : 'Att betala'} value={fmtOre(credit ? -d.totalOre : d.totalOre, true)} bold />
                </div>
              </section>

              {!credit && issued && (
                <section>
                  <SectionHeader title="Betalningar" />
                  <Table head={['Datum', 'Sätt', 'Referens', 'Belopp', '']} empty="Ingen betalning registrerad.">
                    {d.payments.map((p) => (
                      <tr key={p.id}>
                        <Td className="tabular">{p.paymentDate}</Td>
                        <Td className="text-ink-2">{PAYMENT_METHOD_LABEL[p.method]}</Td>
                        <Td className="text-ink-2">
                          {p.reference}
                          {p.paymentAmountOre !== p.amountOre && <div className="text-[12px] text-ink-3">av inbetalning {fmtOre(p.paymentAmountOre, true)}</div>}
                        </Td>
                        <Td className="tabular">{fmtOre(p.amountOre, true)}</Td>
                        <Td className="text-right">
                          {can('payment.write', d.companyId) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-ink-3 hover:text-bad"
                              onClick={() => act(() => api(`/payments/${p.paymentId}`, { method: 'DELETE', ...opts }), 'Betalningen är borttagen.')}
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

              {reminders.length > 0 && (
                <section>
                  <SectionHeader title="Påminnelser" />
                  <Table head={['Datum', 'Nivå', 'Betala senast', 'Avgift', 'Status', '']}>
                    {reminders.map((r) => (
                      <tr key={r.id}>
                        <Td className="tabular">{r.reminderDate}</Td>
                        <Td>{REMINDER_LEVEL_LABEL[r.level]}</Td>
                        <Td className="tabular text-ink-2">{r.dueDate}</Td>
                        <Td className="tabular text-ink-2">
                          {r.feeInvoiceId ? (
                            <Link href={`/fakturor/${r.feeInvoiceId}`} className="hover:underline">
                              {fmtOre(r.feeOre)} (faktura {r.feeInvoiceNr})
                            </Link>
                          ) : (
                            '–'
                          )}
                        </Td>
                        <Td>
                          <Badge tone={REMINDER_STATUS[r.status]?.tone}>{r.channel === 'post' && r.status === 'queued' ? 'Ska skrivas ut' : REMINDER_STATUS[r.status]?.label}</Badge>
                        </Td>
                        <Td className="text-right">
                          <a href={`/api/reminders/${r.id}/pdf`} target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline">
                            PDF
                          </a>
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </section>
              )}

              {d.credits.length > 0 && (
                <section>
                  <SectionHeader title="Kreditfakturor" />
                  <Card className="divide-y divide-line">
                    {d.credits.map((c) => (
                      <Link key={c.id} href={`/fakturor/${c.id}`} className="flex items-center gap-4 px-4 py-2.5 text-[13px] hover:bg-subtle/60">
                        <span className="font-medium tabular">{c.invoiceNr}</span>
                        <span className="flex-1 text-ink-2">{c.invoiceDate}</span>
                        <span className="tabular">{fmtOre(c.totalOre, true)}</span>
                      </Link>
                    ))}
                  </Card>
                </section>
              )}
            </div>

            <aside className="space-y-6">
              <section>
                <SectionHeader title="Uppgifter" />
                <Card className="space-y-2.5 px-4 py-3.5 text-[13px]">
                  <Info label="Kund">
                    <Link href={`/kunder/${d.customerId}`} className="hover:text-accent">
                      {d.billTo.name}
                    </Link>
                    <div className="text-[12px] text-ink-3">
                      {[d.billTo.careOf ? `c/o ${d.billTo.careOf}` : null, d.billTo.addressLine, [d.billTo.postalCode, d.billTo.city].filter(Boolean).join(' ')]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  </Info>
                  {d.contractId && (
                    <Info label="Avtal">
                      <Link href={`/avtal/${d.contractId}`} className="hover:text-accent">
                        {d.contractNr}
                      </Link>
                      {d.objects && <span className="text-ink-3"> · {d.objects}</span>}
                    </Info>
                  )}
                  {d.periodFrom && <Info label="Period">{fmtPeriod(d.periodFrom, d.periodTo)}</Info>}
                  <Info label="Fakturadatum">{d.invoiceDate}</Info>
                  {!credit && <Info label="Förfallodatum">{d.dueDate}</Info>}
                  {d.ocr && (
                    <Info label="OCR">
                      <span className="font-medium tabular">{d.ocr}</span>
                    </Info>
                  )}
                  {!credit && (d.company.bankgiro || d.company.plusgiro) && <Info label={d.company.bankgiro ? 'Bankgiro' : 'Plusgiro'}>{d.company.bankgiro ?? d.company.plusgiro}</Info>}
                  {(d.yourReference || d.billTo.reference) && <Info label="Er referens">{d.yourReference ?? d.billTo.reference}</Info>}
                  {d.ourReference && <Info label="Vår referens">{d.ourReference}</Info>}
                  {d.message && <Info label="Meddelande">{d.message}</Info>}
                  <Info label="Skickas med">{DELIVERY_LABEL[d.deliveryMethod]}</Info>
                  {d.billingRunId && (
                    <Info label="Aviseringskörning">
                      <Link href={`/avisering/${d.billingRunId}`} className="hover:text-accent">
                        Öppna körningen
                      </Link>
                    </Info>
                  )}
                  {d.issuedAt && (
                    <Info label="Utfärdad">
                      {formatDate(d.issuedAt)}
                      {d.issuedByName ? ` av ${d.issuedByName}` : ''}
                    </Info>
                  )}
                </Card>
              </section>
              {d.deliveries.length > 0 && (
                <section>
                  <SectionHeader title="Utskick" />
                  <Card className="divide-y divide-line">
                    {d.deliveries.map((x) => (
                      <div key={x.id} className="px-4 py-2.5 text-[13px]">
                        <div className="flex items-center gap-2">
                          <span className="flex-1">{DELIVERY_LABEL[x.channel]}</span>
                          <Badge tone={DELIVERY_STATUS[x.status]?.tone}>{DELIVERY_STATUS[x.status]?.label}</Badge>
                        </div>
                        <div className="truncate text-[12px] text-ink-3">
                          {x.recipient}
                          {x.sentAt ? ` · ${formatDate(x.sentAt)}` : ''}
                        </div>
                        {x.status === 'test' && <div className="text-[12px] text-ink-3">{x.channel === 'e_invoice' ? 'E-faktura är inte ansluten ännu. Filen kan laddas ned med knappen E-faktura (XML).' : 'E-post är inte ansluten ännu, så inget nådde kunden.'}</div>}
                        {x.error && <div className="text-[12px] text-bad">{x.error}</div>}
                      </div>
                    ))}
                  </Card>
                </section>
              )}
            </aside>
          </div>
        </>
      )}

      <PaymentDialog open={dialog === 'pay'} invoice={d} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); setNotice(msg); load(); }} />
      <CreditDialog open={dialog === 'credit'} invoice={d} onClose={() => setDialog(null)} onDone={(creditId) => router.push(`/fakturor/${creditId}`)} />
      <EmailDialog
        open={dialog === 'email'}
        invoice={d}
        onClose={() => setDialog(null)}
        onDone={(msg) => {
          setDialog(null);
          setNotice(msg);
          load();
        }}
      />
      <Dialog open={dialog === 'issue'} onClose={() => setDialog(null)} title="Utfärda fakturan">
        <p className="text-[13px] text-ink-2">
          Fakturan på {fmtOre(d.totalOre, true)} till {d.customerName} får nästa fakturanummer och ett OCR-nummer och låses. Därefter kan den bara rättas med kreditfaktura.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Avbryt
          </Button>
          <Button
            onClick={() => {
              setDialog(null);
              act(() => api(`/invoices/${id}/issue`, { method: 'POST', ...opts }), 'Fakturan är utfärdad. Skicka den med knappen Skicka.');
            }}
          >
            Utfärda
          </Button>
        </div>
      </Dialog>
      <Dialog open={dialog === 'delete'} onClose={() => setDialog(null)} title="Ta bort utkastet">
        <p className="text-[13px] text-ink-2">Utkastet tas bort. Det har inget fakturanummer, så ingen lucka uppstår i nummerserien.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await api(`/invoices/${id}`, { method: 'DELETE', ...opts });
              router.push('/fakturor');
            }}
          >
            Ta bort
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cx('flex justify-between', bold ? 'border-t border-line pt-1.5 font-semibold' : 'text-ink-2')}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function PaymentDialog({ open, invoice, onClose, onDone }: { open: boolean; invoice: Detail; onClose: () => void; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('bankgiro');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (open) {
      setAmount(String(invoice.balanceOre / 100));
      setDate(todayIso());
      setMethod('bankgiro');
      setReference(invoice.ocr ?? '');
      setError(null);
    }
  }, [open, invoice]);
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;
  return (
    <Dialog open={open} onClose={onClose} title="Registrera betalning">
      <div className="space-y-3.5">
        <p className="text-[13px] text-ink-2">Kvar att betala: {fmtOre(invoice.balanceOre, true)}. Ett lägre belopp blir en delbetalning.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Belopp (kr)" error={fe('amount')}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          <Field label="Referens">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              try {
                const r = await api<{ unallocatedOre: number; state: string }>(`/invoices/${invoice.id}/payments`, {
                  method: 'POST',
                  body: { amount: Number(amount.replace(/\s/g, '').replace(',', '.')), paymentDate: date, method, reference: reference || null },
                  companyId: invoice.companyId,
                });
                onDone(
                  r.unallocatedOre > 0
                    ? `Betalningen är registrerad. ${fmtOre(r.unallocatedOre, true)} var mer än fakturabeloppet och ligger kvar som ej fördelat på kunden.`
                    : r.state === 'paid'
                      ? 'Fakturan är betald.'
                      : 'Delbetalningen är registrerad.',
                );
              } catch (e) {
                setError(e as ApiError);
              }
            }}
          >
            Registrera
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CreditDialog({ open, invoice, onClose, onDone }: { open: boolean; invoice: Detail; onClose: () => void; onDone: (id: string) => void }) {
  const [mode, setMode] = useState<'all' | 'lines'>('all');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [rebill, setRebill] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setMode('all');
      setAmounts({});
      setReason('');
      setRebill(false);
      setError(null);
    }
  }, [open]);
  const remaining = (l: Line) => l.netOre - l.creditedNetOre;
  const fromContract = invoice.lines.some((l) => l.lineKind === 'regular' || l.lineKind === 'retroactive');
  return (
    <Dialog open={open} onClose={onClose} title={`Kreditera ${INVOICE_KIND_LABEL[invoice.kind].toLowerCase()} ${invoice.invoiceNr}`} wide>
      <div className="space-y-4 text-[13px]">
        <p className="text-ink-2">En kreditfaktura skapas och skickas till kunden. Originalet ändras aldrig. Belopp anges exklusive moms; momsen krediteras i samma proportion.</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} className="accent-[var(--color-accent)]" />
            Hela det som återstår ({fmtOre(invoice.totalOre - invoice.creditedOre, true)})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'lines'} onChange={() => setMode('lines')} className="accent-[var(--color-accent)]" />
            Välj rader och belopp
          </label>
        </div>
        {mode === 'lines' && (
          <Card className="divide-y divide-line">
            {invoice.lines
              .filter((l) => remaining(l) !== 0)
              .map((l) => (
                <div key={l.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{l.description}</div>
                    <div className="text-[12px] text-ink-3">högst {fmtOre(Math.abs(remaining(l)), true)}</div>
                  </div>
                  <Input
                    className="w-32"
                    inputMode="decimal"
                    placeholder="kr"
                    value={amounts[l.id] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })}
                  />
                </div>
              ))}
          </Card>
        )}
        <Field label="Orsak (visas på kreditfakturan)" error={error?.fields.find((f) => f.path === 'reason')?.message}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Till exempel Felaktig hyra i januari" />
        </Field>
        {fromContract && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={rebill} onChange={(e) => setRebill(e.target.checked)} />
            <span>
              Avisera perioden på nytt i nästa körning
              <span className="block text-[12px] text-ink-3">Välj detta om hyran var fel och rätt belopp ska debiteras. Låt bli om hyran ska efterskänkas.</span>
            </span>
          </label>
        )}
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const lines =
                  mode === 'lines'
                    ? Object.entries(amounts)
                        .filter(([, v]) => v.trim())
                        .map(([lineId, v]) => ({ lineId, amount: Number(v.replace(/\s/g, '').replace(',', '.')) }))
                    : undefined;
                if (mode === 'lines' && !lines?.length) throw new ApiError(400, 'Ange belopp på minst en rad');
                const r = await api<{ id: string }>(`/invoices/${invoice.id}/credit`, {
                  method: 'POST',
                  body: { reason, rebill, lines },
                  companyId: invoice.companyId,
                });
                onDone(r.id);
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Skapa kreditfaktura
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function EmailDialog({ open, invoice, onClose, onDone }: { open: boolean; invoice: Detail; onClose: () => void; onDone: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (open) {
      setEmail('');
      setError(null);
    }
  }, [open]);
  const send = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const r = await api<{ sent: number; test: number; failed: number; post: number }>(`/invoices/${invoice.id}/send`, { method: 'POST', body, companyId: invoice.companyId });
      onDone(
        r.post
          ? 'Fakturan ska skickas med brev. Skriv ut PDF:en och posta den.'
          : r.test
            ? 'Fakturan skapades i testläge. E-post är inte ansluten ännu, så inget nådde kunden.'
            : r.failed
              ? 'Utskicket misslyckades. Se felet under Utskick.'
              : 'Fakturan är skickad.',
      );
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Skicka fakturan">
      <div className="space-y-4 text-[13px]">
        <p className="text-ink-2">
          Kundens leveranssätt är {DELIVERY_LABEL[invoice.deliveryMethod]?.toLowerCase()}
          {invoice.billTo.email ? ` (${invoice.billTo.email})` : ''}.
        </p>
        <Button onClick={() => send({})}>Skicka med kundens leveranssätt</Button>
        <div className="border-t border-line pt-4">
          <Field label="Eller skicka som e-post till" error={error?.fields.find((f) => f.path === 'email')?.message}>
            <div className="flex gap-2">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="namn@foretag.se" />
              <Button variant="secondary" disabled={!email} onClick={() => send({ email })}>
                Skicka
              </Button>
            </div>
          </Field>
        </div>
        {error && !error.fields.length && <ErrorNote message={error.message} />}
      </div>
    </Dialog>
  );
}
