'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td, formatDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { BATCH_STATUS, ImportMeta } from '@/lib/imports';
import { useSession } from '@/lib/session';

interface ListRow {
  id: string;
  companyName: string;
  batchNr: number;
  name: string;
  sourceSystem: string;
  status: string;
  createdAt: string;
  committedAt: string | null;
  createdByName: string | null;
  files: number;
  totals: { total: number; error: number } | null;
}

export default function ImportCenterPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<ListRow[]>([]);
  const [meta, setMeta] = useState<ImportMeta | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Migrering från DinHyresvärd');
  const [source, setSource] = useState('dinhyresvard');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ListRow[]>('/imports').then(setRows);
    api<ImportMeta>('/imports/meta').then(setMeta);
  }, [version]);

  async function create() {
    setError(null);
    try {
      const b = await api<{ id: string }>('/imports', { method: 'POST', body: { name, sourceSystem: source } });
      router.push(`/import/${b.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const allowed = active && can('import.manage');
  const adapterLabel = (k: string) => meta?.adapters.find((a) => a.key === k)?.label ?? k;

  return (
    <>
      <PageHeader
        title="Importcentral"
        description="Flytta in data från DinHyresvärd eller ett annat fastighetssystem. Inget sparas förrän du har granskat, testat och godkänt."
        actions={
          <Button onClick={() => setOpen(true)} disabled={!allowed} title={allowed ? undefined : 'Välj ett bolag där du är administratör'}>
            Ny import
          </Button>
        }
      />

      {!active && (
        <Card className="mb-6 px-5 py-4 text-[13px] text-ink-2">Välj det bolag som datan ska importeras till i menyn uppe till vänster.</Card>
      )}

      <Card className="mb-6 grid grid-cols-5 divide-x divide-line text-[12.5px]">
        {[
          ['1', 'Ladda upp', 'Excel, CSV, XML, SIE eller PDF'],
          ['2', 'Mappa', 'Gamla kolumner mot nya fält'],
          ['3', 'Kontrollera', 'Fel, dubbletter och koppling'],
          ['4', 'Testa', 'Allt körs, inget sparas'],
          ['5', 'Genomför', 'Med avstämning och ångra'],
        ].map(([n, t, d]) => (
          <div key={n} className="flex items-start gap-2.5 px-4 py-3.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{n}</span>
            <div>
              <div className="font-medium">{t}</div>
              <div className="text-ink-3">{d}</div>
            </div>
          </div>
        ))}
      </Card>

      <Table head={['Nr', 'Namn', 'Bolag', 'Källsystem', 'Filer', 'Poster', 'Status', 'Skapad']} empty="Inga importer ännu.">
        {rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/import/${r.id}`)}>
            <Td className="tabular text-ink-3">{r.batchNr}</Td>
            <Td className="font-medium">
              <Link href={`/import/${r.id}`}>{r.name}</Link>
            </Td>
            <Td className="text-ink-2">{r.companyName}</Td>
            <Td className="text-ink-2">{adapterLabel(r.sourceSystem)}</Td>
            <Td className="tabular">{r.files}</Td>
            <Td className="tabular">
              {r.totals ? (
                <>
                  {r.totals.total}
                  {r.totals.error > 0 && <span className="ml-1.5 text-bad">{r.totals.error} fel</span>}
                </>
              ) : (
                '–'
              )}
            </Td>
            <Td>
              <Badge tone={BATCH_STATUS[r.status]?.tone}>{BATCH_STATUS[r.status]?.label ?? r.status}</Badge>
            </Td>
            <Td className="whitespace-nowrap text-ink-2">
              {formatDateTime(r.createdAt)}
              {r.createdByName && <span className="text-ink-3"> · {r.createdByName}</span>}
            </Td>
          </tr>
        ))}
      </Table>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Ny import till ${active?.companyName ?? ''}`}>
        <div className="space-y-4">
          <Field label="Namn">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Källsystem" hint={meta?.adapters.find((a) => a.key === source)?.description}>
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {meta?.adapters.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button onClick={create} disabled={!name.trim()}>
              Skapa
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
