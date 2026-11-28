'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fmtOre, OBJECT_TYPE_LABEL } from '@/lib/format';
import { describeWishes, INTEREST_STATUS, OFFER_STATUS, Registration, Vacancy } from '@/lib/vacancies';
import { Badge, Button, cx, Dialog, ErrorNote, Field, Input, Select } from './ui';

/** Formulärets värden. Tal som text så att fälten kan vara tomma. */
export interface RegistrationValues {
  kind: 'person' | 'organization';
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  addressLine: string;
  postalCode: string;
  city: string;
  objectTypes: string[];
  propertyIds: string[];
  minRooms: string;
  minAreaM2: string;
  maxRent: string;
  desiredFrom: string;
  householdSize: string;
  message: string;
  notes: string;
  status: string;
}

export const EMPTY_REGISTRATION: RegistrationValues = {
  kind: 'person',
  name: '',
  contactPerson: '',
  email: '',
  phone: '',
  addressLine: '',
  postalCode: '',
  city: '',
  objectTypes: [],
  propertyIds: [],
  minRooms: '',
  minAreaM2: '',
  maxRent: '',
  desiredFrom: '',
  householdSize: '',
  message: '',
  notes: '',
  status: 'new',
};

export function fromRegistration(r: Registration): RegistrationValues {
  const s = (v: string | number | null) => (v === null || v === undefined ? '' : String(v));
  return {
    kind: r.kind,
    name: r.name,
    contactPerson: s(r.contactPerson),
    email: s(r.email),
    phone: s(r.phone),
    addressLine: s(r.addressLine),
    postalCode: s(r.postalCode),
    city: s(r.city),
    objectTypes: r.objectTypes,
    propertyIds: r.propertyIds,
    minRooms: s(r.minRooms),
    minAreaM2: s(r.minAreaM2),
    maxRent: r.maxRentOre ? String(r.maxRentOre / 100) : '',
    desiredFrom: s(r.desiredFrom),
    householdSize: s(r.householdSize),
    message: s(r.message),
    notes: s(r.notes),
    status: r.status,
  };
}

export function toRegistrationBody(v: RegistrationValues, internal: boolean): Record<string, unknown> {
  const n = (x: string) => (x.trim() === '' ? null : Number(x.replace(',', '.').replace(/\s/g, '')));
  const t = (x: string) => (x.trim() === '' ? null : x.trim());
  return {
    kind: v.kind,
    name: v.name,
    contactPerson: v.kind === 'organization' ? t(v.contactPerson) : null,
    email: t(v.email),
    phone: t(v.phone),
    addressLine: t(v.addressLine),
    postalCode: t(v.postalCode),
    city: t(v.city),
    objectTypes: v.objectTypes,
    propertyIds: v.propertyIds,
    minRooms: n(v.minRooms),
    minAreaM2: n(v.minAreaM2),
    maxRent: n(v.maxRent),
    desiredFrom: t(v.desiredFrom),
    householdSize: n(v.householdSize),
    message: t(v.message),
    ...(internal ? { notes: t(v.notes), status: v.status } : {}),
  };
}

const TEXTAREA =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

function Checks({ options, value, onChange }: { options: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <button
            type="button"
            key={o.key}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.key) : [...value, o.key])}
            className={cx(
              'h-7 rounded-md border px-2.5 text-[12.5px] font-medium',
              on ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-ink-2 hover:bg-subtle',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Fälten för en intresseanmälan, både i systemet och i det publika formuläret. */
export function RegistrationFields({
  value,
  onChange,
  error,
  properties,
  objectTypes,
  internal,
}: {
  value: RegistrationValues;
  onChange: (v: RegistrationValues) => void;
  error: ApiError | null;
  properties: { id: string; name: string }[];
  objectTypes: string[];
  internal: boolean;
}) {
  const set = (k: keyof RegistrationValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const err = (k: string) => error?.fields.find((f) => f.path === k)?.message;
  const org = value.kind === 'organization';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={internal ? 'Typ' : 'Jag är'}>
          <Select value={value.kind} onChange={set('kind')}>
            <option value="person">Privatperson</option>
            <option value="organization">Företag eller förening</option>
          </Select>
        </Field>
        <Field label={org ? 'Företagets namn' : 'Namn'} error={err('name')}>
          <Input value={value.name} onChange={set('name')} autoComplete={org ? 'organization' : 'name'} />
        </Field>
        {org && (
          <Field label="Kontaktperson">
            <Input value={value.contactPerson} onChange={set('contactPerson')} autoComplete="name" />
          </Field>
        )}
        <Field label="E-post" error={err('email')}>
          <Input type="email" value={value.email} onChange={set('email')} autoComplete="email" />
        </Field>
        <Field label="Telefon" error={err('phone')}>
          <Input type="tel" value={value.phone} onChange={set('phone')} autoComplete="tel" />
        </Field>
        <Field label="Adress">
          <Input value={value.addressLine} onChange={set('addressLine')} autoComplete="street-address" />
        </Field>
        <div className="grid grid-cols-[100px_1fr] gap-2">
          <Field label="Postnummer">
            <Input value={value.postalCode} onChange={set('postalCode')} autoComplete="postal-code" />
          </Field>
          <Field label="Ort">
            <Input value={value.city} onChange={set('city')} autoComplete="address-level2" />
          </Field>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-medium text-ink-2">Vad söks? (inget valt betyder vad som helst)</div>
        <Checks
          options={objectTypes.map((t) => ({ key: t, label: OBJECT_TYPE_LABEL[t] ?? t }))}
          value={value.objectTypes}
          onChange={(objectTypes) => onChange({ ...value, objectTypes })}
        />
      </div>
      {properties.length > 1 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-ink-2">Fastigheter (inget valt betyder alla)</div>
          <Checks
            options={properties.map((p) => ({ key: p.id, label: p.name }))}
            value={value.propertyIds}
            onChange={(propertyIds) => onChange({ ...value, propertyIds })}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Minst antal rum" error={err('minRooms')}>
          <Input inputMode="decimal" value={value.minRooms} onChange={set('minRooms')} />
        </Field>
        <Field label="Minst yta, m²" error={err('minAreaM2')}>
          <Input inputMode="decimal" value={value.minAreaM2} onChange={set('minAreaM2')} />
        </Field>
        <Field label="Högsta hyra, kr/mån" error={err('maxRent')}>
          <Input inputMode="numeric" value={value.maxRent} onChange={set('maxRent')} />
        </Field>
        <Field label="Inflytt tidigast" error={err('desiredFrom')}>
          <Input type="date" value={value.desiredFrom} onChange={set('desiredFrom')} />
        </Field>
        {!org && (
          <Field label="Antal personer" error={err('householdSize')}>
            <Input inputMode="numeric" value={value.householdSize} onChange={set('householdSize')} />
          </Field>
        )}
      </div>
      <Field label={internal ? 'Meddelande från intressenten' : 'Meddelande (valfritt)'}>
        <textarea className={TEXTAREA} rows={3} value={value.message} onChange={set('message')} />
      </Field>
      {internal && (
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <Field label="Interna anteckningar" hint="Syns bara i systemet.">
            <textarea className={TEXTAREA} rows={3} value={value.notes} onChange={set('notes')} />
          </Field>
          <Field label="Status">
            <Select value={value.status} onChange={set('status')}>
              {Object.entries(INTEREST_STATUS).map(([k, s]) => (
                <option key={k} value={k} disabled={k === 'converted'}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  );
}

/** Ny eller ändrad anmälan i systemet. */
export function RegistrationDialog({
  open,
  onClose,
  initial,
  id,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: RegistrationValues;
  id?: string;
  onSaved: (id: string) => void;
}) {
  const [v, setV] = useState(initial ?? EMPTY_REGISTRATION);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [properties, setProperties] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    setV(initial ?? EMPTY_REGISTRATION);
    setErr(null);
    api<{ id: string; name: string }[]>('/properties').then(setProperties).catch(() => setProperties([]));
  }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} title={id ? 'Ändra intresseanmälan' : 'Ny intresseanmälan'} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const body = toRegistrationBody(v, true);
            if (id) {
              await api(`/interests/${id}`, { method: 'PATCH', body });
              onSaved(id);
            } else {
              const r = await api<{ id: string }>('/interests', { method: 'POST', body });
              onSaved(r.id);
            }
          } catch (e) {
            setErr(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <RegistrationFields
          value={v}
          onChange={setV}
          error={err}
          properties={properties}
          objectTypes={Object.keys(OBJECT_TYPE_LABEL)}
          internal
        />
        <div className="mt-4">
          <ErrorNote message={err && !err.fields.length ? err.message : null} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button disabled={busy}>{id ? 'Spara' : 'Lägg till'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Gör intressenten till hyresgäst och skapar ett avtalsutkast för objektet. */
export function ConvertDialog({
  open,
  onClose,
  registration,
  objects,
  objectId: fixedObject,
}: {
  open: boolean;
  onClose: () => void;
  registration: Pick<Registration, 'id' | 'name' | 'kind' | 'customerId'> | null;
  objects: Vacancy[];
  objectId?: string;
}) {
  const router = useRouter();
  const [objectId, setObjectId] = useState(fixedObject ?? '');
  const [startDate, setStartDate] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const first = fixedObject ?? objects[0]?.objectId ?? '';
    setObjectId(first);
    setNationalId('');
    setErr(null);
  }, [open, fixedObject, objects]);
  useEffect(() => {
    const o = objects.find((x) => x.objectId === objectId);
    if (o) setStartDate(o.vacantFrom > new Date().toISOString().slice(0, 10) ? o.vacantFrom : nextMonthStart());
  }, [objectId, objects]);

  if (!registration) return null;
  const fieldErr = (k: string) => err?.fields.find((f) => f.path === k)?.message;
  return (
    <Dialog open={open} onClose={onClose} title={`Gör ${registration.name} till hyresgäst`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await api<{ contractId: string }>(`/interests/${registration.id}/convert`, {
              method: 'POST',
              body: { objectId, startDate, nationalId: nationalId.trim() || null },
            });
            router.push(`/avtal/${r.contractId}`);
          } catch (e) {
            setErr(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-[13px] text-ink-2">
          {registration.customerId ? 'Intressenten finns redan som hyresgäst.' : 'Intressenten läggs upp som hyresgäst med sina kontaktuppgifter.'} Ett
          avtalsutkast skapas med objektets hyra. Du granskar och aktiverar avtalet som vanligt.
        </p>
        {!fixedObject && (
          <Field label="Objekt" error={fieldErr('objectId')}>
            <Select value={objectId} onChange={(e) => setObjectId(e.target.value)}>
              {objects.map((o) => (
                <option key={o.objectId} value={o.objectId}>
                  {o.propertyName} {o.objectNr} ({OBJECT_TYPE_LABEL[o.type] ?? o.type}, {fmtOre(o.monthlyRentOre)}/mån)
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Inflyttning" error={fieldErr('startDate')}>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </Field>
        {!registration.customerId && (
          <Field
            label={registration.kind === 'person' ? 'Personnummer (valfritt)' : 'Organisationsnummer (valfritt)'}
            error={fieldErr('nationalId')}
            hint="Kan också fyllas i senare på hyresgästen."
          >
            <Input value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
          </Field>
        )}
        <ErrorNote message={err && !err.fields.length ? err.message : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button disabled={busy || !objectId || !startDate}>Skapa hyresgäst och avtalsutkast</Button>
        </div>
      </form>
    </Dialog>
  );
}

function nextMonthStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

interface MatchRow extends Registration {
  offerId: string | null;
  offerStatus: string | null;
}

/** Intressenter som passar ett ledigt objekt, först anmäld först. */
export function MatchesDialog({ vacancy, onClose, onChanged, canManage }: { vacancy: Vacancy | null; onClose: () => void; onChanged: () => void; canManage: boolean }) {
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  const [converting, setConverting] = useState<MatchRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => vacancy && api<{ matching: MatchRow[] }>(`/vacancies/${vacancy.objectId}/matches`).then((r) => setRows(r.matching));
  useEffect(() => {
    setRows(null);
    setErr(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vacancy?.objectId]);
  if (!vacancy) return null;
  return (
    <>
      <Dialog open={!converting} onClose={onClose} title={`Intressenter för ${vacancy.propertyName} ${vacancy.objectNr}`} wide>
        <p className="mb-3 text-[13px] text-ink-2">
          {OBJECT_TYPE_LABEL[vacancy.type] ?? vacancy.type}
          {vacancy.rooms ? `, ${vacancy.rooms} rum` : ''}
          {vacancy.areaM2 ? `, ${vacancy.areaM2} m²` : ''}, {fmtOre(vacancy.monthlyRentOre)}/mån. Ledigt från {vacancy.vacantFrom}. De som anmälde sig först står
          först.
        </p>
        <ErrorNote message={err} />
        {rows && rows.length === 0 && <div className="py-6 text-center text-[13px] text-ink-3">Ingen i intresselistan passar objektet.</div>}
        <ul className="divide-y divide-line">
          {rows?.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/intresse/${r.id}`} className="font-medium hover:underline">
                  {r.name}
                </Link>{' '}
                <Badge tone={INTEREST_STATUS[r.status]?.tone}>{INTEREST_STATUS[r.status]?.label ?? r.status}</Badge>
                {r.offerStatus && (
                  <span className="ml-1">
                    <Badge tone={OFFER_STATUS[r.offerStatus]?.tone}>{`Detta objekt: ${OFFER_STATUS[r.offerStatus]?.label.toLowerCase()}`}</Badge>
                  </span>
                )}
                <div className="text-[12px] text-ink-3">
                  Anmäld {r.createdAt.slice(0, 10)} · {[r.email, r.phone].filter(Boolean).join(' · ')}
                </div>
                <div className="text-[12px] text-ink-2">{describeWishes(r, OBJECT_TYPE_LABEL)}</div>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1.5">
                  {!r.offerId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await api(`/interests/${r.id}/offers`, { method: 'POST', body: { objectId: vacancy.objectId } });
                          await load();
                          onChanged();
                        } catch (e) {
                          setErr((e as ApiError).message);
                        }
                      }}
                    >
                      Erbjud
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setConverting(r)}>
                    Gör till hyresgäst
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
      <ConvertDialog open={!!converting} onClose={() => setConverting(null)} registration={converting} objects={[vacancy]} objectId={vacancy.objectId} />
    </>
  );
}
