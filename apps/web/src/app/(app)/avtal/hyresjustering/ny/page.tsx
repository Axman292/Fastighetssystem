'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Td, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { articleOptions, useArticles } from '@/lib/articles';
import { CONTRACT_TYPE_LABEL, OBJECT_TYPE_LABEL, fmtOre, formatDate } from '@/lib/format';
import { useSession } from '@/lib/session';

type Status = 'ready' | 'indexed' | 'same_day' | 'later_change' | 'negative' | 'unchanged';

interface Row {
  key: string;
  kind: 'line' | 'object';
  contractId: string | null;
  contractNr: number | null;
  contractType: string | null;
  customerName: string | null;
  objectId: string | null;
  objectNr: string | null;
  objectType: string | null;
  propertyName: string | null;
  article: string | null;
  description: string;
  currentOre: number;
  newOre: number;
  status: Status;
  invoiced: boolean;
  indexed: boolean;
}

interface Preview {
  rows: Row[];
  summary: { ready: number; contracts: number; beforeOre: number; afterOre: number; linkedObjects: number };
}

const STATUS: Record<Status, { label: string; tone: 'good' | 'warn' | 'neutral' | 'bad' }> = {
  ready: { label: 'Ändras', tone: 'good' },
  indexed: { label: 'Indexklausul', tone: 'neutral' },
  same_day: { label: 'Redan ändrad från datumet', tone: 'neutral' },
  later_change: { label: 'Har en senare ändring', tone: 'warn' },
  negative: { label: 'Blir negativ', tone: 'bad' },
  unchanged: { label: 'Ingen ändring', tone: 'neutral' },
};

const PRESETS: { label: string; types: string[] }[] = [
  { label: 'Bostäder', types: ['apartment', 'hotel_apartment'] },
  { label: 'Lokaler', types: ['commercial', 'office', 'restaurant'] },
  { label: 'Parkering och förråd', types: ['parking', 'storage'] },
  { label: 'Alla', types: [] },
];

function nextJanuary(): string {
  return `${new Date().getFullYear() + 1}-01-01`;
}

export default function NewRentAdjustmentPage() {
  const router = useRouter();
  const { active, can, version } = useSession();
  const { articles } = useArticles();
  const [properties, setProperties] = useState<{ id: string; name: string; designation: string }[]>([]);

  const [name, setName] = useState(`Hyreshöjning bostäder ${new Date().getFullYear() + 1}`);
  const [effectiveDate, setEffectiveDate] = useState(nextJanuary());
  const [method, setMethod] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<'none' | 'krona' | 'ten'>('krona');
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [objectTypes, setObjectTypes] = useState<string[]>(PRESETS[0].types);
  const [contractTypes, setContractTypes] = useState<string[]>([]);
  const [articleCodes, setArticleCodes] = useState<string[]>(['rent']);
  const [includeIndexed, setIncludeIndexed] = useState(false);
  const [updateObjectRent, setUpdateObjectRent] = useState(true);
  const [reason, setReason] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'ready' | 'skipped'>('all');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ id: string; name: string; designation: string }[]>('/properties').then(setProperties);
    setPropertyIds([]);
  }, [version]);

  const numeric = Number(value.replace(/\s/g, '').replace(',', '.'));
  const valid = value.trim() !== '' && Number.isFinite(numeric) && numeric !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) && articleCodes.length > 0;

  const criteria = useMemo(
    () => ({
      effectiveDate,
      method,
      percent: method === 'percent' ? numeric : null,
      amount: method === 'amount' ? numeric : null,
      rounding,
      propertyIds,
      objectTypes,
      contractTypes,
      articles: articleCodes,
      includeIndexed,
      updateObjectRent,
    }),
    [effectiveDate, method, numeric, rounding, propertyIds, objectTypes, contractTypes, articleCodes, includeIndexed, updateObjectRent],
  );

  // Förhandsvisningen räknas om när urvalet ändras.
  useEffect(() => {
    if (!valid) {
      setPreview(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api<Preview>('/rent-adjustments/preview', { method: 'POST', body: criteria })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
          setExcluded(new Set());
        })
        .catch((e) => setPreviewError((e as ApiError).message))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [criteria, valid, version]);

  const rows = preview?.rows ?? [];
  const chosen = rows.filter((r) => r.status === 'ready' && !excluded.has(r.key));
  const chosenLines = chosen.filter((r) => r.kind === 'line');
  const before = chosenLines.reduce((s, r) => s + r.currentOre, 0);
  const after = chosenLines.reduce((s, r) => s + r.newOre, 0);
  const readyRows = rows.filter((r) => r.status === 'ready');
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'ready' ? r.status === 'ready' : r.status !== 'ready'));
  const invoicedCount = chosen.filter((r) => r.invoiced).length;
  const allChecked = readyRows.length > 0 && readyRows.every((r) => !excluded.has(r.key));

  const toggle = (key: string) =>
    setExcluded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>('/rent-adjustments', {
        method: 'POST',
        body: { ...criteria, name, reason: reason.trim() || null, excludeKeys: [...excluded] },
      });
      router.push(`/avtal/hyresjustering/${r.id}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  }

  const options = articleOptions(articles, active?.companyId);

  if (!active || !can('contract.write')) {
    return (
      <>
        <PageHeader title="Ny hyresjustering" />
        <p className="text-[13px] text-ink-2">Välj ett bolag i menyn till vänster. En hyresjustering görs alltid för ett bolag i taget.</p>
      </>
    );
  }

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        /{' '}
        <Link href="/avtal/hyresjustering" className="hover:text-ink">
          Hyresjustering
        </Link>{' '}
        / Ny
      </div>
      <PageHeader
        title="Ny hyresjustering"
        description={`Välj vilka objekt som ska få ny hyra i ${active.companyName}, och hur mycket. Granska listan och genomför när den stämmer.`}
      />

      <div className="grid grid-cols-[340px_1fr] items-start gap-6">
        <Card className="space-y-4 p-4">
          <Step n={1} title="Ändring">
            <Field label="Namn" hint="Syns i historiken och på avtalen">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Ny hyra gäller från">
              <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Höj med">
                <Select value={method} onChange={(e) => setMethod(e.target.value as 'percent' | 'amount')}>
                  <option value="percent">Procent</option>
                  <option value="amount">Kronor per månad</option>
                </Select>
              </Field>
              <Field label={method === 'percent' ? 'Procent' : 'Kronor per månad'}>
                <Input inputMode="decimal" placeholder={method === 'percent' ? '3,5' : '250'} value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            </div>
            <p className="-mt-2 text-[12px] text-ink-3">Ett minustecken sänker hyran.</p>
            {method === 'percent' && (
              <Field label="Avrundning">
                <Select value={rounding} onChange={(e) => setRounding(e.target.value as 'none' | 'krona' | 'ten')}>
                  <option value="krona">Till hel krona</option>
                  <option value="ten">Till tiotal kronor</option>
                  <option value="none">Ingen avrundning (öre)</option>
                </Select>
              </Field>
            )}
          </Step>

          <Step n={2} title="Urval">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Objekttyper</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <Chip key={p.label} active={sameSet(objectTypes, p.types)} onClick={() => setObjectTypes(p.types)}>
                    {p.label}
                  </Chip>
                ))}
              </div>
              <CheckList
                options={OBJECT_TYPE_LABEL}
                selected={objectTypes}
                onChange={setObjectTypes}
                allLabel="Alla objekttyper"
              />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Fastigheter</div>
              <CheckList
                options={Object.fromEntries(properties.map((p) => [p.id, p.name]))}
                selected={propertyIds}
                onChange={setPropertyIds}
                allLabel="Alla fastigheter"
              />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Avtalstyper</div>
              <CheckList options={CONTRACT_TYPE_LABEL} selected={contractTypes} onChange={setContractTypes} allLabel="Alla avtalstyper" />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Hyresrader som ändras</div>
              <CheckList options={options} selected={articleCodes} onChange={setArticleCodes} />
              {!articleCodes.length && <p className="mt-1 text-[12px] text-bad">Välj minst en artikel</p>}
            </div>
            <Toggle checked={includeIndexed} onChange={setIncludeIndexed} label="Ta med avtal med indexklausul" hint="De räknas normalt upp med KPI under Indexuppräkning." />
            <Toggle
              checked={updateObjectRent}
              onChange={setUpdateObjectRent}
              label="Ändra också objektens hyra"
              hint="Även lediga objekt får ny hyra, så att nästa avtal får rätt hyra."
            />
          </Step>

          <Step n={3} title="Anledning">
            <Field label="Anledning (frivilligt)" hint="Till exempel förhandlingsprotokoll">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Förhandlat med Hyresgästföreningen" />
            </Field>
          </Step>
        </Card>

        <section className="min-w-0">
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Avtalsrader som ändras" value={preview ? chosenLines.length : '–'} sub={preview ? `${new Set(chosenLines.map((r) => r.contractId)).size} avtal` : undefined} />
            <Stat label="Hyra per månad" value={preview ? fmtOre(after) : '–'} sub={preview ? `i dag ${fmtOre(before)}` : undefined} />
            <Stat
              label="Ökning"
              value={preview ? fmtOre(after - before) : '–'}
              sub={preview ? `per månad, ${fmtOre((after - before) * 12)} per år` : undefined}
            />
          </div>

          {!valid && (
            <Card className="px-4 py-10 text-center text-[13px] text-ink-3">Ange hur mycket hyran ska ändras, så visas vilka avtal och objekt som påverkas.</Card>
          )}
          {valid && previewError && <ErrorNote message={previewError} />}
          {valid && preview && (
            <>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex gap-1">
                  <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
                    Alla {rows.length}
                  </Chip>
                  <Chip active={filter === 'ready'} onClick={() => setFilter('ready')}>
                    Ändras {readyRows.length}
                  </Chip>
                  <Chip active={filter === 'skipped'} onClick={() => setFilter('skipped')}>
                    Hoppas över {rows.length - readyRows.length}
                  </Chip>
                </div>
                <span className="text-[12px] text-ink-3">{loading ? 'Räknar…' : `${chosen.length} av ${readyRows.length} valda`}</span>
              </div>
              {invoicedCount > 0 && (
                <div className="mb-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  {invoicedCount} {invoicedCount === 1 ? 'rad är' : 'rader är'} redan aviserade från {formatDate(effectiveDate)}. Skillnaden läggs automatiskt på nästa avi.
                </div>
              )}
              <div className={cx('transition-opacity', loading && 'opacity-60')}>
                <Table
                  head={[
                    <input
                      key="all"
                      type="checkbox"
                      aria-label="Välj alla"
                      className="size-4 accent-[var(--color-accent)]"
                      checked={allChecked}
                      onChange={() => setExcluded(allChecked ? new Set(readyRows.map((r) => r.key)) : new Set())}
                    />,
                    'Objekt',
                    'Hyresgäst',
                    'Rad',
                    'Nu',
                    'Ny',
                    'Status',
                  ]}
                  empty="Inga avtal eller objekt matchar urvalet."
                >
                  {shown.map((r) => {
                    const ready = r.status === 'ready';
                    const on = ready && !excluded.has(r.key);
                    return (
                      <tr key={r.key} className={cx(!on && 'text-ink-3')}>
                        <Td className="w-10">
                          <input
                            type="checkbox"
                            aria-label={`Välj ${r.objectNr ?? ''}`}
                            className="size-4 accent-[var(--color-accent)]"
                            disabled={!ready}
                            checked={on}
                            onChange={() => toggle(r.key)}
                          />
                        </Td>
                        <Td>
                          <span className={cx('font-medium', on && 'text-ink')}>{r.objectNr}</span>{' '}
                          <span className="text-ink-3">{r.propertyName}</span>
                          <div className="text-[12px] text-ink-3">{r.objectType ? OBJECT_TYPE_LABEL[r.objectType] : ''}</div>
                        </Td>
                        <Td>
                          {r.kind === 'line' ? (
                            <>
                              {r.customerName}
                              <div className="text-[12px] text-ink-3">
                                Avtal{' '}
                                <Link href={`/avtal/${r.contractId}`} className="hover:underline">
                                  {r.contractNr}
                                </Link>
                              </div>
                            </>
                          ) : (
                            <span className="text-ink-3">{r.customerName ? `${r.customerName} (avtalet ändras inte)` : 'Vakant'}</span>
                          )}
                        </Td>
                        <Td className="text-ink-2">{r.description}</Td>
                        <Td className="tabular">{fmtOre(r.currentOre, true)}</Td>
                        <Td className={cx('tabular', on && 'font-medium text-ink')}>{fmtOre(r.newOre, true)}</Td>
                        <Td>
                          <Badge tone={on ? 'good' : ready ? 'neutral' : STATUS[r.status].tone}>{ready && !on ? 'Bortvald' : STATUS[r.status].label}</Badge>
                          {r.invoiced && on && <div className="mt-0.5 text-[11.5px] text-warn">Redan aviserad</div>}
                        </Td>
                      </tr>
                    );
                  })}
                </Table>
              </div>
              {updateObjectRent && preview.summary.linkedObjects > 0 && (
                <p className="mt-2 text-[12px] text-ink-3">Objekt vars avtal ändras får samma ändring av objektets egen hyra.</p>
              )}
            </>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Link href="/avtal/hyresjustering">
              <Button variant="ghost">Avbryt</Button>
            </Link>
            <Button disabled={!preview || !chosen.length || loading || !name.trim()} onClick={() => setConfirm(true)}>
              Genomför för {chosen.length} {chosen.length === 1 ? 'rad' : 'rader'}
            </Button>
          </div>
        </section>
      </div>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Genomför hyresjusteringen">
        <div className="space-y-3 text-[13px]">
          <p className="text-ink-2">
            {chosenLines.length} avtalsrader i {new Set(chosenLines.map((r) => r.contractId)).size} avtal får ny hyra från {formatDate(effectiveDate)}.
            Den gamla hyran avslutas dagen före och finns kvar i historiken.
          </p>
          <p className="text-ink-2">
            Hyran per månad ändras från {fmtOre(before)} till <span className="font-medium text-ink">{fmtOre(after)}</span>.
          </p>
          <p className="text-[12px] text-ink-3">Du kan ångra justeringen så länge den nya hyran inte har aviserats.</p>
          {error && <ErrorNote message={error.fields.length ? error.fields.map((f) => f.message).join('. ') : error.message} />}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Avbryt
            </Button>
            <Button onClick={apply} disabled={busy}>
              {busy ? 'Genomför…' : 'Genomför'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'h-6 rounded-full px-2.5 text-[12px] font-medium transition-colors',
        active ? 'bg-accent-soft text-accent' : 'bg-subtle text-ink-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function CheckList({
  options,
  selected,
  onChange,
  allLabel,
}: {
  options: Record<string, string>;
  selected: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
}) {
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2">
      {allLabel && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={!selected.length} onChange={() => onChange([])} />
          {allLabel}
        </label>
      )}
      {Object.entries(options).map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-accent)]"
            checked={selected.includes(key)}
            onChange={(e) => onChange(e.target.checked ? [...selected, key] : selected.filter((x) => x !== key))}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-[13px]">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-[12px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
