'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { Chip, MessageBubble } from '@/components/message-parts';
import { Badge, Button, Card, Dialog, ErrorNote, PageHeader, Stat, Table, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { CONTRACT_TYPE_LABEL, OBJECT_TYPE_LABEL } from '@/lib/format';
import { CHANNEL_LABEL, CONTRACT_STATUS_LABEL, CampaignDetail, CampaignRecipient, RECIPIENT_STATUS, RecipientStatus, channelsLabel } from '@/lib/messages';
import { useSession } from '@/lib/session';

export default function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | RecipientStatus>('all');
  const [open, setOpen] = useState<CampaignRecipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<CampaignDetail>(`/messages/${id}`).then(setC), [id]);
  useEffect(() => {
    load();
    api<{ id: string; name: string }[]>('/properties').then((p) => setProperties(Object.fromEntries(p.map((x) => [x.id, x.name]))));
  }, [load]);

  // Uppdatera medan stora utskick skickas i bakgrunden.
  useEffect(() => {
    if (!c || (c.status !== 'sending' && !c.queued)) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [c, load]);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await api(`/messages/${id}/retry`, { method: 'POST', companyId: c?.companyId });
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!c) return null;
  const rows = filter === 'all' ? c.recipients : c.recipients.filter((r) => r.status === filter);
  const crit = c.criteria;
  const urval = [
    crit.contractStatuses?.length ? crit.contractStatuses.map((s) => CONTRACT_STATUS_LABEL[s]).join(', ') : 'Alla med avtal',
    crit.propertyIds?.length ? crit.propertyIds.map((p) => properties[p] ?? 'okänd fastighet').join(', ') : 'alla fastigheter',
    crit.objectTypes?.length ? crit.objectTypes.map((t) => OBJECT_TYPE_LABEL[t]).join(', ') : null,
    crit.contractTypes?.length ? crit.contractTypes.map((t) => CONTRACT_TYPE_LABEL[t]).join(', ') : null,
    crit.includeContacts ? 'med kontaktpersoner' : null,
    crit.excludeCustomerIds?.length ? `${crit.excludeCustomerIds.length} bortvalda` : null,
  ].filter(Boolean);
  const counts: Record<string, number> = { sent: c.sent, test: c.test, failed: c.failed, skipped: c.skipped, queued: c.queued };

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/utskick" className="hover:text-ink">
          Utskick
        </Link>{' '}
        / {c.campaignNr}
      </div>
      <PageHeader
        title={c.name}
        description={`${channelsLabel(c)} från ${c.companyName}, ${formatDateTime(c.createdAt)}${c.createdByName ? ` av ${c.createdByName}` : ''}.`}
        actions={
          c.failed > 0 &&
          can('message.send', c.companyId) && (
            <Button onClick={retry} disabled={busy}>
              {busy ? 'Skickar…' : `Försök igen med ${c.failed} misslyckade`}
            </Button>
          )
        }
      />
      <ErrorNote message={error} />

      <div className="mb-4 grid grid-cols-4 gap-3">
        <Stat label="Hyresgäster" value={c.recipientCount} />
        <Stat label="Skickade" value={c.sent + c.test} sub={[c.emails && `${c.emails} e-post`, c.sms && `${c.sms} SMS`].filter(Boolean).join(', ') || undefined} />
        <Stat label="Misslyckades" value={c.failed} sub={c.failed ? 'Se orsaken i listan' : undefined} />
        <Stat label="Saknar uppgift" value={c.skipped} sub={c.skipped ? 'Nå dem på annat sätt' : undefined} />
      </div>
      {(c.status === 'sending' || c.queued > 0) && (
        <div className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">Skickar… {c.queued} kvar. Sidan uppdateras av sig själv.</div>
      )}
      {c.test > 0 && (
        <div className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">
          {c.test} {c.test === 1 ? 'meddelande' : 'meddelanden'} hanterades i testläge och nådde inte mottagaren.
        </div>
      )}

      <div className="mb-6 grid grid-cols-[1fr_300px] gap-4">
        <Card className="p-4">
          <div className="mb-2 text-[12px] font-medium text-ink-3">Meddelandet (före ifyllnad)</div>
          {c.sendEmail && <MessageBubble channel="email" subject={c.subject} body={c.body ?? ''} />}
          {c.sendSms && (
            <div className={c.sendEmail ? 'mt-3' : ''}>
              <MessageBubble channel="sms" body={c.smsBody ?? ''} from="SMS" />
            </div>
          )}
        </Card>
        <Card className="space-y-2 p-4 text-[13px]">
          <div className="text-[12px] font-medium text-ink-3">Urval</div>
          {urval.map((u, i) => (
            <div key={i} className="text-ink-2">
              {u}
            </div>
          ))}
          {c.templateName && <div className="pt-1 text-[12px] text-ink-3">Mall: {c.templateName}</div>}
        </Card>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
          Alla {c.recipients.length}
        </Chip>
        {(Object.keys(RECIPIENT_STATUS) as RecipientStatus[])
          .filter((s) => counts[s] > 0)
          .map((s) => (
            <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>
              {RECIPIENT_STATUS[s].label} {counts[s]}
            </Chip>
          ))}
      </div>
      <Table head={['Hyresgäst', 'Kanal', 'Till', 'Status', 'Skickat', '']} empty="Inga mottagare.">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-subtle/50">
            <Td className="font-medium">
              {r.customerId ? (
                <Link href={`/kunder/${r.customerId}`} className="hover:underline">
                  {r.customerName}
                </Link>
              ) : (
                r.customerName
              )}
              {r.customerNr && <div className="text-[12px] font-normal text-ink-3">Kund {r.customerNr}</div>}
            </Td>
            <Td className="text-ink-2">{CHANNEL_LABEL[r.channel]}</Td>
            <Td className="text-ink-2">{r.recipient ?? <span className="text-ink-3">–</span>}</Td>
            <Td>
              <Badge tone={RECIPIENT_STATUS[r.status].tone}>{RECIPIENT_STATUS[r.status].label}</Badge>
              {r.note && <div className="mt-0.5 max-w-[300px] text-[11.5px] text-ink-3">{r.note}</div>}
            </Td>
            <Td className="text-[12px] text-ink-2">{r.sentAt ? formatDateTime(r.sentAt) : '–'}</Td>
            <Td>
              <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>
                Visa
              </Button>
            </Td>
          </tr>
        ))}
      </Table>

      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `${CHANNEL_LABEL[open.channel]} till ${open.customerName}` : ''} wide>
        {open && (
          <div className="space-y-3">
            <MessageBubble channel={open.channel} subject={open.subject} body={open.body} from={open.recipient ?? undefined} />
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Stäng
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
