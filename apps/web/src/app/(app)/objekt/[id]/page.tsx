'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { FieldDef, FormDialog, FormFields, fromRow, toBody } from '@/components/form';
import { Badge, Button, Card, ErrorNote, PageHeader, Stat, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { objectFields } from '@/lib/fields';
import { OBJECT_TYPE_LABEL, RESIDENTIAL_TYPES, fmtInt, fmtM2, fmtNum, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface ObjectDetail {
  id: string;
  companyId: string;
  companyName: string;
  propertyId: string;
  propertyName: string;
  designation: string;
  objectNr: string;
  type: string;
  areaM2: number | null;
  active: boolean;
  monthlyRentOre: number | null;
  vatLiable: boolean | null;
  prices: { id: string; monthlyRentOre: number; validFrom: string; validTo: string | null; reason: string | null }[];
  vat: { id: string; vatLiable: boolean; validFrom: string; validTo: string | null; note: string | null }[];
  [k: string]: unknown;
}

const priceFields: FieldDef[] = [
  { key: 'monthlyRent', label: 'Ny månadshyra (kr, exkl. moms)', type: 'kronor', required: true, half: true },
  { key: 'validFrom', label: 'Gäller från', type: 'date', required: true, half: true },
  { key: 'reason', label: 'Orsak', placeholder: 'Hyresförhandling 2027' },
];
const vatFields: FieldDef[] = [
  { key: 'vatLiable', label: 'Momspliktig från datumet', type: 'checkbox' },
  { key: 'validFrom', label: 'Gäller från', type: 'date', required: true, half: true },
  { key: 'note', label: 'Anteckning', placeholder: 'Hyresgästen bedriver momspliktig verksamhet' },
];

export default function ObjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const [o, setO] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'price' | 'vat' | null>(null);

  const load = useCallback(() => {
    api<ObjectDetail>(`/objects/${id}`).then(setO).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!o) return null;
  const editable = can('property.write', o.companyId);
  const residential = RESIDENTIAL_TYPES.has(o.type);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/fastigheter" className="hover:text-ink">
          Fastigheter
        </Link>{' '}
        /{' '}
        <Link href={`/fastigheter/${o.propertyId}`} className="hover:text-ink">
          {o.propertyName}
        </Link>{' '}
        / {o.objectNr}
      </div>
      <PageHeader
        title={`${OBJECT_TYPE_LABEL[o.type]} ${o.objectNr}`}
        description={`${o.propertyName} · ${o.designation} · ${o.companyName}`}
        actions={o.active ? <Badge tone="good">Aktivt</Badge> : <Badge>Inaktivt</Badge>}
      />
      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Månadshyra" value={fmtOre(o.monthlyRentOre)} sub="exkl. moms" />
        <Stat label="Årshyra" value={fmtOre(o.monthlyRentOre === null ? null : o.monthlyRentOre * 12)} />
        <Stat
          label="Kr/m² och år"
          value={o.areaM2 && o.monthlyRentOre ? fmtInt((o.monthlyRentOre * 12) / 100 / o.areaM2) : '–'}
          sub={fmtM2(o.areaM2)}
        />
        <Stat label="Moms" value={o.vatLiable ? '25 %' : 'Momsfri'} sub={residential ? 'Bostad, alltid momsfri' : undefined} />
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-6">
        <section>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-[14px] font-semibold">Hyreshistorik</h2>
              <p className="text-[12px] text-ink-3">En ny hyra avslutar den föregående. Historiken ändras aldrig.</p>
            </div>
            {editable && (
              <Button size="sm" variant="secondary" onClick={() => setDialog('price')}>
                Ny hyra
              </Button>
            )}
          </div>
          <Table head={['Från', 'Till', 'Månadshyra', 'Orsak']} empty="Ingen hyra registrerad.">
            {o.prices.map((p) => (
              <tr key={p.id}>
                <Td className="tabular">{p.validFrom}</Td>
                <Td className="tabular text-ink-2">{p.validTo ?? 'tills vidare'}</Td>
                <Td className="tabular font-medium">{fmtOre(p.monthlyRentOre, true)}</Td>
                <Td className="text-ink-2">{p.reason ?? ''}</Td>
              </tr>
            ))}
          </Table>
        </section>
        <section>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-[14px] font-semibold">Momsstatus</h2>
              <p className="text-[12px] text-ink-3">Frivillig skattskyldighet för lokaler.</p>
            </div>
            {editable && !residential && (
              <Button size="sm" variant="secondary" onClick={() => setDialog('vat')}>
                Ändra
              </Button>
            )}
          </div>
          <Table head={['Från', 'Till', 'Status', 'Anteckning']} empty="Ingen momsstatus.">
            {o.vat.map((v) => (
              <tr key={v.id}>
                <Td className="tabular">{v.validFrom}</Td>
                <Td className="tabular text-ink-2">{v.validTo ?? 'tills vidare'}</Td>
                <Td>{v.vatLiable ? <Badge tone="accent">Momspliktig</Badge> : <Badge>Momsfri</Badge>}</Td>
                <Td className="text-ink-2">{v.note ?? ''}</Td>
              </tr>
            ))}
          </Table>
        </section>
      </div>

      <ObjectForm object={o} editable={editable} onSaved={load} />

      <FormDialog
        open={dialog === 'price'}
        title="Ny hyra"
        fields={priceFields}
        onClose={() => setDialog(null)}
        submit={async (body) => {
          await api(`/objects/${id}/prices`, { method: 'POST', body, companyId: o.companyId });
          setDialog(null);
          load();
        }}
      />
      <FormDialog
        open={dialog === 'vat'}
        title="Ändra momsstatus"
        fields={vatFields}
        initial={{ vatLiable: !o.vatLiable }}
        onClose={() => setDialog(null)}
        submit={async (body) => {
          await api(`/objects/${id}/vat`, { method: 'POST', body, companyId: o.companyId });
          setDialog(null);
          load();
        }}
      />
    </>
  );
}

function ObjectForm({ object, editable, onSaved }: { object: ObjectDetail; editable: boolean; onSaved: () => void }) {
  const [values, setValues] = useState(() => fromRow(objectFields, object));
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-[14px] font-semibold">Uppgifter</h2>
      <Card className="p-5">
        <FormFields
          fields={objectFields}
          values={values}
          onChange={(v) => {
            setSaved(false);
            setValues(v);
          }}
          error={error}
          disabled={!editable}
        />
        {editable && (
          <div className="mt-5 flex items-center justify-between gap-3">
            <Button
              variant="secondary"
              onClick={async () => {
                await api(`/objects/${object.id}`, { method: 'PATCH', body: { active: !object.active }, companyId: object.companyId });
                onSaved();
              }}
            >
              {object.active ? 'Markera som inaktivt' : 'Aktivera'}
            </Button>
            <div className="flex items-center gap-3">
              {saved && <span className="text-[12px] text-good">Sparat</span>}
              {error && !error.fields.length && <ErrorNote message={error.message} />}
              <Button
                onClick={async () => {
                  setError(null);
                  try {
                    await api(`/objects/${object.id}`, { method: 'PATCH', body: toBody(objectFields, values), companyId: object.companyId });
                    setSaved(true);
                    onSaved();
                  } catch (e) {
                    setError(e as ApiError);
                  }
                }}
              >
                Spara
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
