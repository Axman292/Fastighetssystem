'use client';

import { Select } from './ui';
import { periodOptions } from '@/lib/format';

export interface PeriodValue {
  year: number;
  key: string;
}

export function periodRange(p: PeriodValue): { from: string; to: string; label: string } {
  const o = periodOptions(p.year).find((x) => x.key === p.key) ?? periodOptions(p.year)[0];
  return { from: o.from, to: o.to, label: o.key === 'year' ? o.label : `${o.label} ${p.year}` };
}

/** Väljer år och period (helår, kvartal eller månad). */
export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const now = new Date().getFullYear();
  const years = [now - 3, now - 2, now - 1, now, now + 1, now + 2];
  return (
    <div className="flex gap-2">
      <Select className="w-24" aria-label="År" value={value.year} onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
      <Select className="w-36" aria-label="Period" value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })}>
        {periodOptions(value.year).map((o) => (
          <option key={o.key} value={o.key}>
            {o.key === 'year' ? 'Helår' : o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
