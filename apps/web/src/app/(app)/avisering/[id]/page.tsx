'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, use, useCallback, useEffect, useState } from 'react';
import { SectionHeader } from '@/components/edit-form';
import { InvoiceRow } from '@/components/invoice-table';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Stat, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { RUN_STATUS, RunRow } from '@/lib/billing';
import { DELIVERY_LABEL, DELIVERY_STATUS, LINE_KIND_LABEL, fmtOre, fmtPeriod } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Issue {
  id: string;
  kind: string;
  severity: 'blocking' | 'warning' | 'info';
  message: string;
  contractId: string | null;
  contractNr: number | null;
  invoiceId: string | null;
}

interface RunLine {
  invoiceId: string;
  lineKind: string;
  description: string;
  objectNr: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  netOre: number;
  vatRateBp: number;
  vatOre: number;
}

interface RunDetail extends RunRow {
  fingerprint: string;
  periodLabel: string;
  propertyIds: string[] | null;
  excludedContractIds: string[];
  issues: Issue[];
  invoices: (InvoiceRow & { lines: RunLine[] })[];
  excluded: { id: string; contractNr: number; customerName: string }[];
  properties: { id: string; name: string }[];
}

const SEVERITY = {
  blocking: { label: 'Måste rättas', tone: 'bad' as const, dot: 'bg-bad' },
  warning: { label: 'Kontrollera', tone: 'warn' as const, dot: 'bg-warn' },
  info: { label: 'Information', tone: 'neutral' as const, dot: 'bg-ink-3' },
};

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showInfo, setShowInfo] = useState(false);
  const [dialog, setDialog] = useState<'approve' | 'settings' | 'cancel' | null>(null);

  const load = useCallback(() => {
    api<RunDetail>(`/billing-runs/${id}`)
      .then(setRun)
      .catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error && !run) return <ErrorNote message={error} />;
  if (!run) return null;

  const opts = { companyId: run.companyId };
  const draft = run.status === 'draft';
  const issued = run.status === 'issued';
  const canRun = can('billing.run', run.companyId);
  const canIssue = can('invoice.issue', run.companyId);
  const blocking = run.issues.filter((i) => i.severity === 'blocking');
  const warnings = run.issues.filter((i) => i.severity === 'warning');
  const infos = run.issues.filter((i) => i.severity === 'info');
  const status = RUN_STATUS[run.status];

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (invId: string) => {
    const next = new Set(expanded);
    if (next.has(invId)) next.delete(invId);
    else next.add(invId);
    setExpanded(next);
  };

  const actions = (
    <>
      {draft && canRun && (
        <>
          <Button variant="ghost" onClick={() => setDialog('cancel')}>
            Makulera
          </Button>
          <Button variant="secondary" onClick={() => setDialog('settings')}>
            Ändra urval
          </Button>
          <Button
            variant="secondary"
            disabled={busy === 'regen'}
            onClick={() =>
              act('regen', async () => {
                await api(`/billing-runs/${id}/regenerate`, { method: 'POST', ...opts });
                load();
                setNotice('Underlaget är uppdaterat ur avtalen.');
              })
            }
          >
            {busy === 'regen' ? 'Uppdaterar…' : 'Uppdatera underlag'}
          </Button>
        </>
      )}
      {draft && canIssue && (
        <Button disabled={!run.invoiceCount || blocking.length > 0} onClick={() => setDialog('approve')} title={blocking.length ? 'Rätta felen först' : undefined}>
          Godkänn och lås
        </Button>
      )}
      {issued && (
        <a href={`/api/billing-runs/${id}/print.pdf?all=1`} target="_blank" rel="noreferrer">
          <Button variant="secondary">Alla avier som PDF</Button>
        </a>
      )}
    </>
  );

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avisering" className="hover:text-ink">
          Avisering
        </Link>{' '}
        / Körning {run.runNr}
      </div>
      <PageHeader title={`Avisering ${run.periodLabel}`} description={`Körning ${run.runNr} · ${run.companyName}`} actions={actions} />
      <div className="-mt-3 mb-6 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span>Fakturadatum {run.invoiceDate}</span>
        <span>·</span>
        <span>{run.dueDate ? `Förfaller ${run.dueDate}` : 'Förfallodag per avtal'}</span>
        <span>·</span>
        <span>{run.properties.length ? run.properties.map((p) => p.name).join(', ') : 'Alla fastigheter'}</span>
        {issued && run.issuedAt && (
          <>
            <span>·</span>
            <span>
              Godkänd {run.issuedAt.slice(0, 10)}
              {run.issuedByName ? ` av ${run.issuedByName}` : ''}
            </span>
          </>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}
      {notice && <div className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{notice}</div>}

      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Avier" value={run.invoiceCount} sub={`${new Set(run.invoices.map((i) => i.customerId)).size} hyresgäster`} />
        <Stat label="Hyra exkl. moms" value={fmtOre(run.netOre)} />
        <Stat label="Moms" value={fmtOre(run.vatOre)} />
        <Stat label="Att betala totalt" value={fmtOre(run.totalOre)} sub="inkl. moms och öresavrundning" />
      </div>

      {issued && <Delivery run={run} reload={load} busy={busy} act={act} setNotice={setNotice} canIssue={canIssue} />}

      <section className="mb-10">
        <SectionHeader
          title="Kontroller"
          description={
            draft
              ? blocking.length
                ? `${blocking.length} fel måste rättas i avtalen innan körningen kan godkännas. Uppdatera underlaget efteråt.`
                : warnings.length
                  ? `Inga fel. ${warnings.length} saker att kontrollera innan du godkänner.`
                  : 'Inga fel eller varningar.'
              : 'Kontrollerna som gjordes när körningen godkändes.'
          }
          actions={
            infos.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowInfo(!showInfo)}>
                {showInfo ? 'Dölj information' : `Visa information (${infos.length})`}
              </Button>
            )
          }
        />
        <Card className="divide-y divide-line">
          {[...blocking, ...warnings, ...(showInfo ? infos : [])].map((i) => (
            <div key={i.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
              <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', SEVERITY[i.severity].dot)} />
              <div className="min-w-0 flex-1">{i.message}</div>
              {i.contractId && (
                <Link href={`/avtal/${i.contractId}`} className="shrink-0 text-[12px] text-accent hover:underline">
                  Öppna avtal {i.contractNr}
                </Link>
              )}
            </div>
          ))}
          {blocking.length + warnings.length === 0 && !showInfo && (
            <div className="flex items-center gap-3 px-4 py-3 text-[13px] text-ink-2">
              <span className="size-2 rounded-full bg-good" />
              Inga dubbeldebiteringar, saknade avtal, lediga objekt som debiteras, momsfel eller avvikande belopp hittades.
            </div>
          )}
        </Card>
      </section>

      <section>
        <SectionHeader
          title="Avier"
          description={draft ? 'Klicka på en avi för att se raderna. Avierna får nummer och OCR när körningen godkänns.' : undefined}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded.size ? new Set() : new Set(run.invoices.map((i) => i.id)))}>
              {expanded.size ? 'Fäll ihop alla' : 'Visa alla rader'}
            </Button>
          }
        />
        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle/60 text-[12px] text-ink-3">
                <th className="h-8 w-8 px-3" />
                <th className="h-8 px-3 font-medium">{draft ? 'Hyresgäst' : 'Nr · Hyresgäst'}</th>
                <th className="h-8 px-3 font-medium">Avtal</th>
                <th className="h-8 px-3 font-medium">Period</th>
                <th className="h-8 px-3 font-medium">Förfaller</th>
                <th className="h-8 px-3 font-medium">Skickas med</th>
                <th className="h-8 px-3 text-right font-medium">Moms</th>
                <th className="h-8 px-3 text-right font-medium">Att betala</th>
                <th className="h-8 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {run.invoices.map((inv) => {
                const open = expanded.has(inv.id);
                const flagged = run.issues.filter((x) => x.invoiceId === inv.id && x.severity !== 'info');
                return (
                  <Fragment key={inv.id}>
                    <tr className="cursor-pointer hover:bg-subtle/60" onClick={() => toggle(inv.id)}>
                      <td className="px-3 text-ink-3">{open ? '▾' : '▸'}</td>
                      <td className="h-10 px-3">
                        <span className="font-medium">
                          {inv.invoiceNr ? `${inv.invoiceNr} · ` : ''}
                          {inv.customerName}
                        </span>
                        {inv.kind === 'credit_note' && (
                          <span className="ml-2">
                            <Badge>Kreditfaktura</Badge>
                          </span>
                        )}
                        {flagged.length > 0 && (
                          <span className="ml-2">
                            <Badge tone={flagged.some((f) => f.severity === 'blocking') ? 'bad' : 'warn'}>{flagged.length} att kontrollera</Badge>
                          </span>
                        )}
                        {inv.objects && <div className="text-[12px] text-ink-3">{inv.objects}</div>}
                      </td>
                      <td className="px-3 tabular text-ink-2">{inv.contractNr}</td>
                      <td className="px-3 text-ink-2">{fmtPeriod(inv.periodFrom, inv.periodTo) || 'Justering'}</td>
                      <td className="px-3 tabular text-ink-2">{inv.kind === 'credit_note' ? '–' : inv.dueDate}</td>
                      <td className="px-3 text-ink-2">
                        {DELIVERY_LABEL[inv.deliveryMethod]}
                        {issued && inv.deliveryStatus && (
                          <span className="ml-1.5">
                            <Badge tone={DELIVERY_STATUS[inv.deliveryStatus]?.tone}>{DELIVERY_STATUS[inv.deliveryStatus]?.label}</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 text-right tabular text-ink-2">{fmtOre(inv.vatOre, true)}</td>
                      <td className="px-3 text-right font-medium tabular">{fmtOre(inv.totalOre, true)}</td>
                      <td className="px-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <a href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                            <Button size="sm" variant="ghost">
                              PDF
                            </Button>
                          </a>
                          {issued && (
                            <Link href={`/fakturor/${inv.id}`}>
                              <Button size="sm" variant="ghost">
                                Öppna
                              </Button>
                            </Link>
                          )}
                          {draft && canRun && inv.contractId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-ink-3 hover:text-bad"
                              title="Avtalet aviseras inte i den här körningen"
                              onClick={() =>
                                act(`ex-${inv.id}`, async () => {
                                  await api(`/billing-runs/${id}/exclude`, { method: 'POST', body: { contractId: inv.contractId }, ...opts });
                                  load();
                                })
                              }
                            >
                              Ta bort
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-subtle/40">
                        <td />
                        <td colSpan={8} className="px-3 pb-3 pt-1">
                          <table className="w-full text-[12.5px]">
                            <tbody>
                              {inv.lines.map((l, n) => (
                                <tr key={n} className="border-b border-line/60 last:border-0">
                                  <td className="py-1.5 pr-3">
                                    {l.objectNr && <span className="mr-2 text-ink-3">{l.objectNr}</span>}
                                    {l.description}
                                    {l.lineKind !== 'regular' && (
                                      <span className="ml-2">
                                        <Badge tone={l.lineKind === 'retroactive' ? 'warn' : 'accent'}>{LINE_KIND_LABEL[l.lineKind]}</Badge>
                                      </span>
                                    )}
                                  </td>
                                  <td className="w-56 py-1.5 pr-3 text-ink-3">{l.periodFrom ? `${l.periodFrom} – ${l.periodTo}` : ''}</td>
                                  <td className="w-28 py-1.5 pr-3 text-right text-ink-3">{l.vatRateBp ? `${l.vatRateBp / 100} % moms` : 'momsfri'}</td>
                                  <td className="w-28 py-1.5 text-right tabular">{fmtOre(l.netOre, true)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {run.invoices.length === 0 && (
            <div className="px-4 py-10 text-center text-[13px] text-ink-3">
              {draft ? 'Inga avier att skapa för perioden. Se kontrollerna ovan.' : 'Körningen innehöll inga avier.'}
            </div>
          )}
        </Card>
        {run.excluded.length > 0 && (
          <div className="mt-3 text-[13px] text-ink-2">
            Borttagna ur körningen:{' '}
            {run.excluded.map((x, n) => (
              <span key={x.id}>
                {n > 0 && ', '}
                avtal {x.contractNr} ({x.customerName}){' '}
                {draft && canRun && (
                  <button
                    className="text-accent hover:underline"
                    onClick={() =>
                      act(`in-${x.id}`, async () => {
                        await api(`/billing-runs/${id}/exclude`, { method: 'POST', body: { contractId: x.id, include: true }, ...opts });
                        load();
                      })
                    }
                  >
                    ta med igen
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </section>

      <ApproveDialog
        open={dialog === 'approve'}
        run={run}
        warnings={warnings.length}
        onClose={() => setDialog(null)}
        onDone={(changed) => {
          setDialog(null);
          load();
          setNotice(changed ? 'Underlaget hade ändrats sedan du öppnade körningen och har uppdaterats. Granska det igen innan du godkänner.' : 'Körningen är godkänd. Avierna har fått nummer och OCR och är låsta.');
        }}
      />
      <SettingsDialog open={dialog === 'settings'} run={run} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />
      <Dialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title="Makulera körningen">
        <p className="text-[13px] text-ink-2">Utkasten tas bort och inget aviseras. Du kan skapa en ny körning för samma period efteråt.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              act('cancel', async () => {
                await api(`/billing-runs/${id}`, { method: 'DELETE', ...opts });
                router.push('/avisering');
              })
            }
          >
            Makulera
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function Delivery({
  run,
  reload,
  busy,
  act,
  setNotice,
  canIssue,
}: {
  run: RunDetail;
  reload: () => void;
  busy: string | null;
  act: (k: string, fn: () => Promise<unknown>) => Promise<void>;
  setNotice: (s: string) => void;
  canIssue: boolean;
}) {
  const opts = { companyId: run.companyId };
  const electronic = run.queuedCount - run.queuedPostCount;
  return (
    <section className="mb-10">
      <SectionHeader title="Utskick" description="E-post och e-faktura skickas härifrån. Brevavier skrivs ut som en PDF och markeras sedan som skickade." />
      <Card className="grid grid-cols-3 divide-x divide-line">
        <div className="px-4 py-3.5">
          <div className="text-[12px] text-ink-3">E-post och e-faktura</div>
          <div className="mt-1 text-[13px]">{electronic ? `${electronic} väntar på att skickas` : 'Inget väntar'}</div>
          {canIssue && electronic > 0 && (
            <Button
              size="sm"
              className="mt-2"
              disabled={busy === 'send'}
              onClick={() =>
                act('send', async () => {
                  const r = await api<{ sent: number; test: number; failed: number }>(`/billing-runs/${run.id}/send`, { method: 'POST', ...opts });
                  reload();
                  setNotice(
                    r.test
                      ? `${r.test} avier skapades i testläge (e-post är inte ansluten ännu, så inget skickades till hyresgästerna).${r.failed ? ` ${r.failed} misslyckades.` : ''}`
                      : `${r.sent} avier skickades.${r.failed ? ` ${r.failed} misslyckades.` : ''}`,
                  );
                })
              }
            >
              {busy === 'send' ? 'Skickar…' : 'Skicka nu'}
            </Button>
          )}
        </div>
        <div className="px-4 py-3.5">
          <div className="text-[12px] text-ink-3">Brev</div>
          <div className="mt-1 text-[13px]">{run.queuedPostCount ? `${run.queuedPostCount} ska skrivas ut` : 'Inga brev väntar'}</div>
          {run.queuedPostCount > 0 && (
            <div className="mt-2 flex gap-2">
              <a href={`/api/billing-runs/${run.id}/print.pdf`} target="_blank" rel="noreferrer">
                <Button size="sm" variant="secondary">
                  Skriv ut (PDF)
                </Button>
              </a>
              {canIssue && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    act('printed', async () => {
                      await api(`/billing-runs/${run.id}/mark-printed`, { method: 'POST', ...opts });
                      reload();
                    })
                  }
                >
                  Markera som skickade
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="px-4 py-3.5">
          <div className="text-[12px] text-ink-3">Klart</div>
          <div className="mt-1 text-[13px]">
            {run.sentCount} av {run.invoiceCount} skickade
            {run.failedCount ? <span className="text-bad"> · {run.failedCount} misslyckades</span> : null}
          </div>
        </div>
      </Card>
    </section>
  );
}

function ApproveDialog({ open, run, warnings, onClose, onDone }: { open: boolean; run: RunDetail; warnings: number; onClose: () => void; onDone: (changed: boolean) => void }) {
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setAck(false);
      setError(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={`Godkänn avisering ${run.periodLabel}`}>
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-2">
          {run.invoiceCount} avier på totalt <span className="font-medium text-ink">{fmtOre(run.totalOre, true)}</span> får fakturanummer och OCR och låses.
          Därefter kan de bara rättas med kreditfaktura.
        </p>
        {warnings > 0 && (
          <label className="flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-warn">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            Jag har gått igenom de {warnings} varningarna.
          </label>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            disabled={busy || (warnings > 0 && !ack)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ ok: boolean; changed?: boolean }>(`/billing-runs/${run.id}/approve`, {
                  method: 'POST',
                  body: { fingerprint: run.fingerprint, acknowledgeWarnings: ack },
                  companyId: run.companyId,
                });
                onDone(!r.ok && !!r.changed);
              } catch (e) {
                setError((e as ApiError).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Godkänner…' : 'Godkänn och lås'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SettingsDialog({ open, run, onClose, onDone }: { open: boolean; run: RunDetail; onClose: () => void; onDone: () => void }) {
  const [invoiceDate, setInvoiceDate] = useState(run.invoiceDate);
  const [dueDate, setDueDate] = useState(run.dueDate ?? '');
  const [properties, setProperties] = useState<{ id: string; name: string; designation: string }[]>([]);
  const [selected, setSelected] = useState<string[]>(run.propertyIds ?? []);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!open) return;
    setInvoiceDate(run.invoiceDate);
    setDueDate(run.dueDate ?? '');
    setSelected(run.propertyIds ?? []);
    setError(null);
    api<{ id: string; name: string; designation: string }[]>('/properties', { companyId: run.companyId }).then(setProperties);
  }, [open, run]);
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;
  return (
    <Dialog open={open} onClose={onClose} title="Ändra urval och datum" wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Fakturadatum" error={fe('invoiceDate')}>
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <Field label="Förfallodatum" error={fe('dueDate')} hint="Tomt = sista bankdagen före perioden">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-ink-2">Fastigheter</div>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={!selected.length} onChange={() => setSelected([])} />
              Alla fastigheter
            </label>
            {properties.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-accent)]"
                  checked={selected.includes(p.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
                />
                {p.name} <span className="text-ink-3">{p.designation}</span>
              </label>
            ))}
          </div>
        </div>
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              try {
                await api(`/billing-runs/${run.id}`, {
                  method: 'PATCH',
                  body: { invoiceDate, dueDate: dueDate || null, propertyIds: selected.length ? selected : null },
                  companyId: run.companyId,
                });
                onDone();
              } catch (e) {
                setError(e as ApiError);
              }
            }}
          >
            Spara och uppdatera
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
