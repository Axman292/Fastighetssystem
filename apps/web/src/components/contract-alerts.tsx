'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Dialog, ErrorNote, Field, Input, cx } from './ui';

export interface AlertAck {
  id: string;
  action: 'done' | 'snooze';
  snoozeUntil: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface ContractAlert {
  key: string;
  kind: string;
  label: string;
  date: string;
  severity: 'high' | 'normal';
  overdue: boolean;
  message: string;
  action: string | null;
  link: string;
  contractId: string;
  contractNr: number;
  contractType: string;
  companyId: string;
  companyName: string;
  customerName: string;
  objects: string;
  ack: AlertAck | null;
}

/** Färg per typ av påminnelse, för kalendern. Bara färgtoken. */
export const KIND_DOT: Record<string, string> = {
  notice_deadline: 'bg-bad',
  auto_extended: 'bg-bad',
  ending: 'bg-warn',
  renegotiate: 'bg-accent',
  index: 'bg-good',
  rent_change: 'bg-ink-3',
  line_ends: 'bg-ink-3',
  security_expiry: 'bg-warn',
  deposit_due: 'bg-warn',
  draft: 'bg-ink-3',
  no_lines: 'bg-bad',
};

export function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000);
}

export function whenText(date: string): string {
  const d = daysUntil(date);
  if (d === 0) return 'i dag';
  if (d === 1) return 'i morgon';
  if (d === -1) return 'i går';
  if (d < 0) return `${-d} dagar sedan`;
  return `om ${d} dagar`;
}

export function alertTone(a: ContractAlert): 'bad' | 'warn' | 'neutral' | 'good' {
  if (a.ack?.action === 'done') return 'good';
  if (a.overdue) return 'bad';
  return a.severity === 'high' ? 'warn' : 'neutral';
}

function ackText(a: AlertAck): string {
  const by = a.createdByName ? ` av ${a.createdByName}` : '';
  return a.action === 'done' ? `Klar${by}` : `Uppskjuten till ${a.snoozeUntil}${by}`;
}

/** Lista med påminnelser. Varje rad kan markeras klar eller skjutas upp. */
export function AlertList({
  items,
  onChanged,
  showContract = true,
  empty,
}: {
  items: ContractAlert[];
  onChanged: () => void;
  showContract?: boolean;
  empty?: string;
}) {
  const { can } = useSession();
  const [handling, setHandling] = useState<ContractAlert | null>(null);

  if (!items.length) return <div className="px-4 py-8 text-center text-[13px] text-ink-3">{empty ?? 'Inga påminnelser.'}</div>;

  const undo = async (a: ContractAlert) => {
    await api(`/contract-alerts/ack/${a.ack!.id}`, { method: 'DELETE', companyId: a.companyId });
    onChanged();
  };

  return (
    <>
      <div className="divide-y divide-line">
        {items.map((a) => {
          const write = can('contract.write', a.companyId);
          return (
            <div key={a.key} className={cx('flex items-start gap-4 px-4 py-3', a.ack?.action === 'done' && 'opacity-70')}>
              <div className="w-44 shrink-0 pt-0.5">
                <Badge tone={alertTone(a)}>{a.label}</Badge>
              </div>
              <div className="min-w-0 flex-1">
                {showContract && (
                  <Link href={`/avtal/${a.contractId}`} className="text-[13px] font-medium hover:text-accent">
                    {a.customerName} <span className="font-normal text-ink-3">· avtal {a.contractNr}</span>
                    {a.objects && <span className="font-normal text-ink-3"> · {a.objects}</span>}
                  </Link>
                )}
                <div className="text-[12.5px] text-ink-2">{a.message}</div>
                {a.action && !a.ack && <div className="mt-0.5 text-[12px] text-ink-3">Att göra: {a.action}</div>}
                {a.ack && (
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {ackText(a.ack)}
                    {a.ack.note ? ` · ${a.ack.note}` : ''}
                  </div>
                )}
              </div>
              <div className="w-28 shrink-0 text-right text-[12px]">
                <div className="font-medium tabular">{a.date}</div>
                <div className={cx(a.overdue && !a.ack ? 'text-bad' : 'text-ink-3')}>{whenText(a.date)}</div>
              </div>
              <div className="flex w-44 shrink-0 justify-end gap-1">
                {a.link !== `/avtal/${a.contractId}` && (
                  <Link href={a.link}>
                    <Button size="sm" variant="ghost">
                      Åtgärda
                    </Button>
                  </Link>
                )}
                {write &&
                  (a.ack ? (
                    <Button size="sm" variant="ghost" onClick={() => undo(a)}>
                      Ångra
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setHandling(a)}>
                      Hantera
                    </Button>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
      <HandleDialog
        alert={handling}
        onClose={() => setHandling(null)}
        onDone={() => {
          setHandling(null);
          onChanged();
        }}
      />
    </>
  );
}

function addDaysIso(days: number): string {
  const d = new Date(`${todayIso()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function HandleDialog({ alert, onClose, onDone }: { alert: ContractAlert | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [until, setUntil] = useState(addDaysIso(7));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (action: 'done' | 'snooze', snoozeUntil?: string) => {
    if (!alert) return;
    setBusy(true);
    setError(null);
    try {
      await api('/contract-alerts/ack', {
        method: 'POST',
        companyId: alert.companyId,
        body: { key: alert.key, contractId: alert.contractId, kind: alert.kind, date: alert.date, action, snoozeUntil, note: note.trim() || null },
      });
      setNote('');
      onDone();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!alert} onClose={onClose} wide title={alert ? `${alert.label}: ${alert.customerName}` : ''}>
      {alert && (
        <div className="space-y-4 text-[13px]">
          <p className="text-ink-2">{alert.message}</p>
          <Field label="Anteckning" hint="Sparas i avtalets händelser">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Till exempel: hyresgästen vill förlänga" />
          </Field>
          <ErrorNote message={error} />
          <div className="border-t border-line pt-4">
            <div className="mb-2 text-ink-3">Inte klart än? Påminn igen</div>
            <div className="flex flex-wrap items-center gap-2">
              {[7, 30].map((d) => (
                <Button key={d} size="sm" variant="ghost" disabled={busy} onClick={() => send('snooze', addDaysIso(d))}>
                  om {d} dagar
                </Button>
              ))}
              <div className="w-40">
                <Input type="date" value={until} min={addDaysIso(1)} onChange={(e) => setUntil(e.target.value)} />
              </div>
              <Button size="sm" variant="secondary" disabled={busy || !until} onClick={() => send('snooze', until)}>
                Skjut upp
              </Button>
            </div>
          </div>
          <div className="flex justify-end">
            <Button disabled={busy} onClick={() => send('done')}>
              Markera som klar
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
