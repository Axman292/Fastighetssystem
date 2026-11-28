'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { CheckList, Chip, MergeText, MessageBubble, Step, Toggle } from '@/components/message-parts';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Td, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { CONTRACT_TYPE_LABEL, OBJECT_TYPE_LABEL } from '@/lib/format';
import { BuiltInTemplate, CONTRACT_STATUS_LABEL, Content, Preview, PreviewRecipient, Template, channelsLabel } from '@/lib/messages';
import { useSession } from '@/lib/session';

const PRESETS: { label: string; types: string[] }[] = [
  { label: 'Alla', types: [] },
  { label: 'Bostäder', types: ['apartment', 'hotel_apartment'] },
  { label: 'Lokaler', types: ['commercial', 'office', 'restaurant'] },
  { label: 'Parkering och förråd', types: ['parking', 'storage'] },
];

export default function NewMessagePage() {
  return (
    <Suspense>
      <NewMessage />
    </Suspense>
  );
}

function NewMessage() {
  const router = useRouter();
  const params = useSearchParams();
  const { active, can, version, me } = useSession();
  const [properties, setProperties] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<{ builtIn: BuiltInTemplate[]; own: Template[] }>({ builtIn: [], own: [] });

  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  const [content, setContent] = useState<Content>({ sendEmail: true, sendSms: false, subject: '', body: '', smsBody: '' });
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [objectTypes, setObjectTypes] = useState<string[]>([]);
  const [contractTypes, setContractTypes] = useState<string[]>([]);
  const [contractStatuses, setContractStatuses] = useState<string[]>(['current', 'notice']);
  const [includeContacts, setIncludeContacts] = useState(false);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [shownId, setShownId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'missing'>('all');
  const [confirm, setConfirm] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ id: string; name: string }[]>('/properties').then(setProperties);
    api<{ builtIn: BuiltInTemplate[]; own: Template[] }>('/messages/templates').then(setTemplates);
    setPropertyIds([]);
  }, [version]);

  // Förvald mall eller fastighet från länken, till exempel ?mall=vatten eller ?fastighet=<id>
  useEffect(() => {
    const p = params.get('fastighet');
    if (p) setPropertyIds([p]);
  }, [params]);
  useEffect(() => {
    const m = params.get('mall');
    if (m && !templateId && (templates.builtIn.length || templates.own.length)) chooseTemplate(m.includes('-') ? m : `builtin:${m}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, templates]);

  function chooseTemplate(key: string) {
    setTemplateId(key);
    const t = key.startsWith('builtin:') ? templates.builtIn.find((b) => `builtin:${b.key}` === key) : templates.own.find((o) => o.id === key);
    if (!t) return;
    setContent((c) => ({ ...c, subject: t.subject, body: t.body, smsBody: t.smsBody, sendSms: c.sendSms || (!t.body && !!t.smsBody) }));
    if (!name.trim()) setName(`${t.name} ${new Date().toLocaleDateString('sv-SE')}`);
  }

  const criteria = useMemo(
    () => ({ propertyIds, objectTypes, contractTypes, contractStatuses, includeContacts }),
    [propertyIds, objectTypes, contractTypes, contractStatuses, includeContacts],
  );

  // Förhandsgranskningen räknas om när urval eller text ändras.
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    const t = setTimeout(() => {
      api<Preview>('/messages/preview', { method: 'POST', body: { criteria, content } })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => setPreviewError((e as ApiError).message))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [criteria, content, active, version]);

  // Bortval gäller bara för det urval de gjordes i.
  useEffect(() => setExcluded(new Set()), [criteria]);

  const rows = preview?.recipients ?? [];
  const chosen = rows.filter((r) => !excluded.has(r.customerId));
  const reach = (r: PreviewRecipient, ch: 'email' | 'sms') => r.deliveries.filter((d) => d.channel === ch && !d.skip).length;
  const chosenEmails = chosen.reduce((s, r) => s + reach(r, 'email'), 0);
  const chosenSms = chosen.reduce((s, r) => s + reach(r, 'sms'), 0);
  const unreachable = chosen.filter((r) => r.deliveries.every((d) => d.skip)).length;
  const shownRows = filter === 'all' ? rows : rows.filter((r) => r.deliveries.some((d) => d.skip));
  const shown = rows.find((r) => r.customerId === shownId) ?? chosen[0] ?? rows[0] ?? null;
  const allChecked = rows.length > 0 && rows.every((r) => !excluded.has(r.customerId));
  const parts = preview?.summary.smsParts;
  const fields = preview?.config.fields ?? [];
  const testMode = preview && ((content.sendEmail && preview.config.email === 'test') || (content.sendSms && preview.config.sms === 'test'));
  const canSend = !!preview && !preview.issues.length && chosenEmails + chosenSms > 0 && !!name.trim() && !loading;

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>('/messages', {
        method: 'POST',
        body: {
          name,
          criteria,
          content,
          templateId: templateId && !templateId.startsWith('builtin:') ? templateId : null,
          excludeCustomerIds: [...excluded],
        },
      });
      router.push(`/utskick/${r.id}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  }

  if (!active || !can('message.send')) {
    return (
      <>
        <PageHeader title="Nytt utskick" />
        <p className="text-[13px] text-ink-2">Välj ett bolag i menyn till vänster. Ett utskick görs för ett bolag i taget.</p>
      </>
    );
  }

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/utskick" className="hover:text-ink">
          Utskick
        </Link>{' '}
        / Nytt
      </div>
      <PageHeader
        title="Nytt utskick"
        description={`Skicka e-post eller SMS till hyresgästerna i ${active.companyName}. Välj vilka som ska få det, skriv texten och granska innan du skickar.`}
      />

      <div className="grid grid-cols-[320px_1fr] items-start gap-6">
        <Card className="space-y-4 p-4">
          <Step n={1} title="Mottagare">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Vilka hyresgäster</div>
              <CheckList options={CONTRACT_STATUS_LABEL} selected={contractStatuses} onChange={setContractStatuses} allLabel="Alla med avtal" />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Fastigheter</div>
              <CheckList
                options={Object.fromEntries(properties.map((p) => [p.id, p.name]))}
                selected={propertyIds}
                onChange={setPropertyIds}
                allLabel="Alla fastigheter"
              />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Objekttyper</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <Chip key={p.label} active={sameSet(objectTypes, p.types)} onClick={() => setObjectTypes(p.types)}>
                    {p.label}
                  </Chip>
                ))}
              </div>
              <CheckList options={OBJECT_TYPE_LABEL} selected={objectTypes} onChange={setObjectTypes} allLabel="Alla objekttyper" />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Avtalstyper</div>
              <CheckList options={CONTRACT_TYPE_LABEL} selected={contractTypes} onChange={setContractTypes} allLabel="Alla avtalstyper" />
            </div>
            <Toggle
              checked={includeContacts}
              onChange={setIncludeContacts}
              label="Skicka också till kontaktpersoner"
              hint="Till exempel kontaktpersonen hos ett företag som hyr en lokal."
            />
          </Step>
          <Step n={2} title="Skicka som">
            <Toggle checked={content.sendEmail} onChange={(v) => setContent({ ...content, sendEmail: v })} label="E-post" />
            <Toggle checked={content.sendSms} onChange={(v) => setContent({ ...content, sendSms: v })} label="SMS" hint="Bra för korta, brådskande besked." />
          </Step>
        </Card>

        <section className="min-w-0 space-y-4">
          <Card className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mall">
                <Select value={templateId} onChange={(e) => chooseTemplate(e.target.value)}>
                  <option value="">Ingen mall, skriv fritt</option>
                  <optgroup label="Färdiga mallar">
                    {templates.builtIn.map((t) => (
                      <option key={t.key} value={`builtin:${t.key}`}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                  {templates.own.filter((t) => t.active && t.companyId === active.companyId).length > 0 && (
                    <optgroup label="Egna mallar">
                      {templates.own
                        .filter((t) => t.active && t.companyId === active.companyId)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </Select>
              </Field>
              <Field label="Namn på utskicket" hint="Syns bara här i systemet">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Vattenavstängning Kornet, december" />
              </Field>
            </div>
            {content.sendEmail && (
              <>
                <Field label="Ämnesrad">
                  <MergeText single value={content.subject} onChange={(v) => setContent({ ...content, subject: v })} fields={fields} />
                </Field>
                <Field label="E-postmeddelande">
                  <MergeText value={content.body} onChange={(v) => setContent({ ...content, body: v })} fields={fields} rows={9} />
                </Field>
              </>
            )}
            {content.sendSms && (
              <Field label="SMS-text">
                <MergeText value={content.smsBody} onChange={(v) => setContent({ ...content, smsBody: v })} fields={fields} rows={3} />
                {parts && parts.parts > 0 && (
                  <p className={cx('mt-1 text-[12px]', parts.parts > 1 ? 'text-warn' : 'text-ink-3')}>
                    {parts.chars} tecken, {parts.parts} {parts.parts === 1 ? 'SMS' : 'SMS-delar'} per mottagare
                    {parts.unicode && ' (specialtecken som emoji gör att färre tecken ryms)'}
                    {parts.parts > 1 && '. Varje del kostar som ett SMS.'}
                  </p>
                )}
              </Field>
            )}
            <p className="text-[12px] text-ink-3">
              Klamrarna fylls i för varje hyresgäst, till exempel blir <span className="font-mono">{'{namn}'}</span> hyresgästens namn och{' '}
              <span className="font-mono">{'{fastighet}'}</span> fastigheten de hyr i. Hakparenteser som [datum] är bara platshållare i mallen och ska bytas ut.
            </p>
            {content.sendEmail && /\[[^\]]+\]/.test(content.subject + content.body) && (
              <div className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Texten innehåller fortfarande platshållare inom [hakparenteser]. Byt ut dem innan du skickar.</div>
            )}
            {content.sendSms && !content.sendEmail && /\[[^\]]+\]/.test(content.smsBody) && (
              <div className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">SMS-texten innehåller fortfarande platshållare inom [hakparenteser].</div>
            )}
          </Card>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="Hyresgäster" value={preview ? chosen.length : '–'} sub={preview && excluded.size ? `${excluded.size} bortvalda` : undefined} />
            <Stat label="E-post" value={preview && content.sendEmail ? chosenEmails : '–'} sub={preview && content.sendEmail ? `${preview.summary.missingEmail} saknar adress` : 'Inte valt'} />
            <Stat label="SMS" value={preview && content.sendSms ? chosenSms : '–'} sub={preview && content.sendSms ? `${preview.summary.missingSms} saknar mobilnummer` : 'Inte valt'} />
          </div>

          {testMode && (
            <div className="rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">
              {content.sendSms && preview?.config.sms === 'test'
                ? 'SMS är inte kopplat ännu. SMS:en sparas i loggen men skickas inte till någon.'
                : 'E-post är inte kopplat. Meddelandena sparas i loggen men skickas inte.'}
            </div>
          )}
          {preview?.config.allowlistOnly && (
            <div className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Testmiljö: bara tillåtna testadresser och testnummer får något. Övriga markeras som testläge.</div>
          )}
          {previewError && <ErrorNote message={previewError} />}
          {preview && preview.issues.length > 0 && <ErrorNote message={preview.issues.join('. ')} />}

          {shown && (content.sendEmail || content.sendSms) && (
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[13px] font-semibold">Så ser det ut för {shown.name}</div>
                <span className="text-[12px] text-ink-3">Klicka på en hyresgäst i listan för att se deras version</span>
              </div>
              <div className={cx('grid gap-4', content.sendEmail && content.sendSms ? 'grid-cols-[1fr_300px]' : 'grid-cols-1')}>
                {content.sendEmail && <MessageBubble channel="email" subject={shown.subject} body={shown.body ?? ''} from={active.companyName} />}
                {content.sendSms && <MessageBubble channel="sms" body={shown.smsBody ?? ''} from="SMS" />}
              </div>
            </Card>
          )}

          {preview && (
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex gap-1">
                  <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
                    Alla {rows.length}
                  </Chip>
                  <Chip active={filter === 'missing'} onClick={() => setFilter('missing')}>
                    Saknar uppgifter {rows.filter((r) => r.deliveries.some((d) => d.skip)).length}
                  </Chip>
                </div>
                <span className="text-[12px] text-ink-3">{loading ? 'Räknar…' : `${chosen.length} av ${rows.length} valda`}</span>
              </div>
              <div className={cx('transition-opacity', loading && 'opacity-60')}>
                <Table
                  head={[
                    <input
                      key="all"
                      type="checkbox"
                      aria-label="Välj alla"
                      className="size-4 accent-[var(--color-accent)]"
                      checked={allChecked}
                      onChange={() => setExcluded(allChecked ? new Set(rows.map((r) => r.customerId)) : new Set())}
                    />,
                    'Hyresgäst',
                    'Hyr',
                    'Skickas till',
                  ]}
                  empty="Inga hyresgäster matchar urvalet."
                >
                  {shownRows.map((r) => {
                    const on = !excluded.has(r.customerId);
                    return (
                      <tr
                        key={r.customerId}
                        className={cx('cursor-pointer hover:bg-subtle/50', !on && 'text-ink-3', shown?.customerId === r.customerId && 'bg-subtle/60')}
                        onClick={() => setShownId(r.customerId)}
                      >
                        <Td className="w-10">
                          <input
                            type="checkbox"
                            aria-label={`Välj ${r.name}`}
                            className="size-4 accent-[var(--color-accent)]"
                            checked={on}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggle(r.customerId)}
                          />
                        </Td>
                        <Td>
                          <span className={cx('font-medium', on && 'text-ink')}>{r.name}</span>
                          <div className="text-[12px] text-ink-3">Kund {r.customerNr}</div>
                        </Td>
                        <Td className="text-ink-2">
                          {r.objects.join(', ')}
                          <div className="text-[12px] text-ink-3">{r.properties.join(', ')}</div>
                        </Td>
                        <Td>
                          <div className="space-y-0.5">
                            {r.deliveries.map((d, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-[12.5px]">
                                <span className="w-12 shrink-0 whitespace-nowrap text-[11.5px] text-ink-3">{d.channel === 'email' ? 'E-post' : 'SMS'}</span>
                                {d.skip ? (
                                  <span className="text-warn">
                                    {d.skip}
                                    {d.recipient && <span className="text-ink-3"> ({d.recipient})</span>}
                                  </span>
                                ) : (
                                  <span className={cx(on ? 'text-ink-2' : 'text-ink-3')}>
                                    {d.recipient}
                                    {d.owner !== r.name && <span className="text-ink-3"> · {d.owner}</span>}
                                    {d.blocked && <span className="text-ink-3"> · testläge</span>}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </Table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Link href="/utskick">
              <Button variant="ghost">Avbryt</Button>
            </Link>
            <Button variant="secondary" disabled={!preview || preview.issues.length > 0} onClick={() => setTestOpen(true)}>
              Skicka prov till mig
            </Button>
            <Button disabled={!canSend} onClick={() => setConfirm(true)}>
              Skicka till {chosen.length} {chosen.length === 1 ? 'hyresgäst' : 'hyresgäster'}
            </Button>
          </div>
          {!name.trim() && preview && rows.length > 0 && <p className="-mt-2 text-right text-[12px] text-ink-3">Ge utskicket ett namn för att kunna skicka.</p>}
        </section>
      </div>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Skicka utskicket">
        <div className="space-y-3 text-[13px]">
          <p className="text-ink-2">
            {channelsLabel(content)} skickas nu till {chosen.length} {chosen.length === 1 ? 'hyresgäst' : 'hyresgäster'}:{' '}
            {[content.sendEmail && `${chosenEmails} e-post`, content.sendSms && `${chosenSms} SMS`].filter(Boolean).join(' och ')}.
          </p>
          {unreachable > 0 && (
            <p className="text-warn">
              {unreachable} {unreachable === 1 ? 'hyresgäst saknar' : 'hyresgäster saknar'} både e-post och mobilnummer och får inget. De syns i loggen så att du kan nå dem på annat sätt.
            </p>
          )}
          {testMode && <p className="text-accent">Testläge: inget når hyresgästerna, men allt sparas i loggen.</p>}
          <p className="text-[12px] text-ink-3">Ett skickat meddelande går inte att ta tillbaka.</p>
          {error && <ErrorNote message={error.fields.length ? error.fields.map((f) => f.message).join('. ') : error.message} />}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Avbryt
            </Button>
            <Button onClick={send} disabled={busy}>
              {busy ? 'Skickar…' : 'Skicka nu'}
            </Button>
          </div>
        </div>
      </Dialog>

      <TestDialog
        open={testOpen}
        onClose={() => setTestOpen(false)}
        defaultEmail={me.user.email}
        body={{ criteria, content, customerId: shown?.customerId ?? null }}
        tenantName={shown?.name ?? null}
        content={content}
      />
    </>
  );
}

function TestDialog({
  open,
  onClose,
  defaultEmail,
  body,
  tenantName,
  content,
}: {
  open: boolean;
  onClose: () => void;
  defaultEmail: string;
  body: Record<string, unknown>;
  tenantName: string | null;
  content: Content;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ channel: string; to: string; status: string; note: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
    }
  }, [open]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ result: { channel: string; to: string; status: string; note: string | null }[] }>('/messages/test', {
        method: 'POST',
        body: { ...body, email, phone },
      });
      setResult(r.result);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Skicka ett prov till dig själv">
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-2">
          Provet får samma text som {tenantName ? <span className="font-medium text-ink">{tenantName}</span> : 'den första hyresgästen'} skulle få, med [Prov] i ämnesraden.
        </p>
        {content.sendEmail && (
          <Field label="Din e-post">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        )}
        {content.sendSms && (
          <Field label="Ditt mobilnummer">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="070-123 45 67" />
          </Field>
        )}
        {result && (
          <div className="space-y-1">
            {result.map((r) => (
              <div key={r.channel} className="flex items-center gap-2">
                <Badge tone={r.status === 'sent' ? 'good' : 'accent'}>{r.status === 'sent' ? 'Skickat' : 'Testläge'}</Badge>
                <span className="text-ink-2">
                  {r.channel === 'email' ? 'E-post' : 'SMS'} till {r.to}
                </span>
              </div>
            ))}
            {result.some((r) => r.status === 'test') && (
              <p className="text-[12px] text-ink-3">{result.find((r) => r.note)?.note ?? 'Utskicket är inte kopplat än, så provet sparades bara.'}</p>
            )}
          </div>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Stäng
          </Button>
          <Button onClick={run} disabled={busy}>
            {busy ? 'Skickar…' : 'Skicka prov'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
