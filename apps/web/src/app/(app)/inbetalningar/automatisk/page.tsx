'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td, formatDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Connection {
  id: string;
  name: string;
  kind: 'sftp' | 'folder';
  host: string | null;
  port: number;
  username: string | null;
  remoteDir: string;
  filePattern: string | null;
  hostFingerprint: string | null;
  publicKey: string | null;
  enabled: boolean;
  autoBook: boolean;
  deleteAfterFetch: boolean;
  intervalMinutes: number;
  notifyEmail: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  runAsName: string | null;
  hasKey: boolean;
  nextRunAt: string;
}

interface Run {
  id: string;
  connectionId: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  status: 'running' | 'ok' | 'error';
  filesFound: number;
  filesImported: number;
  payments: number;
  booked: number;
  unmatched: number;
  message: string | null;
}

interface Data {
  connections: Connection[];
  runs: Run[];
  folderEnabled: boolean;
  secretConfigured: boolean;
  schedulerEnabled: boolean;
}

interface RunResult {
  status: 'ok' | 'error' | 'busy';
  message: string | null;
  files: { name: string; result: string; message: string | null }[];
}

type Form = Omit<Connection, 'id' | 'publicKey' | 'lastRunAt' | 'lastStatus' | 'lastError' | 'runAsName' | 'hasKey' | 'nextRunAt'>;

const EMPTY: Form = {
  name: 'Danske Bank',
  kind: 'sftp',
  host: '',
  port: 22,
  username: '',
  remoteDir: '/',
  filePattern: '',
  hostFingerprint: null,
  enabled: false,
  autoBook: true,
  deleteAfterFetch: false,
  intervalMinutes: 60,
  notifyEmail: '',
};

const INTERVALS = [
  [15, 'Var 15:e minut'],
  [30, 'Varje halvtimme'],
  [60, 'Varje timme'],
  [180, 'Var tredje timme'],
  [720, 'Två gånger per dygn'],
  [1440, 'En gång per dygn'],
] as const;

export default function AutoFetchPage() {
  const { me } = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; form: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; r: RunResult } | null>(null);
  const [copied, setCopied] = useState(false);
  const [replaceKey, setReplaceKey] = useState<Connection | null>(null);

  const load = useCallback(() => {
    api<Data>('/bank-connections')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!me.user.isGroupAdmin) {
    return (
      <>
        <PageHeader title="Automatisk hämtning" />
        <ErrorNote message="Bara koncernadministratörer kan ställa in hämtning av bankfiler." />
      </>
    );
  }

  async function save() {
    if (!edit) return;
    setError(null);
    setBusy('save');
    try {
      const body = { ...edit.form, host: edit.form.host || null, username: edit.form.username || null, filePattern: edit.form.filePattern || null, notifyEmail: edit.form.notifyEmail || null };
      if (edit.id) await api(`/bank-connections/${edit.id}`, { method: 'PATCH', body });
      else await api('/bank-connections', { method: 'POST', body });
      setEdit(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function action(c: Connection, what: 'key' | 'test' | 'run' | 'toggle') {
    setError(null);
    setBusy(`${what}-${c.id}`);
    try {
      if (what === 'key') {
        if (c.hasKey && replaceKey?.id !== c.id) {
          setReplaceKey(c);
          return;
        }
        setReplaceKey(null);
        await api(`/bank-connections/${c.id}/key`, { method: 'POST' });
      } else if (what === 'toggle') {
        await api(`/bank-connections/${c.id}`, { method: 'PATCH', body: { ...toForm(c), enabled: !c.enabled } });
      } else {
        const r = await api<RunResult>(`/bank-connections/${c.id}/${what}`, { method: 'POST' });
        setResult({ title: what === 'test' ? 'Test av anslutningen' : 'Hämtning', r });
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setEdit((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));

  return (
    <>
      <PageHeader
        title="Automatisk hämtning av inbetalningar"
        description="Systemet hämtar bankens inbetalningsfiler (camt.054) själv, läser in dem i rätt bolag och bokför betalningar som matchar en avi. Det som inte matchar hamnar under Inbetalningar, Att hantera."
        actions={
          <>
            <Link href="/inbetalningar">
              <Button variant="ghost">Tillbaka</Button>
            </Link>
            <Button onClick={() => setEdit({ id: null, form: EMPTY })}>Ny anslutning</Button>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}
      {data && !data.secretConfigured && (
        <div className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Servern saknar APP_SECRET_KEY. Den behövs för att spara bankens nyckel säkert. Se instruktionen deploy/BANKFIL.md.
        </div>
      )}
      {data && !data.schedulerEnabled && (
        <div className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Den schemalagda hämtningen är avstängd på servern (BANK_FETCH=off). Använd Hämta nu.
        </div>
      )}

      {data?.connections.length === 0 && (
        <Card className="mb-6 px-5 py-4 text-[13px] text-ink-2">
          <div className="mb-2 font-medium text-ink">Så kommer du igång</div>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Beställ camt.054 för bankgirot och SFTP-filöverföring hos Danske Bank.</li>
            <li>Klicka Ny anslutning, fyll i server och användarnamn som banken ger dig och spara.</li>
            <li>Klicka Skapa nyckel och skicka den publika nyckeln till banken.</li>
            <li>När banken aktiverat den: klicka Testa, sedan Slå på.</li>
          </ol>
        </Card>
      )}

      <div className="space-y-4">
        {data?.connections.map((c) => (
          <Card key={c.id} className="px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[15px] font-semibold">
                  {c.name}
                  {c.enabled ? <Badge tone="good">På</Badge> : <Badge>Av</Badge>}
                  {c.lastStatus === 'error' && <Badge tone="bad">Fel vid senaste hämtning</Badge>}
                </div>
                <div className="mt-1 text-[13px] text-ink-2">
                  {c.kind === 'sftp' ? `SFTP ${c.username ?? '?'}@${c.host ?? '?'}:${c.port}, mapp ${c.remoteDir}` : `Mapp på servern: ${c.remoteDir}`}
                  {c.filePattern ? `, filer ${c.filePattern}` : ''}
                </div>
                <div className="mt-1 text-[12px] text-ink-3">
                  {INTERVALS.find(([m]) => m === c.intervalMinutes)?.[1] ?? `Var ${c.intervalMinutes}:e minut`}
                  {c.autoBook ? ', matchade bokförs direkt' : ', allt lämnas för granskning'}
                  {c.deleteAfterFetch ? ', filer tas bort hos banken efter hämtning' : ''}
                  {c.notifyEmail ? `, besked till ${c.notifyEmail}` : ''}
                  {c.lastRunAt ? `. Senast hämtat ${formatDateTime(c.lastRunAt)}` : '. Inte hämtat ännu'}
                  {c.enabled ? `, nästa ${formatDateTime(c.nextRunAt)}` : ''}.
                </div>
                {c.lastError && <div className="mt-2 text-[12px] text-bad">{c.lastError}</div>}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEdit({ id: c.id, form: toForm(c) })}>
                  Ändra
                </Button>
                {c.kind === 'sftp' && (
                  <Button size="sm" variant="secondary" onClick={() => action(c, 'key')} disabled={!!busy}>
                    {busy === `key-${c.id}` ? 'Skapar…' : c.hasKey ? 'Ny nyckel' : 'Skapa nyckel'}
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => action(c, 'test')} disabled={!!busy}>
                  {busy === `test-${c.id}` ? 'Testar…' : 'Testa'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => action(c, 'run')} disabled={!!busy}>
                  {busy === `run-${c.id}` ? 'Hämtar…' : 'Hämta nu'}
                </Button>
                <Button size="sm" variant={c.enabled ? 'danger' : 'primary'} onClick={() => action(c, 'toggle')} disabled={!!busy}>
                  {c.enabled ? 'Stäng av' : 'Slå på'}
                </Button>
              </div>
            </div>
            {c.kind === 'sftp' && c.publicKey && (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-ink-2">Publik nyckel att skicka till banken</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(c.publicKey ?? '');
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? 'Kopierad' : 'Kopiera'}
                  </Button>
                </div>
                <textarea readOnly value={c.publicKey} rows={3} className="w-full resize-none rounded-md border border-line bg-subtle px-2.5 py-2 font-mono text-[11px] text-ink-2" />
                <div className="mt-1 text-[12px] text-ink-3">
                  Den här delen är inte hemlig. Den hemliga delen av nyckeln lämnar aldrig servern.
                  {c.hostFingerprint ? ` Bankens server är sparad med fingeravtrycket ${c.hostFingerprint}.` : ''}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-[15px] font-semibold">Senaste hämtningar</h2>
      <Table head={['Tid', 'Anslutning', 'Hur', 'Nya filer', 'Betalningar', 'Bokförda', 'Att hantera', 'Resultat']} empty="Inga hämtningar ännu.">
        {data?.runs.map((r) => (
          <tr key={r.id}>
            <Td className="tabular text-ink-2">{formatDateTime(r.startedAt)}</Td>
            <Td>{data.connections.find((c) => c.id === r.connectionId)?.name ?? '–'}</Td>
            <Td className="text-ink-2">{r.trigger === 'schedule' ? 'Schema' : 'Hämta nu'}</Td>
            <Td className="tabular">{r.filesImported}</Td>
            <Td className="tabular">{r.payments}</Td>
            <Td className="tabular">{r.booked}</Td>
            <Td className="tabular">
              {r.unmatched ? (
                <Link href="/inbetalningar" className="text-warn hover:underline">
                  {r.unmatched}
                </Link>
              ) : (
                0
              )}
            </Td>
            <Td className="max-w-[360px]">
              {r.status === 'error' ? <Badge tone="bad">Fel</Badge> : r.status === 'running' ? <Badge>Pågår</Badge> : <Badge tone="good">OK</Badge>}
              {r.message && <div className="mt-0.5 text-[12px] text-ink-3">{r.message}</div>}
            </Td>
          </tr>
        ))}
      </Table>

      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Ändra anslutning' : 'Ny anslutning'} wide>
        {edit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Namn">
                <Input value={edit.form.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Typ">
                <Select value={edit.form.kind} onChange={(e) => set('kind', e.target.value as Form['kind'])}>
                  <option value="sftp">SFTP hos banken</option>
                  {data?.folderEnabled && <option value="folder">Mapp på servern</option>}
                </Select>
              </Field>
            </div>
            {edit.form.kind === 'sftp' ? (
              <>
                <div className="grid grid-cols-[1fr_90px] gap-3">
                  <Field label="Server" hint="Adressen banken ger dig, t.ex. sftp.danskebank.com">
                    <Input value={edit.form.host ?? ''} onChange={(e) => set('host', e.target.value)} />
                  </Field>
                  <Field label="Port">
                    <Input type="number" value={edit.form.port} onChange={(e) => set('port', Number(e.target.value))} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Användarnamn" hint="Från banken">
                    <Input value={edit.form.username ?? ''} onChange={(e) => set('username', e.target.value)} />
                  </Field>
                  <Field label="Mapp hos banken" hint="Där banken lägger filerna till dig">
                    <Input value={edit.form.remoteDir} onChange={(e) => set('remoteDir', e.target.value)} />
                  </Field>
                </div>
                <Field label="Bankens fingeravtryck (frivilligt)" hint="Om banken uppger ett. Annars sparas det automatiskt vid första anslutningen.">
                  <Input value={edit.form.hostFingerprint ?? ''} placeholder="SHA256:…" onChange={(e) => set('hostFingerprint', e.target.value || null)} />
                </Field>
              </>
            ) : (
              <Field label="Mapp" hint="Under serverns mapp för bankfiler">
                <Input value={edit.form.remoteDir} onChange={(e) => set('remoteDir', e.target.value)} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bara filer som heter (frivilligt)" hint="T.ex. *.xml. Tomt = alla filer">
                <Input value={edit.form.filePattern ?? ''} onChange={(e) => set('filePattern', e.target.value)} />
              </Field>
              <Field label="Hur ofta">
                <Select value={edit.form.intervalMinutes} onChange={(e) => set('intervalMinutes', Number(e.target.value))}>
                  {INTERVALS.map(([m, l]) => (
                    <option key={m} value={m}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Skicka besked till (frivilligt)" hint="E-post när något behöver hanteras eller hämtningen misslyckas">
              <Input type="email" value={edit.form.notifyEmail ?? ''} onChange={(e) => set('notifyEmail', e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={edit.form.autoBook} onChange={(e) => set('autoBook', e.target.checked)} />
              Bokför betalningar som matchar en avi direkt
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={edit.form.deleteAfterFetch} onChange={(e) => set('deleteAfterFetch', e.target.checked)} />
              Ta bort filen hos banken när den lästs in
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={edit.form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Hämta automatiskt
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Avbryt
              </Button>
              <Button onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Sparar…' : 'Spara'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!replaceKey} onClose={() => setReplaceKey(null)} title="Skapa ny nyckel?">
        <p className="text-[13px] text-ink-2">
          Den gamla nyckeln slutar fungera direkt. Hämtningen fungerar igen först när banken har fått och lagt in den nya publika nyckeln.
        </p>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="ghost" onClick={() => setReplaceKey(null)}>
            Avbryt
          </Button>
          <Button variant="danger" onClick={() => replaceKey && action(replaceKey, 'key')}>
            Skapa ny nyckel
          </Button>
        </div>
      </Dialog>

      <Dialog open={!!result} onClose={() => setResult(null)} title={result?.title ?? ''} wide>
        {result && (
          <div className="space-y-3 text-[13px]">
            {result.r.status === 'ok' ? <Badge tone="good">Klart</Badge> : <Badge tone="bad">{result.r.status === 'busy' ? 'Pågår redan' : 'Problem'}</Badge>}
            {result.r.message && <p className="text-ink-2">{result.r.message}</p>}
            {result.r.files.length > 0 && (
              <ul className="space-y-1">
                {result.r.files.map((f) => (
                  <li key={f.name} className="flex justify-between gap-3">
                    <span className="font-mono text-[12px]">{f.name}</span>
                    <span className="text-right text-ink-3">
                      {RESULT[f.result] ?? f.result}
                      {f.message ? `: ${f.message}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
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

const RESULT: Record<string, string> = { new: 'ny', imported: 'inläst', duplicate: 'redan inläst', ignored: 'inte en inbetalningsfil', error: 'fel' };

function toForm(c: Connection): Form {
  return {
    name: c.name,
    kind: c.kind,
    host: c.host,
    port: c.port,
    username: c.username,
    remoteDir: c.remoteDir,
    filePattern: c.filePattern,
    hostFingerprint: c.hostFingerprint,
    enabled: c.enabled,
    autoBook: c.autoBook,
    deleteAfterFetch: c.deleteAfterFetch,
    intervalMinutes: c.intervalMinutes,
    notifyEmail: c.notifyEmail,
  };
}
