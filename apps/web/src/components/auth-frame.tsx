'use client';

import { ReactNode } from 'react';
import { ThemeToggle } from './theme';
import { Logo } from './ui';

/** Ram för sidorna utanför inloggningen: logga in, glömt lösenord, välj lösenord. */
export function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center p-4">
      <ThemeToggle className="absolute right-4 top-4 w-24" />
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold">Fastighetssystem</span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-2">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
