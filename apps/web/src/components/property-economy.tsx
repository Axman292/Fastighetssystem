'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { PeriodPicker, PeriodValue, periodRange } from './period-picker';
import { Badge, Button, Card, Dialog, ErrorNote, Input, Stat, Table, Td, cx } from './ui';
import { api, ApiError } from '@/lib/api';
import { SUPPLIER_INVOICE_STATUS, fmtInt, fmtMsek, fmtOre, fmtPct } from '@/lib/format';

export interface Kpi {
  incomeOre: number;
  opexOre: number;
  netOperatingOre: number;
  resultAfterInterestOre: number;
  netOperatingYearOre: number;
  yield: number | null;
  vacancyRate: number | null;
  rentPerM2: number | null;
  costPerM2: number | null;
  budgetNetOperatingOre: number | null;
}

interface StatementRow {
  group: string;
  label: string;
  actualOre: number;
  estimatedOre: number | null;
  valueOre: number;
  budgetOre: number | null;
}

interface PropertyEconomyData {
  period: { from: string; to: string; days: number };
  name: string;
  areaM2: number;
  valueSek: number | null;
  rentValueOre: number;
  vacantRentOre: number;
  hasBudget: boolean;
  kpi: Kpi;
  statement: StatementRow[];
  monthly: { month: string; incomeOre: number; opexOre: number; netOperatingOre: number }[];
  byAccount: { account: string; name: string | null; groupLabel: string; amountOre: number; invoiceCount: number }[];
  costLines: { invoiceId: string; entryNr: number; invoiceDate: string; supplierName: string; status: string; account: string; description: string | null; objectNr: string | null; amountOre: number; periodFrom: string | null; periodTo: string | null }[];
}

const INCOME = ['rent_income', 'other_income'];
const OPEX = ['operating', 'maintenance', 'property_tax', 'insurance', 'admin'];

/** Fastighetens resultaträkning med nyckeltal och budget mot utfall. */
export function PropertyEconomy({ propertyId, companyId, editable }: { propertyId: string; companyId: string; editable: boolean }) {
  const [period, setPeriod] = useState<PeriodValue>({ year: new Date().getFullYear(), key: 'year' });
  const [data, setData] = useState<PropertyEconomyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const range = periodRange(period);

  const load = useCallback(() => {
    setError(null);
    api<PropertyEconomyData>(`/economy/properties/${propertyId}?from=${range.from}&to=${range.to}`, { companyId })
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, [propertyId, companyId, range.from, range.to]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const k = data.kpi;
  const s = Object.fromEntries(data.statement.map((r) => [r.group, r]));
  const sum = (gs: string[], f: (r: StatementRow) => number | null) => gs.reduce((t, g) => t + (f(s[g]) ?? 0), 0);
  const hasBudget = data.hasBudget;
  const estimated = data.statement.filter((r) => r.estimatedOre !== null);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-3">
            {data.period.from} – {data.period.to}
          </span>
          <Button variant="secondary" onClick={() => setBudgetOpen(true)}>
            Budget {period.year}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat
          label="Driftnetto"
          value={fmtOre(k.netOperatingOre)}
          sub={k.budgetNetOperatingOre !== null ? `budget ${fmtOre(k.budgetNetOperatingOre)}` : `intäkter ${fmtOre(k.incomeOre)}`}
        />
        <Stat
          label="Direktavkastning"
          value={fmtPct(k.yield)}
          sub={data.valueSek ? `driftnetto i helårstakt på ${fmtMsek(data.valueSek)}` : 'ange marknadsvärde under Taxering, värdering och lån'}
        />
        <Stat label="Ekonomisk vakansgrad" value={fmtPct(k.vacancyRate)} sub={data.rentValueOre ? `${fmtOre(data.vacantRentOre)} av hyresvärdet ${fmtOre(data.rentValueOre)}` : 'inget hyresvärde'} />
        <Stat
          label="Hyresintäkt per m² och år"
          value={k.rentPerM2 !== null ? `${fmtInt(k.rentPerM2)} kr` : '–'}
          sub={k.costPerM2 !== null ? `kostnad ${fmtInt(k.costPerM2)} kr/m² · ${fmtInt(data.areaM2)} m²` : undefined}
        />
      </div>

      <section>
        <h2 className="mb-2 text-[14px] font-semibold">Resultaträkning</h2>
        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle/60 text-[12px] text-ink-3">
                <th className="h-8 px-4 font-medium" />
                <th className="h-8 w-40 px-4 text-right font-medium">Utfall</th>
                {hasBudget && <th className="h-8 w-40 px-4 text-right font-medium">Budget</th>}
                {hasBudget && <th className="h-8 w-40 px-4 text-right font-medium">Avvikelse</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {INCOME.map((g) => (
                <Line key={g} row={s[g]} hasBudget={hasBudget} income />
              ))}
              <Total label="Summa intäkter" value={sum(INCOME, (r) => r.valueOre)} budget={sum(INCOME, (r) => r.budgetOre)} hasBudget={hasBudget} income />
              {OPEX.map((g) => (
                <Line key={g} row={s[g]} hasBudget={hasBudget} />
              ))}
              <Total label="Summa drift- och underhållskostnader" value={-sum(OPEX, (r) => r.valueOre)} budget={-sum(OPEX, (r) => r.budgetOre)} hasBudget={hasBudget} income />
              <Total label="Driftnetto" value={k.netOperatingOre} budget={k.budgetNetOperatingOre ?? 0} hasBudget={hasBudget} income strong />
              <Line row={s.interest} hasBudget={hasBudget} />
              <Total
                label="Resultat efter räntor"
                value={k.resultAfterInterestOre}
                budget={(k.budgetNetOperatingOre ?? 0) - (s.interest.budgetOre ?? 0)}
                hasBudget={hasBudget}
                income
                strong
              />
              {(s.investment.valueOre !== 0 || (s.investment.budgetOre ?? 0) !== 0) && <Line row={s.investment} hasBudget={hasBudget} note="Aktiveras, ingår inte i resultatet" />}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-[12px] text-ink-3">
          Intäkter är utfärdade hyresavier och fakturor för perioden. Kostnader är leverantörsfakturor som konterats på fastigheten och som inte makulerats, fördelade på den
          period de avser. Moms som inte är avdragsgill räknas som kostnad.
          {estimated.length > 0 &&
            ` ${estimated.map((r) => r.label.toLowerCase()).join(', ').replace(/^./, (c) => c.toUpperCase())} saknar bokade kostnader och är beräknade ur fastighetsregistret.`}
        </p>
      </section>

      {data.monthly.length > 1 && (
        <section>
          <h2 className="mb-2 text-[14px] font-semibold">Per månad</h2>
          <MonthTable rows={data.monthly} />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[14px] font-semibold">Kostnader per konto</h2>
        <Table head={['Konto', 'Grupp', 'Fakturor', 'Belopp']} empty="Inga leverantörsfakturor konterade på fastigheten under perioden.">
          {data.byAccount.map((a) => (
            <tr key={a.account}>
              <Td className="tabular">
                <span className="font-medium">{a.account}</span> <span className="text-ink-2">{a.name}</span>
              </Td>
              <Td className="text-ink-2">{a.groupLabel}</Td>
              <Td className="tabular text-ink-2">{a.invoiceCount}</Td>
              <Td className="tabular">{fmtOre(a.amountOre)}</Td>
            </tr>
          ))}
        </Table>
      </section>

      {data.costLines.length > 0 && (
        <section>
          <h2 className="mb-2 text-[14px] font-semibold">Leverantörsfakturor</h2>
          <Table head={['Nr', 'Datum', 'Leverantör', 'Konto', 'Text', 'Avser', 'Belopp', 'Status']}>
            {data.costLines.map((l, i) => (
              <tr key={i}>
                <Td className="tabular text-ink-3">
                  <Link href={`/leverantorsfakturor/${l.invoiceId}`} className="hover:underline">
                    {l.entryNr}
                  </Link>
                </Td>
                <Td className="tabular text-ink-2">{l.invoiceDate}</Td>
                <Td className="font-medium">{l.supplierName}</Td>
                <Td className="tabular">{l.account}</Td>
                <Td className="text-ink-2">
                  {l.description ?? ''}
                  {l.objectNr && <span className="text-ink-3"> · objekt {l.objectNr}</span>}
                </Td>
                <Td className="tabular text-ink-2">{l.periodFrom ? `${l.periodFrom} – ${l.periodTo}` : '–'}</Td>
                <Td className="tabular">{fmtOre(l.amountOre, true)}</Td>
                <Td>
                  <Badge tone={SUPPLIER_INVOICE_STATUS[l.status]?.tone}>{SUPPLIER_INVOICE_STATUS[l.status]?.label}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      <BudgetDialog
        open={budgetOpen}
        propertyId={propertyId}
        companyId={companyId}
        year={period.year}
        editable={editable}
        onClose={() => setBudgetOpen(false)}
        onSaved={() => {
          setBudgetOpen(false);
          load();
        }}
      />
    </div>
  );
}

function Line({ row, hasBudget, income, note }: { row: StatementRow; hasBudget: boolean; income?: boolean; note?: string }) {
  const sign = income ? 1 : -1;
  const diff = row.budgetOre !== null ? sign * (row.valueOre - row.budgetOre) + 0 : null;
  return (
    <tr>
      <td className="h-9 px-4 pl-8 text-ink-2">
        {row.label}
        {row.estimatedOre !== null && (
          <span className="ml-2" title="Inga bokade kostnader. Beräknat ur taxering, försäkringspremie eller lån i fastighetsregistret.">
            <Badge tone="warn">Beräknat</Badge>
          </span>
        )}
        {note && <span className="ml-2 text-[12px] text-ink-3">{note}</span>}
      </td>
      <td className="h-9 px-4 text-right tabular">{fmtOre(sign * row.valueOre + 0)}</td>
      {hasBudget && <td className="h-9 px-4 text-right tabular text-ink-2">{row.budgetOre !== null ? fmtOre(sign * row.budgetOre + 0) : '–'}</td>}
      {hasBudget && <td className={cx('h-9 px-4 text-right tabular', diff !== null && diff < 0 ? 'text-bad' : diff ? 'text-good' : 'text-ink-3')}>{diff !== null ? fmtOre(diff) : '–'}</td>}
    </tr>
  );
}

function Total({ label, value, budget, hasBudget, strong }: { label: string; value: number; budget: number; hasBudget: boolean; income?: boolean; strong?: boolean }) {
  const diff = value - budget + 0;
  return (
    <tr className={cx(strong ? 'bg-subtle/60 font-semibold' : 'font-medium')}>
      <td className="h-9 px-4">{label}</td>
      <td className="h-9 px-4 text-right tabular">{fmtOre(value)}</td>
      {hasBudget && <td className="h-9 px-4 text-right tabular text-ink-2">{fmtOre(budget)}</td>}
      {hasBudget && <td className={cx('h-9 px-4 text-right tabular', diff < 0 ? 'text-bad' : diff ? 'text-good' : 'text-ink-3')}>{fmtOre(diff)}</td>}
    </tr>
  );
}

function MonthTable({ rows }: { rows: PropertyEconomyData['monthly'] }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.incomeOre, r.opexOre)));
  return (
    <Table head={['Månad', 'Intäkter', 'Kostnader', 'Driftnetto', '']}>
      {rows.map((r) => (
        <tr key={r.month}>
          <Td className="tabular font-medium">{r.month}</Td>
          <Td className="tabular">{fmtOre(r.incomeOre)}</Td>
          <Td className="tabular">{fmtOre(r.opexOre)}</Td>
          <Td className={cx('tabular', r.netOperatingOre < 0 && 'text-bad')}>{fmtOre(r.netOperatingOre)}</Td>
          <Td className="w-56">
            <div className="space-y-0.5" aria-hidden>
              <div className="h-1.5 rounded-sm bg-accent" style={{ width: `${(Math.max(0, r.incomeOre) / max) * 100}%` }} />
              <div className="h-1.5 rounded-sm bg-ink-3/50" style={{ width: `${(Math.max(0, r.opexOre) / max) * 100}%` }} />
            </div>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function BudgetDialog({
  open,
  propertyId,
  companyId,
  year,
  editable,
  onClose,
  onSaved,
}: {
  open: boolean;
  propertyId: string;
  companyId: string;
  year: number;
  editable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<{ reportGroup: string; label: string; amountOre: number | null; previousYearOre: number }[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    api<NonNullable<typeof rows>>(`/economy/properties/${propertyId}/budget/${year}`, { companyId }).then((r) => {
      setRows(r);
      setValues(Object.fromEntries(r.map((x) => [x.reportGroup, x.amountOre !== null ? String(Math.round(x.amountOre / 100)) : ''])));
    });
  }, [open, propertyId, companyId, year]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const lines = Object.entries(values).map(([reportGroup, v]) => ({
        reportGroup,
        amount: v.trim() ? Number(v.replace(/\s/g, '').replace(',', '.')) : null,
      }));
      await api(`/economy/properties/${propertyId}/budget/${year}`, { method: 'PUT', body: { lines }, companyId });
      onSaved();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Budget ${year}`} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[13px] text-ink-2">Belopp för helåret i kronor, intäkter och kostnader som positiva tal. Budgeten fördelas jämnt per dag när en kortare period visas.</p>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[12px] text-ink-3">
              <th className="pb-2 text-left font-medium" />
              <th className="pb-2 text-right font-medium">Utfall {year - 1}</th>
              <th className="w-44 pb-2 pl-4 text-right font-medium">Budget {year} (kr)</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.reportGroup}>
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-right tabular text-ink-2">{fmtOre(r.previousYearOre)}</td>
                <td className="py-1 pl-4">
                  <Input
                    aria-label={`Budget ${r.label}`}
                    inputMode="decimal"
                    className="text-right"
                    disabled={!editable}
                    value={values[r.reportGroup] ?? ''}
                    onChange={(e) => setValues({ ...values, [r.reportGroup]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {editable ? 'Avbryt' : 'Stäng'}
          </Button>
          {editable && <Button type="submit">Spara budget</Button>}
        </div>
      </form>
    </Dialog>
  );
}
