'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Sortering av tabeller: klick på en rubrik sorterar stigande, nästa klick
 * fallande och tredje klicket tillbaka till ursprunglig ordning. Valet sparas
 * per tabell i webbläsaren så att det finns kvar när man går mellan sidor.
 */

export type SortDir = 'asc' | 'desc';
export interface SortState {
  /** Rubriken som sorteringen gäller. Sparas som text så att den överlever att kolumner visas/döljs. */
  label: string;
  dir: SortDir;
}
export type SortValue = string | number | null;

const collator = new Intl.Collator('sv', { numeric: true, sensitivity: 'base' });

const EMPTY = new Set(['', '–', '-', '—']);
const UNIT = /^(|kr|sek|mnkr|tkr|%|m²|m2|kr\/m²|kr\/mån|\/mån|st|dagar|dag|mån|år)$/i;
const MULTIPLIER: Record<string, number> = { mnkr: 1_000_000, tkr: 1_000 };

/**
 * Tolkar en visad cell till ett värde att sortera på. Belopp som "1 234,50 kr",
 * "−300 kr", "12,5 m²", "25 %" och "32,5 mnkr" blir tal. Datum som 2026-11-28
 * sorteras rätt som text. Tomt ("–") blir null och hamnar alltid sist.
 */
export function parseSortValue(raw: string): SortValue {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (EMPTY.has(text)) return null;
  const compact = text.replace(/[\s\u00a0\u202f]/g, '');
  const m = /^([+\-−–]?)(\d+(?:,\d+)?)(.*)$/.exec(compact);
  if (m && UNIT.test(m[3])) {
    const n = Number(m[2].replace(',', '.')) * (MULTIPLIER[m[3].toLowerCase()] ?? 1);
    return m[1] && m[1] !== '+' ? -n : n;
  }
  return text;
}

/** Jämför två värden. Tal före text, tomma alltid sist oavsett riktning. */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  let c: number;
  if (typeof a === 'number' && typeof b === 'number') c = a - b;
  else if (typeof a === 'number') c = -1;
  else if (typeof b === 'number') c = 1;
  else c = collator.compare(a, b);
  return dir === 'asc' ? c : -c;
}

/** Värde från rådata (rapporter), t.ex. tal, datumtext eller null. */
export function toSortValue(v: unknown): SortValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Sidans adress utan id:n, så att t.ex. alla kundkort delar samma sortering. */
export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) ? ':id' : seg))
    .join('/');
}

const PREFIX = 'tabellsortering:';

function read(key: string): SortState | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as SortState;
    return v && typeof v.label === 'string' && (v.dir === 'asc' || v.dir === 'desc') ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, v: SortState | null) {
  try {
    if (v) localStorage.setItem(PREFIX + key, JSON.stringify(v));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* privat läge e.d. – sorteringen fungerar ändå, den sparas bara inte */
  }
}

/** Sorteringsval för en tabell, sparat under `key`. */
export function useSortState(key: string) {
  const [sort, setSort] = useState<SortState | null>(null);
  useEffect(() => setSort(read(key)), [key]);
  const toggle = useCallback(
    (label: string) => {
      setSort((cur) => {
        const next: SortState | null =
          !cur || cur.label !== label ? { label, dir: 'asc' } : cur.dir === 'asc' ? { label, dir: 'desc' } : null;
        write(key, next);
        return next;
      });
    },
    [key],
  );
  return { sort, toggle };
}
