'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface MembershipRow {
  userId: string;
  name: string;
  email: string;
  isGroupAdmin: boolean;
  active: boolean;
  companyId: string;
  companyName: string;
  roleKey: string;
  roleName: string;
}
interface Role {
  key: string;
  name: string;
  description: string | null;
}

export default function UsersPage() {
  const { active, can, version } = useSession();
  const [data, setData] = useState<{ memberships: MembershipRow[]; groupAdmins: { id: string; name: string; email: string }[] }>({
    memberships: [],
    groupAdmins: [],
  });
  const [roles, setRoles] = useState<Role[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api<typeof data>('/users').then(setData);
  }, []);
  useEffect(load, [load, version]);
  useEffect(() => {
    api<Role[]>('/users/roles').then(setRoles);
  }, []);

  const manage = can('user.manage');

  return (
    <>
      <PageHeader
        title="Användare och behörigheter"
        description={active ? `Användare med tillgång till ${active.companyName}.` : 'Användare i koncernens bolag. Välj ett bolag för att lägga till eller ändra.'}
        actions={manage && <Button onClick={() => setAdding(true)}>Ny användare</Button>}
      />
      {data.groupAdmins.length > 0 && (
        <p className="mb-4 text-[13px] text-ink-2">
          Koncernadministratörer med tillgång till alla bolag: {data.groupAdmins.map((a) => a.name).join(', ')}.
        </p>
      )}
      <Table head={['Namn', 'E-post', 'Bolag', 'Roll', '']} empty="Inga användare med roll i bolaget ännu.">
        {data.memberships.map((m) => (
          <tr key={`${m.userId}-${m.companyId}`}>
            <Td className="font-medium">{m.name}</Td>
            <Td className="text-ink-2">{m.email}</Td>
            <Td className="text-ink-2">{m.companyName}</Td>
            <Td>
              {manage ? (
                <Select
                  className="w-48"
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
            <Td className="text-right">
              {manage && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/users/${m.userId}/membership`, { method: 'DELETE' });
                    load();
                  }}
                >
                  Ta bort åtkomst
                </Button>
              )}
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

      <NewUserDialog
        open={adding}
        roles={roles}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          load();
        }}
      />
    </>
  );
}

function NewUserDialog({ open, roles, onClose, onDone }: { open: boolean; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const { active } = useSession();
  const [v, setV] = useState({ name: '', email: '', password: '', roleKey: 'manager' });
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/users', { method: 'POST', body: v });
      setV({ name: '', email: '', password: '', roleKey: 'manager' });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Ny användare i ${active?.companyName ?? ''}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Namn" error={fe('name')}>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus />
        </Field>
        <Field label="E-post" error={fe('email')}>
          <Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} required />
        </Field>
        <Field label="Tillfälligt lösenord" error={fe('password')} hint="Minst 12 tecken. Lämna det till användaren på ett säkert sätt.">
          <Input type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} required />
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
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit">Skapa användare</Button>
        </div>
      </form>
    </Dialog>
  );
}
