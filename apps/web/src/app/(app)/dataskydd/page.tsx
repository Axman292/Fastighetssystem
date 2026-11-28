'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Table, Tabs, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { INTEREST_STATUS } from '@/lib/vacancies';

interface Settings {
  autoEnabled: boolean;
  retentionMonths: number;
  bookkeepingYears: number;
  importRetentionMonths: number;
  includeOrganizations: boolean;
  lastAutoRunAt: string | null;
}

interface Preview {
  today: string;
  settings: Settings;
  anonymize: { id: string; customerNr: number; name: string; kind: string; lastActivity: string; mode: 'full' | 'contacts'; contacts: number; documents: number }[];
  accounting: { id: string; customerNr: number; name: string; lastBookkeeping: string | null; keepUntil: string | null }[];
  blocked: { id: string; customerNr: number; name: string; lastActivity: string; blockers: string[] }[];
  upcoming: { id: string; customerNr: number; name: string; purgeDate: string }[];
  imports: { id: string; batchNr: number; name: string; status: string; lastDate: string; action: 'purge' | 'delete' }[];
  interests: { id: string; registrationNr: number; name: string; status: string; lastActivity: string }[];
  interestRetentionMonths: number;
  unmatchedBankTransactions: number;
}

interface LogItem {
  id: string;
  kind: 'anonymize' | 'accounting' | 'import' | 'extract' | 'interest';
  customerId: string | null;
  customerNr: number | null;
  importBatchId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  createdByName: string | null;
}

interface Log {
  runs: { id: string; runNr: number; trigger: string; anonymized: number; accounting: number; imports: number; createdAt: string; createdByName: string | null; items: LogItem[] }[];
  extracts: LogItem[];
}

interface RunResult {
  runNr: number | null;
  anonymized: number;
  accounting: number;
  imports: number;
  interests?: number;
  bankTransactions: number;
}

const TRIGGER: Record<string, string> = { manual: 'Gallra nu', auto: 'Automatisk', request: 'På begäran' };
const KIND: Record<string, string> = { anonymize: 'Anonymiserad', accounting: 'Bokföringsunderlag rensat', import: 'Import rensad', extract: 'Registerutdrag', interest: 'Intresseanmälan borttagen' };

type Tab = 'now' | 'blocked' | 'upcoming' | 'log';

export default function GdprPage() {
  const { active, can, version } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('now');
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<RunResult | null>(null);

  const load = useCallback(() => {
    if (!active) return;
    setError(null);
    api<Preview>('/gdpr/preview').then(setPreview).catch((e: ApiError) => setError(e.message));
    api<Log>('/gdpr/log').then(setLog).catch(() => undefined);
  }, [active]);
  useEffect(load, [load, version]);

  if (!active) {
    return (
      <>
        <PageHeader title="Dataskydd" description="Gallring av tidigare hyresgästers personuppgifter enligt GDPR." />
        <Card className="px-5 py-8 text-center text-[13px] text-ink-2">Välj ett bolag i menyn uppe till vänster. Inställningar och gallring gäller ett bolag i taget.</Card>
      </>
    );
  }
  if (!can('gdpr.manage')) return <ErrorNote message="Du saknar behörighet att hantera gallring i det här bolaget." />;
  if (error) return <ErrorNote message={error} />;
  if (!preview) return null;

  const total = preview.anonymize.length + preview.accounting.length + preview.imports.length + preview.interests.length + (preview.unmatchedBankTransactions ? 1 : 0);

  return (
    <>
      <PageHeader
        title="Dataskydd"
        description={`Personuppgifter om tidigare hyresgäster tas bort när de inte längre behövs. Gäller ${active.companyName}.`}
        actions={
          <Button disabled={total === 0} onClick={() => setConfirm(true)}>
            Gallra nu
          </Button>
        }
      />

      {done && (
        <div className="mb-5 rounded-md bg-good-soft px-3 py-2 text-[13px] text-good">
          {done.runNr
            ? `Gallring ${done.runNr} klar. Anonymiserade kunder: ${done.anonymized}. Rensat bokföringsunderlag: ${done.accounting}. Rensade importer: ${done.imports}. Borttagna intresseanmälningar: ${done.interests ?? 0}.`
            : 'Det fanns inget att gallra.'}
        </div>
      )}

      <SettingsCard settings={preview.settings} onSaved={load} />

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'now', label: 'Gallras nu', count: total },
          { key: 'blocked', label: 'Stoppas', count: preview.blocked.length },
          { key: 'upcoming', label: 'Står på tur', count: preview.upcoming.length },
          { key: 'log', label: 'Logg', count: log?.runs.length },
        ]}
      />

      {tab === 'now' && <NowTab p={preview} />}

      {tab === 'blocked' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">
            Lagringstiden har gått, men något gör att uppgifterna fortfarande behövs. De gallras automatiskt när hindret är borta.
          </p>
          <Table head={['Kund', 'Senast aktiv', 'Hinder']} empty="Inget stoppas.">
            {preview.blocked.map((b) => (
              <tr key={b.id}>
                <Td>
                  <CustomerLink id={b.id} nr={b.customerNr} name={b.name} />
                </Td>
                <Td className="tabular text-ink-2">{b.lastActivity}</Td>
                <Td className="text-warn">{b.blockers.join(' · ')}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'upcoming' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">Tidigare hyresgäster som anonymiseras när lagringstiden har gått. Visar de 100 närmaste.</p>
          <Table head={['Kund', 'Anonymiseras från']} empty="Ingen står på tur.">
            {preview.upcoming.map((u) => (
              <tr key={u.id}>
                <Td>
                  <CustomerLink id={u.id} nr={u.customerNr} name={u.name} />
                </Td>
                <Td className="tabular text-ink-2">{u.purgeDate}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'log' && <LogTab log={log} />}

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Gallra nu">
        <div className="space-y-3 text-[13px]">
          <p>
            {preview.anonymize.length} kunder anonymiseras
            {preview.accounting.length ? `, ${preview.accounting.length} får sitt bokföringsunderlag rensat` : ''}
            {preview.imports.length ? `, ${preview.imports.length} importer rensas` : ''}
            {preview.interests.length ? ` och ${preview.interests.length} intresseanmälningar tas bort` : ''}.
          </p>
          <p className="text-bad">Det här går inte att ångra. Uppgifterna tas bort för gott, även ur revisionsloggen.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Avbryt
            </Button>
            <Button
              variant="danger"
              disabled={running}
              onClick={async () => {
                setRunning(true);
                try {
                  setDone(await api<RunResult>('/gdpr/run', { method: 'POST' }));
                  setConfirm(false);
                  load();
                } catch (e) {
                  setError((e as ApiError).message);
                } finally {
                  setRunning(false);
                }
              }}
            >
              {running ? 'Gallrar …' : 'Gallra'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function CustomerLink({ id, nr, name }: { id: string; nr: number; name: string }) {
  return (
    <Link href={`/kunder/${id}`} className="hover:underline">
      <span className="tabular text-ink-3">{nr}</span> <span className="font-medium">{name}</span>
    </Link>
  );
}

function NowTab({ p }: { p: Preview }) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-1 text-[14px] font-semibold">Anonymiseras</h2>
        <p className="mb-3 text-[13px] text-ink-2">
          Flyttat för mer än {p.settings.retentionMonths} månader sedan och allt är betalt. Namn, personnummer, kontaktuppgifter, adresser,
          anteckningar, kontaktpersoner och dokument tas bort. Fakturorna behåller mottagarens namn och adress tills bokföringstiden har gått.
        </p>
        <Table head={['Kund', 'Senast aktiv', 'Tas bort', '']} empty="Ingen kund ska anonymiseras just nu.">
          {p.anonymize.map((a) => (
            <tr key={a.id}>
              <Td>
                <CustomerLink id={a.id} nr={a.customerNr} name={a.name} />
              </Td>
              <Td className="tabular text-ink-2">{a.lastActivity}</Td>
              <Td className="text-ink-2">
                {a.mode === 'full' ? 'Alla personuppgifter' : 'Kontaktpersoner och anteckningar'}
                {a.contacts ? ` · ${a.contacts} ${a.contacts === 1 ? 'kontakt' : 'kontakter'}` : ''}
                {a.documents ? ` · ${a.documents} dokument` : ''}
              </Td>
              <Td className="text-right">{a.mode === 'contacts' && <Badge>Företag</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </section>

      <section>
        <h2 className="mb-1 text-[14px] font-semibold">Bokföringsunderlag rensas</h2>
        <p className="mb-3 text-[13px] text-ink-2">
          Fakturor och betalningar sparas i {p.settings.bookkeepingYears} år efter utgången av det kalenderår då räkenskapsåret avslutades. När den
          tiden har gått tas namn och adress bort även på fakturorna och i bankfilernas betalningar. Beloppen och bokföringen ligger kvar.
        </p>
        <Table head={['Kund', 'Senaste bokförda händelse', 'Sparades till']} empty="Inget bokföringsunderlag är gammalt nog.">
          {p.accounting.map((a) => (
            <tr key={a.id}>
              <Td>
                <CustomerLink id={a.id} nr={a.customerNr} name={a.name} />
              </Td>
              <Td className="tabular text-ink-2">{a.lastBookkeeping ?? '–'}</Td>
              <Td className="tabular text-ink-2">{a.keepUntil ?? '–'}</Td>
            </tr>
          ))}
        </Table>
        {p.unmatchedBankTransactions > 0 && (
          <p className="mt-2 text-[13px] text-ink-2">
            Dessutom rensas betalaruppgifter på {p.unmatchedBankTransactions} gamla inbetalningar som aldrig kopplades till någon kund.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-[14px] font-semibold">Importer rensas</h2>
        <p className="mb-3 text-[13px] text-ink-2">
          Uppladdade filer i importcentralen innehåller hela kundregister. De rensas {p.settings.importRetentionMonths} månader efter importen.
          Importen kan sedan inte ångras. Påbörjade importer som aldrig genomfördes tas bort helt.
        </p>
        <Table head={['Import', 'Senast ändrad', 'Åtgärd']} empty="Ingen import är gammal nog.">
          {p.imports.map((b) => (
            <tr key={b.id}>
              <Td>
                <Link href={`/import/${b.id}`} className="hover:underline">
                  <span className="tabular text-ink-3">{b.batchNr}</span> <span className="font-medium">{b.name}</span>
                </Link>
              </Td>
              <Td className="tabular text-ink-2">{b.lastDate}</Td>
              <Td className="text-ink-2">{b.action === 'purge' ? 'Filer och rader rensas' : 'Tas bort'}</Td>
            </tr>
          ))}
        </Table>
      </section>

      <section>
        <h2 className="mb-1 text-[14px] font-semibold">Intresseanmälningar tas bort</h2>
        <p className="mb-3 text-[13px] text-ink-2">
          Anmälningar i intresselistan tas bort helt när ingen kontakt har skett på {p.interestRetentionMonths} månader. Tiden ställs in under
          Intresselista → Formulär och inställningar.
        </p>
        <Table head={['Anmälan', 'Status', 'Senaste kontakt']} empty="Ingen anmälan är gammal nog.">
          {p.interests.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={`/intresse/${r.id}`} className="hover:underline">
                  <span className="tabular text-ink-3">{r.registrationNr}</span> <span className="font-medium">{r.name}</span>
                </Link>
              </Td>
              <Td className="text-ink-2">{INTEREST_STATUS[r.status]?.label ?? r.status}</Td>
              <Td className="tabular text-ink-2">{r.lastActivity}</Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

function SettingsCard({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [s, setS] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const fieldErr = (k: string) => err?.fields.find((f) => f.path === k)?.message;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });

  return (
    <Card className="mb-8 px-5 py-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-semibold">Automatisk gallring</div>
          <div className="mt-0.5 text-[13px] text-ink-2">
            {s.autoEnabled
              ? `Påslagen. Körs en gång per dygn.${settings.lastAutoRunAt ? ` Senast ${formatDateTime(settings.lastAutoRunAt)}.` : ''}`
              : 'Avstängd. Inget gallras förrän du trycker på Gallra nu eller slår på den.'}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={s.autoEnabled} onChange={(e) => setS({ ...s, autoEnabled: e.target.checked })} />
          Gallra automatiskt
        </label>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Anonymisera, månader efter avflyttning" error={fieldErr('retentionMonths')} hint="Standard 24 månader. Minst 6.">
          <Input type="number" min={6} max={120} value={s.retentionMonths} onChange={num('retentionMonths')} />
        </Field>
        <Field label="Spara bokföringsunderlag, år" error={fieldErr('bookkeepingYears')} hint="Bokföringslagen kräver minst 7 år.">
          <Input type="number" min={7} max={20} value={s.bookkeepingYears} onChange={num('bookkeepingYears')} />
        </Field>
        <Field label="Rensa importfiler, månader" error={fieldErr('importRetentionMonths')} hint="Standard 12 månader.">
          <Input type="number" min={1} max={120} value={s.importRetentionMonths} onChange={num('importRetentionMonths')} />
        </Field>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
          checked={s.includeOrganizations}
          onChange={(e) => setS({ ...s, includeOrganizations: e.target.checked })}
        />
        <span>
          Anonymisera även företagskunder helt
          <span className="block text-ink-3">Annars behålls företagsnamn och organisationsnummer, och bara kontaktpersoner och anteckningar tas bort.</span>
        </span>
      </label>
      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={!dirty || saving}
          onClick={async () => {
            setSaving(true);
            setErr(null);
            try {
              const { lastAutoRunAt: _ignored, ...body } = s;
              await api('/gdpr/settings', { method: 'PUT', body });
              setSaved(true);
              onSaved();
            } catch (e) {
              setErr(e as ApiError);
            } finally {
              setSaving(false);
            }
          }}
        >
          Spara inställningar
        </Button>
        {saved && !dirty && <span className="text-[13px] text-good">Sparat</span>}
        {err && !err.fields.length && <ErrorNote message={err.message} />}
      </div>
    </Card>
  );
}

function LogTab({ log }: { log: Log | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!log) return null;
  return (
    <div className="space-y-8">
      <section>
        <p className="mb-3 text-[13px] text-ink-2">Loggen visar vad som gallrats och när. Den innehåller bara kundnummer, aldrig namn eller personnummer.</p>
        <Table head={['Gallring', 'Tid', 'Sätt', 'Av', 'Anonymiserade', 'Bokföring', 'Importer']} empty="Ingen gallring har gjorts ännu.">
          {log.runs.map((r) => (
            <Fragment key={r.id}>
              <tr className="cursor-pointer hover:bg-subtle/60" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <Td className="font-medium tabular">{r.runNr}</Td>
                <Td className="tabular text-ink-2">{formatDateTime(r.createdAt)}</Td>
                <Td>
                  <Badge tone={r.trigger === 'auto' ? 'neutral' : 'accent'}>{TRIGGER[r.trigger] ?? r.trigger}</Badge>
                </Td>
                <Td className="text-ink-2">{r.createdByName ?? 'Systemet'}</Td>
                <Td className="tabular">{r.anonymized}</Td>
                <Td className="tabular">{r.accounting}</Td>
                <Td className="tabular">{r.imports}</Td>
              </tr>
              {open === r.id && (
                <tr>
                  <td colSpan={7} className="bg-subtle/50 px-4 py-3">
                    <ul className="space-y-1 text-[12.5px]">
                      {r.items.map((i) => (
                        <li key={i.id}>
                          <span className="font-medium">{KIND[i.kind]}</span>{' '}
                          <span className="text-ink-2">{describe(i)}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </Table>
      </section>
      <section>
        <h2 className="mb-3 text-[14px] font-semibold">Registerutdrag</h2>
        <Table head={['Tid', 'Kund', 'Format', 'Av']} empty="Inga registerutdrag har tagits ut.">
          {log.extracts.map((e) => (
            <tr key={e.id}>
              <Td className="tabular text-ink-2">{formatDateTime(e.createdAt)}</Td>
              <Td className="tabular">{e.customerId ? <Link href={`/kunder/${e.customerId}`}>Kund {e.customerNr}</Link> : `Kund ${e.customerNr}`}</Td>
              <Td className="text-ink-2">{String(e.details.format ?? '').toUpperCase()}</Td>
              <Td className="text-ink-2">{e.createdByName ?? '–'}</Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

function describe(i: LogItem): string {
  const d = i.details as Record<string, number | string>;
  if (i.kind === 'import') return `import ${d.batchNr}: ${d.action === 'deleted' ? 'borttagen' : `${d.files} filer och ${d.rows} rader rensade`}`;
  if (i.kind === 'interest') return `anmälan ${d.registrationNr}`;
  if (i.kind === 'accounting' && !i.customerNr) return `betalaruppgifter på ${d.unmatchedBankTransactions} inbetalningar utan kund`;
  const parts = Object.entries(d)
    .filter(([k, v]) => k !== 'mode' && typeof v === 'number' && v > 0)
    .map(([k, v]) => `${v} ${PART[k] ?? k}`);
  return `kund ${i.customerNr}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

const PART: Record<string, string> = {
  contacts: 'kontaktpersoner',
  contractNotes: 'avtalsanteckningar',
  reminders: 'påminnelser',
  deliveries: 'utskick',
  documents: 'dokument',
  auditRows: 'rader i revisionsloggen',
  invoices: 'fakturor',
  bankTransactions: 'bankbetalningar',
  payments: 'betalningsnoteringar',
};
