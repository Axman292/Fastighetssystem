'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, PageHeader, Table, Td, formatDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { Campaign, channelsLabel } from '@/lib/messages';
import { useSession } from '@/lib/session';

export default function MessagesPage() {
  const { active, can, version } = useSession();
  const [rows, setRows] = useState<Campaign[] | null>(null);

  useEffect(() => {
    api<Campaign[]>('/messages').then(setRows);
  }, [version]);

  return (
    <>
      <PageHeader
        title="Utskick"
        description="Skicka e-post eller SMS till alla hyresgäster eller ett urval, till exempel om vattenavstängning eller planerat underhåll. Allt som skickas sparas här och på varje hyresgäst."
        actions={
          <>
            <Link href="/utskick/mallar">
              <Button variant="secondary">Mallar</Button>
            </Link>
            {active && can('message.send') && (
              <Link href="/utskick/ny">
                <Button>Nytt utskick</Button>
              </Link>
            )}
          </>
        }
      />
      {!active && <p className="mb-3 text-[12px] text-ink-3">Välj ett bolag för att göra ett nytt utskick. Listan visar hela koncernen.</p>}
      <Table head={['Nr', 'Utskick', 'Kanal', 'Hyresgäster', 'Skickade', 'Problem', 'Skickat', 'Status']} empty="Inga utskick är gjorda ännu.">
        {rows?.map((r) => (
          <tr key={r.id} className="hover:bg-subtle/50">
            <Td className="tabular text-ink-2">{r.campaignNr}</Td>
            <Td className="font-medium">
              <Link href={`/utskick/${r.id}`} className="hover:underline">
                {r.name}
              </Link>
              {r.subject && <div className="max-w-[320px] truncate text-[12px] font-normal text-ink-3">{r.subject}</div>}
              {!active && <div className="text-[12px] font-normal text-ink-3">{r.companyName}</div>}
            </Td>
            <Td className="text-ink-2">{channelsLabel(r)}</Td>
            <Td className="tabular">{r.recipientCount}</Td>
            <Td className="tabular">
              {[r.emails && `${r.emails} e-post`, r.sms && `${r.sms} SMS`].filter(Boolean).join(', ') || '0'}
              {r.test > 0 && <div className="text-[12px] text-ink-3">varav {r.test} i testläge</div>}
            </Td>
            <Td className="tabular">
              {r.failed > 0 && <div className="text-bad">{r.failed} misslyckades</div>}
              {r.skipped > 0 && <div className="text-[12px] text-warn">{r.skipped} saknar uppgift</div>}
              {!r.failed && !r.skipped && <span className="text-ink-3">–</span>}
            </Td>
            <Td className="text-[12px] text-ink-2">
              {formatDateTime(r.createdAt)}
              {r.createdByName && <div className="text-ink-3">{r.createdByName}</div>}
            </Td>
            <Td>
              {r.status === 'sending' || r.queued > 0 ? (
                <Badge tone="accent">Skickar</Badge>
              ) : r.failed > 0 ? (
                <Badge tone="bad">Delvis misslyckat</Badge>
              ) : (
                <Badge tone="good">Klart</Badge>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
