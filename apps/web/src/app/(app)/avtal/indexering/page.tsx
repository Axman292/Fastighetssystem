'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SectionHeader } from '@/components/edit-form';
import { FormDialog } from '@/components/form';
import { Badge, Button, Card, ErrorNote, PageHeader, Select, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { MONTH_LABEL, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Kpi {
  year: number;
  month: number;
  value: number;
}

interface IndexRow {
  contractId: string;
  companyName: string;
  contractNr: number;
  customerName: string;
  adjustDate: string;
  kpiYear: number;
  kpiMonth: number;
  baseValue: number;
  newValue: number | null;
  sharePct: number;
  baseAmountOre: number;
  currentIndexOre: number;
  newIndexOre: number | null;
  status: 'ready' | 'missing_kpi' | 'done' | 'no_lines';
  result?: 'applied' | 'skipped';
  message?: string;
}

const STATUS: Record<IndexRow['status'], { label: string; tone: 'good' | 'warn' | 'neutral' | 'bad' }> = {
  ready: { label: 'Klar att räkna upp', tone: 'warn' },
  done: { label: 'Uppräknad', tone: 'good' },
  missing_kpi: { label: 'KPI saknas', tone: 'bad' },
  no_lines: { label: 'Inga indexrader', tone: 'neutral' },
};

const MONTH_OPTIONS = Object.fromEntries(MONTH_LABEL.map((m, i) => [String(i + 1), m]));

export default function IndexPage() {
  const { me, active, can, version } = useSession();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(new Date().getMonth() >= 9 ? thisYear + 1 : thisYear);
  const [kpi, setKpi] = useState<Kpi[]>([]);
  const [rows, setRows] = useState<IndexRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Kpi[]>('/kpi').then(setKpi);
    api<IndexRow[]>(`/contracts/indexation?year=${year}`).then(setRows);
  }, [year]);
  useEffect(load, [load, version]);

  const canKpi = me.user.isGroupAdmin || me.companies.some((c) => c.permissions.includes('index.write'));
  const ready = rows?.filter((r) => r.status === 'ready') ?? [];
  const diff = ready.reduce((s, r) => s + (r.newIndexOre ?? 0) - r.currentIndexOre, 0);

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        / Indexuppräkning
      </div>
      <PageHeader
        title="Indexuppräkning"
        description="Hyror med indexklausul räknas om mot konsumentprisindex. Tillägget läggs som en egen rad, så bashyran och historiken finns kvar."
      />
      <div className="grid grid-cols-[1fr_300px] gap-6">
        <section>
          <SectionHeader
            title={`Uppräkning ${year}`}
            description={`KPI för basmånaden ${year - 1} jämförs med avtalets basvärde.`}
            actions={
              <>
                <Select className="w-24" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
                {active && can('index.write') && (
                  <Button
                    disabled={!ready.length || busy}
                    onClick={async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        const r = await api<IndexRow[]>('/contracts/indexation', { method: 'POST', body: { year } });
                        const n = r.filter((x) => x.result === 'applied').length;
                        setResult(`${n} avtal räknades upp.`);
                        load();
                      } catch (e) {
                        setError((e as ApiError).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Räkna upp {ready.length} avtal
                  </Button>
                )}
              </>
            }
          />
          {!active && <p className="mb-3 text-[12px] text-ink-3">Välj ett bolag för att genomföra uppräkningen. Förhandsvisningen gäller hela koncernen.</p>}
          {error && <ErrorNote message={error} />}
          {result && <div className="mb-3 rounded-md bg-good-soft px-3 py-2 text-[13px] text-good">{result}</div>}
          <Table head={['Avtal', 'Hyresgäst', 'Bashyra/mån', 'KPI', 'Tillägg nu', 'Nytt tillägg', 'Status']} empty="Inga avtal med indexklausul gäller vid uppräkningen.">
            {rows?.map((r) => (
              <tr key={r.contractId}>
                <Td className="font-medium tabular">
                  <Link href={`/avtal/${r.contractId}`}>{r.contractNr}</Link>
                </Td>
                <Td>
                  {r.customerName}
                  {!active && <div className="text-[12px] text-ink-3">{r.companyName}</div>}
                </Td>
                <Td className="tabular">{fmtOre(r.baseAmountOre)}</Td>
                <Td className="tabular text-[12px] text-ink-2">
                  {r.baseValue.toLocaleString('sv-SE')} → {r.newValue?.toLocaleString('sv-SE') ?? '?'}
                  <div className="text-ink-3">
                    {MONTH_LABEL[r.kpiMonth - 1].slice(0, 3)} {r.kpiYear}, {r.sharePct} %
                  </div>
                </Td>
                <Td className="tabular text-ink-2">{fmtOre(r.currentIndexOre)}</Td>
                <Td className="tabular font-medium">{r.newIndexOre === null ? '–' : fmtOre(r.newIndexOre)}</Td>
                <Td>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
          {ready.length > 0 && (
            <p className="mt-2 text-right text-[12px] text-ink-3">
              Ökning för {ready.length} avtal: {fmtOre(diff)} per månad, {fmtOre(diff * 12)} per år.
            </p>
          )}
        </section>
        <section>
          <SectionHeader
            title="KPI"
            description="Konsumentprisindex, 1980 = 100 (SCB)"
            actions={
              canKpi && (
                <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                  Lägg in
                </Button>
              )
            }
          />
          <Card className="max-h-[480px] divide-y divide-line overflow-y-auto">
            {kpi.map((k) => (
              <div key={`${k.year}-${k.month}`} className="flex justify-between px-4 py-2 text-[13px]">
                <span className="text-ink-2">
                  {MONTH_LABEL[k.month - 1]} {k.year}
                </span>
                <span className="tabular font-medium">{k.value.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
              </div>
            ))}
            {kpi.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-ink-3">Inga värden inlagda.</div>}
          </Card>
          <p className="mt-2 text-[12px] text-ink-3">Värdena hämtas från SCB och gäller alla bolag. Oktobervärdet används normalt för uppräkning från januari.</p>
        </section>
      </div>
      <FormDialog
        open={adding}
        title="Lägg in KPI"
        fields={[
          { key: 'year', label: 'År', type: 'number', required: true, half: true },
          { key: 'month', label: 'Månad', type: 'select', options: MONTH_OPTIONS, required: true, half: true },
          { key: 'value', label: 'Indextal', type: 'number', required: true, placeholder: '415,32' },
        ]}
        initial={{ year: thisYear, month: 10 }}
        onClose={() => setAdding(false)}
        submit={async (body) => {
          await api(`/kpi/${body.year}/${body.month}`, { method: 'PUT', body: { value: body.value } });
          setAdding(false);
          load();
        }}
      />
    </>
  );
}
