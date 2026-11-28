'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Input, Select } from './ui';
import { api, ApiError } from '@/lib/api';
import type { WorkOrderDetail, WorkOrderOptions } from '@/lib/work-orders';

export function useWorkOrderOptions(version?: number) {
  const [opts, setOpts] = useState<WorkOrderOptions | null>(null);
  useEffect(() => {
    api<WorkOrderOptions>('/work-orders/options').then(setOpts);
  }, [version]);
  return opts;
}

const textarea =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={4} {...props} className={`${textarea} ${props.className ?? ''}`} />;
}

interface Values {
  propertyId: string;
  objectId: string;
  customerId: string;
  title: string;
  description: string;
  category: string;
  location: string;
  priority: string;
  source: string;
  reporterName: string;
  reporterEmail: string;
  reporterPhone: string;
  masterKeyOk: boolean;
  accessNote: string;
  notifyReporter: boolean;
  assigneeUserId: string;
  supplierId: string;
  dueDate: string;
  scheduledDate: string;
  costEstimate: string;
  chargeable: boolean;
}

function initialValues(d?: WorkOrderDetail | null, propertyId?: string): Values {
  return {
    propertyId: d?.propertyId ?? propertyId ?? '',
    objectId: d?.objectId ?? '',
    customerId: d?.customerId ?? '',
    title: d?.title ?? '',
    description: d?.description ?? '',
    category: d?.category ?? 'other',
    location: d?.location ?? '',
    priority: d?.priority ?? 'normal',
    source: 'phone',
    reporterName: d?.reporterName ?? '',
    reporterEmail: d?.reporterEmail ?? '',
    reporterPhone: d?.reporterPhone ?? '',
    masterKeyOk: d?.masterKeyOk ?? false,
    accessNote: d?.accessNote ?? '',
    notifyReporter: d?.notifyReporter ?? true,
    assigneeUserId: d?.assigneeUserId ?? '',
    supplierId: d?.supplierId ?? '',
    dueDate: d?.dueDate ?? '',
    scheduledDate: d?.scheduledDate ?? '',
    costEstimate: d?.costEstimateOre ? String(d.costEstimateOre / 100) : '',
    chargeable: d?.chargeable ?? false,
  };
}

/** Formulär för nytt ärende eller för att ändra ett befintligt. */
export function WorkOrderForm({
  initial,
  propertyId,
  onSaved,
  onCancel,
}: {
  initial?: WorkOrderDetail | null;
  propertyId?: string;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const opts = useWorkOrderOptions();
  const [v, setV] = useState<Values>(() => initialValues(initial, propertyId));
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((s) => ({ ...s, [k]: val }));

  const objects = opts?.objects.filter((o) => o.propertyId === v.propertyId) ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const body: Record<string, unknown> = {
      propertyId: v.propertyId || undefined,
      objectId: v.objectId || null,
      customerId: v.customerId || null,
      title: v.title,
      description: v.description,
      category: v.category,
      location: v.location,
      priority: v.priority,
      reporterName: v.reporterName,
      reporterEmail: v.reporterEmail,
      reporterPhone: v.reporterPhone,
      masterKeyOk: v.masterKeyOk,
      accessNote: v.accessNote,
      notifyReporter: v.notifyReporter,
      assigneeUserId: v.assigneeUserId || null,
      supplierId: v.supplierId || null,
      dueDate: v.dueDate || null,
      scheduledDate: v.scheduledDate || null,
      costEstimate: v.costEstimate ? Number(v.costEstimate.replace(/\s/g, '').replace(',', '.')) : null,
      chargeable: v.chargeable,
    };
    if (!initial) body.source = v.source;
    if (!initial && !v.assigneeUserId) delete body.assigneeUserId;
    if (!initial && !v.dueDate) delete body.dueDate;
    try {
      const r = initial
        ? await api<WorkOrderDetail>(`/work-orders/${initial.id}`, { method: 'PUT', body, companyId: initial.companyId })
        : await api<{ id: string }>('/work-orders', { method: 'POST', body });
      onSaved(r.id);
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.message);
      setFields(Object.fromEntries((ae.fields ?? []).map((f) => [f.path, f.message])));
      setBusy(false);
    }
  }

  if (!opts) return null;
  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorNote message={error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fastighet" error={fields.propertyId}>
          <Select value={v.propertyId} onChange={(e) => setV((s) => ({ ...s, propertyId: e.target.value, objectId: '', customerId: '' }))} required>
            <option value="">Välj fastighet</option>
            {opts.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Objekt" hint="Lämna tomt för gemensamma utrymmen">
          <Select
            value={v.objectId}
            onChange={(e) => {
              const o = objects.find((x) => x.id === e.target.value);
              setV((s) => ({ ...s, objectId: e.target.value, customerId: o?.customerId ?? (e.target.value ? s.customerId : '') }));
            }}
          >
            <option value="">Gemensamt / hela fastigheten</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.objectNr}
                {o.customerName ? ` · ${o.customerName}` : ' · vakant'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Vad är fel?" error={fields.title}>
        <Input value={v.title} onChange={(e) => set('title', e.target.value)} placeholder="T.ex. Kranen i köket droppar" required maxLength={200} />
      </Field>
      <Field label="Beskrivning">
        <TextArea value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={5000} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Kategori">
          <Select value={v.category} onChange={(e) => set('category', e.target.value)}>
            {opts.categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Plats i lägenheten">
          <Input value={v.location} onChange={(e) => set('location', e.target.value)} placeholder="T.ex. Badrum" maxLength={200} />
        </Field>
        <Field label="Prioritet">
          <Select value={v.priority} onChange={(e) => set('priority', e.target.value)}>
            {opts.priorities.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {!initial && (
        <Field label="Hur kom ärendet in?">
          <Select value={v.source} onChange={(e) => set('source', e.target.value)}>
            <option value="phone">Telefon</option>
            <option value="email">E-post</option>
            <option value="inspection">Besiktning eller rondering</option>
            <option value="manual">Annat</option>
          </Select>
        </Field>
      )}

      <div className="border-t border-line pt-4 text-[12px] font-medium text-ink-3">Anmälare</div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Namn">
          <Input value={v.reporterName} onChange={(e) => set('reporterName', e.target.value)} maxLength={200} />
        </Field>
        <Field label="Telefon">
          <Input value={v.reporterPhone} onChange={(e) => set('reporterPhone', e.target.value)} maxLength={50} />
        </Field>
        <Field label="E-post" error={fields.reporterEmail}>
          <Input type="email" value={v.reporterEmail} onChange={(e) => set('reporterEmail', e.target.value)} maxLength={200} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.masterKeyOk} onChange={(e) => set('masterKeyOk', e.target.checked)} />
          Huvudnyckel får användas
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.notifyReporter} onChange={(e) => set('notifyReporter', e.target.checked)} />
          Anmälaren får besked med e-post
        </label>
      </div>
      <Field label="Tillträde och övrigt" hint="T.ex. hund i lägenheten, hemma efter kl. 16">
        <Input value={v.accessNote} onChange={(e) => set('accessNote', e.target.value)} maxLength={1000} />
      </Field>

      <div className="border-t border-line pt-4 text-[12px] font-medium text-ink-3">Handläggning</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ansvarig" hint={!initial ? 'Lämnas tomt blir det du' : undefined}>
          <Select value={v.assigneeUserId} onChange={(e) => set('assigneeUserId', e.target.value)}>
            <option value="">{initial ? 'Ingen' : 'Jag'}</option>
            {opts.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hantverkare" hint="Ur leverantörsregistret">
          <Select value={v.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
            <option value="">Ingen än</option>
            {opts.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.email ? '' : ' (saknar e-post)'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Klart senast" hint={!initial ? 'Lämnas tomt räknas det fram ur prioriteten' : undefined}>
          <Input type="date" value={v.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </Field>
        <Field label="Planerat datum">
          <Input type="date" value={v.scheduledDate} onChange={(e) => set('scheduledDate', e.target.value)} />
        </Field>
        <Field label="Kostnadsram (kr exkl. moms)">
          <Input inputMode="decimal" value={v.costEstimate} onChange={(e) => set('costEstimate', e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={v.chargeable} onChange={(e) => set('chargeable', e.target.checked)} />
        Kostnaden ska debiteras hyresgästen (t.ex. skada som hyresgästen orsakat)
      </label>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={busy}>
          {initial ? 'Spara' : 'Registrera ärende'}
        </Button>
      </div>
    </form>
  );
}
