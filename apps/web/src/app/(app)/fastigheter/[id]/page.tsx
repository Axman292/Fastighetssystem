'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { CrudTable } from '@/components/crud-table';
import { FieldDef, FormDialog, FormFields, fromRow, toBody } from '@/components/form';
import { ObjectTable } from '@/components/object-table';
import { Badge, Button, Card, ErrorNote, PageHeader, Stat, Table, Tabs, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { newObjectExtraFields, objectFields, propertyFields } from '@/lib/fields';
import { CATEGORY_LABEL, OBJECT_TYPE_LABEL, fmtInt, fmtM2, fmtMsek, fmtNum, fmtOre, fmtPct, fmtSek } from '@/lib/format';
import { useSession } from '@/lib/session';

interface PropertyDetail {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  designation: string;
  category: string;
  city: string | null;
  constructionYear: number | null;
  areaBoaM2: number | null;
  areaLoaM2: number | null;
  valueSek: number | null;
  valuationDate: string | null;
  loansOre: number;
  taxValueSek: number | null;
  propertyTaxOre: number | null;
  byType: { type: string; count: number; areaM2: number; monthlyRentOre: number }[];
  [k: string]: unknown;
}

type Tab = 'objekt' | 'uppgifter' | 'byggnader' | 'ekonomi' | 'teknik';

const technicalFields: FieldDef[] = [
  { key: 'heating', label: 'Uppvärmning', half: true, placeholder: 'Fjärrvärme' },
  { key: 'ventilation', label: 'Ventilation', half: true, placeholder: 'FTX' },
  { key: 'elevators', label: 'Antal hissar', type: 'number', half: true },
  { key: 'energyUseKwhM2', label: 'Energiprestanda (kWh/m² och år)', type: 'number', half: true },
  { key: 'ovkDate', label: 'Senaste OVK', type: 'date', half: true },
  { key: 'energyDeclarationDate', label: 'Energideklaration', type: 'date', half: true },
  { key: 'notes', label: 'Övrigt', type: 'textarea' },
];

export default function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [p, setP] = useState<PropertyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('objekt');
  const [objVersion, setObjVersion] = useState(0);
  const [addingObject, setAddingObject] = useState(false);

  const load = useCallback(() => {
    api<PropertyDetail>(`/properties/${id}`).then(setP).catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!p) return null;

  const editable = can('property.write', p.companyId);
  const objectCount = p.byType.reduce((s, t) => s + t.count, 0);
  const area = p.byType.reduce((s, t) => s + t.areaM2, 0);
  const rent = p.byType.reduce((s, t) => s + t.monthlyRentOre, 0);
  const ltv = p.valueSek ? p.loansOre / 100 / p.valueSek : null;
  const yearlyRent = rent * 12;

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/fastigheter" className="hover:text-ink">
          Fastigheter
        </Link>{' '}
        / {p.name}
      </div>
      <PageHeader
        title={p.name}
        description={`${p.designation} · ${CATEGORY_LABEL[p.category]}${p.constructionYear ? ` · byggd ${p.constructionYear}` : ''} · ${p.companyName}`}
        actions={
          editable && (
            <Button onClick={() => setAddingObject(true)}>
              Nytt objekt
            </Button>
          )
        }
      />

      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Uthyrningsbara objekt" value={objectCount} sub={fmtM2(area)} />
        <Stat label="Hyresvärde per år" value={fmtOre(yearlyRent)} sub={area ? `${fmtInt(yearlyRent / 100 / area)} kr/m²` : undefined} />
        <Stat label="Marknadsvärde" value={fmtMsek(p.valueSek)} sub={p.valuationDate ? `värderad ${p.valuationDate}` : 'ingen värdering'} />
        <Stat label="Belåning" value={fmtMsek(p.loansOre / 100)} sub={ltv !== null ? `belåningsgrad ${fmtPct(ltv)}` : undefined} />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'objekt', label: 'Objekt', count: objectCount },
          { key: 'uppgifter', label: 'Uppgifter' },
          { key: 'byggnader', label: 'Byggnader' },
          { key: 'ekonomi', label: 'Taxering, värdering och lån' },
          { key: 'teknik', label: 'Teknik och underhåll' },
        ]}
      />

      {tab === 'objekt' && (
        <div className="space-y-6">
          {p.byType.length > 0 && (
            <Table head={['Typ', 'Antal', 'Area', 'Hyresvärde/mån', 'Kr/m² och år']}>
              {p.byType.map((t) => (
                <tr key={t.type}>
                  <Td className="font-medium">{OBJECT_TYPE_LABEL[t.type]}</Td>
                  <Td className="tabular">{t.count}</Td>
                  <Td className="tabular">{fmtM2(t.areaM2)}</Td>
                  <Td className="tabular">{fmtOre(t.monthlyRentOre)}</Td>
                  <Td className="tabular">{t.areaM2 ? fmtInt((t.monthlyRentOre * 12) / 100 / t.areaM2) : '–'}</Td>
                </tr>
              ))}
            </Table>
          )}
          <ObjectTable propertyId={id} version={objVersion} hideProperty />
        </div>
      )}

      {tab === 'uppgifter' && <PropertyForm property={p} editable={editable} onSaved={load} onDeleted={() => router.push('/fastigheter')} />}

      {tab === 'byggnader' && (
        <CrudTable<{ id: string; name: string; addressLine: string | null; constructionYear: number | null; energyClass: string | null; floors: number | null }>
          path={`/properties/${id}/buildings`}
          companyId={p.companyId}
          title="Byggnader"
          description="Valfritt. Används när en fastighet har flera byggnader eller adresser."
          editable={editable}
          empty="Inga byggnader registrerade."
          columns={[
            { label: 'Namn', render: (r) => r.name, className: 'font-medium' },
            { label: 'Adress', render: (r) => r.addressLine ?? '–' },
            { label: 'Byggår', render: (r) => r.constructionYear ?? '–', className: 'tabular' },
            { label: 'Våningar', render: (r) => r.floors ?? '–', className: 'tabular' },
            { label: 'Energiklass', render: (r) => (r.energyClass ? <Badge>{r.energyClass}</Badge> : '–') },
          ]}
          fields={[
            { key: 'name', label: 'Namn', required: true, half: true },
            { key: 'addressLine', label: 'Adress', half: true },
            { key: 'constructionYear', label: 'Byggår', type: 'number', half: true },
            { key: 'floors', label: 'Antal våningar', type: 'number', half: true },
            { key: 'energyClass', label: 'Energiklass', type: 'select', options: Object.fromEntries('ABCDEFG'.split('').map((c) => [c, c])), half: true },
          ]}
        />
      )}

      {tab === 'ekonomi' && (
        <div className="space-y-10">
          <CrudTable<{ id: string; assessmentYear: number; typeCode: string | null; landValueSek: number | null; buildingValueSek: number | null; propertyTaxOre: number | null }>
            path={`/properties/${id}/tax-assessments`}
            companyId={p.companyId}
            title="Taxering"
            editable={editable}
            onChange={load}
            empty="Inga taxeringsuppgifter."
            columns={[
              { label: 'Taxeringsår', render: (r) => r.assessmentYear, className: 'tabular font-medium' },
              { label: 'Typkod', render: (r) => r.typeCode ?? '–', className: 'tabular' },
              { label: 'Markvärde', render: (r) => fmtSek(r.landValueSek), className: 'tabular' },
              { label: 'Byggnadsvärde', render: (r) => fmtSek(r.buildingValueSek), className: 'tabular' },
              { label: 'Taxeringsvärde', render: (r) => fmtSek((r.landValueSek ?? 0) + (r.buildingValueSek ?? 0)), className: 'tabular' },
              { label: 'Fastighetsskatt/år', render: (r) => fmtOre(r.propertyTaxOre), className: 'tabular' },
            ]}
            fields={[
              { key: 'assessmentYear', label: 'Taxeringsår', type: 'number', required: true, half: true },
              { key: 'typeCode', label: 'Typkod', half: true, placeholder: '320' },
              { key: 'landValueSek', label: 'Markvärde (kr)', type: 'number', half: true },
              { key: 'buildingValueSek', label: 'Byggnadsvärde (kr)', type: 'number', half: true },
              { key: 'propertyTaxOre', label: 'Fastighetsskatt/avgift per år (kr)', type: 'kronor' },
            ]}
          />
          <CrudTable<{ id: string; valuationDate: string; valueSek: number; valuer: string | null; method: string | null }>
            path={`/properties/${id}/valuations`}
            companyId={p.companyId}
            title="Värdering"
            editable={editable}
            onChange={load}
            empty="Inga värderingar."
            columns={[
              { label: 'Datum', render: (r) => r.valuationDate, className: 'tabular font-medium' },
              { label: 'Marknadsvärde', render: (r) => fmtSek(r.valueSek), className: 'tabular' },
              { label: 'Kr/m²', render: (r) => (area ? fmtInt(r.valueSek / area) : '–'), className: 'tabular' },
              { label: 'Direktavkastning på hyresvärde', render: (r) => fmtPct(yearlyRent / 100 / r.valueSek), className: 'tabular' },
              { label: 'Värderare', render: (r) => r.valuer ?? '–' },
            ]}
            fields={[
              { key: 'valuationDate', label: 'Datum', type: 'date', required: true, half: true },
              { key: 'valueSek', label: 'Marknadsvärde (kr)', type: 'number', required: true, half: true },
              { key: 'valuer', label: 'Värderare', half: true },
              { key: 'method', label: 'Metod', half: true, placeholder: 'Kassaflödesanalys' },
            ]}
          />
          <CrudTable<{ id: string; lender: string; loanNr: string | null; principalOre: number; interestBp: number | null; fixedUntil: string | null; amortizationOrePerYear: number | null }>
            path={`/properties/${id}/loans`}
            companyId={p.companyId}
            title="Lån"
            editable={editable}
            onChange={load}
            empty="Inga lån registrerade."
            columns={[
              { label: 'Långivare', render: (r) => r.lender, className: 'font-medium' },
              { label: 'Lånenummer', render: (r) => r.loanNr ?? '–', className: 'tabular' },
              { label: 'Skuld', render: (r) => fmtOre(r.principalOre), className: 'tabular' },
              { label: 'Ränta', render: (r) => (r.interestBp !== null ? `${fmtNum(r.interestBp / 100)} %` : '–'), className: 'tabular' },
              { label: 'Bunden till', render: (r) => r.fixedUntil ?? 'Rörlig', className: 'tabular' },
              { label: 'Amortering/år', render: (r) => fmtOre(r.amortizationOrePerYear), className: 'tabular' },
            ]}
            fields={[
              { key: 'lender', label: 'Långivare', required: true, half: true },
              { key: 'loanNr', label: 'Lånenummer', half: true },
              { key: 'principalOre', label: 'Aktuell skuld (kr)', type: 'kronor', required: true, half: true },
              { key: 'interestBp', label: 'Ränta (punkter, 395 = 3,95 %)', type: 'number', half: true },
              { key: 'fixedUntil', label: 'Räntebunden till', type: 'date', half: true },
              { key: 'amortizationOrePerYear', label: 'Amortering per år (kr)', type: 'kronor', half: true },
            ]}
          />
          <CrudTable<{ id: string; insurer: string; policyNr: string | null; sumInsuredSek: number | null; premiumOre: number | null; validFrom: string; validTo: string | null }>
            path={`/properties/${id}/insurances`}
            companyId={p.companyId}
            title="Försäkring"
            editable={editable}
            empty="Ingen försäkring registrerad."
            columns={[
              { label: 'Försäkringsbolag', render: (r) => r.insurer, className: 'font-medium' },
              { label: 'Försäkringsnummer', render: (r) => r.policyNr ?? '–' },
              { label: 'Premie/år', render: (r) => fmtOre(r.premiumOre), className: 'tabular' },
              { label: 'Period', render: (r) => `${r.validFrom} – ${r.validTo ?? 'tills vidare'}`, className: 'tabular' },
            ]}
            fields={[
              { key: 'insurer', label: 'Försäkringsbolag', required: true, half: true },
              { key: 'policyNr', label: 'Försäkringsnummer', half: true },
              { key: 'sumInsuredSek', label: 'Försäkringsbelopp (kr)', type: 'number', half: true },
              { key: 'premiumOre', label: 'Premie per år (kr)', type: 'kronor', half: true },
              { key: 'validFrom', label: 'Gäller från', type: 'date', required: true, half: true },
              { key: 'validTo', label: 'Gäller till', type: 'date', half: true },
            ]}
          />
        </div>
      )}

      {tab === 'teknik' && (
        <div className="space-y-10">
          <TechnicalForm propertyId={id} companyId={p.companyId} editable={editable} />
          <CrudTable<{ id: string; component: string; plannedYear: number; estimatedCostOre: number | null; status: string }>
            path={`/properties/${id}/maintenance`}
            companyId={p.companyId}
            title="Underhållsplan"
            editable={editable}
            empty="Ingen planerad åtgärd."
            columns={[
              { label: 'År', render: (r) => r.plannedYear, className: 'tabular font-medium' },
              { label: 'Åtgärd', render: (r) => r.component },
              { label: 'Beräknad kostnad', render: (r) => fmtOre(r.estimatedCostOre), className: 'tabular' },
              {
                label: 'Status',
                render: (r) => (
                  <Badge tone={r.status === 'done' ? 'good' : r.status === 'postponed' ? 'warn' : r.status === 'ordered' ? 'accent' : 'neutral'}>
                    {maintenanceStatus[r.status]}
                  </Badge>
                ),
              },
            ]}
            fields={[
              { key: 'component', label: 'Åtgärd', required: true, placeholder: 'Takbyte' },
              { key: 'plannedYear', label: 'Planerat år', type: 'number', required: true, half: true },
              { key: 'estimatedCostOre', label: 'Beräknad kostnad (kr)', type: 'kronor', half: true },
              { key: 'status', label: 'Status', type: 'select', options: maintenanceStatus, required: true, half: true },
              { key: 'notes', label: 'Anteckningar', type: 'textarea' },
            ]}
          />
        </div>
      )}

      <FormDialog
        open={addingObject}
        title={`Nytt objekt i ${p.name}`}
        fields={[...objectFields, ...newObjectExtraFields]}
        onClose={() => setAddingObject(false)}
        submit={async (body) => {
          await api('/objects', { method: 'POST', body: { ...body, propertyId: id, vatLiable: !!body.vatLiable }, companyId: p.companyId });
          setAddingObject(false);
          setObjVersion((v) => v + 1);
          load();
        }}
        submitLabel="Skapa objekt"
      />
    </>
  );
}

const maintenanceStatus: Record<string, string> = { planned: 'Planerad', ordered: 'Beställd', done: 'Utförd', postponed: 'Uppskjuten' };

function PropertyForm({ property, editable, onSaved, onDeleted }: { property: PropertyDetail; editable: boolean; onSaved: () => void; onDeleted: () => void }) {
  const [values, setValues] = useState(() => fromRow(propertyFields, property));
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    try {
      await api(`/properties/${property.id}`, { method: 'PATCH', body: toBody(propertyFields, values), companyId: property.companyId });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    }
  }

  return (
    <Card className="p-5">
      <FormFields
        fields={propertyFields}
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
            variant="danger"
            onClick={async () => {
              if (!window.confirm('Ta bort fastigheten? Det går bara om den saknar objekt.')) return;
              try {
                await api(`/properties/${property.id}`, { method: 'DELETE', companyId: property.companyId });
                onDeleted();
              } catch (e) {
                setError(e as ApiError);
              }
            }}
          >
            Ta bort fastighet
          </Button>
          <div className="flex items-center gap-3">
            {saved && <span className="text-[12px] text-good">Sparat</span>}
            {error && !error.fields.length && <ErrorNote message={error.message} />}
            <Button onClick={save}>Spara</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function TechnicalForm({ propertyId, companyId, editable }: { propertyId: string; companyId: string; editable: boolean }) {
  const [values, setValues] = useState<ReturnType<typeof fromRow> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    api<Record<string, unknown> | null>(`/properties/${propertyId}/technical`, { companyId }).then((r) => setValues(fromRow(technicalFields, r)));
  }, [propertyId, companyId]);
  if (!values) return null;
  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold">Tekniska uppgifter</h2>
      <Card className="p-5">
        <FormFields
          fields={technicalFields}
          values={values}
          onChange={(v) => {
            setSaved(false);
            setValues(v);
          }}
          error={error}
          disabled={!editable}
        />
        {editable && (
          <div className="mt-5 flex items-center justify-end gap-3">
            {saved && <span className="text-[12px] text-good">Sparat</span>}
            {error && !error.fields.length && <ErrorNote message={error.message} />}
            <Button
              onClick={async () => {
                setError(null);
                try {
                  await api(`/properties/${propertyId}/technical`, { method: 'PUT', body: toBody(technicalFields, values), companyId });
                  setSaved(true);
                } catch (e) {
                  setError(e as ApiError);
                }
              }}
            >
              Spara
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

