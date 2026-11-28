'use client';

import { use, useEffect, useState } from 'react';
import { NotFound, PublicFrame } from '@/components/public-frame';
import { Badge, Button, Card, ErrorNote, cx, formatDateTime } from '@/components/ui';
import { TextArea } from '@/components/work-order-form';

interface View {
  orderNr: number;
  title: string;
  category: string;
  status: string;
  statusLabel: string;
  propertyName: string;
  objectNr: string | null;
  companyName: string;
  createdAt: string;
  doneAt: string | null;
  scheduledDate: string | null;
  canWrite: boolean;
  events: { id: string; createdAt: string; kind: 'status' | 'message' | 'you'; body: string | null }[];
}

const STEPS = [
  { key: 'received', label: 'Mottagen', statuses: ['new', 'assigned', 'in_progress', 'waiting', 'done', 'closed'] },
  { key: 'work', label: 'Under arbete', statuses: ['assigned', 'in_progress', 'waiting', 'done', 'closed'] },
  { key: 'done', label: 'Åtgärdad', statuses: ['done', 'closed'] },
];

/** Anmälarens sida: status och meddelanden i ärendet. */
export default function ReportStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/public/fault-reports/${encodeURIComponent(token)}`;

  useEffect(() => {
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) setMissing(body.message ?? 'Ärendet finns inte.');
        else setV(body);
      })
      .catch(() => setMissing('Kunde inte nå tjänsten. Försök igen om en stund.'));
  }, [url]);

  if (missing) return <NotFound message={missing} />;
  if (!v) return null;

  async function send() {
    setBusy(true);
    setError(null);
    const r = await fetch(`${url}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: msg }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) setError(body.message ?? 'Kunde inte skicka');
    else {
      setV(body);
      setMsg('');
    }
    setBusy(false);
  }

  const cancelled = v.status === 'cancelled';
  return (
    <PublicFrame company={v.companyName} title={`Ärende ${v.orderNr}`} subtitle={`${v.title} · ${v.propertyName}${v.objectNr ? `, ${v.objectNr}` : ''}`}>
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-ink-3">Status</span>
          <Badge tone={cancelled ? 'neutral' : v.status === 'done' || v.status === 'closed' ? 'good' : 'accent'}>{v.statusLabel}</Badge>
        </div>
        {!cancelled && (
          <ol className="mt-4 grid grid-cols-3 gap-2">
            {STEPS.map((s) => {
              const reached = s.statuses.includes(v.status);
              return (
                <li key={s.key}>
                  <div className={cx('h-1.5 rounded-full', reached ? 'bg-accent' : 'bg-subtle')} />
                  <div className={cx('mt-1.5 text-[12px]', reached ? 'font-medium text-ink' : 'text-ink-3')}>{s.label}</div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 space-y-1 text-[13px] text-ink-2">
          <div>Anmäld {formatDateTime(v.createdAt)}</div>
          {v.scheduledDate && !v.doneAt && <div>Planerat datum: {v.scheduledDate}</div>}
          {v.doneAt && <div>Åtgärdad {formatDateTime(v.doneAt)}</div>}
        </div>
      </Card>

      <Card className="mt-4 p-5">
        <div className="mb-3 text-[13px] font-semibold">Händelser och meddelanden</div>
        <ol className="space-y-3">
          {v.events.map((e) => (
            <li key={e.id} className={cx('rounded-md px-3 py-2 text-[13.5px]', e.kind === 'you' ? 'ml-8 bg-accent-soft' : e.kind === 'message' ? 'mr-8 bg-subtle' : 'text-ink-2')}>
              <div className="text-[11.5px] text-ink-3">
                {e.kind === 'you' ? 'Du' : e.kind === 'message' ? v.companyName : 'Status'} · {formatDateTime(e.createdAt)}
              </div>
              <div className="whitespace-pre-wrap">{e.body}</div>
            </li>
          ))}
        </ol>
        {v.canWrite ? (
          <div className="mt-4 space-y-2 border-t border-line pt-4">
            <ErrorNote message={error} />
            <TextArea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Skriv till oss om ärendet" maxLength={2000} className="text-[14px]" />
            <div className="flex justify-end">
              <Button disabled={busy || !msg.trim()} onClick={send}>
                Skicka
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-3">Ärendet är avslutat. Finns felet kvar, gör en ny felanmälan.</p>
        )}
      </Card>
    </PublicFrame>
  );
}
