'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Tabs, Td, cx, formatDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtInt, fmtOre } from '@/lib/format';
import { BATCH_STATUS, Batch, FORMAT_LABEL, ImportMeta, ImportRow, Reconciliation, ROW_STATUS, TestResult, uploadFiles } from '@/lib/imports';
import { useSession } from '@/lib/session';

type Step = 'files' | 'mapping' | 'check' | 'test' | 'commit' | 'result' | 'log';

export default function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, active } = useSession();
  const [b, setB] = useState<Batch | null>(null);
  const [meta, setMeta] = useState<ImportMeta | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'commit' | 'rollback' | 'delete' | null>(null);

  const load = useCallback(async () => {
    const batch = await api<Batch>(`/imports/${id}`);
    setB(batch);
    return batch;
  }, [id]);

  useEffect(() => {
    api<ImportMeta>('/imports/meta').then(setMeta);
    load()
      .then((batch) =>
        setStep(
          (s) =>
            s ??
            (batch.status === 'committed' || batch.status === 'rolled_back'
              ? 'result'
              : batch.status === 'tested'
                ? 'commit'
                : batch.status === 'validated'
                  ? 'check'
                  : batch.files.length
                    ? 'mapping'
                    : 'files'),
        ),
      )
      .catch((e) => setError(e.message));
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>, next?: Step) {
    setError(null);
    setBusy(label);
    try {
      await fn();
      await load();
      if (next) setStep(next);
    } catch (e) {
      const err = e as Error & { fields?: unknown };
      setError(err.message);
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  if (!b || !meta || !step) {
    return error ? <ErrorNote message={error} /> : <div className="text-[13px] text-ink-3">Laddar…</div>;
  }

  const editable = b.status !== 'committed' && b.status !== 'rolled_back';
  const allowed = can('import.manage', b.companyId) && active?.companyId === b.companyId;
  const entityLabel = (k: string) => meta.entities.find((e) => e.key === k)?.labelPlural ?? k;
  const errors = b.validation?.totals.error ?? 0;

  const steps: { key: Step; label: string; count?: number }[] = [
    { key: 'files', label: '1 Filer', count: b.files.length },
    { key: 'mapping', label: '2 Mappning' },
    { key: 'check', label: '3 Kontroll', count: b.validation ? b.validation.totals.total : undefined },
    { key: 'test', label: '4 Testimport' },
    { key: 'commit', label: '5 Genomför' },
    { key: 'result', label: 'Avstämning' },
    { key: 'log', label: 'Logg' },
  ];

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/import" className="hover:text-ink">
          Importcentral
        </Link>{' '}
        / Import {b.batchNr}
      </div>
      <PageHeader
        title={b.name}
        description={`${b.adapter.label} → ${b.companyName}`}
        actions={
          <>
            <Badge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</Badge>
            {b.status === 'committed' && allowed && (
              <Button variant="danger" onClick={() => setConfirm('rollback')}>
                Ångra import
              </Button>
            )}
            {(b.status === 'committed' || b.status === 'rolled_back') && allowed && (
              <Button
                variant="secondary"
                onClick={() => run('copy', async () => router.push(`/import/${(await api<{ id: string }>(`/imports/${id}/copy`, { method: 'POST' })).id}`))}
              >
                Kör filerna igen
              </Button>
            )}
            {editable && allowed && (
              <Button variant="ghost" onClick={() => setConfirm('delete')}>
                Ta bort
              </Button>
            )}
          </>
        }
      />
      {!allowed && (
        <Card className="mb-4 px-4 py-3 text-[13px] text-ink-2">
          Välj {b.companyName} i bolagsväljaren för att arbeta med importen. Du behöver vara koncernadministratör eller ekonomiansvarig.
        </Card>
      )}

      <Tabs tabs={steps} value={step} onChange={setStep} />
      <div className="mb-4">
        <ErrorNote message={error} />
      </div>

      {step === 'files' && <FilesStep b={b} editable={editable && !!allowed} busy={busy} run={run} next={() => setStep('mapping')} />}
      {step === 'mapping' && <MappingStep b={b} meta={meta} editable={editable && !!allowed} run={run} next={() => run('validate', () => api(`/imports/${id}/validate`, { method: 'POST' }), 'check')} busy={busy} />}
      {step === 'check' && <CheckStep b={b} meta={meta} editable={editable && !!allowed} busy={busy} run={run} entityLabel={entityLabel} next={() => setStep('test')} />}
      {step === 'test' && (
        <TestStep b={b} editable={editable && !!allowed} busy={busy} entityLabel={entityLabel} onTest={() => run('test', () => api(`/imports/${id}/test`, { method: 'POST' }))} next={() => setStep('commit')} />
      )}
      {step === 'commit' && (
        <CommitStep b={b} editable={editable && !!allowed} busy={busy} errors={errors} run={run} onCommit={() => setConfirm('commit')} />
      )}
      {step === 'result' && <ResultStep b={b} entityLabel={entityLabel} />}
      {step === 'log' && <LogStep id={id} />}

      <Dialog open={confirm === 'commit'} onClose={() => setConfirm(null)} title="Genomför import">
        <p className="mb-4 text-[13px] text-ink-2">
          Posterna sparas i {b.companyName}. Befintliga uppgifter skrivs bara över där du har godkänt det. Importen loggas och kan ångras så länge de importerade
          posterna inte har ändrats.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            Avbryt
          </Button>
          <Button
            disabled={!!busy}
            onClick={() => {
              setConfirm(null);
              run('commit', () => api(`/imports/${id}/commit`, { method: 'POST' }), 'result');
            }}
          >
            Genomför import
          </Button>
        </div>
      </Dialog>
      <Dialog open={confirm === 'rollback'} onClose={() => setConfirm(null)} title="Ångra import">
        <p className="mb-4 text-[13px] text-ink-2">
          Allt som importen skapade tas bort och ändrade uppgifter får tillbaka sina tidigare värden. Om något har ändrats eller börjat användas efter importen
          stoppas ångringen och ingenting ändras.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirm(null);
              run('rollback', async () => {
                const res = await fetch(`/api/imports/${id}/rollback`, { method: 'POST', credentials: 'same-origin' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error([data.message, ...(data.blockers ?? [])].join(' '));
              });
            }}
          >
            Ångra import
          </Button>
        </div>
      </Dialog>
      <Dialog open={confirm === 'delete'} onClose={() => setConfirm(null)} title="Ta bort import">
        <p className="mb-4 text-[13px] text-ink-2">Uppladdade filer och kontroller tas bort. Ingenting i registren påverkas.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            Avbryt
          </Button>
          <Button variant="danger" onClick={() => run('delete', async () => (await api(`/imports/${id}`, { method: 'DELETE' }), router.push('/import')))}>
            Ta bort
          </Button>
        </div>
      </Dialog>
    </>
  );
}

type Run = (label: string, fn: () => Promise<unknown>, next?: Step) => Promise<void>;

// ---------------------------------------------------------------------
// 1. Filer
// ---------------------------------------------------------------------

function FilesStep({ b, editable, busy, run, next }: { b: Batch; editable: boolean; busy: string | null; run: Run; next: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const add = (files: FileList | null) => files?.length && run('upload', () => uploadFiles(`/imports/${b.id}/files`, [...files]));

  return (
    <div className="space-y-5">
      {b.sourceSystem === 'dinhyresvard' && (
        <Card className="px-5 py-4 text-[13px] text-ink-2">
          <div className="mb-1 font-medium text-ink">Så exporterar du från DinHyresvärd</div>
          Ta ut rapporterna <b>Bostäder</b>, <b>Lokaler</b> och <b>Bilplatser</b> som Excel. Bostadsrapporten innehåller hyresgäster och kontrakt. Kontoplan och
          verifikationer tas ut som <b>SIE 4</b>. Avtal och andra bilagor kan laddas upp som PDF, gärna med objektsnumret i filnamnet. Rader som tillhör andra bolag
          hoppas över automatiskt.
        </Card>
      )}
      {editable && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            add(e.dataTransfer.files);
          }}
          className={cx(
            'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center',
            drag ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface',
          )}
        >
          <div className="text-[13px] text-ink-2">Dra filerna hit, eller</div>
          <input ref={input} type="file" multiple className="hidden" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xml,.se,.si,.sie,.pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={(e) => add(e.target.files)} />
          <Button onClick={() => input.current?.click()} disabled={!!busy}>
            {busy === 'upload' ? 'Läser in…' : 'Välj filer'}
          </Button>
          <div className="text-[12px] text-ink-3">Excel, CSV, XML, SIE 4 och PDF. Högst 25 MB per fil.</div>
        </div>
      )}
      <Table head={['Fil', 'Format', 'Innehåll', 'Storlek', '']} empty="Inga filer uppladdade.">
        {b.files.map((f) => (
          <tr key={f.id}>
            <Td className="font-medium">{f.fileName}</Td>
            <Td>
              <Badge>{FORMAT_LABEL[f.format] ?? f.format}</Badge>
            </Td>
            <Td className="text-ink-2">{f.note}</Td>
            <Td className="tabular whitespace-nowrap text-ink-2">{fmtInt(f.sizeBytes / 1024)} kB</Td>
            <Td className="text-right">
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => run('remove', () => api(`/imports/${b.id}/files/${f.id}`, { method: 'DELETE' }))}>
                  Ta bort
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {b.files.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={next}>Nästa: mappning</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// 2. Mappning
// ---------------------------------------------------------------------

function MappingStep({ b, meta, editable, run, next, busy }: { b: Batch; meta: ImportMeta; editable: boolean; run: Run; next: () => void; busy: string | null }) {
  const tables = b.tables.filter((t) => t.profile !== 'ignored');
  return (
    <div className="space-y-5">
      <p className="text-[13px] text-ink-2">
        Varje kolumn i filerna kopplas till ett fält i systemet. Förslagen kommer från {b.adapter.label}. Ändra där det behövs. Kolumner som inte mappas läses inte in.
      </p>
      {tables.length === 0 && <Card className="px-5 py-8 text-center text-[13px] text-ink-3">Inga tabeller att mappa. Dokument behöver ingen mappning.</Card>}
      {tables.map((t) => (
        <TableMapping key={t.id + JSON.stringify(t.mapping)} b={b} t={t} meta={meta} editable={editable} run={run} />
      ))}
      {editable && (
        <div className="flex justify-end">
          <Button onClick={next} disabled={!!busy}>
            {busy === 'validate' ? 'Kontrollerar…' : 'Nästa: kontrollera'}
          </Button>
        </div>
      )}
    </div>
  );
}

function TableMapping({ b, t, meta, editable, run }: { b: Batch; t: Batch['tables'][number]; meta: ImportMeta; editable: boolean; run: Run }) {
  const [mapping, setMapping] = useState<Record<string, string>>(t.mapping);
  const used = new Set(Object.keys(mapping).map((k) => k.split('.')[0]));
  const [shown, setShown] = useState<string[]>(meta.entities.filter((e) => used.has(e.key)).map((e) => e.key));
  const [open, setOpen] = useState(shown.length === 0);
  const dirty = JSON.stringify(mapping) !== JSON.stringify(t.mapping);
  const file = b.files.find((f) => f.id === t.fileId);
  const sample = (col: string) => {
    const i = t.headers.indexOf(col);
    const v = t.sample?.map((r) => r[i]).find((x) => x !== null && x !== '');
    return v === undefined || v === null ? '' : String(v);
  };
  const mappedCount = new Set(Object.values(mapping).filter(Boolean)).size;

  return (
    <Card>
      <button className="flex w-full items-center justify-between px-5 py-3.5 text-left" onClick={() => setOpen(!open)}>
        <div>
          <div className="text-[14px] font-semibold">
            {file?.fileName} <span className="font-normal text-ink-3">› {t.name}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-2">
            {file?.note?.split(' · ').find((n) => n.startsWith(t.name))?.split(': ')[1] ?? ''} · {mappedCount} av {t.headers.length} kolumner används
          </div>
        </div>
        <span className="text-[12px] text-ink-3">{open ? 'Dölj' : 'Visa'}</span>
      </button>
      {open && (
        <div className="border-t border-line px-5 py-4">
          {shown.map((ek) => {
            const e = meta.entities.find((x) => x.key === ek)!;
            return (
              <div key={ek} className="mb-5">
                <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wide text-ink-3">
                  {e.labelPlural}
                  {!e.available && <Badge tone="warn">Sparas i fas 4</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  {e.fields.map((f) => {
                    const key = `${ek}.${f.key}`;
                    const col = mapping[key] ?? '';
                    return (
                      <div key={key} className="grid grid-cols-[150px_1fr] items-center gap-2">
                        <span className="text-[12.5px] text-ink-2" title={f.help}>
                          {f.label}
                          {f.required && <span className="text-bad"> *</span>}
                        </span>
                        <div className="min-w-0">
                          <Select
                            value={col}
                            disabled={!editable}
                            onChange={(ev) => setMapping((m) => ({ ...m, [key]: ev.target.value }))}
                            className={cx(!col && 'text-ink-3')}
                          >
                            <option value="">– används inte –</option>
                            {t.headers.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </Select>
                          {col && <div className="mt-0.5 truncate text-[11.5px] text-ink-3">t.ex. {sample(col) || '(tomt)'}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {editable && (
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <div className="w-64">
              <Select value="" onChange={(e) => e.target.value && setShown((s) => [...s, e.target.value])}>
                <option value="">Lägg till typ av uppgift…</option>
                {meta.entities
                  .filter((e) => !shown.includes(e.key) && e.key !== 'document')
                  .map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.labelPlural}
                    </option>
                  ))}
              </Select>
              </div>
              <Button
                disabled={!dirty}
                onClick={() =>
                  run('mapping', () =>
                    api(`/imports/${b.id}/tables/${t.id}/mapping`, {
                      method: 'PUT',
                      body: { mapping: Object.fromEntries(Object.entries({ ...t.mapping, ...mapping }).filter(([k]) => !k.startsWith('meta.') || t.mapping[k])) },
                    }),
                  )
                }
              >
                Spara mappning
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------
// 3. Kontroll
// ---------------------------------------------------------------------

const STATUS_ORDER = ['new', 'update', 'link', 'unchanged', 'error', 'skipped'] as const;

function CheckStep({
  b,
  meta,
  editable,
  busy,
  run,
  entityLabel,
  next,
}: {
  b: Batch;
  meta: ImportMeta;
  editable: boolean;
  busy: string | null;
  run: Run;
  entityLabel: (k: string) => string;
  next: () => void;
}) {
  const v = b.validation;
  const entities = v ? meta.entities.filter((e) => v.perEntity[e.key]).map((e) => e.key) : [];
  const [entity, setEntity] = useState<string>(entities[0] ?? 'object');
  const [status, setStatus] = useState<string>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assign, setAssign] = useState('');
  const [newProp, setNewProp] = useState('');

  useEffect(() => {
    if (v && !v.perEntity[entity] && entities[0]) setEntity(entities[0]);
  }, [v, entity, entities]);

  const loadRows = useCallback(async () => {
    if (!v) return;
    const p = new URLSearchParams({ entity, ...(status ? { status } : {}), ...(q ? { q } : {}) });
    const r = await api<{ rows: ImportRow[]; total: number }>(`/imports/${b.id}/rows?${p}`);
    setRows(r.rows);
    setTotal(r.total);
    setSelected(new Set());
  }, [b.id, entity, status, q, v]);

  useEffect(() => {
    loadRows();
  }, [loadRows, b.validation?.at]);

  const decide = (row: ImportRow, body: Record<string, unknown>) => run('decide', () => api(`/imports/${b.id}/rows/${row.id}/decision`, { method: 'PUT', body }));
  const bulk = (body: Record<string, unknown>) => run('bulk', () => api(`/imports/${b.id}/rows/bulk`, { method: 'POST', body }));

  if (!v) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="mb-4 text-[13px] text-ink-2">Kontrollen läser alla rader, letar efter saknade och felaktiga uppgifter och jämför med det som redan finns i {b.companyName}.</p>
        <Button disabled={!editable || !!busy || !b.files.length} onClick={() => run('validate', () => api(`/imports/${b.id}/validate`, { method: 'POST' }))}>
          {busy === 'validate' ? 'Kontrollerar…' : 'Kontrollera'}
        </Button>
      </Card>
    );
  }
  const updates = v.perEntity[entity]?.update ?? 0;
  const propertyOptions = [
    ...b.properties.map((p) => ({ value: `id:${p.id}`, label: `${p.name} (${p.designation})` })),
    ...b.newProperties.map((n) => ({ value: `name:${n}`, label: `${n} (ny i importen)` })),
  ];

  return (
    <div className="space-y-5">
      <Table head={['Typ', 'Nya', 'Ändras', 'Kopplas', 'Oförändrade', 'Fel', 'Hoppas över', 'Varningar']}>
        {entities.map((k) => {
          const e = v.perEntity[k];
          return (
            <tr key={k} className={cx('cursor-pointer', entity === k ? 'bg-accent-soft/50' : 'hover:bg-subtle/60')} onClick={() => setEntity(k)}>
              <Td className="font-medium">
                {entityLabel(k)}
                {!meta.entities.find((x) => x.key === k)?.available && <span className="ml-2 text-[12px] font-normal text-ink-3">sparas i fas 4</span>}
              </Td>
              <Td className="tabular">{e.new || '–'}</Td>
              <Td className={cx('tabular', e.update > 0 && 'font-medium text-warn')}>{e.update || '–'}</Td>
              <Td className="tabular">{e.link || '–'}</Td>
              <Td className="tabular text-ink-2">{e.unchanged || '–'}</Td>
              <Td className={cx('tabular', e.error > 0 && 'font-medium text-bad')}>{e.error || '–'}</Td>
              <Td className="tabular text-ink-2">{e.skipped || '–'}</Td>
              <Td className="tabular text-ink-2">{e.warnings || '–'}</Td>
            </tr>
          );
        })}
      </Table>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <Field label="Objekt utan fastighet kopplas till">
            <Select
              disabled={!editable}
              value={b.defaultPropertyId ?? ''}
              onChange={(e) => run('default', () => api(`/imports/${b.id}`, { method: 'PATCH', body: { defaultPropertyId: e.target.value || null } }))}
            >
              <option value="">Ingen, välj per objekt</option>
              {b.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" disabled={!editable || !!busy} onClick={() => run('validate', () => api(`/imports/${b.id}/validate`, { method: 'POST' }))}>
            {busy === 'validate' ? 'Kontrollerar…' : 'Kontrollera igen'}
          </Button>
          <Button disabled={!editable} onClick={next}>
            Nästa: testimport
          </Button>
        </div>
      </div>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-[14px] font-semibold">{entityLabel(entity)}</h2>
          {['', ...STATUS_ORDER].map((s) => {
            const n = s ? v.perEntity[entity]?.[s as keyof typeof v.perEntity[string]] : v.perEntity[entity]?.total;
            if (s && !n) return null;
            return (
              <button
                key={s || 'all'}
                onClick={() => setStatus(s)}
                className={cx('h-7 rounded-md px-2.5 text-[12.5px]', status === s ? 'bg-ink text-white' : 'bg-surface text-ink-2 shadow-card hover:bg-subtle')}
              >
                {s ? ROW_STATUS[s].label : 'Alla'} <span className="opacity-60">{n}</span>
              </button>
            );
          })}
          <div className="ml-auto w-56">
            <Input placeholder="Sök…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {editable && (updates > 0 || selected.size > 0) && (
          <Card className="mb-3 flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
            {updates > 0 && selected.size === 0 && (
              <>
                <span className="text-ink-2">{updates} poster har uppgifter som skiljer sig från det som finns i systemet.</span>
                <Button size="sm" variant="secondary" onClick={() => bulk({ entity, status: 'update', approveUpdate: true })}>
                  Godkänn alla ändringar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => bulk({ entity, status: 'update', approveUpdate: false })}>
                  Behåll befintliga uppgifter
                </Button>
              </>
            )}
            {selected.size > 0 && (
              <>
                <span className="font-medium">{selected.size} markerade</span>
                {entity === 'object' && (
                  <>
                    <div className="w-72">
                    <Select value={assign} onChange={(e) => setAssign(e.target.value)}>
                      <option value="">Koppla till fastighet…</option>
                      {propertyOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                      <option value="new">Ny fastighet…</option>
                    </Select>
                    </div>
                    {assign === 'new' && (
                      <div className="w-56">
                        <Input placeholder="Fastighetens namn" value={newProp} onChange={(e) => setNewProp(e.target.value)} />
                      </div>
                    )}
                    <Button
                      size="sm"
                      disabled={!assign || (assign === 'new' && !newProp.trim())}
                      onClick={() =>
                        bulk({
                          rowIds: [...selected],
                          overrides:
                            assign === 'new'
                              ? { propertyId: null, propertyName: newProp.trim() }
                              : assign.startsWith('name:')
                                ? { propertyId: null, propertyName: assign.slice(5) }
                                : { propertyId: assign.slice(3), propertyName: null },
                        }).then(() => (setAssign(''), setNewProp('')))
                      }
                    >
                      Koppla
                    </Button>
                  </>
                )}
                <Button size="sm" variant="secondary" onClick={() => bulk({ rowIds: [...selected], skip: true })}>
                  Hoppa över
                </Button>
                <Button size="sm" variant="ghost" onClick={() => bulk({ rowIds: [...selected], skip: false })}>
                  Ta med
                </Button>
              </>
            )}
          </Card>
        )}

        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle/60 text-[12px] text-ink-3">
                {editable && (
                  <th className="h-8 w-8 px-3">
                    <input
                      type="checkbox"
                      aria-label="Markera alla"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                    />
                  </th>
                )}
                <th className="h-8 px-3 font-medium">Status</th>
                <th className="h-8 px-3 font-medium">Post</th>
                <th className="h-8 px-3 font-medium">Källa</th>
                <th className="h-8 px-3 font-medium">Kontroll</th>
                <th className="h-8 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <RowView
                  key={r.id}
                  r={r}
                  b={b}
                  editable={editable}
                  selected={selected.has(r.id)}
                  onSelect={(on) => setSelected((s) => (on ? new Set(s).add(r.id) : new Set([...s].filter((x) => x !== r.id))))}
                  decide={decide}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="px-4 py-10 text-center text-[13px] text-ink-3">Inga poster.</div>}
          {total > rows.length && <div className="border-t border-line px-4 py-2 text-[12px] text-ink-3">Visar {rows.length} av {total}. Sök eller filtrera för att se fler.</div>}
        </Card>
      </section>
    </div>
  );
}

function RowView({
  r,
  b,
  editable,
  selected,
  onSelect,
  decide,
}: {
  r: ImportRow;
  b: Batch;
  editable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  decide: (r: ImportRow, body: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(r.status === 'error' || r.status === 'update');
  const needsProperty = r.entity === 'object' && r.issues.some((i) => /Välj vilken fastighet|annat bolag/.test(i.message));
  const facts = summaryFacts(r);
  return (
    <>
      <tr className={cx('align-top', selected && 'bg-accent-soft/40')}>
        {editable && (
          <td className="px-3 py-2.5">
            <input type="checkbox" aria-label={`Markera ${r.label}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          </td>
        )}
        <td className="px-3 py-2.5">
          <Badge tone={r.skip ? 'neutral' : ROW_STATUS[r.status].tone}>{ROW_STATUS[r.status].label}</Badge>
          {r.status === 'update' && r.approveUpdate && <div className="mt-1 text-[11.5px] text-warn">Skrivs över</div>}
        </td>
        <td className="px-3 py-2.5">
          <button className="text-left font-medium hover:underline" onClick={() => setOpen(!open)}>
            {r.label}
          </button>
          {facts && <div className="text-[12px] text-ink-3">{facts}</div>}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-ink-3">
          {r.tableName ?? r.fileName}
          {r.sourceRow ? ` rad ${r.sourceRow}` : ''}
        </td>
        <td className="px-3 py-2.5">
          <ul className="space-y-0.5">
            {r.issues.slice(0, open ? undefined : 2).map((i, n) => (
              <li key={n} className={cx('text-[12.5px]', i.level === 'error' ? 'text-bad' : i.level === 'warning' ? 'text-warn' : 'text-ink-2')}>
                {i.message}
              </li>
            ))}
            {!open && r.issues.length > 2 && <li className="text-[12px] text-ink-3">+{r.issues.length - 2} till</li>}
            {r.changes.length > 0 && !open && <li className="text-[12.5px] text-warn">{r.changes.length} uppgifter skiljer sig</li>}
          </ul>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          {editable && (
            <Button size="sm" variant="ghost" onClick={() => decide(r, { skip: !r.skip })}>
              {r.skip ? 'Ta med' : 'Hoppa över'}
            </Button>
          )}
        </td>
      </tr>
      {open && (r.changes.length > 0 || needsProperty) && (
        <tr className="bg-subtle/40">
          <td colSpan={editable ? 6 : 5} className="px-3 py-3">
            {r.changes.length > 0 && (
              <div className="mb-2">
                <table className="text-[12.5px]">
                  <thead>
                    <tr className="text-ink-3">
                      <th className="pr-6 text-left font-medium">Uppgift</th>
                      <th className="pr-6 text-left font-medium">I systemet nu</th>
                      <th className="text-left font-medium">I filen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.changes.map((c) => (
                      <tr key={c.field}>
                        <td className="pr-6 text-ink-2">{c.label}</td>
                        <td className="pr-6">{fmtValue(c.field, c.current)}</td>
                        <td className="font-medium">{fmtValue(c.field, c.incoming)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {editable && (
                  <label className="mt-2 flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" checked={r.approveUpdate} onChange={(e) => decide(r, { approveUpdate: e.target.checked })} />
                    Skriv över med uppgifterna från filen
                  </label>
                )}
              </div>
            )}
            {needsProperty && editable && <PropertyPicker b={b} onPick={(o) => decide(r, { overrides: o })} />}
          </td>
        </tr>
      )}
    </>
  );
}

function PropertyPicker({ b, onPick }: { b: Batch; onPick: (o: Record<string, unknown>) => void }) {
  const [v, setV] = useState('');
  const [name, setName] = useState('');
  const pick = () =>
    onPick(
      v === 'new'
        ? { propertyId: null, propertyName: name.trim() }
        : v.startsWith('name:')
          ? { propertyId: null, propertyName: v.slice(5) }
          : { propertyId: v, propertyName: null },
    );
  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      <span className="text-ink-2">Fastighet:</span>
      <div className="w-72">
        <Select value={v} onChange={(e) => setV(e.target.value)}>
          <option value="">Välj…</option>
          {b.properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {b.newProperties.map((n) => (
            <option key={n} value={`name:${n}`}>
              {n} (ny i importen)
            </option>
          ))}
          <option value="new">Ny fastighet…</option>
        </Select>
      </div>
      {v === 'new' && (
        <div className="w-56">
          <Input placeholder="Fastighetens namn" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      <Button size="sm" disabled={!v || (v === 'new' && !name.trim())} onClick={pick}>
        Koppla
      </Button>
    </div>
  );
}

function summaryFacts(r: ImportRow): string {
  const d = r.data as Record<string, any>;
  const parts: string[] = [];
  if (r.entity === 'object') {
    if (d.propertyRef) parts.push(String(d.propertyRef));
    if (d.addressLine) parts.push(String(d.addressLine));
    if (typeof d.monthlyRent === 'number') parts.push(`${fmtOre(d.monthlyRent)}/mån`);
    if (d.vatLiable) parts.push('moms');
  } else if (r.entity === 'customer') {
    if (d.nationalIdNormalized) parts.push(String(d.nationalIdNormalized));
    if (d.email) parts.push(String(d.email));
  } else if (r.entity === 'contract') {
    parts.push(`${d.startDate ?? '?'} – ${d.endDate ?? 'tills vidare'}`);
    if (typeof d.monthlyRent === 'number') parts.push(`${fmtOre(d.monthlyRent)}/mån i originalet`);
  } else if (r.entity === 'property') {
    if (d.addressLine) parts.push(`${d.addressLine}${d.city ? `, ${d.city}` : ''}`);
  } else if (r.entity === 'voucher') {
    parts.push(`${(d.lines as unknown[])?.length ?? 0} rader`);
  }
  return parts.join(' · ');
}

function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'boolean') return v ? 'Ja' : 'Nej';
  if (/rent|amount/i.test(field) && typeof v === 'number') return fmtOre(v, true);
  return String(v);
}

// ---------------------------------------------------------------------
// 4. Testimport
// ---------------------------------------------------------------------

function TestStep({
  b,
  editable,
  busy,
  onTest,
  next,
  entityLabel,
}: {
  b: Batch;
  editable: boolean;
  busy: string | null;
  onTest: () => void;
  next: () => void;
  entityLabel: (k: string) => string;
}) {
  const t = b.testResult;
  return (
    <div className="space-y-5">
      <Card className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="text-[13px] text-ink-2">
          Testimporten sparar allt på riktigt, med alla kontroller i databasen, och ångrar sedan direkt. Ingenting ändras i registren.
          {t && <div className="mt-1 text-[12px] text-ink-3">Senaste test {formatDateTime(t.at)}</div>}
        </div>
        <Button disabled={!editable || !!busy || !b.validation} onClick={onTest}>
          {busy === 'test' ? 'Testar…' : t ? 'Testa igen' : 'Kör testimport'}
        </Button>
      </Card>
      {t && (
        <>
          <div
            className={cx('rounded-lg px-5 py-3.5 text-[13px] shadow-card', t.ok && !b.validation?.totals.error ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn')}
          >
            {t.ok
              ? b.validation?.totals.error
                ? `Testet gick igenom, men ${b.validation.totals.error} poster med fel tas inte med. Rätta dem eller välj Hoppa över under Kontroll.`
                : 'Testet gick igenom utan fel. Importen kan genomföras.'
              : `${t.result.errors.length} poster gick inte att spara. Se nedan.`}
          </div>
          <ApplySummary r={t.result} entityLabel={entityLabel} />
          {t.result.errors.length > 0 && (
            <Table head={['Post', 'Fel']}>
              {t.result.errors.map((e, i) => (
                <tr key={i}>
                  <Td className="font-medium">{e.label}</Td>
                  <Td className="text-bad">{e.message}</Td>
                </tr>
              ))}
            </Table>
          )}
          <ReconciliationView rec={t.reconciliation} preview />
          {t.ok && editable && (
            <div className="flex justify-end">
              <Button onClick={next}>Nästa: genomför</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ApplySummary({ r, entityLabel }: { r: TestResult['result']; entityLabel: (k: string) => string }) {
  const keys = [...new Set([...Object.keys(r.created), ...Object.keys(r.updated), ...Object.keys(r.linked)])];
  if (!keys.length) return null;
  return (
    <Table head={['Typ', 'Skapas', 'Skrivs över', 'Kopplas till befintliga']}>
      {keys.map((k) => (
        <tr key={k}>
          <Td className="font-medium">{entityLabel(k)}</Td>
          <Td className="tabular">{r.created[k] ?? '–'}</Td>
          <Td className="tabular">{r.updated[k] ?? '–'}</Td>
          <Td className="tabular">{r.linked[k] ?? '–'}</Td>
        </tr>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------------
// 5. Genomför
// ---------------------------------------------------------------------

const CONTROL_FIELDS: { key: string; label: string; ore?: boolean }[] = [
  { key: 'properties', label: 'Antal fastigheter' },
  { key: 'objects', label: 'Antal objekt' },
  { key: 'customers', label: 'Antal hyresgäster' },
  { key: 'activeContracts', label: 'Antal aktiva avtal' },
  { key: 'objectRentOre', label: 'Objektens månadshyra (kr)', ore: true },
  { key: 'monthlyRentOre', label: 'Kontrakterad månadshyra (kr)', ore: true },
  { key: 'unpaidInvoices', label: 'Antal obetalda fakturor' },
  { key: 'receivablesOre', label: 'Kundfordringar (kr)', ore: true },
];

function ControlTotals({ b, editable, run }: { b: Batch; editable: boolean; run: Run }) {
  const init = useMemo(
    () =>
      Object.fromEntries(
        CONTROL_FIELDS.map((f) => {
          const v = b.controlTotals?.[f.key];
          return [f.key, v === null || v === undefined ? '' : String(f.ore ? v / 100 : v)];
        }),
      ),
    [b.controlTotals],
  );
  const [vals, setVals] = useState<Record<string, string>>(init);
  const dirty = JSON.stringify(vals) !== JSON.stringify(init);
  return (
    <Card className="px-5 py-4">
      <div className="mb-1 text-[14px] font-semibold">Kontrollsummor från originalsystemet</div>
      <p className="mb-4 text-[12.5px] text-ink-2">Frivilligt. Fyll i siffror ur DinHyresvärds rapporter, så jämförs de med det som importerats under Avstämning.</p>
      <div className="grid grid-cols-4 gap-3">
        {CONTROL_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input inputMode="decimal" disabled={!editable && b.status !== 'committed'} value={vals[f.key]} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          variant="secondary"
          disabled={!dirty}
          onClick={() =>
            run('control', () =>
              api(`/imports/${b.id}`, {
                method: 'PATCH',
                body: {
                  controlTotals: Object.fromEntries(
                    CONTROL_FIELDS.map((f) => {
                      const n = Number(vals[f.key].replace(/\s/g, '').replace(',', '.'));
                      return [f.key, vals[f.key].trim() === '' || !Number.isFinite(n) ? null : f.ore ? Math.round(n * 100) : Math.round(n)];
                    }),
                  ),
                },
              }),
            )
          }
        >
          Spara kontrollsummor
        </Button>
      </div>
    </Card>
  );
}

function CommitStep({ b, editable, busy, errors, run, onCommit }: { b: Batch; editable: boolean; busy: string | null; errors: number; run: Run; onCommit: () => void }) {
  const ready = b.status === 'tested' && errors === 0;
  return (
    <div className="space-y-5">
      <ControlTotals b={b} editable={editable} run={run} />
      <Card className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="text-[13px] text-ink-2">
          {b.status === 'committed'
            ? `Importen genomfördes ${formatDateTime(b.committedAt!)}${b.committedByName ? ` av ${b.committedByName}` : ''}.`
            : !b.validation
              ? 'Kontrollera filerna först.'
              : errors > 0
                ? `${errors} poster har fel. Rätta dem eller välj Hoppa över under Kontroll.`
                : b.status !== 'tested'
                  ? 'Kör en testimport först. Den måste göras om efter varje ändring.'
                  : 'Testimporten gick igenom. Allt är klart för skarp import.'}
        </div>
        {editable && (
          <Button disabled={!ready || !!busy} onClick={onCommit}>
            {busy === 'commit' ? 'Importerar…' : 'Genomför import'}
          </Button>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
// Avstämning
// ---------------------------------------------------------------------

function ResultStep({ b, entityLabel }: { b: Batch; entityLabel: (k: string) => string }) {
  const [rec, setRec] = useState<Reconciliation | null>(b.reconciliation);
  useEffect(() => {
    if (b.status === 'committed') api<Reconciliation>(`/imports/${b.id}/reconciliation`).then(setRec);
  }, [b.id, b.status, b.controlTotals]);
  if (b.status === 'rolled_back') {
    return (
      <Card className="px-5 py-6 text-[13px] text-ink-2">
        Importen ångrades {b.rolledBackAt ? formatDateTime(b.rolledBackAt) : ''}. Allt den skapade har tagits bort och ändrade uppgifter har återställts.
      </Card>
    );
  }
  if (!rec) {
    return <Card className="px-5 py-8 text-center text-[13px] text-ink-3">Avstämningen visas när importen är genomförd. Testimporten visar en förhandsversion.</Card>;
  }
  return (
    <div className="space-y-5">
      <ReconciliationView rec={rec} />
      {rec.issues.errors + rec.issues.skipped + rec.issues.warnings > 0 && (
        <section>
          <h2 className="mb-3 text-[14px] font-semibold">Fel och avvikelser</h2>
          <Table head={['Typ', 'Med fel (ej importerade)', 'Överhoppade', 'Med varningar']}>
            {Object.entries(rec.issues.byEntity)
              .filter(([, v]) => v.errors + v.skipped + v.warnings > 0)
              .map(([k, v]) => (
                <tr key={k}>
                  <Td className="font-medium">{entityLabel(k)}</Td>
                  <Td className={cx('tabular', v.errors > 0 && 'text-bad')}>{v.errors || '–'}</Td>
                  <Td className="tabular">{v.skipped || '–'}</Td>
                  <Td className={cx('tabular', v.warnings > 0 && 'text-warn')}>{v.warnings || '–'}</Td>
                </tr>
              ))}
          </Table>
        </section>
      )}
    </div>
  );
}

function ReconciliationView({ rec, preview }: { rec: Reconciliation; preview?: boolean }) {
  const s = rec.system;
  const fmt = (unit: 'count' | 'ore', v: number | null) => (v === null || v === undefined ? '–' : unit === 'ore' ? fmtOre(v) : fmtInt(v));
  return (
    <section className="space-y-4">
      <h2 className="text-[14px] font-semibold">{preview ? 'Så här blir det efter importen' : 'Datakontroll efter import'}</h2>
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Fastigheter" value={fmtInt(s.properties)} sub={`${fmtInt(rec.batch.properties)} från importen`} />
        <Stat label="Objekt" value={fmtInt(s.objects)} sub={`${fmtInt(rec.batch.objects)} från importen`} />
        <Stat label="Hyresgäster" value={fmtInt(s.customers)} sub={`${fmtInt(rec.batch.customers)} från importen`} />
        <Stat label="Avtal" value={`${fmtInt(s.activeContracts)} aktiva`} sub={`${fmtInt(s.endedContracts)} avslutade`} />
        <Stat label="Kontrakterad hyra per år" value={fmtOre(s.annualRentOre)} sub={`${fmtOre(s.monthlyRentOre)} per månad`} />
        <Stat label="Obetalda fakturor" value={s.unpaidInvoices === null ? '–' : fmtInt(s.unpaidInvoices)} sub={rec.invoicesAvailable ? undefined : 'Kommer med aviseringen'} />
        <Stat label="Kundfordringar" value={s.receivablesOre === null ? '–' : fmtOre(s.receivablesOre)} sub={rec.invoicesAvailable ? undefined : 'Kommer med aviseringen'} />
        <Stat label="Importfel" value={fmtInt(rec.issues.errors)} sub={`${fmtInt(rec.issues.skipped)} överhoppade, ${fmtInt(rec.issues.warnings)} varningar`} />
      </div>
      <Table head={['Jämförelse med originalsystemet', 'I filerna', 'Enligt kontrollsumma', 'Importerat', 'I systemet', 'Avvikelse']}>
        {rec.comparison.map((c) => {
          const ref = c.control ?? c.source;
          const diff = ref !== null && c.imported !== null ? c.imported - ref : null;
          const off = diff !== null && Math.abs(diff) >= (c.unit === 'ore' ? 100 : 1);
          return (
            <tr key={c.key}>
              <Td className="font-medium">{c.label}</Td>
              <Td className="tabular">{fmt(c.unit, c.source)}</Td>
              <Td className="tabular">{fmt(c.unit, c.control)}</Td>
              <Td className="tabular">{fmt(c.unit, c.imported)}</Td>
              <Td className="tabular text-ink-2">{fmt(c.unit, c.system)}</Td>
              <Td className={cx('tabular', off ? 'font-medium text-warn' : 'text-good')}>
                {diff === null ? '–' : off ? `${diff > 0 ? '+' : ''}${fmt(c.unit, diff)}` : 'Stämmer'}
              </Td>
            </tr>
          );
        })}
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------
// Logg
// ---------------------------------------------------------------------

function LogStep({ id }: { id: string }) {
  const [events, setEvents] = useState<{ id: number; kind: string; message: string; createdAt: string; userName: string | null }[]>([]);
  useEffect(() => {
    api<typeof events>(`/imports/${id}/events`).then(setEvents);
  }, [id]);
  return (
    <Table head={['Tid', 'Användare', 'Händelse']} empty="Inga händelser.">
      {events.map((e) => (
        <tr key={e.id}>
          <Td className="whitespace-nowrap tabular text-ink-2">{formatDateTime(e.createdAt)}</Td>
          <Td>{e.userName ?? 'System'}</Td>
          <Td>{e.message}</Td>
        </tr>
      ))}
    </Table>
  );
}

