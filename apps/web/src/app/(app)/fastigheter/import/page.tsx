'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Badge, Button, Card, ErrorNote, PageHeader, Table, Td } from '@/components/ui';
import { CATEGORY_LABEL, OBJECT_TYPE_LABEL, fmtM2, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Issue {
  sheet: string;
  row: number;
  message: string;
}
interface Preview {
  properties: number;
  objects: number;
  propertyRows: { row: number; designation: string; name: string; category: string; city: string | null; areaBoaM2: number | null; areaLoaM2: number | null }[];
  objectRows: { row: number; designation: string; objectNr: string; type: string; areaM2: number | null; monthlyRentOre: number | null; rentFrom: string; vatLiable: boolean }[];
  errors: Issue[];
  warnings: Issue[];
}

async function upload(path: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api${path}`, { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message ?? 'Något gick fel'), { data });
  return data;
}

export default function ImportPage() {
  const { active, can } = useSession();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await upload('/import/preview', f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    try {
      await upload('/import/commit', file);
      router.push('/fastigheter');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!active || !can('property.import')) {
    return (
      <>
        <PageHeader title="Importera från Excel" />
        <Card className="px-6 py-10 text-center text-[13px] text-ink-2">Välj det bolag som äger fastigheterna i menyn uppe till vänster.</Card>
      </>
    );
  }

  const ok = preview && preview.errors.length === 0 && preview.properties + preview.objects > 0;

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/fastigheter" className="hover:text-ink">
          Fastigheter
        </Link>{' '}
        / Import
      </div>
      <PageHeader
        title="Importera från Excel"
        description={`Fastigheter och objekt läses in till ${active.companyName}. Inget sparas förrän du har granskat och godkänt.`}
        actions={
          <a href="/api/import/template">
            <Button variant="secondary">Ladda ner mall</Button>
          </a>
        }
      />

      <Card className="mb-6 p-5">
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
          <li>Ladda ner mallen och fyll i flikarna Fastigheter och Objekt.</li>
          <li>Välj filen här. Den kontrolleras rad för rad.</li>
          <li>Granska och godkänn. Allt sparas på en gång, eller inte alls.</li>
        </ol>
        <input ref={input} type="file" accept=".xlsx" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
        <div className="flex items-center gap-3">
          <Button onClick={() => input.current?.click()} disabled={busy}>
            {file ? 'Välj en annan fil' : 'Välj Excel-fil'}
          </Button>
          {file && <span className="text-[13px] text-ink-2">{file.name}</span>}
          {busy && <span className="text-[13px] text-ink-3">Kontrollerar…</span>}
        </div>
      </Card>

      <ErrorNote message={error} />

      {preview && (
        <div className="space-y-6">
          <div className="flex items-center justify-between rounded-lg bg-surface px-5 py-4 shadow-card">
            <div className="text-[13px]">
              <span className="font-semibold">{preview.properties} fastigheter</span> och{' '}
              <span className="font-semibold">{preview.objects} objekt</span> kommer att läggas till.
              {preview.errors.length > 0 && <span className="ml-2 text-bad">{preview.errors.length} fel måste rättas i filen först.</span>}
            </div>
            <Button onClick={commit} disabled={!ok || busy}>
              Godkänn och spara
            </Button>
          </div>

          {preview.errors.length > 0 && <IssueList title="Fel" tone="bad" issues={preview.errors} />}
          {preview.warnings.length > 0 && <IssueList title="Hoppas över" tone="warn" issues={preview.warnings} />}

          {preview.propertyRows.length > 0 && (
            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Fastigheter</h2>
              <Table head={['Rad', 'Beteckning', 'Namn', 'Kategori', 'Ort', 'BOA', 'LOA']}>
                {preview.propertyRows.map((p) => (
                  <tr key={p.row}>
                    <Td className="tabular text-ink-3">{p.row}</Td>
                    <Td className="font-medium">{p.designation}</Td>
                    <Td>{p.name}</Td>
                    <Td>{CATEGORY_LABEL[p.category]}</Td>
                    <Td className="text-ink-2">{p.city ?? '–'}</Td>
                    <Td className="tabular">{fmtM2(p.areaBoaM2)}</Td>
                    <Td className="tabular">{fmtM2(p.areaLoaM2)}</Td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
          {preview.objectRows.length > 0 && (
            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Objekt</h2>
              <Table head={['Rad', 'Fastighet', 'Objekt', 'Typ', 'Area', 'Månadshyra', 'Från', 'Moms']}>
                {preview.objectRows.map((o) => (
                  <tr key={o.row}>
                    <Td className="tabular text-ink-3">{o.row}</Td>
                    <Td className="text-ink-2">{o.designation}</Td>
                    <Td className="font-medium">{o.objectNr}</Td>
                    <Td>{OBJECT_TYPE_LABEL[o.type]}</Td>
                    <Td className="tabular">{fmtM2(o.areaM2)}</Td>
                    <Td className="tabular">{fmtOre(o.monthlyRentOre, true)}</Td>
                    <Td className="tabular text-ink-2">{o.rentFrom}</Td>
                    <Td>{o.vatLiable ? <Badge tone="accent">25 %</Badge> : <span className="text-[12px] text-ink-3">Momsfri</span>}</Td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function IssueList({ title, tone, issues }: { title: string; tone: 'bad' | 'warn'; issues: Issue[] }) {
  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
      <Card className={tone === 'bad' ? 'border-l-2 border-bad' : 'border-l-2 border-warn'}>
        <ul className="divide-y divide-line">
          {issues.map((i, n) => (
            <li key={n} className="flex gap-4 px-4 py-2 text-[13px]">
              <span className="w-32 shrink-0 text-ink-3">
                {i.sheet} rad {i.row}
              </span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
