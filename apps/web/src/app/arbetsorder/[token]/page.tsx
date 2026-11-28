'use client';

import { use, useEffect, useRef, useState } from 'react';
import { NotFound, PublicFrame } from '@/components/public-frame';
import { Badge, Button, Card, ErrorNote, Field, Input, formatDateTime } from '@/components/ui';
import { TextArea } from '@/components/work-order-form';

interface View {
  orderNr: number;
  title: string;
  description: string | null;
  category: string;
  priority: string;
  status: string;
  statusLabel: string;
  companyName: string;
  propertyName: string;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  objectNr: string | null;
  apartmentNr: string | null;
  floor: number | null;
  location: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  costEstimateOre: number | null;
  masterKeyOk: boolean;
  accessNote: string | null;
  contactName: string | null;
  contactPhone: string | null;
  canReport: boolean;
  photos: { id: string; fileName: string }[];
  events: { id: string; createdAt: string; author: string | null; body: string | null; kind: string }[];
}

const PRIORITY: Record<string, string> = { urgent: 'Akut', high: 'Hög', normal: 'Normal', low: 'Låg' };

/** Hantverkarens arbetsorder: allt som behövs på plats, och kvittering. */
export default function SupplierWorkOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = `/api/public/work-orders/${encodeURIComponent(token)}`;

  useEffect(() => {
    try {
      setName(localStorage.getItem('arbetsorder:namn') ?? '');
    } catch {
      /* privat läge */
    }
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) setMissing(b.message ?? 'Arbetsordern finns inte.');
        else setV(b);
      })
      .catch(() => setMissing('Kunde inte nå tjänsten. Försök igen om en stund.'));
  }, [url]);

  if (missing) return <NotFound message={missing} />;
  if (!v) return null;

  async function report(action: 'comment' | 'started' | 'done') {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set('action', action);
    if (body.trim()) fd.set('body', body.trim());
    if (name.trim()) fd.set('name', name.trim());
    for (const f of files) fd.append('photos', f);
    try {
      localStorage.setItem('arbetsorder:namn', name.trim());
    } catch {
      /* privat läge */
    }
    const r = await fetch(`${url}/report`, { method: 'POST', body: fd });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) setError(b.message ?? 'Kunde inte skicka');
    else {
      setV(b);
      setBody('');
      setFiles([]);
      setSent(action === 'done' ? 'Tack! Arbetet är kvitterat som utfört.' : action === 'started' ? 'Markerat som påbörjat.' : 'Meddelandet är skickat.');
    }
    setBusy(false);
  }

  const address = [v.addressLine, [v.postalCode, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || v.propertyName)}`;

  return (
    <PublicFrame company={v.companyName} title={`Arbetsorder ${v.orderNr}`} subtitle={v.title}>
      <Card className="p-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={v.status === 'done' || v.status === 'closed' ? 'good' : 'accent'}>{v.statusLabel}</Badge>
          <Badge tone={v.priority === 'urgent' ? 'bad' : v.priority === 'high' ? 'warn' : 'neutral'}>Prioritet {PRIORITY[v.priority]?.toLowerCase()}</Badge>
          <Badge>{v.category}</Badge>
        </div>
        <dl className="mt-4 grid gap-3 text-[13.5px] sm:grid-cols-2">
          <Item label="Adress">
            {v.propertyName}
            {address && (
              <div>
                <a href={mapUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {address}
                </a>
              </div>
            )}
          </Item>
          <Item label="Lägenhet eller lokal">
            {v.objectNr ? `${v.apartmentNr ? `Lgh ${v.apartmentNr} (${v.objectNr})` : v.objectNr}${v.floor !== null ? `, våning ${v.floor}` : ''}` : 'Gemensamma utrymmen'}
            {v.location && <div className="text-ink-2">{v.location}</div>}
          </Item>
          <Item label="Kontakt på plats">
            {v.contactName ?? '–'}
            {v.contactPhone && (
              <div>
                <a href={`tel:${v.contactPhone}`} className="text-accent">
                  {v.contactPhone}
                </a>
              </div>
            )}
          </Item>
          <Item label="Tillträde">
            {v.masterKeyOk ? 'Huvudnyckel får användas' : 'Kontakta hyresgästen innan ni går in'}
            {v.accessNote && <div className="text-ink-2">{v.accessNote}</div>}
          </Item>
          <Item label="Önskas klart">
            {v.dueDate ?? '–'}
            {v.scheduledDate && <div className="text-ink-2">Planerat {v.scheduledDate}</div>}
          </Item>
          {v.costEstimateOre ? <Item label="Kostnadsram">{Math.round(v.costEstimateOre / 100).toLocaleString('sv-SE')} kr exkl. moms</Item> : null}
        </dl>
        {v.description && <p className="mt-4 whitespace-pre-wrap border-t border-line pt-4 text-[13.5px]">{v.description}</p>}
        {v.photos.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-2">
            {v.photos.map((p) => (
              <a key={p.id} href={`${url}/photos/${p.id}`} target="_blank" rel="noreferrer" className="aspect-square overflow-hidden rounded-md bg-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${url}/photos/${p.id}`} alt={p.fileName} className="size-full object-cover" />
              </a>
            ))}
          </div>
        )}
        <p className="mt-4 text-[12px] text-ink-3">Ange arbetsorder {v.orderNr} på fakturan.</p>
      </Card>

      {v.events.length > 0 && (
        <Card className="mt-4 p-5">
          <div className="mb-2 text-[13px] font-semibold">Meddelanden</div>
          <ol className="space-y-2">
            {v.events.map((e) => (
              <li key={e.id} className="text-[13.5px]">
                <div className="text-[11.5px] text-ink-3">
                  {e.author ?? v.companyName} · {formatDateTime(e.createdAt)}
                </div>
                <div className="whitespace-pre-wrap">{e.body}</div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {v.canReport ? (
        <Card className="mt-4 space-y-3 p-5">
          <div className="text-[13px] font-semibold">Rapportera</div>
          {sent && <div className="rounded-md bg-good-soft px-3 py-2 text-[13px] text-good">{sent}</div>}
          <ErrorNote message={error} />
          <Field label="Ditt namn">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="h-10 text-[14px]" />
          </Field>
          <Field label="Vad har gjorts? (frivilligt)">
            <TextArea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} className="text-[14px]" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
              {files.length ? `${files.length} bild${files.length > 1 ? 'er' : ''} valda` : 'Bifoga bild'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <Button className="h-10 flex-1 text-[14px]" disabled={busy} onClick={() => report('done')}>
              Arbetet är utfört
            </Button>
            {v.status !== 'in_progress' && (
              <Button variant="secondary" className="h-10 text-[14px]" disabled={busy} onClick={() => report('started')}>
                Påbörjat
              </Button>
            )}
            <Button variant="secondary" className="h-10 text-[14px]" disabled={busy || (!body.trim() && !files.length)} onClick={() => report('comment')}>
              Skicka meddelande
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="mt-4 p-5 text-[13.5px] text-ink-2">Arbetsordern är avslutad. Tack!</Card>
      )}
    </PublicFrame>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
