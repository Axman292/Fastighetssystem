'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssignDialog, BankTx, PaymentRow, UnallocatedDialog } from '@/components/payments';
import { Badge, Button, ErrorNote, PageHeader, Stat, Table, Tabs, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { PAYMENT_METHOD_LABEL, fmtOre, formatDate } from '@/lib/format';
import { useSession } from '@/lib/session';

interface BankFileRow {
  id: string;
  companyId: string;
  companyName: string;
  filename: string;
  bankgiro: string;
  source?: 'upload' | 'auto';
  testFile: boolean;
  status: 'draft' | 'booked';
  paymentCount: number;
  totalOre: number;
  createdAt: string;
  bookedAt: string | null;
  createdByName: string | null;
  paymentDate: string | null;
  unmatchedCount: number;
  duplicateCount: number;
}

type Tab = 'files' | 'todo' | 'unallocated' | 'payments';

export default function PaymentsPage() {
  const { me, active, can, version } = useSession();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('files');
  const [files, setFiles] = useState<BankFileRow[] | null>(null);
  const [todo, setTodo] = useState<BankTx[] | null>(null);
  const [unallocated, setUnallocated] = useState<PaymentRow[] | null>(null);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [assign, setAssign] = useState<BankTx | null>(null);
  const [spread, setSpread] = useState<PaymentRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<BankFileRow[]>('/bank-files').then(setFiles);
    api<BankTx[]>('/bank-transactions?status=unmatched').then(setTodo);
    api<PaymentRow[]>('/payments?unallocated=1').then(setUnallocated);
    api<PaymentRow[]>('/payments').then(setPayments);
  }, []);
  useEffect(load, [load, version]);

  const canWrite = !!active && can('payment.write');

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/bank-files', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? 'Något gick fel');
      router.push(`/inbetalningar/${data.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const drafts = files?.filter((f) => f.status === 'draft') ?? [];
  const unallocatedSum = unallocated?.reduce((s, p) => s + p.unallocatedOre, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Inbetalningar"
        description={
          active
            ? `Inbetalningsfiler från banken (camt.054, eller BgMax för äldre filer) för ${active.companyName}. Betalningarna matchas mot avierna på OCR-nummer.`
            : 'Välj ett bolag för att läsa in en bankfil. Här visas inbetalningar i hela koncernen.'
        }
        actions={
          <>
            {me.user.isGroupAdmin && (
              <Link href="/inbetalningar/automatisk">
                <Button variant="secondary">Automatisk hämtning</Button>
              </Link>
            )}
            {canWrite && (
            <>
              <input ref={input} type="file" accept=".xml,.txt,.bgm,.bgmax,text/plain,application/xml,text/xml" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
              <Button onClick={() => input.current?.click()} disabled={busy}>
                {busy ? 'Läser in…' : 'Läs in bankfil'}
              </Button>
            </>
            )}
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Filer att granska" value={files ? drafts.length : '–'} sub={drafts.length ? 'inlästa men inte bokförda' : 'allt är bokfört'} />
        <Stat label="Att hantera" value={todo ? todo.length : '–'} sub={todo?.length ? fmtOre(todo.reduce((s, t) => s + t.amountOre, 0)) : 'inga omatchade betalningar'} />
        <Stat label="Ej fördelat" value={unallocated ? fmtOre(unallocatedSum) : '–'} sub={unallocated?.length ? `${unallocated.length} betalningar med överskott` : 'inget överskott'} />
        <Stat
          label="Senaste inbetalning"
          value={<span className="text-[17px]">{payments?.[0] ? payments[0].paymentDate : '–'}</span>}
          sub={payments?.[0] ? `${fmtOre(payments[0].amountOre)} från ${payments[0].customerName}` : undefined}
        />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'files', label: 'Bankfiler', count: files?.length },
          { key: 'todo', label: 'Att hantera', count: todo?.length },
          { key: 'unallocated', label: 'Ej fördelat', count: unallocated?.length },
          { key: 'payments', label: 'Alla inbetalningar' },
        ]}
      />

      {tab === 'files' && (
        <Table
          head={['Fil', ...(active ? [] : ['Bolag']), 'Betalningsdag', 'Betalningar', 'Belopp', 'Inläst', 'Status']}
          empty={
            <>
              Inga bankfiler ännu. Slå på <span className="font-medium">Automatisk hämtning</span>, eller hämta inbetalningsfilen (camt.054) från internetbanken och läs in den här.
            </>
          }
        >
          {files?.map((f) => (
            <tr key={f.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/inbetalningar/${f.id}`)}>
              <Td className="font-medium">
                <Link href={`/inbetalningar/${f.id}`}>{f.filename}</Link>
                {f.testFile && <span className="ml-2 text-[12px] text-warn">testfil</span>}
                {f.source === 'auto' && <span className="ml-2 text-[12px] text-ink-3">hämtad automatiskt</span>}
              </Td>
              {!active && <Td className="text-ink-2">{f.companyName}</Td>}
              <Td className="tabular text-ink-2">{f.paymentDate ?? '–'}</Td>
              <Td className="tabular">{f.paymentCount}</Td>
              <Td className="tabular">{fmtOre(f.totalOre, true)}</Td>
              <Td className="text-ink-2">
                {formatDate(f.createdAt)}
                {f.createdByName ? ` av ${f.createdByName}` : ''}
              </Td>
              <Td>
                {f.status === 'draft' ? (
                  <Badge tone="warn">Att granska</Badge>
                ) : f.unmatchedCount ? (
                  <Badge tone="warn">{f.unmatchedCount} att hantera</Badge>
                ) : (
                  <Badge tone="good">Bokförd</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {tab === 'todo' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">
            Betalningar som inte kunde kopplas till en faktura, till exempel när OCR-numret saknas eller är fel. Välj vilken kund betalningen gäller.
          </p>
          <Table head={['Betalningsdag', 'Inbetalare', 'Referens', 'Belopp', 'Fil', '']} empty="Inga betalningar väntar på hantering.">
            {todo?.map((t) => (
              <tr key={t.id}>
                <Td className="tabular text-ink-2">{t.paymentDate}</Td>
                <Td>
                  {t.payerName ?? <span className="text-ink-3">okänd</span>}
                  {t.kind === 'deduction' && <span className="ml-2 text-[12px] text-bad">avdrag</span>}
                </Td>
                <Td className="text-ink-2">
                  {t.reference ?? '–'}
                  {t.note && <div className="text-[12px] text-ink-3">{t.note}</div>}
                </Td>
                <Td className="tabular">{fmtOre(t.amountOre, true)}</Td>
                <Td className="text-ink-2">
                  <Link href={`/inbetalningar/${t.bankFileId}`} className="hover:underline">
                    {t.filename}
                  </Link>
                </Td>
                <Td className="text-right">
                  {canWrite && t.fileStatus === 'booked' && (
                    <Button size="sm" variant="secondary" onClick={() => setAssign(t)}>
                      Hantera
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'unallocated' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">
            Inbetalningar där kunden betalat mer än fakturan. Använd överskottet till en annan faktura eller betala tillbaka det.
          </p>
          <Table head={['Betalningsdag', 'Kund', 'Inbetalt', 'Fördelat på', 'Ej fördelat', '']} empty="Inga överskott.">
            {unallocated?.map((p) => (
              <tr key={p.id}>
                <Td className="tabular text-ink-2">{p.paymentDate}</Td>
                <Td>
                  <Link href={`/kunder/${p.customerId}`} className="hover:underline">
                    {p.customerName}
                  </Link>
                </Td>
                <Td className="tabular">{fmtOre(p.amountOre, true)}</Td>
                <Td className="text-ink-2">{p.invoices || '–'}</Td>
                <Td className="tabular font-medium">{fmtOre(p.unallocatedOre, true)}</Td>
                <Td className="text-right">
                  {canWrite && (
                    <Button size="sm" variant="secondary" onClick={() => setSpread(p)}>
                      Fördela eller betala tillbaka
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {tab === 'payments' && (
        <Table head={['Betalningsdag', 'Kund', 'Sätt', 'Referens', 'Belopp', 'Fördelat på']} empty="Inga inbetalningar ännu.">
          {payments?.map((p) => (
            <tr key={p.id}>
              <Td className="tabular text-ink-2">{p.paymentDate}</Td>
              <Td>
                <Link href={`/kunder/${p.customerId}`} className="hover:underline">
                  {p.customerName}
                </Link>
              </Td>
              <Td className="text-ink-2">{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
              <Td className="text-ink-2">{p.reference ?? '–'}</Td>
              <Td className="tabular">{fmtOre(p.amountOre, true)}</Td>
              <Td className="text-ink-2">
                {p.invoices || '–'}
                {p.unallocatedOre > 0 && <span className="ml-2 text-[12px] text-warn">{fmtOre(p.unallocatedOre, true)} ej fördelat</span>}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <AssignDialog
        tx={assign}
        companyId={assign ? active?.companyId ?? '' : ''}
        onClose={() => setAssign(null)}
        onDone={() => {
          setAssign(null);
          load();
        }}
      />
      <UnallocatedDialog
        payment={spread}
        onClose={() => setSpread(null)}
        onDone={() => {
          setSpread(null);
          load();
        }}
      />
    </>
  );
}
