'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { MONTH_LABEL, fmtMonth, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { RUN_STATUS, RunRow } from '@/lib/billing';

export default function BillingPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<RunRow[]>('/billing-runs').then(setRuns);
  }, [version]);

  const draft = runs?.find((r) => r.status === 'draft' && (!active || r.companyId === active.companyId));
  const issued = runs?.filter((r) => r.status === 'issued') ?? [];
  const latest = issued[0];

  return (
    <>
      <PageHeader
        title="Avisering"
        description={
          active
            ? `Hyresavier för ${active.companyName} skapas ur avtalen, granskas och godkänns här.`
            : 'Välj ett bolag för att skapa en aviseringskörning. Här visas körningar i hela koncernen.'
        }
        actions={
          <>
            <Link href="/fakturor">
              <Button variant="secondary">Alla fakturor</Button>
            </Link>
            {can('billing.run') &&
              (draft ? (
                <Button onClick={() => router.push(`/avisering/${draft.id}`)}>Fortsätt granska</Button>
              ) : (
                <Button onClick={() => setOpen(true)}>Ny aviseringskörning</Button>
              ))}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Senast aviserade period" value={<span className="text-[17px]">{latest ? fmtMonth(latest.periodMonth) : '–'}</span>} sub={latest ? `körning ${latest.runNr}` : 'ingen körning ännu'} />
        <Stat label="Belopp i senaste körningen" value={latest ? fmtOre(latest.totalOre) : '–'} sub={latest ? `${latest.invoiceCount} avier inkl. moms` : undefined} />
        <Stat label="Ej skickade" value={runs ? issued.reduce((s, r) => s + r.queuedCount, 0) : '–'} sub="avier som väntar på utskick" />
        <Stat label="Under granskning" value={runs ? runs.filter((r) => r.status === 'draft').length : '–'} sub="körningar som inte godkänts" />
      </div>

      {draft && (
        <Card className="mb-6 flex items-center gap-4 px-4 py-3.5">
          <Badge tone="warn">Under granskning</Badge>
          <div className="min-w-0 flex-1 text-[13px]">
            <span className="font-medium">Körning {draft.runNr} för {fmtMonth(draft.periodMonth)}</span>
            <span className="text-ink-2">
              {' '}
              · {draft.invoiceCount} avier · {fmtOre(draft.totalOre)}
              {draft.blockingCount ? ` · ${draft.blockingCount} fel att rätta` : ''}
              {draft.warningCount ? ` · ${draft.warningCount} varningar` : ''}
            </span>
          </div>
          <Link href={`/avisering/${draft.id}`}>
            <Button size="sm">Granska</Button>
          </Link>
        </Card>
      )}

      <Table head={['Körning', 'Period', ...(active ? [] : ['Bolag']), 'Fakturadatum', 'Avier', 'Belopp inkl. moms', 'Utskick', 'Status']} empty="Inga aviseringskörningar ännu.">
        {runs?.map((r) => {
          const s = RUN_STATUS[r.status];
          return (
            <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/avisering/${r.id}`)}>
              <Td className="font-medium tabular">
                <Link href={`/avisering/${r.id}`}>{r.runNr}</Link>
              </Td>
              <Td>{fmtMonth(r.periodMonth)}</Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td className="tabular text-ink-2">{r.invoiceDate}</Td>
              <Td className="tabular">{r.invoiceCount}</Td>
              <Td className="tabular">{fmtOre(r.totalOre)}</Td>
              <Td className="text-ink-2">
                {r.status === 'issued' ? (r.queuedCount ? `${r.queuedCount} väntar` : r.failedCount ? `${r.failedCount} misslyckades` : 'Klart') : '–'}
              </Td>
              <Td>
                <Badge tone={s.tone}>{s.label}</Badge>
              </Td>
            </tr>
          );
        })}
      </Table>

      <NewRunDialog open={open} onClose={() => setOpen(false)} onCreated={(id) => router.push(`/avisering/${id}`)} />
    </>
  );
}

function NewRunDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { version } = useSession();
  const [month, setMonth] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [properties, setProperties] = useState<{ id: string; name: string; designation: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api<{ periodMonth: string; invoiceDate: string }>('/billing-runs/suggestion').then((s) => {
      setMonth(s.periodMonth);
      setInvoiceDate(s.invoiceDate);
    });
    api<{ id: string; name: string; designation: string }[]>('/properties').then(setProperties);
    setSelected([]);
    setDueDate('');
  }, [open, version]);

  const months = (() => {
    const out: string[] = [];
    const now = new Date();
    for (let i = -6; i <= 6; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      out.push(d.toISOString().slice(0, 7));
    }
    if (month && !out.includes(month)) out.push(month);
    return out.sort();
  })();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const run = await api<{ id: string }>('/billing-runs', {
        method: 'POST',
        body: { periodMonth: month, invoiceDate, dueDate: dueDate || null, propertyIds: selected.length ? selected : null },
      });
      onCreated(run.id);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  return (
    <Dialog open={open} onClose={onClose} title="Ny aviseringskörning" wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[13px] text-ink-2">
          Systemet går igenom alla aktiva avtal och skapar avier för perioden. Månadsavtal aviseras för vald månad och kvartalsavtal för kvartalet
          som månaden ingår i. Inget skickas förrän du har granskat och godkänt körningen.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Period som aviseras" error={fe('periodMonth')}>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[13px]"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {MONTH_LABEL[Number(m.slice(5)) - 1]} {m.slice(0, 4)}
                </option>
              ))}
            </select>
          </Field>
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
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy || !month}>
            {busy ? 'Skapar underlag…' : 'Skapa underlag'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
