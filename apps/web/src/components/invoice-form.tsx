'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select } from './ui';
import { api, ApiError } from '@/lib/api';
import { articleDefaults, articleOptions, useArticles } from '@/lib/articles';
import { useSession } from '@/lib/session';
import { DELIVERY_LABEL, VAT_LABEL, fmtOre, todayIso } from '@/lib/format';

export interface DraftLine {
  article: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRateBp: string;
  objectId: string;
  periodFrom: string;
  periodTo: string;
}

export interface InvoiceFormInitial {
  id?: string;
  customerId?: string;
  contractId?: string | null;
  invoiceDate?: string;
  dueDate?: string;
  deliveryMethod?: string;
  ourReference?: string | null;
  yourReference?: string | null;
  message?: string | null;
  lines?: { article: string; description: string; quantity: number; unitPriceOre: number; vatRateBp: number; objectId: string | null; periodFrom: string | null; periodTo: string | null }[];
}

const emptyLine = (): DraftLine => ({ article: 'other', description: '', quantity: '1', unitPrice: '', vatRateBp: '0', objectId: '', periodFrom: '', periodTo: '' });
const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

/** Formulär för manuell faktura (engångsfaktura). Sparas som utkast. */
export function InvoiceForm({ initial, onSaved, onCancel }: { initial: InvoiceFormInitial; onSaved: (id: string) => void; onCancel?: () => void }) {
  const { me } = useSession();
  const { articles } = useArticles();
  const [customers, setCustomers] = useState<{ id: string; name: string; customerNr: number; deliveryMethod: string }[]>([]);
  const [contracts, setContracts] = useState<{ id: string; contractNr: number; type: string; objects: string; status: string }[]>([]);
  const [objects, setObjects] = useState<{ objectId: string; objectNr: string; propertyName: string }[]>([]);
  const [customerId, setCustomerId] = useState(initial.customerId ?? '');
  const [contractId, setContractId] = useState(initial.contractId ?? '');
  const [invoiceDate, setInvoiceDate] = useState(initial.invoiceDate ?? todayIso());
  const [dueDate, setDueDate] = useState(initial.dueDate ?? '');
  const [deliveryMethod, setDeliveryMethod] = useState(initial.deliveryMethod ?? '');
  const [ourReference, setOurReference] = useState(initial.ourReference ?? '');
  const [yourReference, setYourReference] = useState(initial.yourReference ?? '');
  const [message, setMessage] = useState(initial.message ?? '');
  const [lines, setLines] = useState<DraftLine[]>(
    initial.lines?.length
      ? initial.lines.map((l) => ({
          article: l.article,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPriceOre / 100),
          vatRateBp: String(l.vatRateBp),
          objectId: l.objectId ?? '',
          periodFrom: l.periodFrom ?? '',
          periodTo: l.periodTo ?? '',
        }))
      : [emptyLine()],
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ id: string; name: string; customerNr: number; deliveryMethod: string; active: boolean }[]>('/customers').then((r) => setCustomers(r.filter((c) => c.active)));
  }, []);

  useEffect(() => {
    if (!customerId) {
      setContracts([]);
      return;
    }
    api<{ id: string; contractNr: number; type: string; objects: string; status: string }[]>(`/contracts?customerId=${customerId}`).then((r) =>
      setContracts(r.filter((k) => k.status !== 'cancelled')),
    );
  }, [customerId]);

  useEffect(() => {
    if (!contractId) {
      setObjects([]);
      return;
    }
    api<{ objects: { objectId: string; objectNr: string; propertyName: string }[] }>(`/contracts/${contractId}`).then((k) => setObjects(k.objects));
  }, [contractId]);

  const net = lines.reduce((s, l) => s + Math.round(num(l.unitPrice || '0') * 100 * num(l.quantity || '1')), 0);
  const vat = lines.reduce((s, l) => s + Math.round((Math.round(num(l.unitPrice || '0') * 100 * num(l.quantity || '1')) * Number(l.vatRateBp)) / 10000), 0);
  const setLine = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const fe = (p: string) => error?.fields.find((f) => f.path === p || f.path.startsWith(`${p}.`))?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      customerId,
      contractId: contractId || null,
      invoiceDate,
      dueDate: dueDate || null,
      deliveryMethod: deliveryMethod || null,
      ourReference: ourReference || null,
      yourReference: yourReference || null,
      message: message || null,
      lines: lines
        .filter((l) => l.description.trim() || l.unitPrice.trim())
        .map((l) => ({
          article: l.article,
          description: l.description,
          quantity: num(l.quantity || '1'),
          unitPrice: num(l.unitPrice || '0'),
          vatRateBp: Number(l.vatRateBp),
          objectId: l.objectId || null,
          periodFrom: l.periodFrom || null,
          periodTo: l.periodTo || null,
        })),
    };
    try {
      if (initial.id) {
        const { lines: ls, ...header } = body;
        await api(`/invoices/${initial.id}`, { method: 'PATCH', body: header });
        await api(`/invoices/${initial.id}/lines`, { method: 'PUT', body: { lines: ls } });
        onSaved(initial.id);
      } else {
        const r = await api<{ id: string }>('/invoices', { method: 'POST', body });
        onSaved(r.id);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card className="grid grid-cols-2 gap-x-4 gap-y-3.5 p-5">
        <Field label="Kund" error={fe('customerId')}>
          <Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setContractId(''); }} required>
            <option value="">Välj kund</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.customerNr})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Avtal" error={fe('contractId')} hint="Valfritt. Kopplar fakturan till avtalet och dess fastighet.">
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)} disabled={!customerId}>
            <option value="">Inget avtal</option>
            {contracts.map((k) => (
              <option key={k.id} value={k.id}>
                {k.contractNr} · {k.objects}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fakturadatum" error={fe('invoiceDate')}>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Förfallodatum" error={fe('dueDate')} hint="Tomt = kundens betalningsvillkor">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Er referens" error={fe('yourReference')}>
          <Input value={yourReference} onChange={(e) => setYourReference(e.target.value)} />
        </Field>
        <Field label="Vår referens" error={fe('ourReference')}>
          <Input value={ourReference} onChange={(e) => setOurReference(e.target.value)} />
        </Field>
        <Field label="Skickas med" hint="Tomt = kundens inställning">
          <Select value={deliveryMethod} onChange={(e) => setDeliveryMethod(e.target.value)}>
            <option value="">Kundens inställning</option>
            {Object.entries(DELIVERY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Meddelande på fakturan">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
      </Card>

      <div>
        <div className="mb-2 flex items-end justify-between">
          <h2 className="text-[14px] font-semibold">Rader</h2>
          <Button type="button" size="sm" variant="secondary" onClick={() => setLines([...lines, emptyLine()])}>
            Ny rad
          </Button>
        </div>
        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle/60 text-[12px] text-ink-3">
                <th className="h-8 px-2 font-medium">Artikel</th>
                <th className="h-8 px-2 font-medium">Text</th>
                <th className="h-8 w-20 px-2 font-medium">Antal</th>
                <th className="h-8 w-28 px-2 font-medium">À-pris (kr)</th>
                <th className="h-8 w-24 px-2 font-medium">Moms</th>
                {objects.length > 0 && <th className="h-8 w-28 px-2 font-medium">Objekt</th>}
                <th className="h-8 w-28 px-2 text-right font-medium">Belopp</th>
                <th className="h-8 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <Select
                      value={l.article}
                      onChange={(e) =>
                        setLine(i, {
                          ...(articleDefaults(articles, me.activeCompanyId, e.target.value, { ...l }) as Partial<DraftLine>),
                          article: e.target.value,
                        })
                      }
                    >
                      {Object.entries(articleOptions(articles, me.activeCompanyId, l.article)).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={l.description} placeholder="Till exempel Fönsterputs" onChange={(e) => setLine(i, { description: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select value={l.vatRateBp} onChange={(e) => setLine(i, { vatRateBp: e.target.value })}>
                      {Object.entries(VAT_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </td>
                  {objects.length > 0 && (
                    <td className="px-2 py-1.5">
                      <Select value={l.objectId} onChange={(e) => setLine(i, { objectId: e.target.value })}>
                        <option value="">–</option>
                        {objects.map((o) => (
                          <option key={o.objectId} value={o.objectId}>
                            {o.objectNr}
                          </option>
                        ))}
                      </Select>
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right tabular">{fmtOre(Math.round(num(l.unitPrice || '0') * 100 * num(l.quantity || '1')), true)}</td>
                  <td className="px-1">
                    <button type="button" className="px-1 text-ink-3 hover:text-bad" title="Ta bort raden" onClick={() => setLines(lines.filter((_, n) => n !== i))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end gap-8 border-t border-line px-4 py-3 text-[13px]">
            <span className="text-ink-2">Netto {fmtOre(net, true)}</span>
            <span className="text-ink-2">Moms {fmtOre(vat, true)}</span>
            <span className="font-semibold">Summa {fmtOre(net + vat, true)}</span>
          </div>
        </Card>
        {fe('lines') && <div className="mt-2 text-[12px] text-bad">{fe('lines')}</div>}
      </div>

      {error && !error.fields.length && <ErrorNote message={error.message} />}
      {error && error.fields.length > 0 && <ErrorNote message={error.fields.map((f) => f.message).join('. ')} />}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        )}
        <Button type="submit" disabled={busy || !customerId}>
          {initial.id ? 'Spara utkast' : 'Spara som utkast'}
        </Button>
      </div>
    </form>
  );
}
