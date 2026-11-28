'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Tabs, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

interface Mandate {
  id: string;
  customerId: string;
  customerName: string;
  customerNr: number;
  payerNr: string;
  clearingNr: string | null;
  accountNr: string | null;
  holderId: string | null;
  holderName: string | null;
  source: 'form' | 'internet_bank';
  status: string;
  response: 'approve' | 'reject' | null;
  signedDate: string | null;
  bgcMessage: string | null;
  activatedDate: string | null;
  cancelledDate: string | null;
  note: string | null;
  openPayments: number;
}

interface Payment {
  id: string;
  invoiceId: string;
  invoiceNr: number;
  customerId: string;
  customerName: string;
  amountOre: number;
  paymentDate: string;
  reference: string;
  status: string;
  statusCode: string | null;
  message: string | null;
  fallbackChannel: string | null;
  fallbackStatus: string | null;
}

interface AgFile {
  id: string;
  direction: 'in' | 'out';
  kind: string;
  filename: string;
  recordCount: number;
  totalOre: number;
  fileDate: string | null;
  status: string;
  uploadedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  result: { lines?: ResultLine[]; paid?: number; failed?: number; fallbacks?: number; unmatched?: number };
}

interface ResultLine {
  payerNr: string;
  customerName: string | null;
  outcome: string;
  message: string;
}

interface Overview {
  counts: { active: number; review: number; toSend: number; waiting: number; planned: number; plannedOre: number; sent: number; failed: number };
  settings: { enabled: boolean; customerNr: string | null; bankgiro: string | null; companyBankgiro: string | null } | null;
}

interface CustomerOption {
  id: string;
  name: string;
  customerNr: number;
  nationalId: string | null;
}

const MANDATE_STATUS: Record<string, { label: string; tone: Tone }> = {
  review: { label: 'Att granska', tone: 'warn' },
  new: { label: 'Att skicka', tone: 'accent' },
  sent: { label: 'Väntar på Bankgirot', tone: 'neutral' },
  active: { label: 'Godkänt', tone: 'good' },
  rejected: { label: 'Avvisat', tone: 'bad' },
  cancel_new: { label: 'Makulering att skicka', tone: 'accent' },
  cancel_sent: { label: 'Makulering skickad', tone: 'neutral' },
  cancelled: { label: 'Makulerat', tone: 'neutral' },
};

const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  planned: { label: 'Planerad', tone: 'accent' },
  sent: { label: 'Skickad', tone: 'neutral' },
  paid: { label: 'Dragen', tone: 'good' },
  failed: { label: 'Misslyckad', tone: 'bad' },
  cancelled: { label: 'Dras inte', tone: 'neutral' },
};

const FILE_KIND: Record<string, string> = {
  mandates: 'Medgivanden',
  payments: 'Dragningar',
  mandate_advice: 'Medgivandeavisering',
  internet_mandates: 'Medgivanden från internetbanken',
  payment_spec: 'Betalningsspecifikation',
  rejected_payments: 'Avvisade betalningsuppdrag',
};

type Tab = 'mandates' | 'payments' | 'files' | 'settings';

function account(m: Mandate) {
  if (!m.clearingNr) return '–';
  return `${m.clearingNr}-${m.accountNr}`;
}

export default function AutogiroPage() {
  const { active, can, version } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('mandates');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [mandates, setMandates] = useState<Mandate[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [files, setFiles] = useState<AgFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ title: string; text: string; lines: ResultLine[] } | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(() => {
    api<Overview>('/autogiro/overview').then(setOverview).catch((e) => setError(e.message));
    api<Mandate[]>('/autogiro/mandates').then(setMandates);
    api<Payment[]>('/autogiro/payments').then(setPayments);
    api<AgFile[]>('/autogiro/files').then(setFiles);
  }, []);
  useEffect(load, [load, version]);

  const canWrite = !!active && can('payment.write');
  const enabled = !!overview?.settings?.enabled;

  async function run(key: string, fn: () => Promise<void>) {
    setError(null);
    setBusy(key);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function download(id: string) {
    window.location.href = `/api/autogiro/files/${id}/download`;
  }

  const makeFile = (kind: 'mandates' | 'payments') =>
    run(`file-${kind}`, async () => {
      const r = await api<{ id: string; filename: string; count: number; totalOre: number; skipped: { customerName: string; invoiceNr: number | null; reason: string }[] }>(
        `/autogiro/files/${kind}`,
        { method: 'POST' },
      );
      download(r.id);
      setResult({
        title: kind === 'mandates' ? 'Medgivandefil skapad' : 'Dragningsfil skapad',
        text:
          kind === 'mandates'
            ? `${r.count} medgivanden finns i filen ${r.filename}. Skicka den till Bankgirot och tryck sedan på Markera som skickad under Filer.`
            : `${r.count} dragningar på totalt ${fmtOre(r.totalOre, true)} finns i filen ${r.filename}. Skicka den till Bankgirot senast bankdagen före första förfallodagen.`,
        lines: r.skipped.map((s) => ({ payerNr: '', customerName: s.customerName, outcome: s.invoiceNr ? `Avi ${s.invoiceNr}` : '', message: s.reason })),
      });
    });

  async function chooseIncoming(f: File | undefined) {
    if (!f) return;
    await run('incoming', async () => {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/autogiro/files/incoming', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (input.current) input.current.value = '';
      if (!res.ok) throw new Error(data.message ?? 'Något gick fel');
      const parts = [
        data.paid ? `${data.paid} dragningar bokförda` : null,
        data.failed ? `${data.failed} misslyckade` : null,
        data.fallbacks ? `${data.fallbacks} hyresgäster fick vanlig avi` : null,
        data.unmatched ? `${data.unmatched} rader kunde inte kopplas och behöver hanteras` : null,
      ].filter(Boolean);
      setResult({ title: `${FILE_KIND[data.kind] ?? 'Fil'} inläst`, text: parts.length ? `${parts.join(', ')}.` : 'Filen är inläst.', lines: data.lines ?? [] });
    });
  }

  const c = overview?.counts;
  const shownMandates = (mandates ?? []).filter((m) => showClosed || !['rejected', 'cancelled'].includes(m.status));

  return (
    <>
      <PageHeader
        title="Autogiro"
        description="Hyran dras automatiskt från hyresgästens konto på förfallodagen via Bankgirot."
        actions={
          canWrite && enabled ? (
            <>
              <input ref={input} type="file" accept=".txt,.dat,.ag,text/plain" className="hidden" onChange={(e) => chooseIncoming(e.target.files?.[0])} />
              <Button variant="secondary" disabled={busy === 'incoming'} onClick={() => input.current?.click()}>
                Läs in fil från Bankgirot
              </Button>
              <Button onClick={() => setAdding(true)}>Nytt medgivande</Button>
            </>
          ) : null
        }
      />
      <ErrorNote message={error} />
      {!active && <ErrorNote message="Välj ett bolag för att hantera autogiro." />}
      {overview && active && !enabled && (
        <Card className="mb-6 p-5">
          <div className="text-[14px] font-medium">Autogiro är inte påslaget för bolaget</div>
          <p className="mt-1 text-[13px] text-ink-2">
            Bolaget behöver ett avtal om Autogiro med banken och ett kundnummer från Bankgirot. Fyll i kundnumret under Inställningar och slå på autogiro.
          </p>
          <Button className="mt-3" variant="secondary" onClick={() => setTab('settings')}>
            Till inställningar
          </Button>
        </Card>
      )}

      {c && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Godkända medgivanden" value={c.active} sub={c.review ? `${c.review} att granska` : c.waiting ? `${c.waiting} väntar på Bankgirot` : undefined} />
          <Stat label="Medgivanden att skicka" value={c.toSend} />
          <Stat label="Planerade dragningar" value={c.planned} sub={c.planned ? fmtOre(c.plannedOre) : undefined} />
          <Stat label="Misslyckade (90 dagar)" value={c.failed} sub={c.sent ? `${c.sent} skickade väntar på svar` : undefined} />
        </div>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'mandates', label: 'Medgivanden', count: c ? c.active + c.review + c.toSend + c.waiting : undefined },
          { key: 'payments', label: 'Dragningar', count: c?.planned },
          { key: 'files', label: 'Filer' },
          { key: 'settings', label: 'Inställningar' },
        ]}
      />

      <div className="mt-4">
        {tab === 'mandates' && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {canWrite && enabled && (
                <Button disabled={!c?.toSend || busy === 'file-mandates'} onClick={() => makeFile('mandates')}>
                  Skapa medgivandefil{c?.toSend ? ` (${c.toSend})` : ''}
                </Button>
              )}
              <a className="text-[13px] text-accent hover:underline" href="/api/autogiro/mandate-form.pdf" target="_blank" rel="noreferrer">
                Tom medgivandeblankett (PDF)
              </a>
              <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
                Visa avslutade
              </label>
            </div>
            <Table head={['Hyresgäst', 'Betalarnr', 'Konto', 'Källa', 'Status', 'Meddelande', '']} empty="Inga medgivanden ännu.">
              {shownMandates.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Link href={`/kunder/${m.customerId}`} className="hover:underline">
                      {m.customerName}
                    </Link>
                  </Td>
                  <Td className="tabular">{m.payerNr}</Td>
                  <Td className="tabular text-ink-2">{account(m)}</Td>
                  <Td className="text-ink-2">{m.source === 'internet_bank' ? 'Internetbanken' : 'Blankett'}</Td>
                  <Td>
                    <Badge tone={MANDATE_STATUS[m.status]?.tone}>{MANDATE_STATUS[m.status]?.label ?? m.status}</Badge>
                    {m.status === 'new' && m.response && <span className="ml-1.5 text-[12px] text-ink-3">{m.response === 'approve' ? 'godkänns' : 'avvisas'}</span>}
                  </Td>
                  <Td className="text-[12.5px] text-ink-2">{m.bgcMessage ?? m.note ?? ''}</Td>
                  <Td className="text-right">
                    {canWrite && m.status === 'review' && (
                      <span className="inline-flex gap-1.5">
                        <Button size="sm" onClick={() => run(`r-${m.id}`, () => api(`/autogiro/mandates/${m.id}/respond`, { method: 'POST', body: { approve: true } }))}>
                          Godkänn
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => run(`r-${m.id}`, () => api(`/autogiro/mandates/${m.id}/respond`, { method: 'POST', body: { approve: false } }))}>
                          Avvisa
                        </Button>
                      </span>
                    )}
                    {canWrite && ['new', 'sent', 'active'].includes(m.status) && !m.response && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === `c-${m.id}`}
                        onClick={() => {
                          if (!window.confirm(`Makulera medgivandet för ${m.customerName}? Planerade dragningar stoppas och hyresgästen får vanlig avi.`)) return;
                          run(`c-${m.id}`, () => api(`/autogiro/mandates/${m.id}/cancel`, { method: 'POST' }));
                        }}
                      >
                        Makulera
                      </Button>
                    )}
                    <a className="ml-2 text-[12.5px] text-accent hover:underline" href={`/api/autogiro/mandate-form.pdf?customerId=${m.customerId}`} target="_blank" rel="noreferrer">
                      Blankett
                    </a>
                  </Td>
                </tr>
              ))}
            </Table>
          </>
        )}

        {tab === 'payments' && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {canWrite && enabled && (
                <>
                  <Button disabled={!c?.planned || busy === 'file-payments'} onClick={() => makeFile('payments')}>
                    Skapa dragningsfil{c?.planned ? ` (${c.planned})` : ''}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy === 'plan'}
                    onClick={() =>
                      run('plan', async () => {
                        const r = await api<{ planned: number }>('/autogiro/payments/plan', { method: 'POST' });
                        setResult({ title: 'Dragningar planerade', text: r.planned ? `${r.planned} obetalda avier dras på förfallodagen.` : 'Det fanns inga nya avier att dra.', lines: [] });
                      })
                    }
                  >
                    Planera obetalda avier
                  </Button>
                </>
              )}
              <span className="text-[12.5px] text-ink-3">Dragningar planeras när en aviseringskörning godkänns, för hyresgäster med medgivande.</span>
            </div>
            <Table head={['Dras', 'Hyresgäst', 'Avi', <span key="b" className="text-right">Belopp</span>, 'Status', 'Meddelande', '']} empty="Inga dragningar ännu.">
              {(payments ?? []).map((p) => (
                <tr key={p.id}>
                  <Td className="tabular">{p.paymentDate}</Td>
                  <Td>
                    <Link href={`/kunder/${p.customerId}`} className="hover:underline">
                      {p.customerName}
                    </Link>
                  </Td>
                  <Td className="tabular">
                    <Link href={`/fakturor/${p.invoiceId}`} className="hover:underline">
                      {p.invoiceNr}
                    </Link>
                  </Td>
                  <Td className="tabular text-right font-medium">{fmtOre(p.amountOre, true)}</Td>
                  <Td>
                    <Badge tone={PAYMENT_STATUS[p.status]?.tone}>{PAYMENT_STATUS[p.status]?.label ?? p.status}</Badge>
                  </Td>
                  <Td className="text-[12.5px] text-ink-2">
                    {p.message}
                    {p.fallbackChannel && (
                      <span className="block text-ink-3">
                        Vanlig avi {p.fallbackChannel === 'post' ? (p.fallbackStatus === 'queued' ? 'ska skrivas ut och skickas med post' : 'skickad med post') : 'skickad med e-post'}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right">
                    {canWrite && p.status === 'planned' && (
                      <Button size="sm" variant="ghost" onClick={() => run(`p-${p.id}`, () => api(`/autogiro/payments/${p.id}/cancel`, { method: 'POST' }))}>
                        Stoppa
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </>
        )}

        {tab === 'files' && (
          <Table head={['Skapad', 'Riktning', 'Typ', 'Fil', 'Poster', <span key="b" className="text-right">Belopp</span>, 'Status', '']} empty="Inga filer ännu.">
            {(files ?? []).map((f) => (
              <tr key={f.id}>
                <Td className="tabular text-ink-2">{formatDateTime(f.createdAt)}</Td>
                <Td>{f.direction === 'out' ? 'Till Bankgirot' : 'Från Bankgirot'}</Td>
                <Td>{FILE_KIND[f.kind] ?? f.kind}</Td>
                <Td className="text-[12.5px] text-ink-2">{f.filename}</Td>
                <Td className="tabular">{f.recordCount}</Td>
                <Td className="tabular text-right">{f.totalOre ? fmtOre(f.totalOre, true) : ''}</Td>
                <Td>
                  {f.direction === 'out' ? (
                    f.status === 'uploaded' ? (
                      <Badge tone="good">Skickad</Badge>
                    ) : (
                      <Badge tone="warn">Ej skickad</Badge>
                    )
                  ) : (
                    <Badge tone="good">Inläst</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  <span className="inline-flex gap-1.5">
                    {f.direction === 'in' && f.result?.lines?.length ? (
                      <Button size="sm" variant="ghost" onClick={() => setResult({ title: FILE_KIND[f.kind] ?? 'Fil', text: f.filename, lines: f.result.lines ?? [] })}>
                        Visa
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => download(f.id)}>
                      Ladda ned
                    </Button>
                    {canWrite && f.direction === 'out' && f.status !== 'uploaded' && (
                      <Button size="sm" variant="secondary" onClick={() => run(`u-${f.id}`, () => api(`/autogiro/files/${f.id}/uploaded`, { method: 'POST' }))}>
                        Markera som skickad
                      </Button>
                    )}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {tab === 'settings' && overview?.settings && <Settings settings={overview.settings} canWrite={canWrite} onSaved={load} />}
      </div>

      {adding && <NewMandate onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}

      <Dialog open={!!result} onClose={() => setResult(null)} title={result?.title ?? ''} wide>
        {result && (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-2">{result.text}</p>
            {result.lines.length > 0 && (
              <Table head={['Hyresgäst', 'Betalarnr', 'Resultat', 'Förklaring']} sortable={false}>
                {result.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.customerName ?? '–'}</Td>
                    <Td className="tabular">{l.payerNr}</Td>
                    <Td>{l.outcome}</Td>
                    <Td className="text-[12.5px] text-ink-2">{l.message}</Td>
                  </tr>
                ))}
              </Table>
            )}
            <div className="flex justify-end">
              <Button onClick={() => setResult(null)}>Stäng</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Settings({ settings, canWrite, onSaved }: { settings: NonNullable<Overview['settings']>; canWrite: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ enabled: settings.enabled, customerNr: settings.customerNr ?? '', bankgiro: settings.bankgiro ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await api('/autogiro/settings', { method: 'PUT', body: form });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card className="max-w-xl space-y-4 p-5">
      <ErrorNote message={error} />
      <Field label="Kundnummer hos Bankgirot" hint="Sex siffror. Du får det från Bankgirot när avtalet om Autogiro är klart.">
        <Input value={form.customerNr} disabled={!canWrite} onChange={(e) => setForm({ ...form, customerNr: e.target.value })} />
      </Field>
      <Field label="Bankgiro för autogiro" hint={`Lämna tomt för att använda bolagets bankgiro${settings.companyBankgiro ? ` (${settings.companyBankgiro})` : ''}.`}>
        <Input value={form.bankgiro} disabled={!canWrite} onChange={(e) => setForm({ ...form, bankgiro: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={form.enabled} disabled={!canWrite} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Använd autogiro för bolaget
      </label>
      <p className="text-[12.5px] text-ink-3">
        När autogiro är påslaget planeras en dragning för varje avi till en hyresgäst med godkänt medgivande. Avin säger då att beloppet dras automatiskt.
      </p>
      {canWrite && (
        <div className="flex items-center gap-3">
          <Button onClick={save}>Spara</Button>
          {saved && <span className="text-[13px] text-good">Sparat</span>}
        </div>
      )}
    </Card>
  );
}

function NewMandate({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [form, setForm] = useState({ customerId: '', clearingNr: '', accountNr: '', holderId: '', holderName: '', signedDate: todayIso(), note: '' });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CustomerOption[]>('/customers').then(setCustomers);
  }, []);

  function pick(id: string) {
    const c = customers.find((x) => x.id === id);
    setForm({ ...form, customerId: id, holderId: form.holderId || c?.nationalId || '', holderName: form.holderName || c?.name || '' });
  }

  async function save() {
    setError(null);
    setFields({});
    setBusy(true);
    try {
      await api('/autogiro/mandates', { method: 'POST', body: { ...form, holderName: form.holderName || null, note: form.note || null, signedDate: form.signedDate || null } });
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) setFields(Object.fromEntries(e.fields.map((f) => [f.path, f.message])));
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Nytt medgivande">
      <div className="space-y-3">
        <p className="text-[13px] text-ink-2">Fyll i uppgifterna från den påskrivna blanketten. Medgivandet skickas till Bankgirot med nästa medgivandefil.</p>
        <ErrorNote message={error} />
        <Field label="Hyresgäst" error={fields.customerId}>
          <Select value={form.customerId} onChange={(e) => pick(e.target.value)}>
            <option value="">Välj hyresgäst</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.customerNr})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_2fr] gap-3">
          <Field label="Clearingnummer" error={fields.clearingNr}>
            <Input value={form.clearingNr} onChange={(e) => setForm({ ...form, clearingNr: e.target.value })} />
          </Field>
          <Field label="Kontonummer" error={fields.accountNr}>
            <Input value={form.accountNr} onChange={(e) => setForm({ ...form, accountNr: e.target.value })} />
          </Field>
        </div>
        <Field label="Kontohavarens personnummer eller organisationsnummer" error={fields.holderId}>
          <Input value={form.holderId} onChange={(e) => setForm({ ...form, holderId: e.target.value })} />
        </Field>
        <Field label="Kontohavarens namn">
          <Input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} />
        </Field>
        <Field label="Underskrivet">
          <Input type="date" value={form.signedDate} onChange={(e) => setForm({ ...form, signedDate: e.target.value })} />
        </Field>
        <Field label="Anteckning">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button disabled={busy || !form.customerId} onClick={save}>
            Spara
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
