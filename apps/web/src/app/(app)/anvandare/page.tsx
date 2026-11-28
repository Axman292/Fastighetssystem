'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, formatDateTime, Input, PageHeader, Select, Table, Tabs, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { describeAgent } from '@/lib/format';
import { useSession } from '@/lib/session';

interface UserStatus {
  active: boolean;
  mfaEnabled?: boolean;
  lastLoginAt?: string | null;
  lockedUntil?: string | null;
  hasPassword?: boolean;
  invitePending?: boolean;
}
interface MembershipRow extends UserStatus {
  userId: string;
  name: string;
  email: string;
  isGroupAdmin: boolean;
  companyId: string;
  companyName: string;
  roleKey: string;
  roleName: string;
}
interface AdminRow extends UserStatus {
  id: string;
  name: string;
  email: string;
}
interface Role {
  key: string;
  name: string;
  description: string | null;
}
interface Invite {
  link: string;
  emailStatus: 'sent' | 'test' | 'failed';
  emailNote: string | null;
}
interface LogRow {
  id: number;
  occurredAt: string;
  event: string;
  label: string;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  userName: string | null;
}

type Tab = 'users' | 'log' | 'settings';

export default function UsersPage() {
  const { me, active, can, version } = useSession();
  const [tab, setTab] = useState<Tab>('users');
  const admin = me.user.isGroupAdmin;

  return (
    <>
      <PageHeader
        title="Användare och behörigheter"
        description={active ? `Användare med tillgång till ${active.companyName}.` : 'Användare i koncernens bolag. Välj ett bolag för att bjuda in eller ändra roller.'}
      />
      {admin && (
        <div className="mb-5">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'users', label: 'Användare' },
              { key: 'log', label: 'Inloggningslogg' },
              { key: 'settings', label: 'Säkerhet' },
            ]}
          />
        </div>
      )}
      {tab === 'users' && <UsersTab manage={can('user.manage')} admin={admin} myId={me.user.id} version={version} />}
      {tab === 'log' && admin && <LoginLog />}
      {tab === 'settings' && admin && <SecuritySettings myMfa={me.user.mfaEnabled} />}
    </>
  );
}

function StatusBadges({ s }: { s: UserStatus }) {
  if (!s.active) return <Badge tone="bad">Inaktiverad</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {s.lockedUntil && <Badge tone="bad">Spärrad</Badge>}
      {!s.hasPassword ? (
        <Badge tone="warn">{s.invitePending ? 'Inbjuden' : 'Inbjudan har gått ut'}</Badge>
      ) : s.mfaEnabled ? (
        <Badge tone="good">Tvåsteg på</Badge>
      ) : (
        <Badge tone="neutral">Bara lösenord</Badge>
      )}
    </span>
  );
}

function UsersTab({ manage, admin, myId, version }: { manage: boolean; admin: boolean; myId: string; version: number }) {
  const [data, setData] = useState<{ memberships: MembershipRow[]; groupAdmins: AdminRow[] }>({ memberships: [], groupAdmins: [] });
  const [roles, setRoles] = useState<Role[]>([]);
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ name: string; invite: Invite } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<typeof data>('/users').then(setData);
  }, []);
  useEffect(load, [load, version]);
  useEffect(() => {
    api<Role[]>('/users/roles').then(setRoles);
  }, []);

  async function act(path: string, done?: (r: unknown) => void) {
    setError(null);
    try {
      const r = await api(path, { method: 'POST' });
      done?.(r);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  function Actions({ id, name, s }: { id: string; name: string; s: UserStatus }) {
    return (
      <span className="flex justify-end gap-1">
        {(manage || admin) && s.active && (
          <Button size="sm" variant="ghost" onClick={() => act(`/users/${id}/invite`, (r) => setInvite({ name, invite: r as Invite }))}>
            {s.hasPassword ? 'Nytt lösenord' : 'Skicka inbjudan igen'}
          </Button>
        )}
        {admin && s.lockedUntil && (
          <Button size="sm" variant="ghost" onClick={() => act(`/users/${id}/unlock`)}>
            Häv spärr
          </Button>
        )}
        {admin && s.mfaEnabled && id !== myId && (
          <Button
            size="sm"
            variant="ghost"
            title="Om användaren tappat telefonen"
            onClick={() => window.confirm(`Nollställa tvåstegsverifieringen för ${name}? Användaren får sätta upp den igen.`) && act(`/users/${id}/reset-mfa`)}
          >
            Nollställ tvåsteg
          </Button>
        )}
        {admin && id !== myId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              s.active
                ? window.confirm(`Inaktivera ${name}? Kontot loggas ut och kan inte logga in förrän det aktiveras igen.`) && act(`/users/${id}/deactivate`)
                : act(`/users/${id}/activate`)
            }
          >
            {s.active ? 'Inaktivera' : 'Aktivera'}
          </Button>
        )}
      </span>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-[13px] text-ink-2">
          Varje användare har ett eget konto och en roll per bolag. Inbjudan skickas med e-post och användaren väljer själv sitt lösenord.
        </p>
        {manage && <Button onClick={() => setAdding(true)}>Bjud in användare</Button>}
      </div>
      <ErrorNote message={error} />

      {data.groupAdmins.length > 0 && (
        <>
          <h2 className="mb-2 mt-2 text-[13px] font-semibold">Koncernadministratörer (alla bolag)</h2>
          <div className="mb-6">
            <Table head={['Namn', 'E-post', 'Säkerhet', 'Senast inloggad', '']}>
              {data.groupAdmins.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td className="text-ink-2">{a.email}</Td>
                  <Td>
                    <StatusBadges s={a} />
                  </Td>
                  <Td className="text-ink-2">{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : '–'}</Td>
                  <Td>
                    <Actions id={a.id} name={a.name} s={a} />
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}

      <Table head={['Namn', 'E-post', 'Bolag', 'Roll', 'Säkerhet', 'Senast inloggad', '']} empty="Inga användare med roll i bolaget ännu.">
        {data.memberships.map((m) => (
          <tr key={`${m.userId}-${m.companyId}`}>
            <Td className="font-medium">{m.name}</Td>
            <Td className="text-ink-2">{m.email}</Td>
            <Td className="text-ink-2">{m.companyName}</Td>
            <Td>
              {manage ? (
                <Select
                  className="w-44"
                  value={m.roleKey}
                  onChange={async (e) => {
                    await api(`/users/${m.userId}/membership`, { method: 'POST', body: { roleKey: e.target.value } });
                    load();
                  }}
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Badge tone="accent">{m.roleName}</Badge>
              )}
            </Td>
            <Td>
              <StatusBadges s={m} />
            </Td>
            <Td className="text-ink-2">{m.lastLoginAt ? formatDateTime(m.lastLoginAt) : '–'}</Td>
            <Td>
              <span className="flex justify-end gap-1">
                <Actions id={m.userId} name={m.name} s={m} />
                {manage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!window.confirm(`Ta bort ${m.name}s åtkomst till ${m.companyName}?`)) return;
                      await api(`/users/${m.userId}/membership`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    Ta bort åtkomst
                  </Button>
                )}
              </span>
            </Td>
          </tr>
        ))}
      </Table>

      <h2 className="mb-3 mt-10 text-[14px] font-semibold">Roller</h2>
      <Table head={['Roll', 'Får göra']}>
        {roles.map((r) => (
          <tr key={r.key}>
            <Td className="font-medium">{r.name}</Td>
            <Td className="text-ink-2">{r.description}</Td>
          </tr>
        ))}
      </Table>

      <InviteDialog
        open={adding}
        roles={roles}
        onClose={() => setAdding(false)}
        onDone={(name, inv) => {
          setAdding(false);
          if (inv) setInvite({ name, invite: inv });
          load();
        }}
      />
      <InviteResult value={invite} onClose={() => setInvite(null)} />
    </>
  );
}

function InviteDialog({
  open,
  roles,
  onClose,
  onDone,
}: {
  open: boolean;
  roles: Role[];
  onClose: () => void;
  onDone: (name: string, invite: Invite | null) => void;
}) {
  const { active } = useSession();
  const [v, setV] = useState({ name: '', email: '', roleKey: 'manager' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ name: string; existing: boolean; invite: Invite | null }>('/users', { method: 'POST', body: v });
      setV({ name: '', email: '', roleKey: 'manager' });
      onDone(r.name, r.invite);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Bjud in till ${active?.companyName ?? ''}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Namn" error={fe('name')}>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus />
        </Field>
        <Field label="E-post" error={fe('email')} hint="Inbjudan skickas hit. Har personen redan ett konto får hen bara rollen i bolaget.">
          <Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} required />
        </Field>
        <Field label="Roll i bolaget">
          <Select value={v.roleKey} onChange={(e) => setV({ ...v, roleKey: e.target.value })}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-[12px] text-ink-3">{roles.find((r) => r.key === v.roleKey)?.description}</p>
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Skickar…' : 'Skicka inbjudan'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteResult({ value, onClose }: { value: { name: string; invite: Invite } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  if (!value) return null;
  const { invite } = value;
  return (
    <Dialog open onClose={onClose} title={`Länk till ${value.name}`}>
      {invite.emailStatus === 'sent' ? (
        <div className="rounded-md bg-good-soft px-3 py-2 text-[13px] text-good">E-post med länken är skickad.</div>
      ) : (
        <div className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          E-posten skickades inte{invite.emailNote ? `: ${invite.emailNote}` : ' (testläge)'}. Skicka länken nedan själv, till exempel i ett sms.
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-2">Länken kan bara användas en gång. Dela den bara med {value.name}.</p>
      <div className="mt-2 break-all rounded-md bg-subtle p-3 font-mono text-[12px]">{invite.link}</div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(invite.link);
            setCopied(true);
          }}
        >
          {copied ? 'Kopierad' : 'Kopiera länk'}
        </Button>
        <Button onClick={onClose}>Klar</Button>
      </div>
    </Dialog>
  );
}

const TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = {
  login_ok: 'good',
  login_failed: 'bad',
  mfa_failed: 'bad',
  login_locked: 'bad',
  account_locked: 'bad',
  login_inactive: 'bad',
  mfa_disabled: 'warn',
  mfa_reset_by_admin: 'warn',
  user_deactivated: 'warn',
};

function LoginLog() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [more, setMore] = useState(true);
  const load = useCallback(async (before?: number) => {
    const r = await api<LogRow[]>(`/users/login-log${before ? `?before=${before}` : ''}`);
    setRows((prev) => (before ? [...prev, ...r] : r));
    setMore(r.length === 200);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <p className="mb-4 text-[13px] text-ink-2">Alla inloggningar, misslyckade försök och ändringar av lösenord och tvåstegsverifiering i koncernen.</p>
      <Table head={['Tid', 'Händelse', 'Användare', 'IP-adress', 'Enhet', 'Detaljer']} empty="Inga händelser ännu.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap text-ink-2">{formatDateTime(r.occurredAt)}</Td>
            <Td>
              <Badge tone={TONE[r.event] ?? 'neutral'}>{r.label}</Badge>
            </Td>
            <Td>
              <div className="font-medium">{r.userName ?? '–'}</div>
              <div className="text-[12px] text-ink-3">{r.email}</div>
            </Td>
            <Td className="text-ink-2">{r.ip ?? '–'}</Td>
            <Td className="text-ink-2">{describeAgent(r.userAgent)}</Td>
            <Td className="text-ink-2">{r.detail}</Td>
          </tr>
        ))}
      </Table>
      {more && rows.length > 0 && (
        <Button className="mt-3" variant="secondary" onClick={() => load(rows[rows.length - 1].id)}>
          Visa äldre
        </Button>
      )}
    </>
  );
}

function SecuritySettings({ myMfa }: { myMfa: boolean }) {
  const [v, setV] = useState<{ requireMfa: boolean; sessionIdleMinutes: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ requireMfa: boolean; sessionIdleMinutes: number }>('/users/security-settings').then(setV);
  }, []);
  if (!v) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api('/users/security-settings', { method: 'PUT', body: v });
      setSaved(true);
      if (v?.requireMfa && !myMfa) window.location.href = '/konto';
    } catch (err) {
      setError((err as ApiError).fields[0]?.message ?? (err as ApiError).message);
    }
  }

  return (
    <Card className="max-w-2xl p-5">
      <form onSubmit={save} className="space-y-5">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={v.requireMfa} onChange={(e) => setV({ ...v, requireMfa: e.target.checked })} />
          <span>
            <span className="block text-[13px] font-medium">Kräv tvåstegsverifiering för alla</span>
            <span className="block text-[12px] text-ink-3">
              Användare som inte har slagit på det måste göra det direkt efter inloggning. Rekommenderas innan riktiga hyresgästuppgifter läggs in.
            </span>
            {v.requireMfa && !myMfa && (
              <span className="mt-1 block text-[12px] text-warn">Du har själv inte slagit på det än. Du skickas till Mitt konto när du sparar.</span>
            )}
          </span>
        </label>
        <Field label="Logga ut efter inaktivitet (minuter)" hint="Mellan 5 och 720. Sessionen gäller ändå högst 12 timmar.">
          <Input
            type="number"
            min={5}
            max={720}
            className="w-32"
            value={v.sessionIdleMinutes}
            onChange={(e) => setV({ ...v, sessionIdleMinutes: Number(e.target.value) })}
          />
        </Field>
        <div className="rounded-md bg-subtle px-3 py-2 text-[12px] text-ink-2">
          Alltid påslaget: kontot spärras i 15 minuter efter 5 felaktiga försök, och för många misslyckade försök från samma anslutning
          stoppas. Lösenord måste vara minst 12 tecken.
        </div>
        <ErrorNote message={error} />
        <div className="flex items-center gap-3">
          <Button type="submit">Spara</Button>
          {saved && <span className="text-[13px] text-good">Sparat</span>}
        </div>
      </form>
    </Card>
  );
}
