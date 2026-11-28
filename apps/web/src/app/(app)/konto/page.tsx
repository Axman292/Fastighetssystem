'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, formatDateTime, Input, PageHeader, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { describeAgent } from '@/lib/format';

interface Account {
  name: string;
  email: string;
  mfaEnabled: boolean;
  mfaEnabledAt: string | null;
  recoveryCodesLeft: number;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  requireMfa: boolean;
  sessionIdleMinutes: number;
  sessions: { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }[];
}

export default function AccountPage() {
  const { me, refresh } = useSession();
  const [acc, setAcc] = useState<Account | null>(null);
  const [setup, setSetup] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [newCodes, setNewCodes] = useState(false);
  const load = useCallback(() => {
    api<Account>('/account').then(setAcc);
  }, []);
  useEffect(load, [load]);

  if (!acc) return null;

  return (
    <>
      <PageHeader title="Mitt konto" description={`${acc.name} · ${acc.email}`} />

      {me.mfaSetupRequired && (
        <div className="mb-6 rounded-md bg-warn-soft px-4 py-3 text-[13px] text-warn">
          Koncernen kräver tvåstegsverifiering. Slå på den nedan för att kunna använda systemet.
        </div>
      )}

      <Section
        title="Tvåstegsverifiering"
        description="Vid inloggning behövs då både lösenordet och en kod från en app i telefonen, till exempel Microsoft Authenticator eller Google Authenticator. Ingen kan logga in med bara ditt lösenord."
      >
        {acc.mfaEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 text-[13px]">
              <div>
                <Badge tone="good">Påslagen</Badge>
                {acc.mfaEnabledAt && <span className="ml-2 text-ink-3">sedan {formatDateTime(acc.mfaEnabledAt)}</span>}
              </div>
              <div className={acc.recoveryCodesLeft <= 3 ? 'text-warn' : 'text-ink-2'}>
                {acc.recoveryCodesLeft} oanvända reservkoder kvar
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setNewCodes(true)}>
                Nya reservkoder
              </Button>
              {!acc.requireMfa && (
                <Button variant="danger" onClick={() => setDisabling(true)}>
                  Stäng av
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <Badge tone="warn">Avstängd</Badge>
            <Button onClick={() => setSetup(true)}>Slå på tvåstegsverifiering</Button>
          </div>
        )}
      </Section>

      <Section title="Lösenord" description={acc.passwordChangedAt ? `Senast bytt ${formatDateTime(acc.passwordChangedAt)}.` : undefined}>
        <ChangePassword email={acc.email} onDone={load} />
      </Section>

      <Section
        title="Inloggade enheter"
        description={`Du loggas ut automatiskt efter ${acc.sessionIdleMinutes} minuter utan aktivitet, och alltid efter 12 timmar.`}
      >
        <Table head={['Enhet', 'IP-adress', 'Inloggad', 'Senast aktiv', '']}>
          {acc.sessions.map((s) => (
            <tr key={s.id}>
              <Td>
                {describeAgent(s.userAgent)} {s.current && <Badge tone="accent">Den här</Badge>}
              </Td>
              <Td className="text-ink-2">{s.ip ?? '–'}</Td>
              <Td className="text-ink-2">{formatDateTime(s.createdAt)}</Td>
              <Td className="text-ink-2">{formatDateTime(s.lastSeenAt)}</Td>
              <Td className="text-right">
                {!s.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api(`/account/sessions/${s.id}/logout`, { method: 'POST' });
                      load();
                    }}
                  >
                    Logga ut
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        {acc.sessions.length > 1 && (
          <Button
            className="mt-3"
            variant="secondary"
            onClick={async () => {
              await api('/account/sessions/others/logout', { method: 'POST' });
              load();
            }}
          >
            Logga ut alla andra enheter
          </Button>
        )}
      </Section>

      <SetupDialog
        open={setup}
        onClose={() => setSetup(false)}
        onDone={async (c) => {
          setSetup(false);
          setCodes(c);
          await refresh();
          load();
        }}
      />
      <CodeDialog
        open={newCodes}
        title="Nya reservkoder"
        text="De gamla reservkoderna slutar gälla. Skriv koden från appen för att bekräfta."
        action="Skapa nya koder"
        onClose={() => setNewCodes(false)}
        submit={async (code) => {
          const r = await api<{ recoveryCodes: string[] }>('/account/mfa/recovery-codes', { method: 'POST', body: { code } });
          setNewCodes(false);
          setCodes(r.recoveryCodes);
          load();
        }}
      />
      <CodeDialog
        open={disabling}
        title="Stäng av tvåstegsverifiering"
        text="Ditt konto blir mindre skyddat. Bekräfta med lösenord och kod från appen."
        action="Stäng av"
        withPassword
        onClose={() => setDisabling(false)}
        submit={async (code, password) => {
          await api('/account/mfa/disable', { method: 'POST', body: { code, password } });
          setDisabling(false);
          await refresh();
          load();
        }}
      />
      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Spara dina reservkoder">
        <p className="text-[13px] text-ink-2">
          Om du tappar telefonen kan du logga in med en av de här koderna. Varje kod fungerar en gång. Skriv ut dem eller spara dem i en
          lösenordshanterare. De visas bara nu.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-md bg-subtle p-4 font-mono text-[14px]">
          {codes?.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(codes?.join('\n') ?? '')}>
            Kopiera
          </Button>
          <Button onClick={() => setCodes(null)}>Jag har sparat dem</Button>
        </div>
      </Dialog>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-6 p-5">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-2xl text-[13px] text-ink-2">{description}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function ChangePassword({ email, onDone }: { email: string; onDone: () => void }) {
  const [v, setV] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [ok, setOk] = useState(false);
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (v.newPassword !== v.repeat) {
      setError(new ApiError(400, 'Lösenorden är inte likadana', [{ path: 'repeat', message: 'Lösenorden är inte likadana' }]));
      return;
    }
    try {
      await api('/account/password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
      setV({ currentPassword: '', newPassword: '', repeat: '' });
      setOk(true);
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-3">
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <Field label="Nuvarande lösenord" error={fe('currentPassword')}>
        <Input type="password" autoComplete="current-password" value={v.currentPassword} onChange={(e) => setV({ ...v, currentPassword: e.target.value })} required />
      </Field>
      <Field label="Nytt lösenord" error={fe('newPassword')} hint="Minst 12 tecken">
        <Input type="password" autoComplete="new-password" value={v.newPassword} onChange={(e) => setV({ ...v, newPassword: e.target.value })} required />
      </Field>
      <Field label="Upprepa nytt lösenord" error={fe('repeat')}>
        <Input type="password" autoComplete="new-password" value={v.repeat} onChange={(e) => setV({ ...v, repeat: e.target.value })} required />
      </Field>
      <div className="flex items-center gap-3 md:col-span-3">
        <Button type="submit">Byt lösenord</Button>
        {ok && <span className="text-[13px] text-good">Lösenordet är bytt. Andra enheter har loggats ut.</span>}
        {error && !error.fields.length && <ErrorNote message={error.message} />}
      </div>
    </form>
  );
}

function SetupDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (codes: string[]) => void }) {
  const [data, setData] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setCode('');
    setError(null);
    api<{ secret: string; qrSvg: string }>('/account/mfa/setup', { method: 'POST' })
      .then(setData)
      .catch((e) => setError((e as ApiError).message));
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/account/mfa/enable', { method: 'POST', body: { code } });
      onDone(r.recoveryCodes);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Slå på tvåstegsverifiering">
      <ol className="list-decimal space-y-2 pl-5 text-[13px] text-ink-2">
        <li>Installera en autentiseringsapp i telefonen, till exempel Microsoft Authenticator eller Google Authenticator.</li>
        <li>Välj att lägga till ett konto i appen och skanna QR-koden.</li>
        <li>Skriv den sexsiffriga koden som appen visar.</li>
      </ol>
      {data && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {/* QR-koden är svart på vitt så att telefonkameran läser den även i mörkt läge. */}
          <div className="size-44 rounded-md bg-white p-2" dangerouslySetInnerHTML={{ __html: data.qrSvg }} />
          <div className="text-center text-[12px] text-ink-3">
            Går det inte att skanna? Skriv in nyckeln:
            <div className="mt-1 select-all font-mono text-[13px] text-ink">{data.secret}</div>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="mt-4 space-y-4">
        <Field label="Kod från appen">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className="text-center text-[16px] tracking-[0.2em]"
          />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={!data}>
            Slå på
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CodeDialog({
  open,
  title,
  text,
  action,
  withPassword,
  onClose,
  submit,
}: {
  open: boolean;
  title: string;
  text: string;
  action: string;
  withPassword?: boolean;
  onClose: () => void;
  submit: (code: string, password: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCode('');
    setPassword('');
    setError(null);
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await submit(code, password);
          } catch (err) {
            setError((err as ApiError).message);
          }
        }}
        className="space-y-4"
      >
        <p className="text-[13px] text-ink-2">{text}</p>
        {withPassword && (
          <Field label="Lösenord">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
        )}
        <Field label="Kod från appen">
          <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit">{action}</Button>
        </div>
      </form>
    </Dialog>
  );
}
