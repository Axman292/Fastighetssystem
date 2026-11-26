'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select, cx } from './ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre, todayIso } from '@/lib/format';
import type { Account, Supplier, SupplierInvoiceDetail } from '@/lib/suppliers';

interface DraftLine {
  accountNumber: string;
  description: string;
  propertyId: string;
  objectId: string;
  costCenterId: string;
  net: string;
  vat: string;
  vatDeductible: boolean;
  periodFrom: string;
  periodTo: string;
  share?: number;
}

interface PropertyOption {
  id: string;
  name: string;
  category: string;
}

const num = (s: string) => {
  const n = Number(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const ore = (s: string) => Math.round(num(s) * 100);
const emptyLine = (accountNumber = ''): DraftLine => ({
  accountNumber,
  description: '',
  propertyId: '',
  objectId: '',
  costCenterId: '',
  net: '',
  vat: '',
  vatDeductible: true,
  periodFrom: '',
  periodTo: '',
});

/** Bostäder är momsfria, så momsen på deras kostnader går inte att dra av. */
const deductibleFor = (p?: PropertyOption) => !p || !['residential'].includes(p.category);

/** Registrering och kontering av en leverantörsfaktura. */
export function SupplierInvoiceForm({
  initial,
  initialSupplierId,
  onSaved,
  onCancel,
}: {
  initial?: SupplierInvoiceDetail;
  initialSupplierId?: string;
  onSaved: (id: string) => void;
  onCancel?: () => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [objects, setObjects] = useState<Record<string, { id: string; objectNr: string }[]>>({});
  const [costCenters, setCostCenters] = useState<{ id: string; code: string; name: string }[]>([]);

  const credit = initial?.kind === 'credit_note';
  // Beloppen visas utan minustecken på kreditfakturor
  const show = (o: number) => (o ? String((credit ? -o : o) / 100).replace('.', ',') : '');
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? initialSupplierId ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'invoice');
  const [invoiceNr, setInvoiceNr] = useState(initial?.invoiceNr ?? '');
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoiceDate ?? todayIso());
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [ocr, setOcr] = useState(initial?.ocr ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [net, setNet] = useState(initial ? show(initial.netOre) : '');
  const [vat, setVat] = useState(initial ? show(initial.vatOre) : '');
  const [total, setTotal] = useState(initial ? show(initial.totalOre) : '');
  const [lines, setLines] = useState<DraftLine[]>(
    initial?.lines.length
      ? initial.lines.map((l) => ({
          accountNumber: l.accountNumber,
          description: l.description ?? '',
          propertyId: l.propertyId ?? '',
          objectId: l.objectId ?? '',
          costCenterId: l.costCenterId ?? '',
          net: show(l.netOre),
          vat: show(l.vatOre),
          vatDeductible: l.vatDeductible,
          periodFrom: l.periodFrom ?? '',
          periodTo: l.periodTo ?? '',
        }))
      : [emptyLine()],
  );
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Supplier[]>('/suppliers').then((r) => setSuppliers(r.filter((s) => s.active || s.id === supplierId)));
    api<Account[]>('/accounts').then((r) => setAccounts(r.filter((a) => a.active && a.number >= '1000')));
    api<PropertyOption[]>('/properties').then(setProperties);
    api<{ id: string; code: string; name: string; active: boolean }[]>('/cost-centers').then((r) => setCostCenters(r.filter((c) => c.active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialSupplierId && !initial) pickSupplier(initialSupplierId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Objekt per vald fastighet
  const propertyIds = useMemo(() => [...new Set(lines.map((l) => l.propertyId).filter(Boolean))], [lines]);
  useEffect(() => {
    for (const pid of propertyIds) {
      if (objects[pid]) continue;
      api<{ id: string; objectNr: string }[]>(`/objects?propertyId=${pid}`).then((r) => setObjects((o) => ({ ...o, [pid]: r })));
    }
  }, [propertyIds, objects]);

  // Förslag på kontering när leverantören väljs för en ny faktura
  async function pickSupplier(id: string) {
    setSupplierId(id);
    if (initial || !id) return;
    const s = await api<{ defaultAccount: string | null; fromInvoiceDate: string | null; lines: (Omit<DraftLine, 'net' | 'vat' | 'periodFrom' | 'periodTo'> & { share: number })[] }>(
      `/suppliers/${id}/suggestion`,
    );
    const blank = lines.every((l) => !l.net && !l.accountNumber && !l.propertyId);
    if (!blank) return;
    if (s.lines.length) {
      setLines(
        s.lines.map((l) => ({
          ...emptyLine(l.accountNumber),
          description: l.description ?? '',
          propertyId: l.propertyId ?? '',
          objectId: l.objectId ?? '',
          costCenterId: l.costCenterId ?? '',
          vatDeductible: l.vatDeductible,
          share: l.share,
        })),
      );
      setSuggestedFrom(s.fromInvoiceDate);
    } else if (s.defaultAccount) {
      setLines([emptyLine(s.defaultAccount)]);
    }
  }

  const sign = kind === 'credit_note' ? -1 : 1;
  const netOre = ore(net);
  const vatOre = ore(vat);
  const totalOre = total.trim() ? ore(total) : netOre + vatOre;
  const lineNet = lines.reduce((s, l) => s + ore(l.net), 0);
  const lineVat = lines.reduce((s, l) => s + ore(l.vat), 0);
  const leftNet = netOre - lineNet;
  const leftVat = vatOre - lineVat;

  /** Fördelar fakturans netto och moms på raderna: efter förra fakturans andelar, annars det som är kvar på sista raden. */
  function distribute() {
    const shares = lines.map((l) => l.share ?? 0);
    const sum = shares.reduce((a, b) => a + b, 0);
    let restNet = netOre;
    let restVat = vatOre;
    setLines(
      lines.map((l, i) => {
        const last = i === lines.length - 1;
        const part = sum > 0 ? shares[i] / sum : last ? 1 : 0;
        const n = last ? restNet : sum > 0 ? Math.round(netOre * part) : ore(l.net);
        const v = last ? restVat : sum > 0 ? Math.round(vatOre * part) : ore(l.vat);
        restNet -= n;
        restVat -= v;
        return { ...l, net: n ? String(n / 100).replace('.', ',') : '', vat: v ? String(v / 100).replace('.', ',') : '' };
      }),
    );
  }

  const setLine = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      supplierId,
      kind,
      invoiceNr,
      invoiceDate,
      dueDate: dueDate || null,
      ocr: ocr || null,
      description: description || null,
      net: (sign * netOre) / 100,
      vat: (sign * vatOre) / 100,
      total: (sign * totalOre) / 100,
      lines: lines
        .filter((l) => l.accountNumber || l.net.trim())
        .map((l) => ({
          accountNumber: l.accountNumber,
          description: l.description || null,
          propertyId: l.propertyId || null,
          objectId: l.objectId || null,
          costCenterId: l.costCenterId || null,
          net: (sign * ore(l.net)) / 100,
          vat: (sign * ore(l.vat)) / 100,
          vatDeductible: l.vatDeductible,
          periodFrom: l.periodFrom || null,
          periodTo: l.periodTo || null,
        })),
    };
    try {
      if (initial) {
        await api(`/supplier-invoices/${initial.id}`, { method: 'PUT', body, companyId: initial.companyId });
        onSaved(initial.id);
      } else {
        const r = await api<{ id: string }>('/supplier-invoices', { method: 'POST', body });
        onSaved(r.id);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const accountLabel = (a: Account) => `${a.number} ${a.name}`;

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card className="grid grid-cols-4 gap-x-4 gap-y-3.5 p-5">
        <div className="col-span-2">
          <Field label="Leverantör" error={fe('supplierId')}>
            <Select value={supplierId} onChange={(e) => pickSupplier(e.target.value)} required>
              <option value="">Välj leverantör</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.supplierNr})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Typ">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="invoice">Faktura</option>
            <option value="credit_note">Kreditfaktura</option>
          </Select>
        </Field>
        <Field label="Leverantörens fakturanummer" error={fe('invoiceNr')}>
          <Input value={invoiceNr} onChange={(e) => setInvoiceNr(e.target.value)} required />
        </Field>
        <Field label="Fakturadatum" error={fe('invoiceDate')}>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required />
        </Field>
        <Field label="Förfallodatum" error={fe('dueDate')} hint="Tomt = leverantörens villkor">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="OCR eller meddelande" error={fe('ocr')}>
          <Input value={ocr} onChange={(e) => setOcr(e.target.value)} />
        </Field>
        <Field label="Beskrivning">
          <Input value={description} placeholder="Till exempel Värme januari" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Belopp exkl. moms (kr)" error={fe('net')}>
          <Input inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} required />
        </Field>
        <Field label="Moms (kr)" error={fe('vat')}>
          <Input inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
        </Field>
        <Field label="Att betala (kr)" error={fe('total')} hint={`Tomt = ${fmtOre(netOre + vatOre, true)}`}>
          <Input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        {kind === 'credit_note' && <div className="self-end pb-2 text-[12px] text-ink-3">Ange beloppen utan minustecken.</div>}
      </Card>

      <div>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold">Kontering</h2>
            <p className="text-[12px] text-ink-3">
              Vilket konto och vilken fastighet kostnaden hör till. Ange period om fakturan avser flera månader, till exempel en årspremie.
              {suggestedFrom && ` Förslaget kommer från leverantörens faktura ${suggestedFrom}.`}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={distribute} disabled={!netOre}>
              Fördela beloppen
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setLines([...lines, emptyLine(lines[lines.length - 1]?.accountNumber)])}>
              Ny rad
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const prop = properties.find((p) => p.id === l.propertyId);
            const objs = l.propertyId ? (objects[l.propertyId] ?? []) : [];
            return (
              <Card key={i} className="grid grid-cols-12 gap-x-3 gap-y-2 p-3">
                <div className="col-span-4">
                  <Field label="Konto" error={fe(`lines.${i}.accountNumber`)}>
                    <Select value={l.accountNumber} onChange={(e) => setLine(i, { accountNumber: e.target.value })}>
                      <option value="">Välj konto</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.number}>
                          {accountLabel(a)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="col-span-3">
                  <Field label="Fastighet" error={fe(`lines.${i}.propertyId`)}>
                    <Select
                      value={l.propertyId}
                      onChange={(e) => {
                        const p = properties.find((x) => x.id === e.target.value);
                        setLine(i, { propertyId: e.target.value, objectId: '', vatDeductible: deductibleFor(p) });
                      }}
                    >
                      <option value="">Bolaget (ingen fastighet)</option>
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Objekt" error={fe(`lines.${i}.objectId`)}>
                    <Select value={l.objectId} onChange={(e) => setLine(i, { objectId: e.target.value })} disabled={!objs.length}>
                      <option value="">–</option>
                      {objs.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.objectNr}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="col-span-3">
                  <Field label="Kostnadsställe" error={fe(`lines.${i}.costCenterId`)}>
                    <Select value={l.costCenterId} onChange={(e) => setLine(i, { costCenterId: e.target.value })} disabled={!costCenters.length}>
                      <option value="">–</option>
                      {costCenters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="col-span-3">
                  <Field label="Text">
                    <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Belopp exkl. moms" error={fe(`lines.${i}.net`)}>
                    <Input inputMode="decimal" value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Moms">
                    <Input inputMode="decimal" value={l.vat} onChange={(e) => setLine(i, { vat: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Avser från" error={fe(`lines.${i}.periodFrom`)}>
                    <Input type="date" value={l.periodFrom} onChange={(e) => setLine(i, { periodFrom: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Avser till" error={fe(`lines.${i}.periodTo`)}>
                    <Input type="date" value={l.periodTo} onChange={(e) => setLine(i, { periodTo: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-1 flex items-end justify-end pb-1">
                  <button type="button" className="px-1 text-[16px] text-ink-3 hover:text-bad" title="Ta bort raden" onClick={() => setLines(lines.length > 1 ? lines.filter((_, n) => n !== i) : [emptyLine()])}>
                    ×
                  </button>
                </div>
                <label className="col-span-12 flex items-center gap-2 text-[12px] text-ink-2">
                  <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={l.vatDeductible} onChange={(e) => setLine(i, { vatDeductible: e.target.checked })} />
                  Momsen är avdragsgill
                  {!l.vatDeductible && <span className="text-ink-3">– momsen räknas som kostnad{prop?.category === 'residential' ? ' (bostadsfastighet)' : ''}</span>}
                </label>
              </Card>
            );
          })}
        </div>
        <div className="mt-2 flex justify-end gap-6 text-[13px]">
          <span className="text-ink-2">Konterat {fmtOre(lineNet, true)} + moms {fmtOre(lineVat, true)}</span>
          <span className={cx('font-medium', leftNet || leftVat ? 'text-warn' : 'text-good')}>
            {leftNet || leftVat ? `Kvar att kontera: ${fmtOre(leftNet, true)} + moms ${fmtOre(leftVat, true)}` : 'Hela beloppet är konterat'}
          </span>
        </div>
      </div>

      {error && <ErrorNote message={error.fields.length ? error.fields.map((f) => f.message).join('. ') : error.message} />}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        )}
        <Button type="submit" disabled={busy || !supplierId}>
          {initial ? 'Spara ändringar' : 'Registrera faktura'}
        </Button>
      </div>
    </form>
  );
}
