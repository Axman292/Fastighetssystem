'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PeriodPicker, PeriodValue, periodRange } from '@/components/period-picker';
import type { Kpi } from '@/components/property-economy';
import { Card, ErrorNote, PageHeader, Select, Stat, Table, Td, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtInt, fmtMsek, fmtOre, fmtPct } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Agg {
  areaM2: number;
  valueSek: number | null;
  rentValueOre: number;
  vacantRentOre: number;
  hasBudget: boolean;
  kpi: Kpi;
}

interface Overview {
  period: { from: string; to: string; days: number };
  properties: (Agg & { propertyId: string; companyName: string; name: string; designation: string; estimatedGroups: string[] })[];
  companies: (Agg & { companyId: string; companyName: string; propertyCount: number })[];
  total: Agg & { propertyCount: number; budgetedCount: number };
  unallocated: { companyId: string; companyName: string; incomeOre: number; costOre: number }[];
}

const SORT: Record<string, { label: string; f: (r: Agg & { name: string }) => number | string }> = {
  name: { label: 'Namn', f: (r) => r.name },
  net: { label: 'Driftnetto', f: (r) => -r.kpi.netOperatingOre },
  yield: { label: 'Direktavkastning', f: (r) => -(r.kpi.yield ?? -99) },
  vacancy: { label: 'Vakansgrad', f: (r) => -(r.kpi.vacancyRate ?? -1) },
  costm2: { label: 'Kostnad per m²', f: (r) => -(r.kpi.costPerM2 ?? -1) },
  budget: { label: 'Avvikelse mot budget', f: (r) => (r.kpi.budgetNetOperatingOre === null ? 1e15 : r.kpi.netOperatingOre - r.kpi.budgetNetOperatingOre) },
};

export default function EconomyPage() {
  const { active, version } = useSession();
  const router = useRouter();
  const [period, setPeriod] = useState<PeriodValue>({ year: new Date().getFullYear(), key: 'year' });
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState('name');
  const range = periodRange(period);

  useEffect(() => {
    setError(null);
    api<Overview>(`/economy/overview?from=${range.from}&to=${range.to}`)
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, [range.from, range.to, version]);

  const props = useMemo(() => {
    if (!data) return [];
    const f = SORT[sort].f;
    return [...data.properties].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return typeof x === 'string' ? x.localeCompare(String(y), 'sv') : x - (y as number);
    });
  }, [data, sort]);

  const t = data?.total;

  return (
    <>
      <PageHeader
        title="Ekonomi"
        description={
          active
            ? `Driftnetto, avkastning och vakanser för fastigheterna i ${active.companyName}.`
            : 'Driftnetto, avkastning och vakanser för koncernens bolag och fastigheter.'
        }
        actions={<PeriodPicker value={period} onChange={setPeriod} />}
      />
      <ErrorNote message={error} />
      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Intäkter" value={t ? fmtOre(t.kpi.incomeOre) : '–'} sub={range.label} />
        <Stat
          label="Driftnetto"
          value={t ? fmtOre(t.kpi.netOperatingOre) : '–'}
          sub={
            !t
              ? undefined
              : t.budgetedCount === t.propertyCount && t.kpi.budgetNetOperatingOre !== null
                ? `budget ${fmtOre(t.kpi.budgetNetOperatingOre)}`
                : t.budgetedCount > 0
                  ? `budget finns för ${t.budgetedCount} av ${t.propertyCount} fastigheter`
                  : `kostnader ${fmtOre(t.kpi.opexOre)}`
          }
        />
        <Stat label="Direktavkastning" value={fmtPct(t?.kpi.yield)} sub={t?.valueSek ? `på marknadsvärde ${fmtMsek(t.valueSek)}` : 'marknadsvärde saknas'} />
        <Stat label="Ekonomisk vakansgrad" value={fmtPct(t?.kpi.vacancyRate)} sub={t ? `${fmtOre(t.vacantRentOre)} vakant hyresvärde` : undefined} />
      </div>

      {data && data.companies.length > 1 && (
        <section className="mb-8">
          <h2 className="mb-2 text-[14px] font-semibold">Bolag</h2>
          <Table head={['Bolag', 'Fastigheter', 'Intäkter', 'Kostnader', 'Driftnetto', 'Budget', 'Direktavkastning', 'Vakansgrad']}>
            {data.companies.map((c) => (
              <tr key={c.companyId}>
                <Td className="font-medium">{c.companyName}</Td>
                <Td className="tabular">{c.propertyCount}</Td>
                <Td className="tabular">{fmtOre(c.kpi.incomeOre)}</Td>
                <Td className="tabular">{fmtOre(c.kpi.opexOre)}</Td>
                <Td className={cx('tabular font-medium', c.kpi.netOperatingOre < 0 && 'text-bad')}>{fmtOre(c.kpi.netOperatingOre)}</Td>
                <Td className="tabular text-ink-2">{c.kpi.budgetNetOperatingOre !== null ? fmtOre(c.kpi.budgetNetOperatingOre) : '–'}</Td>
                <Td className="tabular">{fmtPct(c.kpi.yield)}</Td>
                <Td className="tabular">{fmtPct(c.kpi.vacancyRate)}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      <section className="mb-8">
        <div className="mb-2 flex items-end justify-between">
          <h2 className="text-[14px] font-semibold">Fastigheter</h2>
          <div className="flex items-center gap-2 whitespace-nowrap text-[12px] text-ink-3">
            Sortera efter
            <Select className="w-48" value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORT).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <Table
          head={['Fastighet', ...(active ? [] : ['Bolag']), 'Intäkter', 'Kostnader', 'Driftnetto', 'Mot budget', 'Direktavk.', 'Vakans', 'Hyra kr/m²', 'Kostnad kr/m²']}
          empty={data ? 'Inga fastigheter.' : 'Laddar…'}
        >
          {props.map((p) => {
            const diff = p.kpi.budgetNetOperatingOre !== null ? p.kpi.netOperatingOre - p.kpi.budgetNetOperatingOre : null;
            return (
              <tr key={p.propertyId} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/fastigheter/${p.propertyId}?flik=resultat`)}>
                <Td className="font-medium">
                  <Link href={`/fastigheter/${p.propertyId}?flik=resultat`}>{p.name}</Link>
                  <div className="text-[12px] font-normal text-ink-3">{p.designation}</div>
                </Td>
                {!active && <Td className="text-ink-2">{p.companyName}</Td>}
                <Td className="tabular">{fmtOre(p.kpi.incomeOre)}</Td>
                <Td className="tabular">
                  {fmtOre(p.kpi.opexOre)}
                  {p.estimatedGroups.length > 0 && <span className="text-warn" title="Delvis beräknat ur fastighetsregistret"> *</span>}
                </Td>
                <Td className={cx('tabular font-medium', p.kpi.netOperatingOre < 0 && 'text-bad')}>{fmtOre(p.kpi.netOperatingOre)}</Td>
                <Td className={cx('tabular', diff === null ? 'text-ink-3' : diff < 0 ? 'text-bad' : 'text-good')}>{diff === null ? '–' : fmtOre(diff)}</Td>
                <Td className="tabular">{fmtPct(p.kpi.yield)}</Td>
                <Td className="tabular">{fmtPct(p.kpi.vacancyRate)}</Td>
                <Td className="tabular">{fmtInt(p.kpi.rentPerM2)}</Td>
                <Td className="tabular">{fmtInt(p.kpi.costPerM2)}</Td>
              </tr>
            );
          })}
        </Table>
        <p className="mt-2 text-[12px] text-ink-3">
          Direktavkastning och kr/m² är omräknade till helår. * Fastighetsskatt, försäkring eller räntor saknar bokade kostnader och är beräknade ur fastighetsregistret.
        </p>
      </section>

      {data && data.unallocated.length > 0 && (
        <Card className="px-5 py-4 text-[13px]">
          <div className="font-medium">Ej fördelat på fastighet</div>
          <p className="mt-1 text-ink-2">Intäkter och kostnader under perioden som är konterade på bolaget men inte på någon fastighet. De ingår inte i siffrorna ovan.</p>
          <div className="mt-2 space-y-1">
            {data.unallocated.map((u) => (
              <div key={u.companyId} className="flex gap-6 tabular">
                <span className="w-60">{u.companyName}</span>
                <span>Intäkter {fmtOre(u.incomeOre)}</span>
                <span>Kostnader {fmtOre(u.costOre)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
