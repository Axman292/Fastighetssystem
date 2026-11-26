'use client';

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, useEffect } from 'react';

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
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-hover',
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
        'inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-medium',
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

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-subtle/60">
            {head.map((h, i) => (
              <th key={i} className="h-8 px-4 text-[12px] font-medium text-ink-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {rows.length === 0 && empty && <div className="px-4 py-10 text-center text-[13px] text-ink-3">{empty}</div>}
    </Card>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx('h-10 px-4', className)}>{children}</td>;
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} className="w-full max-w-md rounded-lg bg-surface shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
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
