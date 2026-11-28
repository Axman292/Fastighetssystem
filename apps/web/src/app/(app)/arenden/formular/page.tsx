'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td } from '@/components/ui';
import { TextArea, useWorkOrderOptions } from '@/components/work-order-form';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface FormRow {
  propertyId: string;
  propertyName: string;
  designation: string;
  companyName: string;
  formId: string | null;
  token: string | null;
  enabled: boolean;
  defaultAssigneeUserId: string | null;
  defaultAssigneeName: string | null;
  reportCount: number;
  url: string | null;
}

interface Settings {
  notifyEmails: string | null;
  confirmReporter: boolean;
  formIntro: string | null;
}

export default function FaultFormsPage() {
  const { active, can, version } = useSession();
  const [rows, setRows] = useState<FormRow[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<FormRow | null>(null);
  const opts = useWorkOrderOptions(version);
  const write = !!active && can('work_order.manage');

  const load = useCallback(() => {
    api<FormRow[]>('/work-orders/forms').then(setRows);
    api<Settings | null>('/work-orders/settings').then(setSettings);
  }, []);
  useEffect(load, [load, version]);

  async function save(r: FormRow, body: { enabled: boolean; defaultAssigneeUserId?: string | null }) {
    setError(null);
    try {
      await api(`/work-orders/forms/${r.propertyId}`, { method: 'PUT', body: { defaultAssigneeUserId: r.defaultAssigneeUserId, ...body } });
      load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  return (
    <>
      <div className="mb-2 text-[12.5px] text-ink-3">
        <Link href="/arenden" className="hover:text-ink">
          Felanmälan och ärenden
        </Link>{' '}
        / Formulär och länkar
      </div>
      <PageHeader
        title="Formulär och länkar"
        description="Varje fastighet får en egen länk till felanmälan. Hyresgästen behöver inte logga in. Sätt upp QR-koden i trapphuset eller skicka länken till hyresgästerna."
      />
      <ErrorNote message={error} />
      {!active && <p className="mb-4 text-[13px] text-ink-3">Välj ett bolag för att slå på formulär och ändra inställningar.</p>}

      {rows && (
        <Table head={['Fastighet', ...(active ? [] : ['Bolag']), 'Formulär', 'Ansvarig för nya ärenden', 'Anmälningar', '']} empty="Inga fastigheter.">
          {rows.map((r) => (
            <tr key={r.propertyId}>
              <Td className="font-medium">
                {r.propertyName}
                <div className="text-[12px] font-normal text-ink-3">{r.designation}</div>
              </Td>
              {!active && <Td className="text-ink-2">{r.companyName}</Td>}
              <Td>
                {r.enabled ? <Badge tone="good">På</Badge> : r.token ? <Badge>Avstängt</Badge> : <Badge>Inte skapat</Badge>}
                {r.url && r.enabled && (
                  <a href={r.url} target="_blank" rel="noreferrer" className="ml-2 text-[12px] text-accent hover:underline">
                    Öppna
                  </a>
                )}
              </Td>
              <Td>
                {write ? (
                  <Select
                    className="max-w-[200px]"
                    value={r.defaultAssigneeUserId ?? ''}
                    onChange={(e) => save(r, { enabled: r.enabled, defaultAssigneeUserId: e.target.value || null })}
                    disabled={!r.token}
                  >
                    <option value="">Ingen</option>
                    {opts?.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  (r.defaultAssigneeName ?? '–')
                )}
              </Td>
              <Td className="tabular text-ink-2">{r.reportCount}</Td>
              <Td className="text-right">
                <div className="flex justify-end gap-1.5">
                  {r.url && r.enabled && (
                    <Button size="sm" variant="secondary" onClick={() => setQr(r)}>
                      QR-kod och länk
                    </Button>
                  )}
                  {write && (
                    <Button size="sm" variant={r.enabled ? 'ghost' : 'primary'} onClick={() => save(r, { enabled: !r.enabled })}>
                      {r.enabled ? 'Stäng av' : r.token ? 'Slå på' : 'Skapa formulär'}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {active && settings && <SettingsCard initial={settings} write={write} onSaved={setSettings} />}

      <Dialog open={!!qr} onClose={() => setQr(null)} title={`Felanmälan för ${qr?.propertyName ?? ''}`}>
        {qr?.url && (
          <div className="space-y-4 text-[13px]">
            <div className="flex justify-center rounded-lg bg-on-accent p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/work-orders/forms/${qr.propertyId}/qr?v=${qr.token}`} alt="QR-kod till felanmälan" className="size-56" />
            </div>
            <Field label="Länk">
              <Input readOnly value={qr.url} onFocus={(e) => e.target.select()} />
            </Field>
            <div className="flex flex-wrap justify-between gap-2">
              <a href={`/api/work-orders/forms/${qr.propertyId}/qr?v=${qr.token}`} download={`felanmalan-${qr.propertyName}.png`}>
                <Button variant="secondary">Ladda ned QR-kod</Button>
              </a>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(qr.url!)}>
                  Kopiera länk
                </Button>
                {write && (
                  <Button
                    variant="danger"
                    title="Den gamla länken och QR-koden slutar fungera"
                    onClick={async () => {
                      await api(`/work-orders/forms/${qr.propertyId}/new-link`, { method: 'POST' });
                      setQr(null);
                      load();
                    }}
                  >
                    Ny länk
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[12px] text-ink-3">Gör du en ny länk slutar den gamla länken och QR-koden att fungera, till exempel om länken spridits till fel personer.</p>
          </div>
        )}
      </Dialog>
    </>
  );
}

function SettingsCard({ initial, write, onSaved }: { initial: Settings; write: boolean; onSaved: (s: Settings) => void }) {
  const [notifyEmails, setNotifyEmails] = useState(initial.notifyEmails ?? '');
  const [confirmReporter, setConfirmReporter] = useState(initial.confirmReporter);
  const [formIntro, setFormIntro] = useState(initial.formIntro ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onSaved(await api<Settings>('/work-orders/settings', { method: 'PUT', body: { notifyEmails, confirmReporter, formIntro } }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <div className="mb-3 text-[14px] font-semibold">Inställningar för bolaget</div>
      <form onSubmit={submit} className="max-w-2xl space-y-3">
        <ErrorNote message={error} />
        <Field label="Besked om nya felanmälningar till" hint="E-postadresser åtskilda med komma. Den som är ansvarig för fastighetens formulär får också besked.">
          <Input value={notifyEmails} onChange={(e) => setNotifyEmails(e.target.value)} disabled={!write} placeholder="felanmalan@bolaget.se" />
        </Field>
        <Field label="Text överst i formuläret" hint="T.ex. telefonnummer till jouren vid akuta fel.">
          <TextArea rows={3} value={formIntro} onChange={(e) => setFormIntro(e.target.value)} disabled={!write} maxLength={2000} />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={confirmReporter} onChange={(e) => setConfirmReporter(e.target.checked)} disabled={!write} />
          Skicka kvittens med ärendenummer och statuslänk till den som anmäler
        </label>
        {write && (
          <div className="flex items-center gap-3">
            <Button type="submit">Spara</Button>
            {saved && <span className="text-[13px] text-good">Sparat</span>}
          </div>
        )}
      </form>
    </Card>
  );
}
