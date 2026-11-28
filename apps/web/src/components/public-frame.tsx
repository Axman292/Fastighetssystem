'use client';

import { ReactNode } from 'react';
import { ThemeToggle } from './theme';

/** Ram för sidor som hyresgäster och hantverkare öppnar utan att logga in. */
export function PublicFrame({ company, title, subtitle, children }: { company?: string | null; title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="min-h-screen px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-[600px]">
        <div className="mb-6 flex items-center justify-between gap-3">
          <span className="text-[14px] font-semibold text-ink-2">{company ?? ''}</span>
          <ThemeToggle className="w-24" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <div className="mt-1 text-[13.5px] text-ink-2">{subtitle}</div>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function NotFound({ message }: { message: string }) {
  return (
    <PublicFrame title="Sidan finns inte">
      <p className="text-[14px] text-ink-2">{message}</p>
    </PublicFrame>
  );
}
