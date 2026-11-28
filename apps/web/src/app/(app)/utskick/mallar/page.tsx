'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { MergeText, Toggle } from '@/components/message-parts';
import { Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { BuiltInTemplate, DeliveryConfig, Template } from '@/lib/messages';
import { useSession } from '@/lib/session';

type Draft = { id: string | null; name: string; subject: string; body: string; smsBody: string; active: boolean };

export default function TemplatesPage() {
  const { active, can, version } = useSession();
  const [data, setData] = useState<{ builtIn: BuiltInTemplate[]; own: Template[] } | null>(null);
  const [fields, setFields] = useState<DeliveryConfig['fields']>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = !!active && can('message.send');

  const load = useCallback(() => api<{ builtIn: BuiltInTemplate[]; own: Template[] }>('/messages/templates').then(setData), []);
  useEffect(() => {
    load();
    api<DeliveryConfig>('/messages/config').then((c) => setFields(c.fields));
  }, [load, version]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name, subject: draft.subject, body: draft.body, smsBody: draft.smsBody, active: draft.active };
      if (draft.id) await api(`/messages/templates/${draft.id}`, { method: 'PATCH', body });
      else await api('/messages/templates', { method: 'POST', body });
      setDraft(null);
      load();
    } catch (e) {
      const err = e as ApiError;
      setError(err.fields.length ? err.fields.map((f) => f.message).join('. ') : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api(`/messages/templates/${id}`, { method: 'DELETE' });
      setDraft(null);
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const own = (data?.own ?? []).filter((t) => !active || t.companyId === active.companyId);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/utskick" className="hover:text-ink">
          Utskick
        </Link>{' '}
        / Mallar
      </div>
      <PageHeader
        title="Mallar för utskick"
        description="Färdiga texter att utgå från. Klamrar som {namn} och {fastighet} fylls i för varje hyresgäst när du skickar."
        actions={
          editable && (
            <Button onClick={() => setDraft({ id: null, name: '', subject: '', body: 'Hej {namn},\n\n\n\nVänliga hälsningar\n{bolag}', smsBody: '', active: true })}>
              Ny mall
            </Button>
          )
        }
      />

      <h2 className="mb-2 text-[14px] font-semibold">Egna mallar</h2>
      <div className="mb-8">
        <Table head={['Namn', 'Ämnesrad', 'SMS', 'Status', '']} empty={active ? 'Inga egna mallar än. Spara en färdig mall som egen för att ändra den.' : 'Välj ett bolag för att se och ändra bolagets mallar.'}>
          {own.map((t) => (
            <tr key={t.id} className="hover:bg-subtle/50">
              <Td className="font-medium">{t.name}</Td>
              <Td className="max-w-[320px] truncate text-ink-2">{t.subject || '–'}</Td>
              <Td className="text-ink-2">{t.smsBody ? 'Ja' : '–'}</Td>
              <Td>{t.active ? <Badge tone="good">Aktiv</Badge> : <Badge>Inaktiv</Badge>}</Td>
              <Td className="text-right">
                <div className="flex justify-end gap-1">
                  {editable && t.active && (
                    <Link href={`/utskick/ny?mall=${t.id}`}>
                      <Button size="sm" variant="secondary">
                        Använd
                      </Button>
                    </Link>
                  )}
                  {editable && (
                    <Button size="sm" variant="ghost" onClick={() => setDraft({ id: t.id, name: t.name, subject: t.subject, body: t.body, smsBody: t.smsBody, active: t.active })}>
                      Ändra
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      </div>

      <h2 className="mb-2 text-[14px] font-semibold">Färdiga mallar</h2>
      <Table head={['Namn', 'Ämnesrad', '']}>
        {data?.builtIn.map((t) => (
          <tr key={t.key} className="hover:bg-subtle/50">
            <Td className="font-medium">{t.name}</Td>
            <Td className="text-ink-2">{t.subject}</Td>
            <Td className="text-right">
              <div className="flex justify-end gap-1">
                {editable && (
                  <>
                    <Link href={`/utskick/ny?mall=${t.key}`}>
                      <Button size="sm" variant="secondary">
                        Använd
                      </Button>
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setDraft({ id: null, name: t.name, subject: t.subject, body: t.body, smsBody: t.smsBody, active: true })}>
                      Spara som egen
                    </Button>
                  </>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </Table>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Ändra mall' : 'Ny mall'} wide>
        {draft && (
          <div className="space-y-3">
            <Field label="Namn">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Ämnesrad (e-post)">
              <MergeText single value={draft.subject} onChange={(v) => setDraft({ ...draft, subject: v })} fields={fields} />
            </Field>
            <Field label="E-postmeddelande">
              <MergeText value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} fields={fields} rows={8} />
            </Field>
            <Field label="SMS-text (frivilligt)">
              <MergeText value={draft.smsBody} onChange={(v) => setDraft({ ...draft, smsBody: v })} fields={fields} rows={3} />
            </Field>
            {draft.id && <Toggle checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label="Aktiv" hint="Inaktiva mallar syns inte när du gör ett utskick." />}
            <ErrorNote message={error} />
            <div className="flex justify-between gap-2 pt-1">
              <div>
                {draft.id && (
                  <Button variant="danger" onClick={() => remove(draft.id!)} disabled={busy}>
                    Ta bort
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Avbryt
                </Button>
                <Button onClick={save} disabled={busy || !draft.name.trim()}>
                  Spara
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
