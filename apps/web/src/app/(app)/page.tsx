'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';
import { Badge, Card, cx, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtOre, fmtPct } from '@/lib/format';
import { useSession } from '@/lib/session';

/**
 * Startsidan: nyckeltal för valt bolag eller hela koncernen. Varje tal länkar
 * till listan det är räknat ur. Allt kommer från /dashboard i ett anrop.
 */
export default function OverviewPage() {
  const { me, active, version } = useSession();
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api<Dashboard>('/dashboard')
      .then(setD)
      .catch((e) => setError(e instanceof Error ? e.message : 'Kunde inte hämta nyckeltalen'));
  }, [version]);

  const scope = active ? active.companyName : 'Hela koncernen';
  const o = d?.occupancy;
  const r = d?.receivables;
  const p = d?.payments;
  const c = d?.contracts;

  return (
    <>
      <PageHeader title={`God ${greeting()}, ${me.user.name.split(' ')[0]}`} description={`Visar ${scope}${d ? ` per ${d.today}` : ''}.`} />
      {error && <Card className="mb-4 px-4 py-3 text-[13px] text-bad">{error}</Card>}

      {/* Huvudtalen */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          href="/rapporter/hyreslista"
          label="Uthyrningsgrad"
          value={o ? fmtPct(o.byValue) : undefined}
          sub={o ? `${o.let} av ${o.objects} objekt uthyrda (${fmtPct(o.byCount)})` : undefined}
          meter={o?.byValue ?? undefined}
          hint="Räknat på hyresvärde"
        />
        <Kpi
          href="/avtal?tab=all"
          label="Avtalad hyra per månad"
          value={d ? fmtOre(d.rent.monthlyOre) : undefined}
          sub={d ? `${fmtOre(d.rent.monthlyOre * 12)} per år · ${d.rent.contracts} avtal` : undefined}
          hint="Exklusive moms"
        />
        <Kpi
          href="/fakturor?tab=open"
          label="Obetalt"
          value={r ? fmtOre(r.openOre) : undefined}
          sub={r ? (r.overdueOre ? `varav ${fmtOre(r.overdueOre)} förfallet` : `${r.openCount} fakturor, inget förfallet`) : undefined}
          subTone={r && r.overdueOre > 0 ? 'warn' : undefined}
        />
        <Kpi
          href="/inbetalningar?tab=payments"
          label="Inbetalt denna månad"
          value={p ? fmtOre(p.thisMonthOre) : undefined}
          sub={p ? `${p.thisMonthCount} betalningar · förra månaden ${fmtOre(p.lastMonthOre)}` : undefined}
          meter={p && p.dueThisMonthOre > 0 ? Math.min(1, (p.dueThisMonthOre - p.dueThisMonthOpenOre) / p.dueThisMonthOre) : undefined}
          hint={p && p.dueThisMonthOre > 0 ? `${fmtOre(p.dueThisMonthOre - p.dueThisMonthOpenOre)} av ${fmtOre(p.dueThisMonthOre)} som förfaller i månaden är betalt` : undefined}
        />
      </div>

      {/* Saker att hålla koll på */}
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Small
          href="/rapporter/hyreslista"
          label="Lediga objekt"
          value={o ? String(o.vacant + o.upcoming) : undefined}
          sub={o ? (o.vacantRentOre ? `${fmtOre(o.vacantRentOre)} i månaden` : o.upcoming ? `${o.upcoming} med kommande avtal` : 'inga lediga') : undefined}
        />
        <Small
          href="/fakturor?tab=overdue"
          label="Förfallna fakturor"
          value={r ? String(r.overdueCount) : undefined}
          sub={r ? (r.overdueCount ? `${r.overdueCustomers} hyresgäster` : 'allt betalt i tid') : undefined}
          tone={r && r.overdueCount > 0 ? 'warn' : undefined}
        />
        <Small
          href="/inbetalningar?tab=todo"
          label="Omatchade inbetalningar"
          value={d ? String(d.unmatched.count) : undefined}
          sub={d ? (d.unmatched.count ? fmtOre(d.unmatched.amountOre) : 'allt kopplat') : undefined}
          tone={d && d.unmatched.count > 0 ? 'warn' : undefined}
        />
        <Small
          href="/avtal"
          label="Avtal att hantera"
          value={c ? String(c.attentionCount) : undefined}
          sub={c ? (c.attentionHigh ? `${c.attentionHigh} brådskande` : 'inget brådskande') : undefined}
          tone={c && c.attentionHigh > 0 ? 'warn' : undefined}
        />
        {d?.extras.map((e) => <Small key={e.key} href={e.href} label={e.label} value={e.value} sub={e.sub} tone={e.tone === 'neutral' ? undefined : e.tone} />)}
        {d && !d.extras.some((e) => e.key === 'fault-reports') && (
          <Card className="px-4 py-3">
            <div className="text-[12px] text-ink-3">Öppna felanmälningar</div>
            <div className="mt-1.5 text-[13px] text-ink-3">Visas här när felanmälan är på plats</div>
          </Card>
        )}
      </div>

      {/* Diagram */}
      <div className="mt-8 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="px-5 pb-4 pt-4 xl:col-span-2">
          <SectionHead title="Fakturerat och inbetalt per månad" href="/rapporter/manadsanalys" link="Månadsanalys" />
          {d ? <MonthChart months={d.months} /> : <ChartSkeleton />}
        </Card>
        <Card className="px-5 pb-4 pt-4">
          <SectionHead title="Obetalt efter ålder" href="/reskontra" link="Kundreskontra" />
          {r ? <AgingBars aging={r.aging} /> : <ChartSkeleton />}
        </Card>
      </div>

      {/* Avtal */}
      <div className="mt-8 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div>
          <SectionHead title="Avtal att hantera" href="/avtal" link="Alla att hantera" />
          <Card className="divide-y divide-line">
            {c?.attention.map((a, i) => (
              <ListLink key={i} href={`/avtal/${a.contractId}`} badge={<Badge tone={a.severity === 'high' ? 'warn' : 'neutral'}>{a.date}</Badge>} title={a.customerName} text={a.message} right={a.objects} />
            ))}
            {c && c.attention.length === 0 && <Empty>Inget att hantera just nu.</Empty>}
            {!c && <Empty>Hämtar …</Empty>}
          </Card>
        </div>
        <div>
          <SectionHead title="Avtal som slutar inom 90 dagar" href="/rapporter/in-och-avflyttning" link="In- och avflyttningar" />
          <Card className="divide-y divide-line">
            {c?.ending.slice(0, 6).map((e) => (
              <ListLink
                key={e.contractId}
                href={`/avtal/${e.contractId}`}
                badge={<Badge tone={daysUntil(e.endDate, d!.today) <= 30 ? 'warn' : 'neutral'}>{e.endDate}</Badge>}
                title={e.customerName}
                text={e.status === 'terminated' ? `Uppsagt, avtal ${e.contractNr}` : `Tidsbestämt utan förlängning, avtal ${e.contractNr}`}
                right={e.objects}
              />
            ))}
            {c && c.ending.length === 0 && <Empty>Inga avtal slutar de närmaste 90 dagarna.</Empty>}
            {!c && <Empty>Hämtar …</Empty>}
          </Card>
          <h3 className="mb-2 mt-5 text-[13px] font-semibold">Uppsägningar senaste 30 dagarna</h3>
          <Card className="divide-y divide-line">
            {c?.notices.slice(0, 5).map((n) => (
              <ListLink
                key={n.contractId}
                href={`/avtal/${n.contractId}`}
                badge={<Badge>{n.receivedDate}</Badge>}
                title={n.customerName}
                text={`${n.terminatedBy === 'landlord' ? 'Uppsagt av hyresvärden' : n.terminatedBy === 'mutual' ? 'Avslutas efter överenskommelse' : 'Uppsagt av hyresgästen'}, upphör ${n.endDate ?? '–'}`}
                right={n.objects}
              />
            ))}
            {c && c.notices.length === 0 && <Empty>Inga nya uppsägningar.</Empty>}
            {!c && <Empty>Hämtar …</Empty>}
          </Card>
        </div>
      </div>

      {/* Uthyrning per fastighet */}
      <div className="mt-8">
        <SectionHead title="Uthyrning per fastighet" href="/fastigheter" link="Alla fastigheter" />
        <Card className="divide-y divide-line">
          {d?.properties.map((pr) => (
            <Link key={pr.id} href={`/fastigheter/${pr.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/60">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{pr.name}</div>
                {!active && <div className="truncate text-[12px] text-ink-3">{pr.companyName}</div>}
              </div>
              <div className="hidden w-40 sm:block">
                <Meter value={pr.occupancy ?? 0} />
              </div>
              <div className="w-24 text-right text-[12px] text-ink-2 tabular">
                {pr.let} av {pr.objects}
              </div>
              <div className="w-14 text-right text-[13px] font-medium tabular">{fmtPct(pr.occupancy)}</div>
            </Link>
          ))}
          {d && d.properties.length === 0 && <Empty>Inga fastigheter med objekt än.</Empty>}
          {!d && <Empty>Hämtar …</Empty>}
        </Card>
      </div>

      {/* Per bolag i koncernvyn */}
      {!active && d && d.companies.length > 1 && (
        <div className="mt-8">
          <SectionHead title="Per bolag" href="/bolag" link="Alla bolag" />
          <Card className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-4 py-2.5 font-medium">Bolag</th>
                  <th className="px-4 py-2.5 text-right font-medium">Uthyrningsgrad</th>
                  <th className="px-4 py-2.5 text-right font-medium">Hyra per månad</th>
                  <th className="px-4 py-2.5 text-right font-medium">Obetalt</th>
                  <th className="px-4 py-2.5 text-right font-medium">Förfallet</th>
                  <th className="px-4 py-2.5 text-right font-medium">Omatchade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.companies.map((co) => (
                  <tr key={co.id} className="hover:bg-subtle/60">
                    <td className="px-4 py-2.5">
                      <Link href={`/bolag/${co.id}`} className="font-medium hover:underline">
                        {co.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {fmtPct(co.occupancy)} <span className="text-ink-3">({co.let}/{co.objects})</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">{fmtOre(co.monthlyRentOre)}</td>
                    <td className="px-4 py-2.5 text-right tabular">{fmtOre(co.openOre)}</td>
                    <td className={cx('px-4 py-2.5 text-right tabular', co.overdueOre > 0 && 'text-warn')}>{fmtOre(co.overdueOre)}</td>
                    <td className={cx('px-4 py-2.5 text-right tabular', co.unmatched > 0 && 'text-warn')}>{co.unmatched}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------

interface Dashboard {
  today: string;
  occupancy: {
    objects: number;
    let: number;
    notice: number;
    upcoming: number;
    vacant: number;
    byCount: number | null;
    byValue: number | null;
    vacantRentOre: number;
  };
  rent: { monthlyOre: number; monthlyVatOre: number; contracts: number };
  properties: { id: string; name: string; companyName: string; objects: number; let: number; occupancy: number | null }[];
  receivables: {
    openOre: number;
    openCount: number;
    overdueOre: number;
    overdueCount: number;
    overdueCustomers: number;
    aging: { key: string; label: string; amountOre: number }[];
  };
  payments: { thisMonthOre: number; thisMonthCount: number; lastMonthOre: number; dueThisMonthOre: number; dueThisMonthOpenOre: number };
  months: { month: string; invoicedOre: number; paidOre: number }[];
  unmatched: { count: number; amountOre: number };
  contracts: {
    ending: { contractId: string; contractNr: number; endDate: string; status: string; customerName: string; objects: string }[];
    notices: { contractId: string; contractNr: number; receivedDate: string; endDate: string | null; terminatedBy: string | null; customerName: string; objects: string }[];
    attention: { contractId: string; date: string; severity: 'high' | 'normal'; message: string; customerName: string; objects: string }[];
    attentionCount: number;
    attentionHigh: number;
  };
  companies: { id: string; name: string; objects: number; let: number; occupancy: number | null; monthlyRentOre: number; openOre: number; overdueOre: number; unmatched: number }[];
  extras: { key: string; label: string; value: string; sub?: string; href: string; tone?: 'neutral' | 'warn' | 'bad' }[];
}

// ---------------------------------------------------------------------
// Byggstenar
// ---------------------------------------------------------------------

function Kpi({ href, label, value, sub, hint, meter, subTone }: { href: string; label: string; value?: string; sub?: string; hint?: string; meter?: number; subTone?: 'warn' }) {
  return (
    <Link href={href} className="group block rounded-lg bg-surface px-4 py-3.5 shadow-card transition-colors hover:bg-subtle/50">
      <div className="flex items-center justify-between text-[12px] text-ink-3">
        <span>{label}</span>
        <Arrow />
      </div>
      <div className="mt-1 text-[24px] font-semibold tabular tracking-[-0.01em]">{value ?? '–'}</div>
      {sub && <div className={cx('mt-0.5 text-[12px]', subTone === 'warn' ? 'text-warn' : 'text-ink-2')}>{sub}</div>}
      {meter !== undefined && (
        <div className="mt-2.5">
          <Meter value={meter} />
        </div>
      )}
      {hint && <div className="mt-1.5 text-[11px] text-ink-3">{hint}</div>}
    </Link>
  );
}

function Small({ href, label, value, sub, tone }: { href: string; label: string; value?: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <Link href={href} className="group block rounded-lg bg-surface px-4 py-3 shadow-card transition-colors hover:bg-subtle/50">
      <div className="flex items-center justify-between text-[12px] text-ink-3">
        <span className="truncate">{label}</span>
        <Arrow />
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        {tone && <span className={cx('h-1.5 w-1.5 rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-warn')} aria-hidden />}
        <span className="text-[18px] font-semibold tabular">{value ?? '–'}</span>
      </div>
      {sub && <div className="truncate text-[12px] text-ink-3">{sub}</div>}
    </Link>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function Meter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${v * 100}%` }} />
    </div>
  );
}

function SectionHead({ title, href, link }: { title: string; href: string; link: string }) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <Link href={href} className="text-[12px] text-accent hover:underline">
        {link}
      </Link>
    </div>
  );
}

function ListLink({ href, badge, title, text, right }: { href: string; badge: ReactNode; title: string; text: string; right?: string }) {
  return (
    <Link href={href} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/60">
      <div className="shrink-0">{badge}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        <div className="truncate text-[12px] text-ink-2">{text}</div>
      </div>
      {right && <div className="hidden max-w-[30%] truncate text-[12px] text-ink-3 sm:block">{right}</div>}
    </Link>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-center text-[13px] text-ink-3">{children}</div>;
}

function ChartSkeleton() {
  return <div className="h-[220px] animate-pulse rounded-md bg-subtle/60" />;
}

// ---------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------

const monthName = new Intl.DateTimeFormat('sv-SE', { month: 'short' });
const monthLong = new Intl.DateTimeFormat('sv-SE', { month: 'long', year: 'numeric' });
const toDate = (ym: string) => new Date(`${ym}-15T12:00:00`);

/** Avrundar axelns tak uppåt till ett jämnt tal (1, 2 eller 5 gånger tiopotens). */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function shortKr(ore: number) {
  const kr = ore / 100;
  if (kr >= 1_000_000) return `${(kr / 1_000_000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} mn`;
  if (kr >= 1000) return `${Math.round(kr / 1000).toLocaleString('sv-SE')} tkr`;
  return `${Math.round(kr)} kr`;
}

function MonthChart({ months }: { months: Dashboard['months'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.invoicedOre, m.paidOre))));
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const empty = months.every((m) => !m.invoicedOre && !m.paidOre);
  const h = months[hover ?? -1];

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[12px] text-ink-2">
        <Legend color="bg-chart-1" label="Fakturerat" />
        <Legend color="bg-chart-2" label="Inbetalt" />
        <span className="ml-auto text-ink-3">Inklusive moms</span>
      </div>
      <div className="relative h-[200px] pl-16">
        {/* Rutnät och axel */}
        {ticks.map((t) => (
          <div key={t} className="absolute left-16 right-0 border-t border-line" style={{ bottom: `${(t / max) * 100}%` }}>
            <span className="absolute -left-16 -top-2 w-14 whitespace-nowrap text-right text-[11px] text-ink-3 tabular">{shortKr(t)}</span>
          </div>
        ))}
        <div className="relative flex h-full items-end">
          {months.map((m, i) => (
            <div
              key={m.month}
              className={cx('flex h-full flex-1 items-end justify-center gap-[2px] rounded-sm', hover === i && 'bg-subtle/70')}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${monthLong.format(toDate(m.month))}: fakturerat ${fmtOre(m.invoicedOre)}, inbetalt ${fmtOre(m.paidOre)}`}
            >
              <div className="w-[38%] max-w-[18px] rounded-t-[4px] bg-chart-1" style={{ height: `${(Math.max(0, m.invoicedOre) / max) * 100}%` }} />
              <div className="w-[38%] max-w-[18px] rounded-t-[4px] bg-chart-2" style={{ height: `${(Math.max(0, m.paidOre) / max) * 100}%` }} />
            </div>
          ))}
          {h && (
            <div
              className="pointer-events-none absolute top-1 z-10 w-48 rounded-md bg-surface px-3 py-2 text-[12px] shadow-pop"
              style={{ left: `${((hover! + 0.5) / months.length) * 100}%`, transform: hover! > months.length / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
            >
              <div className="mb-1 font-medium capitalize">{monthLong.format(toDate(h.month))}</div>
              <TipRow color="bg-chart-1" label="Fakturerat" value={fmtOre(h.invoicedOre)} />
              <TipRow color="bg-chart-2" label="Inbetalt" value={fmtOre(h.paidOre)} />
            </div>
          )}
        </div>
        {empty && <div className="absolute inset-0 flex items-center justify-center pl-16 text-[13px] text-ink-3">Inga fakturor eller inbetalningar det senaste året.</div>}
      </div>
      <div className="mt-1.5 flex pl-16">
        {months.map((m, i) => (
          <div key={m.month} className={cx('flex-1 text-center text-[11px]', hover === i ? 'text-ink' : 'text-ink-3')}>
            {monthName.format(toDate(m.month)).replace('.', '')}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx('h-2.5 w-2.5 rounded-[3px]', color)} aria-hidden />
      {label}
    </span>
  );
}

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={cx('h-2 w-2 rounded-[2px]', color)} aria-hidden />
      <span className="text-ink-2">{label}</span>
      <span className="ml-auto font-medium tabular">{value}</span>
    </div>
  );
}

function AgingBars({ aging }: { aging: Dashboard['receivables']['aging'] }) {
  const max = Math.max(...aging.map((a) => a.amountOre), 1);
  const total = aging.reduce((s, a) => s + a.amountOre, 0);
  return (
    <div className="space-y-3 pt-1">
      {aging.map((a) => (
        <div key={a.key} title={`${a.label}: ${fmtOre(a.amountOre)}`}>
          <div className="mb-1 flex justify-between text-[12px]">
            <span className="text-ink-2">{a.label}</span>
            <span className="font-medium tabular">{fmtOre(a.amountOre)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-subtle">
            <div className={cx('h-full rounded-full', a.key === 'notDue' ? 'bg-chart-1' : 'bg-warn')} style={{ width: `${(a.amountOre / max) * 100}%`, minWidth: a.amountOre ? 4 : 0 }} />
          </div>
        </div>
      ))}
      <div className="flex justify-between border-t border-line pt-2.5 text-[12px]">
        <span className="text-ink-3">Summa obetalt</span>
        <span className="font-semibold tabular">{fmtOre(total)}</span>
      </div>
    </div>
  );
}

function daysUntil(date: string, today: string) {
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

function greeting() {
  const h = new Date().getHours();
  return h < 10 ? 'morgon' : h < 18 ? 'dag' : 'kväll';
}
