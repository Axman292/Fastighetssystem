'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Stat, Table, Tabs, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { INVOICE_KIND_LABEL, REMINDER_LEVEL_LABEL, REMINDER_STATUS, fmtOre, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Candidate {
  invoiceId: string;
  companyId: string;
  invoiceNr: number;
  kind: string;
  dueDate: string;
  totalOre: number;
  balanceOre: number;
  customerId: string;
  customerName: string;
  contractNr: number | null;
  daysOverdue: number;
  lastLevel: number;
  lastReminderDate: string | null;
  lastDueDate: string | null;
  action: 'remind' | 'wait' | 'collection';
  nextLevel: number | null;
  feeOre: number;
  interestOre: number;
  channel: 'email' | 'post';
  recipient: string | null;
  warnings: string[];
}

interface Suggestion {
  date: string;
  settings: { feeOre: number; graceDays: number; dueDays: number; interestBp: number } | null;
  candidates: Candidate[];
}

interface ReminderRow {
  id: string;
  level: number;
  reminderDate: string;
  dueDate: string;
  balanceOre: number;
  feeOre: number;
  channel: string;
  recipient: string | null;
  status: string;
  error: string | null;
  invoiceId: string;
  invoiceNr: number;
  customerId: string;
  customerName: string;
  currentBalanceOre: number;
  companyName: string;
}

type Tab = 'remind' | 'collection' | 'history';

export default function RemindersPage() {
  const { active, can, version } = useSession();
  const [date, setDate] = useState(todayIso());
  const [s, setS] = useState<Suggestion | null>(null);
  const [history, setHistory] = useState<ReminderRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chargeFee, setChargeFee] = useState(true);
  const [tab, setTab] = useState<Tab>('remind');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Suggestion>(`/reminders/suggestion?date=${date}`).then((r) => {
      setS(r);
      setSelected(new Set(r.candidates.filter((c) => c.action === 'remind' && !c.warnings.length).map((c) => c.invoiceId)));
    });
    api<ReminderRow[]>('/reminders').then(setHistory);
  }, [date]);
  useEffect(load, [load, version]);

  const remind = useMemo(() => s?.candidates.filter((c) => c.action === 'remind') ?? [], [s]);
  const waiting = s?.candidates.filter((c) => c.action === 'wait') ?? [];
  const collection = s?.candidates.filter((c) => c.action === 'collection') ?? [];
  const chosen = remind.filter((c) => selected.has(c.invoiceId));
  const queuedPost = history?.filter((r) => r.status === 'queued' && r.channel === 'post') ?? [];
  const canSend = !!active && can('reminder.send');

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function create() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ created: string[]; skipped: { reason: string }[]; delivery: { sent: number; test: number; failed: number; post: number } }>('/reminders', {
        method: 'POST',
        body: { reminderDate: date, invoiceIds: chosen.map((c) => c.invoiceId), chargeFee },
      });
      const d = r.delivery;
      const parts = [
        `${r.created.length} påminnelser skapades.`,
        d.sent ? `${d.sent} skickades med e-post.` : '',
        d.test ? `${d.test} e-post sparades i testläge (inget skickades till kunden).` : '',
        d.post ? `${d.post} ska skrivas ut och skickas som brev.` : '',
        d.failed ? `${d.failed} kunde inte skickas, se Skickade.` : '',
        r.skipped.length ? `${r.skipped.length} hoppades över.` : '',
      ];
      setResult(parts.filter(Boolean).join(' '));
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function markPrinted() {
    await api('/reminders/mark-printed', { method: 'POST', body: { ids: queuedPost.map((r) => r.id) } });
    load();
  }

  const settings = s?.settings;

  return (
    <>
      <PageHeader
        title="Påminnelser"
        description={
          active
            ? `Förfallna fakturor för ${active.companyName}. Påminnelser skickas med e-post eller skrivs ut som brev.`
            : 'Välj ett bolag för att skicka påminnelser. Här visas förfallna fakturor i hela koncernen.'
        }
        actions={
          queuedPost.length > 0 && (
            <>
              <a href="/api/reminders/print.pdf" target="_blank" rel="noreferrer">
                <Button variant="secondary">Skriv ut {queuedPost.length} brev</Button>
              </a>
              {canSend && <Button variant="secondary" onClick={markPrinted}>Markera som utskrivna</Button>}
            </>
          )
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Kan påminnas" value={s ? remind.length : '–'} sub={s ? fmtOre(remind.reduce((a, c) => a + c.balanceOre, 0)) : undefined} />
        <Stat label="Inom frist" value={s ? waiting.length : '–'} sub={settings ? `${settings.graceDays} dagar efter förfallodagen` : 'förfallna men nyligen'} />
        <Stat label="Redo för inkasso" value={s ? collection.length : '–'} sub={s ? fmtOre(collection.reduce((a, c) => a + c.balanceOre, 0)) : undefined} />
        <Stat
          label="Påminnelseavgift"
          value={settings ? fmtOre(settings.feeOre) : '–'}
          sub={settings ? `ny frist ${settings.dueDays} dagar · ränta ${(settings.interestBp / 100).toLocaleString('sv-SE')} %` : 'välj ett bolag'}
        />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'remind', label: 'Att påminna', count: remind.length },
          { key: 'collection', label: 'Redo för inkasso', count: collection.length },
          { key: 'history', label: 'Skickade', count: history?.length },
        ]}
      />

      {result && (
        <Card className="mb-4 px-4 py-3 text-[13px]">
          <span className="font-medium text-good">Klart.</span> {result}
        </Card>
      )}
      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {tab === 'remind' && (
        <>
          <Card className="mb-4 flex flex-wrap items-end gap-4 px-4 py-3.5">
            <div className="w-44">
              <Field label="Påminnelsedatum">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <label className="flex h-8 items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={chargeFee} onChange={(e) => setChargeFee(e.target.checked)} />
              Ta ut påminnelseavgift på första påminnelsen
            </label>
            <div className="flex-1" />
            {canSend && (
              <Button onClick={create} disabled={busy || !chosen.length}>
                {busy ? 'Skickar…' : `Skapa och skicka ${chosen.length} påminnelser`}
              </Button>
            )}
          </Card>
          <p className="mb-3 text-[12px] text-ink-3">
            Avgiften får bara tas ut om den avtalats i förväg, till exempel i hyresavtalet, och är högst 60 kr. Fakturor med varning är inte förvalda.
          </p>
          <Table
            head={['', 'Kund', 'Faktura', 'Förföll', 'Dagar sen', 'Obetalt', 'Nivå', 'Avgift', 'Skickas med', '']}
            empty="Inga förfallna fakturor att påminna om."
          >
            {remind.map((c) => (
              <tr key={c.invoiceId}>
                <Td>
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-accent)]"
                    checked={selected.has(c.invoiceId)}
                    disabled={!canSend}
                    onChange={(e) => toggle(c.invoiceId, e.target.checked)}
                  />
                </Td>
                <Td>
                  <Link href={`/kunder/${c.customerId}`} className="hover:underline">
                    {c.customerName}
                  </Link>
                  {c.warnings.map((w) => (
                    <div key={w} className="text-[12px] text-warn">
                      {w}
                    </div>
                  ))}
                </Td>
                <Td className="tabular">
                  <Link href={`/fakturor/${c.invoiceId}`} className="hover:underline">
                    {INVOICE_KIND_LABEL[c.kind]} {c.invoiceNr}
                  </Link>
                </Td>
                <Td className="tabular text-ink-2">{c.dueDate}</Td>
                <Td className="tabular text-ink-2">{c.daysOverdue}</Td>
                <Td className="tabular font-medium">{fmtOre(c.balanceOre, true)}</Td>
                <Td>
                  <Badge tone={c.nextLevel === 2 ? 'bad' : 'warn'}>{REMINDER_LEVEL_LABEL[c.nextLevel ?? 1]}</Badge>
                </Td>
                <Td className="tabular text-ink-2">{c.feeOre && chargeFee ? fmtOre(c.feeOre) : '–'}</Td>
                <Td className="text-ink-2">{c.channel === 'email' ? c.recipient : 'Brev'}</Td>
                <Td />
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'collection' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">
            Båda påminnelserna är skickade och fristen har gått ut. Nästa steg är att kontakta hyresgästen, göra en avbetalningsplan eller lämna skulden
            till ett inkassobolag under{' '}
            <Link href="/inkasso" className="text-accent hover:underline">
              Ränta och inkasso
            </Link>
            .
            För bostadshyra kan obetald hyra också vara grund för uppsägning, men det kräver en särskild underrättelse som ännu inte görs i systemet.
          </p>
          <Table head={['Kund', 'Faktura', 'Förföll', 'Dagar sen', 'Obetalt', 'Upplupen ränta', 'Senaste påminnelse']} empty="Inga fakturor är redo för inkasso.">
            {collection.map((c) => (
              <tr key={c.invoiceId}>
                <Td>
                  <Link href={`/kunder/${c.customerId}`} className="hover:underline">
                    {c.customerName}
                  </Link>
                </Td>
                <Td className="tabular">
                  <Link href={`/fakturor/${c.invoiceId}`} className="hover:underline">
                    {c.invoiceNr}
                  </Link>
                </Td>
                <Td className="tabular text-ink-2">{c.dueDate}</Td>
                <Td className="tabular text-ink-2">{c.daysOverdue}</Td>
                <Td className="tabular font-medium">{fmtOre(c.balanceOre, true)}</Td>
                <Td className="tabular text-ink-2">{fmtOre(c.interestOre, true)}</Td>
                <Td className="tabular text-ink-2">
                  {c.lastReminderDate} (frist {c.lastDueDate})
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'history' && (
        <Table head={['Datum', 'Kund', 'Faktura', 'Nivå', 'Belopp', 'Betala senast', 'Kvar nu', 'Skickad med', 'Status', '']} empty="Inga påminnelser ännu.">
          {history?.map((r) => {
            const st = REMINDER_STATUS[r.status];
            return (
              <tr key={r.id}>
                <Td className="tabular text-ink-2">{r.reminderDate}</Td>
                <Td>
                  <Link href={`/kunder/${r.customerId}`} className="hover:underline">
                    {r.customerName}
                  </Link>
                </Td>
                <Td className="tabular">
                  <Link href={`/fakturor/${r.invoiceId}`} className="hover:underline">
                    {r.invoiceNr}
                  </Link>
                </Td>
                <Td className="text-ink-2">{REMINDER_LEVEL_LABEL[r.level]}</Td>
                <Td className="tabular">{fmtOre(r.balanceOre + r.feeOre, true)}</Td>
                <Td className="tabular text-ink-2">{r.dueDate}</Td>
                <Td className="tabular">{r.currentBalanceOre > 0 ? fmtOre(r.currentBalanceOre, true) : <span className="text-good">Betald</span>}</Td>
                <Td className="text-ink-2">{r.channel === 'email' ? r.recipient : 'Brev'}</Td>
                <Td>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {r.error && <div className="text-[12px] text-bad">{r.error}</div>}
                </Td>
                <Td className="text-right">
                  <a href={`/api/reminders/${r.id}/pdf`} target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline">
                    PDF
                  </a>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
