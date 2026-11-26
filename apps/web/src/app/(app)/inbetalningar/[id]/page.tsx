'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { AssignDialog, BankTx, matchNote } from '@/components/payments';
import { Badge, Button, Card, ErrorNote, PageHeader, Stat, Table, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { BANK_TX_STATUS, MATCH_RULE_LABEL, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface BankFile {
  id: string;
  companyId: string;
  companyName: string;
  filename: string;
  bankgiro: string;
  fileTimestamp: string;
  testFile: boolean;
  status: 'draft' | 'booked';
  paymentCount: number;
  totalOre: number;
  createdAt: string;
  bookedAt: string | null;
  createdByName: string | null;
  bookedByName: string | null;
  transactions: BankTx[];
}

export default function BankFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [f, setF] = useState<BankFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assign, setAssign] = useState<BankTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<BankFile>(`/bank-files/${id}`).then(setF).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error && !f) return <ErrorNote message={error} />;
  if (!f) return null;
  const canWrite = can('payment.write', f.companyId);
  const opts = { companyId: f.companyId };
  const count = (s: string) => f.transactions.filter((t) => t.status === s);
  const matched = count('matched');
  const unmatched = count('unmatched');
  const duplicates = count('duplicate');
  const sum = (list: BankTx[]) => list.reduce((s, t) => s + t.amountOre, 0);
  const warnings = f.transactions.filter((t) => matchNote(t)?.tone === 'warn');
  const suggestions = unmatched.filter((t) => t.matchRule === 'name_amount' && t.customerId);

  /** Bekräftar förslag på namn och belopp. Är filen bokförd bokförs de direkt. */
  async function confirm(list: BankTx[]) {
    setBusy(true);
    setError(null);
    try {
      for (const t of list) {
        await api(`/bank-transactions/${t.id}`, { method: 'PATCH', ...opts, body: { customerId: t.customerId, invoiceId: t.invoiceId, note: 'Förslag på namn och belopp bekräftat' } });
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function book() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ booked: number; unmatched: number }>(`/bank-files/${id}/book`, { method: 'POST', ...opts });
      setResult(
        `${r.booked} ${r.booked === 1 ? 'betalning bokfördes' : 'betalningar bokfördes'}.` +
          (r.unmatched ? ` ${r.unmatched} väntar på att du väljer kund.` : ''),
      );
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/bank-files/${id}`, { method: 'DELETE', ...opts });
      router.push('/inbetalningar');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/inbetalningar" className="hover:text-ink">
          Inbetalningar
        </Link>{' '}
        / {f.filename}
      </div>
      <PageHeader
        title={f.filename}
        description={`Bankgiro ${f.bankgiro} · ${f.companyName} · inläst ${formatDateTime(f.createdAt)}${f.createdByName ? ` av ${f.createdByName}` : ''}`}
        actions={
          <>
            {f.status === 'booked' ? <Badge tone="good">Bokförd</Badge> : <Badge tone="warn">Att granska</Badge>}
            {f.testFile && <Badge tone="warn">Testfil från Bankgirot</Badge>}
            {canWrite && f.status === 'draft' && (
              <>
                <Button variant="ghost" onClick={remove} disabled={busy}>
                  Ta bort filen
                </Button>
                <Button onClick={book} disabled={busy || !matched.length}>
                  {busy ? 'Bokför…' : `Bokför ${matched.length} betalningar`}
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="I filen" value={fmtOre(f.totalOre, true)} sub={`${f.paymentCount} betalningar`} />
        <Stat
          label={f.status === 'draft' ? 'Matchade' : 'Bokförda'}
          value={f.status === 'draft' ? matched.length : count('booked').length}
          sub={fmtOre(sum(f.status === 'draft' ? matched : count('booked')), true)}
        />
        <Stat label="Att hantera" value={unmatched.length} sub={unmatched.length ? fmtOre(sum(unmatched), true) : 'alla hittade sin faktura'} />
        <Stat label="Redan inlästa" value={duplicates.length} sub={duplicates.length ? 'hoppas över, bokförs inte igen' : 'inga dubbletter'} />
      </div>

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
      {f.status === 'draft' && (
        <Card className="mb-6 px-4 py-3.5 text-[13px] text-ink-2">
          Inget är bokfört ännu. Kontrollera matchningarna nedan och tryck på <span className="font-medium text-ink">Bokför</span>.
          {unmatched.length > 0 && ' Betalningar som inte hittade sin faktura kan du hantera nu eller senare under Inbetalningar.'}
          {warnings.length > 0 && ` ${warnings.length === 1 ? '1 betalning avviker' : `${warnings.length} betalningar avviker`} från fakturans belopp.`}
        </Card>
      )}
      {suggestions.length > 0 && (
        <Card className="mb-6 flex items-center gap-4 px-4 py-3.5 text-[13px]">
          <Badge tone="accent">Förslag</Badge>
          <div className="flex-1 text-ink-2">
            {suggestions.length === 1 ? '1 betalning saknar' : `${suggestions.length} betalningar saknar`} OCR men inbetalarens namn och beloppet pekar ut en hyresgäst.
            Kontrollera förslagen i tabellen. De bokförs först när du godkänner dem.
          </div>
          {canWrite && (
            <Button size="sm" variant="secondary" onClick={() => confirm(suggestions)} disabled={busy}>
              Godkänn {suggestions.length === 1 ? 'förslaget' : `alla ${suggestions.length} förslag`}
            </Button>
          )}
        </Card>
      )}

      <Table head={['#', 'Inbetalare', 'Referens', 'Belopp', 'Kund', 'Faktura', 'Kommentar', 'Status', '']}>
        {f.transactions.map((t) => {
          const suggested = t.status === 'unmatched' && t.matchRule === 'name_amount' && !!t.customerId;
          const s = suggested ? { label: 'Förslag', tone: 'accent' as const } : BANK_TX_STATUS[t.status];
          const n = matchNote(t);
          return (
            <tr key={t.id}>
              <Td className="tabular text-ink-3">{t.position}</Td>
              <Td>
                {t.payerName ?? <span className="text-ink-3">okänd</span>}
                {t.kind === 'deduction' && <div className="text-[12px] text-bad">Avdrag</div>}
              </Td>
              <Td className="tabular text-ink-2">{t.reference ?? '–'}</Td>
              <Td className="tabular font-medium">{fmtOre(t.amountOre, true)}</Td>
              <Td>
                {t.customerId ? (
                  <Link href={`/kunder/${t.customerId}`} className="hover:underline">
                    {t.customerName}
                  </Link>
                ) : (
                  <span className="text-ink-3">–</span>
                )}
              </Td>
              <Td className="tabular">
                {t.invoiceId ? (
                  <Link href={`/fakturor/${t.invoiceId}`} className="hover:underline">
                    {t.invoiceNr}
                  </Link>
                ) : (
                  '–'
                )}
                {t.matchRule && <div className="text-[11.5px] text-ink-3">{MATCH_RULE_LABEL[t.matchRule]}</div>}
              </Td>
              <Td className="max-w-[260px] text-[12.5px]">
                {n && <div className={n.tone === 'warn' ? 'text-warn' : n.tone === 'good' ? 'text-good' : 'text-ink-2'}>{n.text}</div>}
                {t.note && <div className="text-ink-3">{t.note}</div>}
              </Td>
              <Td>
                <Badge tone={s.tone}>{s.label}</Badge>
              </Td>
              <Td className="text-right">
                {canWrite && suggested && (
                  <Button size="sm" variant="secondary" onClick={() => confirm([t])} disabled={busy}>
                    Godkänn
                  </Button>
                )}
                {canWrite && ['matched', 'unmatched'].includes(t.status) && (
                  <Button size="sm" variant="ghost" onClick={() => setAssign(t)}>
                    {t.status === 'unmatched' && !suggested ? 'Välj kund' : 'Ändra'}
                  </Button>
                )}
              </Td>
            </tr>
          );
        })}
      </Table>

      <AssignDialog
        tx={assign}
        companyId={f.companyId}
        onClose={() => setAssign(null)}
        onDone={() => {
          setAssign(null);
          load();
        }}
      />
    </>
  );
}
