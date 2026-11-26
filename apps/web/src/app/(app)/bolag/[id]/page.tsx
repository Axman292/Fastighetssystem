'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState, FormEvent } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Table, Td, formatDateTime } from '@/components/ui';
import { api, ApiError, AuditRow, BankAccount, Company, CostCenter } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EditForm, SectionHeader } from '@/components/edit-form';
import type { FieldDef as FormFieldDef } from '@/components/form';

const invoiceSettingsFields: FormFieldDef[] = [
  { key: 'invoiceEmail', label: 'E-post för fakturor', half: true, hint: 'Avsändare och svarsadress för avier' },
  { key: 'invoiceFooter', label: 'Text längst ned på fakturan', half: true },
  { key: 'fTax', label: 'Godkänd för F-skatt', type: 'checkbox' },
  { key: 'roundToKrona', label: 'Avrunda fakturor till hela kronor', type: 'checkbox' },
];

const reminderSettingsFields: FormFieldDef[] = [
  { key: 'reminderFee', label: 'Påminnelseavgift', type: 'kronor', half: true, required: true, hint: 'Högst 60 kr. Tas ut en gång per faktura, om det avtalats i förväg.' },
  { key: 'lateInterestRate', label: 'Dröjsmålsränta (% per år)', type: 'number', half: true, required: true, hint: 'Referensräntan plus 8 procentenheter enligt räntelagen' },
  { key: 'reminderGraceDays', label: 'Dagar efter förfallodagen innan påminnelse', type: 'number', half: true, required: true },
  { key: 'reminderDueDays', label: 'Ny betalningsfrist på påminnelsen (dagar)', type: 'number', half: true, required: true },
];

const purposes: Record<string, string> = {
  rent: 'Hyresinbetalningar',
  operations: 'Drift',
  loan: 'Lån',
  deposit: 'Depositioner',
  other: 'Övrigt',
};

const months = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const [company, setCompany] = useState<Company | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Company>(`/companies/${id}`).then(setCompany).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!company) return null;

  const editable = can('company.write', id);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/bolag" className="hover:text-ink">
          Bolag
        </Link>{' '}
        / {company.name}
      </div>
      <PageHeader title={company.name} description={`Org.nr ${company.orgNr}`} actions={company.active ? <Badge tone="good">Aktivt</Badge> : <Badge>Inaktivt</Badge>} />
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="space-y-8">
          <CompanyForm company={company} editable={editable} onSaved={setCompany} />
          <section>
            <SectionHeader title="Fakturering" description="Uppgifter som visas på hyresavier och fakturor." />
            <EditForm
              key={company.updatedAt}
              fields={invoiceSettingsFields}
              row={company as unknown as Record<string, unknown>}
              editable={editable}
              save={async (body) => setCompany(await api<Company>(`/companies/${id}`, { method: 'PATCH', body }))}
            />
          </section>
          <section>
            <SectionHeader title="Påminnelser" description="Hur förfallna fakturor påminns." />
            <EditForm
              key={`r-${company.updatedAt}`}
              fields={reminderSettingsFields}
              row={{ ...company, reminderFee: company.reminderFeeOre, lateInterestRate: company.lateInterestBp / 100 } as unknown as Record<string, unknown>}
              editable={editable}
              save={async (body) => setCompany(await api<Company>(`/companies/${id}`, { method: 'PATCH', body }))}
            />
          </section>
          <BankAccounts companyId={id} editable={can('bank_account.write', id)} />
          <CostCenters companyId={id} editable={can('cost_center.write', id)} />
        </div>
        <History companyId={id} canRead={can('audit.read', id)} version={company.updatedAt} />
      </div>
    </>
  );
}

function CompanyForm({ company, editable, onSaved }: { company: Company; editable: boolean; onSaved: (c: Company) => void }) {
  const [form, setForm] = useState(company);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(company), [company]);

  const set = (k: keyof Company) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm({ ...form, [k]: k === 'fiscalYearStart' ? Number(e.target.value) : e.target.value });
  };
  const fe = (p: string) => error?.fields.find((f) => f.path === p)?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { name, orgNr, vatNr, addressLine, postalCode, city, bankgiro, plusgiro, fiscalYearStart, hogiaClientId } = form;
      const c = await api<Company>(`/companies/${company.id}`, {
        method: 'PATCH',
        body: { name, orgNr, vatNr, addressLine, postalCode, city, bankgiro, plusgiro, fiscalYearStart, hogiaClientId },
      });
      onSaved(c);
      setSaved(true);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold">Uppgifter</h2>
      <Card className="p-5">
        <form onSubmit={submit}>
          <fieldset disabled={!editable} className="grid grid-cols-2 gap-x-4 gap-y-3.5">
            <Field label="Namn" error={fe('name')}>
              <Input value={form.name} onChange={set('name')} />
            </Field>
            <Field label="Organisationsnummer" error={fe('orgNr')}>
              <Input value={form.orgNr} onChange={set('orgNr')} />
            </Field>
            <Field label="Momsregistreringsnummer">
              <Input value={form.vatNr ?? ''} onChange={set('vatNr')} placeholder="SE556000000001" />
            </Field>
            <Field label="Räkenskapsår börjar">
              <Select value={form.fiscalYearStart} onChange={set('fiscalYearStart')}>
                {months.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2">
              <Field label="Adress">
                <Input value={form.addressLine ?? ''} onChange={set('addressLine')} />
              </Field>
            </div>
            <Field label="Postnummer">
              <Input value={form.postalCode ?? ''} onChange={set('postalCode')} />
            </Field>
            <Field label="Ort">
              <Input value={form.city ?? ''} onChange={set('city')} />
            </Field>
            <Field label="Bankgiro">
              <Input value={form.bankgiro ?? ''} onChange={set('bankgiro')} placeholder="123-4567" />
            </Field>
            <Field label="Plusgiro">
              <Input value={form.plusgiro ?? ''} onChange={set('plusgiro')} />
            </Field>
            <Field label="Klient-id i Hogia" hint="Används av Hogia-integrationen.">
              <Input value={form.hogiaClientId ?? ''} onChange={set('hogiaClientId')} />
            </Field>
          </fieldset>
          {editable && (
            <div className="mt-5 flex items-center justify-end gap-3">
              {saved && <span className="text-[12px] text-good">Sparat</span>}
              {error && !error.fields.length && <ErrorNote message={error.message} />}
              <Button type="submit" disabled={busy}>
                Spara
              </Button>
            </div>
          )}
        </form>
      </Card>
    </section>
  );
}

function BankAccounts({ companyId, editable }: { companyId: string; editable: boolean }) {
  const [rows, setRows] = useState<BankAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api<BankAccount[]>('/bank-accounts', { companyId }).then(setRows);
  }, [companyId]);
  useEffect(load, [load]);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Bankkonton</h2>
        {editable && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Lägg till
          </Button>
        )}
      </div>
      <Table head={['Syfte', 'Bank', 'Clearing', 'Kontonummer', 'IBAN', '']} empty="Inga bankkonton ännu.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{purposes[r.purpose] ?? r.purpose}</Td>
            <Td className="text-ink-2">{r.bankName ?? '–'}</Td>
            <Td className="tabular text-ink-2">{r.clearingNr ?? '–'}</Td>
            <Td className="tabular text-ink-2">{r.accountNr ?? '–'}</Td>
            <Td className="tabular text-ink-2">{r.iban ?? '–'}</Td>
            <Td className="text-right">
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/bank-accounts/${r.id}`, { method: 'DELETE', companyId });
                    load();
                  }}
                >
                  Ta bort
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <SimpleForm
        open={adding}
        title="Nytt bankkonto"
        onClose={() => setAdding(false)}
        fields={[
          { key: 'purpose', label: 'Syfte', options: purposes },
          { key: 'bankName', label: 'Bank' },
          { key: 'clearingNr', label: 'Clearingnummer' },
          { key: 'accountNr', label: 'Kontonummer' },
          { key: 'iban', label: 'IBAN' },
        ]}
        submit={(body) => api('/bank-accounts', { method: 'POST', body, companyId })}
        onDone={() => {
          setAdding(false);
          load();
        }}
      />
    </section>
  );
}

function CostCenters({ companyId, editable }: { companyId: string; editable: boolean }) {
  const [rows, setRows] = useState<CostCenter[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api<CostCenter[]>('/cost-centers', { companyId }).then(setRows);
  }, [companyId]);
  useEffect(load, [load]);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">Kostnadsställen</h2>
          <p className="text-[12px] text-ink-3">Synkas från Hogia när integrationen är på plats.</p>
        </div>
        {editable && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Lägg till
          </Button>
        )}
      </div>
      <Table head={['Kod', 'Namn', 'Status']} empty="Inga kostnadsställen ännu.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="tabular font-medium">{r.code}</Td>
            <Td>{r.name}</Td>
            <Td>{r.active ? <Badge tone="good">Aktivt</Badge> : <Badge>Inaktivt</Badge>}</Td>
          </tr>
        ))}
      </Table>
      <SimpleForm
        open={adding}
        title="Nytt kostnadsställe"
        onClose={() => setAdding(false)}
        fields={[
          { key: 'code', label: 'Kod' },
          { key: 'name', label: 'Namn' },
        ]}
        submit={(body) => api('/cost-centers', { method: 'POST', body, companyId })}
        onDone={() => {
          setAdding(false);
          load();
        }}
      />
    </section>
  );
}

const tableNames: Record<string, string> = {
  company: 'Bolag',
  bank_account: 'Bankkonto',
  cost_center: 'Kostnadsställe',
  membership: 'Behörighet',
  app_user: 'Användare',
};
const actions: Record<string, string> = { insert: 'skapade', update: 'ändrade', delete: 'tog bort' };

function History({ companyId, canRead, version }: { companyId: string; canRead: boolean; version: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    if (canRead) api<AuditRow[]>('/audit-log', { companyId }).then((r) => setRows(r.slice(0, 15)));
  }, [companyId, canRead, version]);
  if (!canRead) return null;
  return (
    <aside>
      <h2 className="mb-3 text-[14px] font-semibold">Senaste händelser</h2>
      <ol className="space-y-3 border-l border-line pl-4">
        {rows.map((r) => (
          <li key={r.id} className="text-[12.5px]">
            <div>
              <span className="font-medium">{r.userName ?? 'System'}</span> {actions[r.action] ?? r.action}{' '}
              {(tableNames[r.tableName] ?? r.tableName).toLowerCase()}
            </div>
            <div className="text-[11.5px] text-ink-3">{formatDateTime(r.occurredAt)}</div>
          </li>
        ))}
        {rows.length === 0 && <li className="text-[12.5px] text-ink-3">Inga händelser ännu.</li>}
      </ol>
    </aside>
  );
}

type FieldDef = { key: string; label: string; options?: Record<string, string> };

function SimpleForm({
  open,
  title,
  fields,
  onClose,
  submit,
  onDone,
}: {
  open: boolean;
  title: string;
  fields: FieldDef[];
  onClose: () => void;
  submit: (body: Record<string, string | null>) => Promise<unknown>;
  onDone: () => void;
}) {
  const initial = () => Object.fromEntries(fields.map((f) => [f.key, f.options ? Object.keys(f.options)[0] : '']));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await submit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])));
      setValues(initial());
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form onSubmit={onSubmit} className="space-y-4">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} error={error?.fields.find((x) => x.path === f.key)?.message}>
            {f.options ? (
              <Select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                {Object.entries(f.options).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit">Spara</Button>
        </div>
      </form>
    </Dialog>
  );
}
