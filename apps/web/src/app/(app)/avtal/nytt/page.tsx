'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { CONTRACT_TYPE_LABEL, OBJECT_STATUS, OBJECT_TYPE_LABEL, RESIDENTIAL_TYPES, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { ObjectRow } from '@/components/object-table';

interface CustomerOption {
  id: string;
  customerNr: number;
  name: string;
  nationalId: string | null;
}

const TYPE_FOR_OBJECT: Record<string, string> = {
  apartment: 'residential',
  hotel_apartment: 'residential',
  parking: 'parking',
  storage: 'storage',
  commercial: 'commercial',
  office: 'commercial',
  restaurant: 'commercial',
  hotel_room: 'commercial',
};

/** Standardvillkor per avtalstyp, som kan ändras innan avtalet skapas. */
const DEFAULTS: Record<string, { noticeMonths: string; extensionMonths: string; fixed: boolean; index: boolean }> = {
  residential: { noticeMonths: '3', extensionMonths: '', fixed: false, index: false },
  commercial: { noticeMonths: '9', extensionMonths: '36', fixed: true, index: true },
  parking: { noticeMonths: '1', extensionMonths: '', fixed: false, index: false },
  storage: { noticeMonths: '1', extensionMonths: '', fixed: false, index: false },
  other: { noticeMonths: '3', extensionMonths: '', fixed: false, index: false },
};

function firstOfNextMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

function plusYears(iso: string, years: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function NewContractPage() {
  return (
    <Suspense>
      <NewContract />
    </Suspense>
  );
}

function NewContract() {
  const { active, version } = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [objects, setObjects] = useState<ObjectRow[]>([]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>(() => (search.get('objectId') ? [search.get('objectId')!] : []));
  const [customerId, setCustomerId] = useState(search.get('customerId') ?? '');
  const [type, setType] = useState('');
  const [startDate, setStartDate] = useState(firstOfNextMonth());
  const [fixed, setFixed] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [noticeMonths, setNoticeMonths] = useState('3');
  const [extensionMonths, setExtensionMonths] = useState('');
  const [billingInterval, setBillingInterval] = useState('month');
  const [useIndex, setUseIndex] = useState(false);
  const [specialTerms, setSpecialTerms] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CustomerOption[]>('/customers').then(setCustomers);
    api<ObjectRow[]>('/objects').then(setObjects);
  }, [version]);

  const chosen = objects.filter((o) => selected.includes(o.id));
  // Avtalstyp följer första valda objektet tills användaren väljer själv
  const effectiveType = type || (chosen[0] ? (TYPE_FOR_OBJECT[chosen[0].type] ?? 'other') : '');
  useEffect(() => {
    if (!effectiveType) return;
    const d = DEFAULTS[effectiveType];
    setNoticeMonths(d.noticeMonths);
    setExtensionMonths(d.extensionMonths);
    setFixed(d.fixed);
    setUseIndex(d.index);
  }, [effectiveType]);
  useEffect(() => {
    if (fixed && !endDate) setEndDate(plusYears(startDate, 3));
  }, [fixed, startDate, endDate]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return objects
      .filter((o) => o.active)
      .filter((o) => !s || `${o.objectNr} ${o.propertyName} ${o.addressLine ?? ''}`.toLowerCase().includes(s))
      .sort((a, b) => Number(b.status === 'vacant') - Number(a.status === 'vacant'));
  }, [objects, q]);

  const monthly = chosen.reduce((s, o) => s + (o.monthlyRentOre ?? 0), 0);
  const residentialMismatch = effectiveType !== 'residential' && chosen.some((o) => RESIDENTIAL_TYPES.has(o.type));

  if (!active) {
    return (
      <>
        <PageHeader title="Nytt avtal" />
        <Card className="px-6 py-12 text-center text-[13px] text-ink-2">Välj ett bolag i menyn uppe till vänster för att skapa avtal.</Card>
      </>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const startYear = Number(startDate.slice(0, 4));
      const k = await api<{ id: string }>('/contracts', {
        method: 'POST',
        body: {
          type: effectiveType || 'other',
          customerId,
          startDate,
          endDate: fixed ? endDate || null : null,
          noticeMonths: Number(noticeMonths || 0),
          extensionMonths: fixed && extensionMonths ? Number(extensionMonths) : null,
          billingInterval,
          specialTerms: specialTerms || null,
          objectIds: selected,
          indexClause: useIndex ? { baseYear: startYear - 1 } : null,
        },
      });
      router.push(`/avtal/${k.id}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  }
  const fe = (k: string) => error?.fields.find((f) => f.path === k || f.path.startsWith(`${k}.`))?.message;

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        / Nytt avtal
      </div>
      <PageHeader
        title="Nytt avtal"
        description={`Avtalet skapas som utkast i ${active.companyName}. Hyresrader fylls i från objektens hyra och kan ändras innan avtalet aktiveras.`}
      />
      <div className="grid grid-cols-[1fr_360px] gap-6">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-[14px] font-semibold">Objekt</h2>
            <Input placeholder="Sök objekt eller fastighet" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="mt-3 max-h-80 divide-y divide-line overflow-y-auto rounded-md border border-line">
              {visible.map((o) => {
                const s = OBJECT_STATUS[o.status ?? 'vacant'];
                const on = selected.includes(o.id);
                return (
                  <label key={o.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-subtle/60">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setSelected(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])}
                      className="size-4 accent-[var(--color-accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">
                        {o.objectNr} <span className="font-normal text-ink-3">· {OBJECT_TYPE_LABEL[o.type]}</span>
                      </div>
                      <div className="truncate text-[12px] text-ink-3">
                        {o.propertyName}
                        {o.addressLine ? `, ${o.addressLine}` : ''}
                        {o.tenantName ? ` · ${o.tenantName}` : ''}
                      </div>
                    </div>
                    <div className="text-[12px] tabular text-ink-2">{fmtOre(o.monthlyRentOre)}</div>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </label>
                );
              })}
              {visible.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-ink-3">Inga objekt.</div>}
            </div>
            <p className="mt-2 text-[12px] text-ink-3">Uthyrda objekt kan väljas om avtalet börjar efter att nuvarande avtal slutar.</p>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-[14px] font-semibold">Villkor</h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              <Field label="Avtalstyp">
                <Select value={effectiveType} onChange={(e) => setType(e.target.value)}>
                  {!effectiveType && <option value="">Välj</option>}
                  {Object.entries(CONTRACT_TYPE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Avtalet börjar" error={fe('startDate')}>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <div className="col-span-2 flex gap-4 text-[13px]">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!fixed} onChange={() => setFixed(false)} className="accent-[var(--color-accent)]" />
                  Tills vidare
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={fixed} onChange={() => setFixed(true)} className="accent-[var(--color-accent)]" />
                  Tidsbestämt
                </label>
              </div>
              {fixed && (
                <>
                  <Field label="Avtalet slutar" error={fe('endDate')}>
                    <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  </Field>
                  <Field label="Förlängning (månader)" hint="Tom = upphör vid avtalstidens slut">
                    <Input inputMode="numeric" value={extensionMonths} onChange={(e) => setExtensionMonths(e.target.value)} />
                  </Field>
                </>
              )}
              <Field label="Uppsägningstid (månader)" error={fe('noticeMonths')}>
                <Input inputMode="numeric" value={noticeMonths} onChange={(e) => setNoticeMonths(e.target.value)} />
              </Field>
              <Field label="Aviseras">
                <Select value={billingInterval} onChange={(e) => setBillingInterval(e.target.value)}>
                  <option value="month">Månadsvis</option>
                  <option value="quarter">Kvartalsvis</option>
                </Select>
              </Field>
              <label className="col-span-2 flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={useIndex} onChange={(e) => setUseIndex(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                Indexklausul (KPI, bas oktober {Number(startDate.slice(0, 4)) - 1})
                <span className="text-[12px] text-ink-3">Vanligt för lokaler</span>
              </label>
              <div className="col-span-2">
                <Field label="Särskilda villkor" hint="Skrivs in i avtalet, till exempel verksamhet eller hyresgästens åtaganden">
                  <textarea
                    value={specialTerms}
                    onChange={(e) => setSpecialTerms(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </Field>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-3 text-[14px] font-semibold">Hyresgäst</h2>
            <Field label="Hyresgäst" error={fe('customerId')}>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Välj hyresgäst</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.customerNr})
                  </option>
                ))}
              </Select>
            </Field>
            <Link href="/kunder" className="mt-2 inline-block text-[12px] text-accent hover:underline">
              Lägg till ny hyresgäst
            </Link>
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 text-[14px] font-semibold">Sammanfattning</h2>
            <dl className="space-y-2 text-[13px]">
              <Row label="Typ" value={effectiveType ? CONTRACT_TYPE_LABEL[effectiveType] : '–'} />
              <Row label="Objekt" value={chosen.map((o) => o.objectNr).join(', ') || '–'} />
              <Row label="Hyra per månad" value={fmtOre(monthly)} />
              <Row label="Period" value={`${startDate} – ${fixed ? endDate || '?' : 'tills vidare'}`} />
            </dl>
            {residentialMismatch && (
              <div className="mt-3">
                <ErrorNote message="Bostäder kan bara ingå i bostadsavtal." />
              </div>
            )}
            {error && !error.fields.length && (
              <div className="mt-3">
                <ErrorNote message={error.message} />
              </div>
            )}
            <Button className="mt-4 w-full" disabled={busy || !customerId || !effectiveType || startDate < '1990-01-01'} onClick={submit}>
              Skapa utkast
            </Button>
            <p className="mt-2 text-[12px] text-ink-3">Inget skickas till hyresgästen. Du granskar och aktiverar avtalet i nästa steg.</p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right tabular">{value}</dd>
    </div>
  );
}

