'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { PeriodPicker, PeriodValue, periodRange } from '@/components/period-picker';
import { Card, ErrorNote, Input, PageHeader, Select, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtNum, fmtOre, fmtPct, todayIso } from '@/lib/format';
import type { Cell, ColumnType, Report, ReportInfo, ReportSection } from '@/lib/reports';
import { useSession } from '@/lib/session';

interface PropertyOption {
  id: string;
  name: string;
  designation: string;
  companyName: string;
}

const NUMERIC = new Set<ColumnType>(['money', 'int', 'number', 'area', 'pct']);

function show(type: ColumnType, v: Cell): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money':
      return fmtOre(v as number);
    case 'area':
      return `${fmtNum(v as number)} m²`;
    case 'pct':
      return fmtPct(v as number);
    case 'number':
      return fmtNum(v as number);
    default:
      return String(v);
  }
}

export default function ReportPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { active, version } = useSession();
  const [info, setInfo] = useState<ReportInfo | null>(null);
  const [period, setPeriod] = useState<PeriodValue>({ year: new Date().getFullYear(), key: `m${new Date().getMonth() + 1}` });
  const [day, setDay] = useState(todayIso());
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const range = periodRange(period);

  useEffect(() => {
    api<ReportInfo[]>('/reports')
      .then((list) => setInfo(list.find((r) => r.key === key) ?? null))
      .catch((e: ApiError) => setError(e.message));
  }, [key]);

  useEffect(() => {
    api<PropertyOption[]>('/properties')
      .then((list) => {
        setProperties(list);
        setPropertyId((p) => (list.some((x) => x.id === p) ? p : ''));
      })
      .catch(() => setProperties([]));
  }, [version]);

  const query = useMemo(() => {
    if (!info) return null;
    const q = new URLSearchParams(info.mode === 'date' ? { to: day } : { from: range.from, to: range.to });
    if (propertyId) q.set('propertyId', propertyId);
    return q.toString();
  }, [info, day, range.from, range.to, propertyId]);

  useEffect(() => {
    if (!query) return;
    setError(null);
    setLoading(true);
    api<Report>(`/reports/${key}?${query}`)
      .then(setReport)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [key, query, version]);

  const title = info?.title ?? report?.title ?? 'Rapport';
  const multiCompany = !active && new Set(properties.map((p) => p.companyName)).size > 1;

  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link href="/rapporter" className="text-ink-3 hover:text-ink">
          ← Rapporter
        </Link>
      </div>
      <PageHeader
        title={title}
        description={`${info?.description ?? ''} ${active ? active.companyName : 'Hela koncernen'}.`}
        actions={
          query && (
            <>
              <DownloadLink href={`/api/reports/${key}?${query}&format=xlsx`} label="Excel" />
              <DownloadLink href={`/api/reports/${key}?${query}&format=pdf`} label="PDF" newTab />
            </>
          )
        }
      />

      <Card className="mb-6 flex flex-wrap items-end gap-4 px-4 py-3">
        {info?.mode === 'date' ? (
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-ink-2">Per datum</span>
            <Input type="date" className="w-40" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        ) : (
          <div className="space-y-1">
            <span className="block text-[12px] font-medium text-ink-2">Period</span>
            <PeriodPicker value={period} onChange={setPeriod} />
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-ink-2">Fastighet</span>
          <Select className="w-64" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">Alla fastigheter</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {multiCompany ? ` (${p.companyName})` : ''}
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto pb-1.5 text-[12px] text-ink-3">{loading ? 'Hämtar…' : report ? `Uppdaterad ${report.generatedAt}` : ''}</div>
      </Card>

      <ErrorNote message={error} />

      {report && (
        <div className={cx('space-y-8 transition-opacity', loading && 'opacity-60')}>
          {report.sections.map((s, i) => (
            <SectionTable key={`${report.key}-${i}`} section={s} />
          ))}
          {report.notes && report.notes.length > 0 && (
            <div className="space-y-1 text-[12px] text-ink-3">
              {report.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function DownloadLink({ href, label, newTab }: { href: string; label: string; newTab?: boolean }) {
  return (
    <a
      href={href}
      {...(newTab ? { target: '_blank', rel: 'noreferrer' } : { download: true })}
      className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-surface px-3 text-[13px] font-medium text-ink shadow-card hover:bg-subtle"
    >
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M10 3v9M6 8l4 4 4-4M4 14v3h12v-3" />
      </svg>
      {label}
    </a>
  );
}

function SectionTable({ section: s }: { section: ReportSection }) {
  return (
    <section>
      {s.title && <h2 className="mb-1 text-[14px] font-semibold">{s.title}</h2>}
      {s.description && <p className="mb-2 text-[12.5px] text-ink-2">{s.description}</p>}
      <Card className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-line bg-subtle/60">
              {s.columns.map((c) => (
                <th key={c.key} className={cx('h-8 whitespace-nowrap px-3 text-[12px] font-medium text-ink-3', NUMERIC.has(c.type) && 'text-right')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.rows.map((r, i) => (
              <tr key={i} className="hover:bg-subtle/50">
                {s.columns.map((c) => (
                  <td
                    key={c.key}
                    className={cx(
                      'h-9 whitespace-nowrap px-3',
                      NUMERIC.has(c.type) ? 'text-right tabular' : c.type === 'date' ? 'tabular' : '',
                      typeof r[c.key] === 'number' && (r[c.key] as number) < 0 && 'text-bad',
                    )}
                  >
                    {show(c.type, r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {s.totals && s.rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-line-strong bg-subtle/60 font-semibold">
                {s.columns.map((c) => (
                  <td key={c.key} className={cx('h-9 whitespace-nowrap px-3', NUMERIC.has(c.type) && 'text-right tabular')}>
                    {show(c.type, s.totals![c.key] ?? null)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
        {s.rows.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-ink-3">{s.empty ?? 'Inga rader'}</div>}
      </Card>
    </section>
  );
}
