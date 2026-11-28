'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, PageHeader, Select, Table, Td, cx, formatDateTime } from '@/components/ui';
import { TextArea, WorkOrderForm } from '@/components/work-order-form';
import { api, ApiError } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { CATEGORY_LABEL, PRIORITY_LABEL, SOURCE_LABEL, STATUS_LABEL, WorkOrderDetail, WorkOrderStatus } from '@/lib/work-orders';

const NEXT: Record<WorkOrderStatus, { status: WorkOrderStatus; label: string; primary?: boolean }[]> = {
  new: [
    { status: 'in_progress', label: 'Påbörja', primary: true },
    { status: 'done', label: 'Åtgärdad' },
    { status: 'cancelled', label: 'Makulera' },
  ],
  assigned: [
    { status: 'in_progress', label: 'Pågår' },
    { status: 'done', label: 'Åtgärdad', primary: true },
    { status: 'waiting', label: 'Väntar' },
  ],
  in_progress: [
    { status: 'done', label: 'Åtgärdad', primary: true },
    { status: 'waiting', label: 'Väntar' },
  ],
  waiting: [
    { status: 'in_progress', label: 'Pågår igen' },
    { status: 'done', label: 'Åtgärdad', primary: true },
  ],
  done: [
    { status: 'closed', label: 'Avsluta', primary: true },
    { status: 'in_progress', label: 'Öppna igen' },
  ],
  closed: [{ status: 'in_progress', label: 'Öppna igen' }],
  cancelled: [{ status: 'new', label: 'Öppna igen' }],
};

const VISIBILITY = {
  internal: { label: 'Intern', tone: 'neutral' as const },
  reporter: { label: 'Till anmälaren', tone: 'accent' as const },
  supplier: { label: 'Till hantverkaren', tone: 'warn' as const },
};

const EVENT_TITLE: Record<string, string> = {
  created: 'Ärendet skapades',
  comment: 'Kommentar',
  status: 'Status',
  priority: 'Prioritet',
  assigned: 'Ansvarig',
  supplier: 'Hantverkare',
  email: 'E-post',
  photo: 'Bilder',
  cost: 'Kostnad',
  updated: 'Ändrat',
  supplier_report: 'Från hantverkaren',
  reporter_comment: 'Från anmälaren',
};

interface Candidate {
  id: string;
  entryNr: number;
  invoiceNr: string;
  supplierName: string;
  invoiceDate: string;
  netOre: number;
  description: string | null;
  sameSupplier: boolean;
  sameProperty: boolean;
}

export default function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const [d, setD] = useState<WorkOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [statusTo, setStatusTo] = useState<WorkOrderStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [linking, setLinking] = useState<Candidate[] | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<WorkOrderDetail>(`/work-orders/${id}`).then(setD).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (!d) return error ? <ErrorNote message={error} /> : null;
  const write = can('work_order.manage', d.companyId);
  const co = d.companyId;
  const call = async (path: string, method: string, body?: unknown) => {
    setError(null);
    try {
      const r = await api<WorkOrderDetail>(`/work-orders/${id}${path}`, { method, body, companyId: co });
      if (r && typeof r === 'object' && 'id' in r) setD(r);
      else load();
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    }
  };

  if (editing) {
    return (
      <>
        <PageHeader title={`Ändra ärende ${d.orderNr}`} description={d.title} />
        <Card className="p-5">
          <WorkOrderForm
            initial={d}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              load();
            }}
          />
        </Card>
      </>
    );
  }

  const st = STATUS_LABEL[d.status];
  const pr = PRIORITY_LABEL[d.priority];
  const costNet = d.costs.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + c.netOre, 0);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of Array.from(files).slice(0, 5)) fd.append('photos', f);
    setError(null);
    const res = await fetch(`/api/work-orders/${id}/photos`, { method: 'POST', body: fd, headers: { 'x-company-id': co }, credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setError(body.message ?? 'Kunde inte spara bilderna');
    else setD(body);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <>
      <div className="mb-2 text-[12.5px] text-ink-3">
        <Link href="/arenden" className="hover:text-ink">
          Felanmälan och ärenden
        </Link>{' '}
        / {d.orderNr}
      </div>
      <PageHeader
        title={d.title}
        description={`Ärende ${d.orderNr} · ${CATEGORY_LABEL[d.category] ?? d.category} · ${SOURCE_LABEL[d.source] ?? d.source} ${formatDateTime(d.createdAt)}${d.createdByName ? ` av ${d.createdByName}` : d.reporterName ? ` av ${d.reporterName}` : ''}`}
        actions={
          write ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Ändra
              </Button>
              {NEXT[d.status].map((n) => (
                <Button key={n.status} variant={n.primary ? 'primary' : 'secondary'} onClick={() => setStatusTo(n.status)}>
                  {n.label}
                </Button>
              ))}
            </>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge tone={st.tone}>{st.label}</Badge>
        <Badge tone={pr.tone}>Prioritet {pr.label.toLowerCase()}</Badge>
        {d.overdue && <Badge tone="bad">Försenad, skulle vara klar {d.dueDate}</Badge>}
        {d.chargeable && <Badge tone="warn">Debiteras hyresgästen</Badge>}
        {d.anonymizedAt && <Badge>Anmälarens uppgifter gallrade</Badge>}
      </div>
      <ErrorNote message={error} />

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_320px] gap-5">
        <div className="space-y-5">
          <Card className="p-5">
            <div className="text-[12px] font-medium text-ink-3">Beskrivning</div>
            <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed">{d.description || <span className="text-ink-3">Ingen beskrivning.</span>}</p>
            {d.resolution && (
              <>
                <div className="mt-4 text-[12px] font-medium text-ink-3">Åtgärd</div>
                <p className="mt-1.5 whitespace-pre-wrap text-[13.5px]">{d.resolution}</p>
              </>
            )}
            <div className="mt-5 flex items-center justify-between">
              <div className="text-[12px] font-medium text-ink-3">Bilder {d.photos.length ? `(${d.photos.length})` : ''}</div>
              {write && (
                <>
                  <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
                  <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
                    Lägg till bild
                  </Button>
                </>
              )}
            </div>
            {d.photos.length > 0 ? (
              <div className="mt-2 grid grid-cols-4 gap-2">
                {d.photos.map((p) => (
                  <button
                    key={p.id}
                    className="group relative aspect-square overflow-hidden rounded-md bg-subtle"
                    onClick={() => setPhoto(p.id)}
                    title={`${p.fileName}${p.description ? ` · ${p.description}` : ''}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/work-orders/${id}/photos/${p.id}`} alt={p.fileName} className="size-full object-cover" />
                    {p.description && <span className="absolute inset-x-0 bottom-0 truncate bg-surface/90 px-1.5 py-0.5 text-[11px] text-ink-2">{p.description}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[13px] text-ink-3">Inga bilder.</p>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 text-[13px] font-semibold">Händelser och kommentarer</div>
            <ol className="space-y-3">
              {d.events.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span
                    className={cx(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      e.kind === 'comment' || e.kind === 'reporter_comment' || e.kind === 'supplier_report' ? 'bg-accent' : 'bg-line-strong',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                      <span className="font-medium text-ink-2">{EVENT_TITLE[e.kind] ?? e.kind}</span>
                      {e.author && <span>· {e.author}</span>}
                      <span>· {formatDateTime(e.createdAt)}</span>
                      {(e.kind === 'comment' || e.visibility !== 'internal') && <Badge tone={VISIBILITY[e.visibility].tone}>{VISIBILITY[e.visibility].label}</Badge>}
                    </div>
                    {e.body && <div className={cx('mt-0.5 whitespace-pre-wrap text-[13px]', e.kind === 'email' && 'text-ink-2')}>{e.body}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {write && <CommentBox hasReporterEmail={!!d.reporterEmail} hasSupplier={!!d.supplierToken} onSend={(body, visibility) => call('/comments', 'POST', { body, visibility })} />}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <Info label="Fastighet">
              {d.propertyName}
              <div className="text-[12px] text-ink-3">
                {[d.addressLine, [d.postalCode, d.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
              </div>
            </Info>
            <Info label="Objekt">
              {d.objectNr ? (
                <>
                  {d.objectNr}
                  {d.apartmentNr ? ` · lgh ${d.apartmentNr}` : ''}
                  {d.floor !== null ? ` · vån ${d.floor}` : ''}
                </>
              ) : (
                'Gemensamt utrymme'
              )}
              {d.location && <div className="text-[12px] text-ink-3">{d.location}</div>}
            </Info>
            <Info label="Hyresgäst">
              {d.customerId ? (
                <Link href={`/kunder/${d.customerId}`} className="text-accent hover:underline">
                  {d.customerName}
                </Link>
              ) : (
                <span className="text-ink-3">Inte kopplad</span>
              )}
            </Info>
            <Info label="Anmälare">
              {d.reporterName || d.reporterPhone || d.reporterEmail ? (
                <>
                  {d.reporterName}
                  {d.reporterPhone && <div className="text-[12px]"><a href={`tel:${d.reporterPhone}`} className="text-accent">{d.reporterPhone}</a></div>}
                  {d.reporterEmail && <div className="truncate text-[12px]"><a href={`mailto:${d.reporterEmail}`} className="text-accent">{d.reporterEmail}</a></div>}
                </>
              ) : (
                <span className="text-ink-3">–</span>
              )}
              <div className="mt-1 text-[12px] text-ink-3">
                {d.masterKeyOk ? 'Huvudnyckel får användas' : 'Kontakta innan tillträde'}
                {d.accessNote ? `. ${d.accessNote}` : ''}
              </div>
            </Info>
            {d.statusUrl && (
              <Info label="Anmälarens statussida">
                <CopyLink url={d.statusUrl} />
              </Info>
            )}
          </Card>

          <Card className="p-4">
            <Info label="Ansvarig">{d.assigneeName ?? <span className="text-ink-3">Ingen</span>}</Info>
            <Info label="Klart senast">
              <span className={d.overdue ? 'text-bad' : undefined}>{d.dueDate ?? '–'}</span>
              {d.scheduledDate && <div className="text-[12px] text-ink-3">Planerat {d.scheduledDate}</div>}
            </Info>
            <Info label="Hantverkare">
              {d.supplierId ? (
                <>
                  <Link href={`/leverantorer/${d.supplierId}`} className="text-accent hover:underline">
                    {d.supplierName}
                  </Link>
                  <div className="text-[12px] text-ink-3">{[d.supplierPhone, d.supplierEmail].filter(Boolean).join(' · ') || 'Saknar kontaktuppgifter'}</div>
                  {d.sentToSupplierAt && <div className="text-[12px] text-ink-3">Arbetsorder skickad {formatDateTime(d.sentToSupplierAt)}</div>}
                </>
              ) : (
                <span className="text-ink-3">Ingen vald</span>
              )}
            </Info>
            {write && d.supplierId && !['closed', 'cancelled'].includes(d.status) && (
              <Button className="mt-1 w-full" variant={d.sentToSupplierAt ? 'secondary' : 'primary'} onClick={() => setSending(true)}>
                {d.sentToSupplierAt ? 'Skicka arbetsordern igen' : 'Skicka arbetsorder'}
              </Button>
            )}
            {write && !d.supplierId && (
              <Button className="mt-1 w-full" variant="secondary" onClick={() => setEditing(true)}>
                Välj hantverkare
              </Button>
            )}
            {d.supplierUrl && (
              <div className="mt-3">
                <div className="text-[12px] text-ink-3">Hantverkarens länk</div>
                <CopyLink url={d.supplierUrl} />
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium text-ink-3">Kostnader</div>
              {write && (
                <Button size="sm" variant="ghost" onClick={() => api<Candidate[]>(`/work-orders/${id}/cost-candidates`).then(setLinking)}>
                  Koppla faktura
                </Button>
              )}
            </div>
            {d.costEstimateOre ? <div className="mt-1 text-[12px] text-ink-3">Kostnadsram {fmtOre(d.costEstimateOre)} exkl. moms</div> : null}
            {d.costs.length ? (
              <div className="mt-2 space-y-1.5">
                {d.costs.map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-2 text-[13px]">
                    <Link href={`/leverantorsfakturor/${c.supplierInvoiceId}`} className="min-w-0 hover:text-accent">
                      <div className="truncate">{c.supplierName}</div>
                      <div className="text-[12px] text-ink-3">
                        Nr {c.entryNr} · {c.invoiceNr} · {c.invoiceDate}
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="tabular">{fmtOre(c.netOre)}</span>
                      {write && (
                        <button className="rounded px-1 text-ink-3 hover:text-bad" title="Koppla bort" onClick={() => call(`/costs/${c.id}`, 'DELETE')}>
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="flex justify-between border-t border-line pt-1.5 text-[13px] font-medium">
                  <span>Summa exkl. moms</span>
                  <span className={cx('tabular', d.costEstimateOre && costNet > d.costEstimateOre ? 'text-bad' : undefined)}>{fmtOre(costNet)}</span>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-[13px] text-ink-3">Inga leverantörsfakturor kopplade.</p>
            )}
            {d.chargeable && d.customerId && (
              <p className="mt-2 text-[12px] text-ink-3">
                Lägg kostnaden som extra debitering på hyresgästens avtal, så kommer den med på nästa avi.
              </p>
            )}
          </Card>
        </div>
      </div>

      {statusTo && (
        <StatusDialog
          d={d}
          to={statusTo}
          onClose={() => setStatusTo(null)}
          onSave={async (body) => {
            if (await call('/status', 'POST', { status: statusTo, ...body })) setStatusTo(null);
          }}
        />
      )}

      <SendDialog
        open={sending}
        d={d}
        onClose={() => setSending(false)}
        onSend={async (body) => {
          if (await call('/send-to-supplier', 'POST', body)) setSending(false);
        }}
      />

      <Dialog open={!!linking} onClose={() => setLinking(null)} title="Koppla leverantörsfaktura" wide>
        {linking && linking.length === 0 && <p className="text-[13px] text-ink-3">Inga leverantörsfakturor från det senaste året att koppla.</p>}
        {linking && linking.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table head={['Nr', 'Leverantör', 'Fakturadatum', <span key="b" className="text-right">Belopp exkl. moms</span>, '']} sortable={false}>
              {linking.map((c) => (
                <tr key={c.id}>
                  <Td className="tabular text-ink-3">{c.entryNr}</Td>
                  <Td>
                    {c.supplierName}
                    <div className="text-[12px] text-ink-3">
                      {c.invoiceNr}
                      {c.sameSupplier ? ' · ärendets hantverkare' : ''}
                      {c.sameProperty ? ' · konterad på fastigheten' : ''}
                    </div>
                  </Td>
                  <Td className="tabular text-ink-2">{c.invoiceDate}</Td>
                  <Td className="text-right tabular">{fmtOre(c.netOre)}</Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (await call('/costs', 'POST', { supplierInvoiceId: c.id })) setLinking(null);
                      }}
                    >
                      Koppla
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Dialog>

      <Dialog open={!!photo} onClose={() => setPhoto(null)} title="Bild" wide>
        {photo && (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/work-orders/${id}/photos/${photo}`} alt="" className="max-h-[70vh] w-full rounded-md object-contain" />
            <div className="flex justify-between">
              <a href={`/api/work-orders/${id}/photos/${photo}`} target="_blank" rel="noreferrer">
                <Button variant="secondary">Öppna i full storlek</Button>
              </a>
              {write && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (await call(`/photos/${photo}`, 'DELETE')) setPhoto(null);
                  }}
                >
                  Ta bort bilden
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[13px]">{children}</div>
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[12px] text-accent hover:underline">
        {url.replace(/^https?:\/\//, '')}
      </a>
      <button
        className="shrink-0 rounded px-1.5 text-[12px] text-ink-3 hover:bg-subtle hover:text-ink"
        onClick={() => {
          navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Kopierad' : 'Kopiera'}
      </button>
    </div>
  );
}

function CommentBox({
  hasReporterEmail,
  hasSupplier,
  onSend,
}: {
  hasReporterEmail: boolean;
  hasSupplier: boolean;
  onSend: (body: string, visibility: 'internal' | 'reporter' | 'supplier') => Promise<boolean>;
}) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'reporter' | 'supplier'>('internal');
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-5 space-y-2 border-t border-line pt-4">
      <TextArea rows={3} placeholder="Skriv en kommentar" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-2">
        <Select className="max-w-[260px]" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
          <option value="internal">Intern, syns bara för personalen</option>
          <option value="reporter">Till anmälaren{hasReporterEmail ? ' (skickas med e-post)' : ''}</option>
          <option value="supplier">Till hantverkaren{hasSupplier ? ' (skickas med e-post)' : ''}</option>
        </Select>
        <Button
          className="ml-auto"
          disabled={busy || !body.trim()}
          onClick={async () => {
            setBusy(true);
            if (await onSend(body, visibility)) setBody('');
            setBusy(false);
          }}
        >
          Spara kommentar
        </Button>
      </div>
    </div>
  );
}

function StatusDialog({
  d,
  to,
  onClose,
  onSave,
}: {
  d: WorkOrderDetail;
  to: WorkOrderStatus;
  onClose: () => void;
  onSave: (body: { message: string; resolution?: string; notifyReporter: boolean }) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [resolution, setResolution] = useState(d.resolution ?? '');
  const [notify, setNotify] = useState(d.notifyReporter && !!d.reporterEmail);
  const tellsReporter = ['in_progress', 'done', 'cancelled'].includes(to) && !!d.reporterEmail && d.notifyReporter;
  return (
    <Dialog open onClose={onClose} title={`Ändra status till ${STATUS_LABEL[to].label.toLowerCase()}`}>
      <div className="space-y-3">
        {(to === 'done' || to === 'closed') && (
          <Field label="Vad gjordes?">
            <TextArea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="T.ex. bytt packning i blandaren" />
          </Field>
        )}
        <Field label="Meddelande till anmälaren (frivilligt)">
          <TextArea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        {tellsReporter && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Skicka besked till {d.reporterEmail}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button onClick={() => onSave({ message, resolution: resolution || undefined, notifyReporter: notify })}>Spara</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SendDialog({
  open,
  d,
  onClose,
  onSend,
}: {
  open: boolean;
  d: WorkOrderDetail;
  onClose: () => void;
  onSend: (body: { message: string; includePhotos: boolean }) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [photos, setPhotos] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={`Skicka arbetsorder till ${d.supplierName ?? 'hantverkaren'}`}>
      <div className="space-y-3 text-[13px]">
        {d.supplierEmail ? (
          <p className="text-ink-2">
            Arbetsordern skickas till <b>{d.supplierEmail}</b> med beskrivning, adress, objekt, kontaktuppgifter till anmälaren och om huvudnyckel får användas.
            Hantverkaren får en länk där de kan se bilderna och kvittera när arbetet är utfört.
          </p>
        ) : (
          <ErrorNote message={`${d.supplierName} har ingen e-postadress. Lägg till den i leverantörsregistret först.`} />
        )}
        <Field label="Meddelande (frivilligt)">
          <TextArea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="T.ex. Ring hyresgästen innan ni kommer." />
        </Field>
        {d.photos.length > 0 && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={photos} onChange={(e) => setPhotos(e.target.checked)} />
            Bifoga {d.photos.length} bild{d.photos.length > 1 ? 'er' : ''}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            disabled={busy || !d.supplierEmail}
            onClick={async () => {
              setBusy(true);
              await onSend({ message, includePhotos: photos });
              setBusy(false);
            }}
          >
            Skicka
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
