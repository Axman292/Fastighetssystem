'use client';

import {
  ButtonHTMLAttributes,
  Children,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { usePathname } from 'next/navigation';
import { SortDir, compareSortValues, normalizePath, parseSortValue, useSortState } from '@/lib/table-sort';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-on-accent hover:bg-accent-hover',
        variant === 'secondary' && 'bg-surface text-ink shadow-card hover:bg-subtle',
        variant === 'ghost' && 'text-ink-2 hover:bg-subtle hover:text-ink',
        variant === 'danger' && 'bg-surface text-bad shadow-card hover:bg-bad-soft',
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[13px] text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
        className,
      )}
    />
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="block text-[12px] text-bad">{error}</span> : hint ? <span className="block text-[12px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg bg-surface shadow-card', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-[11.5px] font-medium',
        tone === 'neutral' && 'bg-subtle text-ink-2',
        tone === 'good' && 'bg-good-soft text-good',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'bad' && 'bg-bad-soft text-bad',
        tone === 'accent' && 'bg-accent-soft text-accent',
      )}
    >
      {children}
    </span>
  );
}

/** Rubrikens text, även när rubriken är ett element som <span className="text-right">Belopp</span>. */
function headText(h: ReactNode): string {
  if (typeof h === 'string' || typeof h === 'number') return String(h);
  if (Array.isArray(h)) return h.map(headText).join('');
  if (isValidElement<{ children?: ReactNode }>(h)) return headText(h.props.children);
  return '';
}

function headAlignedRight(h: ReactNode): boolean {
  return isValidElement<{ className?: string }>(h) && /\btext-right\b/.test(h.props.className ?? '');
}

/** Liten pil som visar sorteringen. Utan aktiv sortering syns den svagt när man pekar på rubriken. */
export function SortArrow({ dir }: { dir?: SortDir | null }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      className={cx('shrink-0', dir ? 'text-ink' : 'text-ink-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
    >
      {dir === 'desc' ? (
        <path d="M5 8 1.5 3.5h7z" fill="currentColor" />
      ) : dir === 'asc' ? (
        <path d="M5 2 8.5 6.5h-7z" fill="currentColor" />
      ) : (
        <path d="M5 1 7.5 4h-5zM5 9 2.5 6h5z" fill="currentColor" />
      )}
    </svg>
  );
}

/** Klickbar rubrik. Används av Table och av tabeller som sorterar på egen data (t.ex. rapporter). */
export function SortHeader({
  label,
  dir,
  onClick,
  alignRight,
  children,
}: {
  label: string;
  dir?: SortDir | null;
  onClick: () => void;
  alignRight?: boolean;
  children?: ReactNode;
}) {
  const next = !dir ? 'stigande' : dir === 'asc' ? 'fallande' : 'ursprunglig ordning';
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sortera på ${label.toLowerCase()} (${next})`}
      className={cx(
        'group -mx-1 inline-flex items-center gap-1 whitespace-nowrap rounded px-1 font-medium hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
        dir && 'text-ink',
        alignRight && 'w-[calc(100%+0.5rem)] justify-end',
      )}
    >
      {children ?? label}
      <SortArrow dir={dir} />
    </button>
  );
}

/**
 * Standardtabellen. Rubriker med text går att klicka på för att sortera
 * (stigande, fallande, tillbaka). Sorteringen läser det som visas i cellerna, så
 * belopp, datum, namn (svensk ordning, å ä ö sist) och status sorteras som man
 * ser dem. En cell kan ange eget sorteringsvärde med <Td sortValue={…}>.
 * Summarader läggs i `foot` så att de stannar sist. Valet sparas per sida och tabell.
 */
export function Table({
  head,
  children,
  empty,
  foot,
  sortable = true,
  sortKey,
}: {
  head: ReactNode[];
  children: ReactNode;
  empty?: ReactNode;
  /** Rader som alltid ligger sist, t.ex. summa. */
  foot?: ReactNode;
  /** false för tabeller där ordningen betyder något, t.ex. redigerbara rader. */
  sortable?: boolean;
  /** Egen nyckel för att spara sorteringen. Standard är sidan och rubrikerna. */
  sortKey?: string;
}) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const labels = head.map(headText);
  const pathname = usePathname() ?? '';
  // "Bolag" visas bara när alla bolag är valda; den ska inte ge en ny nyckel.
  const key = sortKey ?? `${normalizePath(pathname)}|${labels.filter((l) => l && l !== 'Bolag').join('|')}`;
  const { sort, toggle } = useSortState(key);
  const col = sort ? labels.indexOf(sort.label) : -1;
  const active = sortable && sort && col >= 0 ? { col, dir: sort.dir } : null;

  const [order, setOrder] = useState<string[] | null>(null);
  const [rowsMatch, setRowsMatch] = useState(true);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  let shown = items;
  if (active && order) {
    const byKey = new Map(items.map((el) => [String(el.key), el]));
    const seen = new Set<string>();
    shown = [];
    for (const k of order) {
      const el = byKey.get(k);
      if (el) {
        shown.push(el);
        seen.add(k);
      }
    }
    for (const el of items) if (!seen.has(String(el.key))) shown.push(el);
  }

  // Läser de visade cellerna efter varje rendering och ordnar raderna. Körs innan
  // skärmen ritas, så ingen hoppande lista syns. Ordningen är entydig (lika värden
  // behåller ursprunglig ordning) och blir därför stabil efter en omgång.
  useLayoutEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const match = tbody.rows.length === shown.length;
    if (match !== rowsMatch) setRowsMatch(match);
    if (!active || !match) {
      if (order) setOrder(null);
      return;
    }
    const original = new Map(items.map((el, i) => [String(el.key), i]));
    const values = shown.map((el, i) => {
      const cell = tbody.rows[i].cells[active.col] as HTMLTableCellElement | undefined;
      const raw = cell ? (cell.dataset.sort ?? cell.textContent ?? '') : '';
      return { key: String(el.key), idx: original.get(String(el.key)) ?? i, v: parseSortValue(raw) };
    });
    values.sort((a, b) => compareSortValues(a.v, b.v, active.dir) || a.idx - b.idx);
    const next = values.map((x) => x.key);
    const same = (o: string[] | null) => !!o && o.length === next.length && o.every((k, i) => k === next[i]);
    if (!same(order) || !same(shown.map((el) => String(el.key)))) setOrder(next);
  });

  const canSort = sortable && rowsMatch && items.length > 1;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-subtle/60">
            {head.map((h, i) => {
              const label = labels[i].trim();
              const dir = active?.col === i ? active.dir : null;
              return (
                <th
                  key={i}
                  className="h-8 px-4 text-[12px] font-medium text-ink-3"
                  aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {canSort && label ? (
                    <SortHeader label={label} dir={dir} onClick={() => toggle(label)} alignRight={headAlignedRight(h)} />
                  ) : (
                    h
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={tbodyRef} className="divide-y divide-line">
          {shown}
        </tbody>
        {foot && <tfoot className="border-t border-line">{foot}</tfoot>}
      </table>
      {items.length === 0 && empty && <div className="px-4 py-10 text-center text-[13px] text-ink-3">{empty}</div>}
    </Card>
  );
}

export function Td({ children, className, sortValue }: { children?: ReactNode; className?: string; sortValue?: string | number | null }) {
  return (
    <td className={cx('h-10 px-4', className)} data-sort={sortValue === undefined ? undefined : String(sortValue ?? '')}>
      {children}
    </td>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-backdrop p-4 pt-[8vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} className={cx('w-full rounded-lg bg-surface shadow-pop', wide ? 'max-w-2xl' : 'max-w-md')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-5 py-3.5 text-[14px] font-semibold">{title}</div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ErrorNote({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{message}</div>;
}

export function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--color-accent)" />
      <path d="M6 17V10l6-4 6 4v7h-4v-4h-4v4z" fill="white" />
    </svg>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium',
            value === t.key ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded bg-subtle px-1 text-[11px] text-ink-3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tabular tracking-[-0.01em]">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div>}
    </Card>
  );
}
