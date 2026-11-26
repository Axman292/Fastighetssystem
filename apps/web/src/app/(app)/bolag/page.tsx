'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Table, Td } from '@/components/ui';
import { api, ApiError, Company } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function CompaniesPage() {
  const { me, version, refresh } = useSession();
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<Company[]>('/companies').then(setCompanies);
  }, [version]);

  return (
    <>
      <PageHeader
        title="Bolag"
        description="Juridiska bolag i koncernen. Varje bolag har egen kontoplan, egna bankkonton och egen fakturering."
        actions={me.user.isGroupAdmin && <Button onClick={() => setCreating(true)}>Nytt bolag</Button>}
      />
      <Table head={['Namn', 'Organisationsnummer', 'Ort', 'Bankgiro', 'Status']} empty="Inga bolag att visa.">
        {companies.map((c) => (
          <tr key={c.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/bolag/${c.id}`)}>
            <Td className="font-medium">
              <Link href={`/bolag/${c.id}`}>{c.name}</Link>
            </Td>
            <Td className="tabular text-ink-2">{c.orgNr}</Td>
            <Td className="text-ink-2">{c.city ?? '–'}</Td>
            <Td className="tabular text-ink-2">{c.bankgiro ?? '–'}</Td>
            <Td>{c.active ? <Badge tone="good">Aktivt</Badge> : <Badge>Inaktivt</Badge>}</Td>
          </tr>
        ))}
      </Table>
      <CreateCompanyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (c) => {
          setCreating(false);
          await refresh();
          router.push(`/bolag/${c.id}`);
        }}
      />
    </>
  );
}

function CreateCompanyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Company) => void }) {
  const [name, setName] = useState('');
  const [orgNr, setOrgNr] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<Company>('/companies', { method: 'POST', body: { name, orgNr } });
      setName('');
      setOrgNr('');
      onCreated(c);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (path: string) => error?.fields.find((f) => f.path === path)?.message;

  return (
    <Dialog open={open} onClose={onClose} title="Nytt bolag">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Bolagets namn" error={fieldError('name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Exempel Fastigheter AB" required autoFocus />
        </Field>
        <Field label="Organisationsnummer" error={fieldError('orgNr')} hint="Kontrollsiffran valideras.">
          <Input value={orgNr} onChange={(e) => setOrgNr(e.target.value)} placeholder="556000-0000" required />
        </Field>
        {!error?.fields.length && <ErrorNote message={error?.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy}>
            Skapa bolag
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
