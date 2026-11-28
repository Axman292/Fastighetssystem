'use client';

import { ComponentProps, ReactNode, useRef } from 'react';
import { cx } from './ui';

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={cx(
        'w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
        className,
      )}
    />
  );
}

/** Textfält med knappar som lägger in kopplingsfält där markören står. */
export function MergeText({
  value,
  onChange,
  fields,
  rows = 8,
  single,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  fields: { key: string; label: string }[];
  rows?: number;
  single?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div>
      {single ? (
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
      ) : (
        <TextArea ref={ref} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {fields.map((f) => (
          <button
            key={f.key}
            type="button"
            title={f.label}
            onClick={() => insert(f.key)}
            className="h-5 rounded bg-subtle px-1.5 font-mono text-[11px] text-ink-2 hover:bg-accent-soft hover:text-accent"
          >
            {`{${f.key}}`}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'h-6 rounded-full px-2.5 text-[12px] font-medium transition-colors',
        active ? 'bg-accent-soft text-accent' : 'bg-subtle text-ink-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export function CheckList({
  options,
  selected,
  onChange,
  allLabel,
}: {
  options: Record<string, string>;
  selected: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
}) {
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2">
      {allLabel && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={!selected.length} onChange={() => onChange([])} />
          {allLabel}
        </label>
      )}
      {Object.entries(options).map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-accent)]"
            checked={selected.includes(key)}
            onChange={(e) => onChange(e.target.checked ? [...selected, key] : selected.filter((x) => x !== key))}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-[13px]">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-[12px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

/** Ett meddelande som det ser ut för mottagaren. */
export function MessageBubble({ channel, subject, body, from }: { channel: 'email' | 'sms'; subject?: string | null; body: string; from?: string }) {
  if (channel === 'sms') {
    return (
      <div className="max-w-[300px]">
        {from && <div className="mb-1 text-[11.5px] text-ink-3">{from}</div>}
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-subtle px-3 py-2 text-[13px] text-ink">{body}</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="border-b border-line px-3 py-2 text-[13px]">
        {from && <div className="text-[11.5px] text-ink-3">Från {from}</div>}
        <div className="font-medium">{subject}</div>
      </div>
      <div className="whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-relaxed text-ink">{body}</div>
    </div>
  );
}
