'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SectionHeader } from './edit-form';
import { MessageBubble } from './message-parts';
import { Badge, Button, Dialog, Table, Td, formatDateTime } from './ui';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, Channel, RECIPIENT_STATUS, RecipientStatus } from '@/lib/messages';

interface Row {
  id: string;
  campaignId: string;
  campaignNr: number;
  campaignName: string;
  channel: Channel;
  recipient: string | null;
  subject: string | null;
  body: string;
  status: RecipientStatus;
  note: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** Utskick som hyresgästen har fått: e-post och SMS. */
export function CustomerMessages({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<Row | null>(null);

  useEffect(() => {
    api<Row[]>(`/messages/customer/${customerId}`).then(setRows).catch(() => setRows([]));
  }, [customerId]);

  return (
    <section>
      <SectionHeader title="Utskick" description="E-post och SMS som skickats till hyresgästen från Utskick." />
      <Table head={['Datum', 'Utskick', 'Kanal', 'Till', 'Status', '']} empty="Inga utskick till den här hyresgästen.">
        {rows?.map((r) => (
          <tr key={r.id} className="hover:bg-subtle/50">
            <Td className="text-[12px] text-ink-2">{formatDateTime(r.sentAt ?? r.createdAt)}</Td>
            <Td className="font-medium">
              <Link href={`/utskick/${r.campaignId}`} className="hover:underline">
                {r.campaignName}
              </Link>
              {r.subject && <div className="max-w-[280px] truncate text-[12px] font-normal text-ink-3">{r.subject}</div>}
            </Td>
            <Td className="text-ink-2">{CHANNEL_LABEL[r.channel]}</Td>
            <Td className="text-ink-2">{r.recipient ?? '–'}</Td>
            <Td>
              <Badge tone={RECIPIENT_STATUS[r.status].tone}>{RECIPIENT_STATUS[r.status].label}</Badge>
              {r.note && <div className="mt-0.5 max-w-[260px] text-[11.5px] text-ink-3">{r.note}</div>}
            </Td>
            <Td>
              <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>
                Visa
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.campaignName ?? ''} wide>
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
    </section>
  );
}
