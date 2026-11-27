'use client';

import { useEffect, useState } from 'react';
import { cx } from './ui';

/**
 * Ljust, mörkt eller följ systemet. Valet sparas i webbläsaren och läses av
 * themeScript i layout.tsx innan sidan ritas, så att den inte blinkar.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'theme';

export const themeScript = `(function(){try{var t=localStorage.getItem('${KEY}');var d=t==='dark'||((t!=='light')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const options: { key: ThemeChoice; label: string; d: string }[] = [
  { key: 'light', label: 'Ljust', d: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1' },
  { key: 'dark', label: 'Mörkt', d: 'M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z' },
  { key: 'system', label: 'Följ systemet', d: 'M3 4h14v9H3zM7 17h6M10 13v4' },
];

export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => setChoice(read()), []);

  // Följer systemet: byt direkt när datorn växlar mellan ljust och mörkt.
  useEffect(() => {
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  function pick(c: ThemeChoice) {
    setChoice(c);
    try {
      if (c === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // Privat läge utan lagring: temat gäller bara tills sidan laddas om.
    }
    apply(c);
  }

  return (
    <div role="radiogroup" aria-label="Utseende" className={cx('flex rounded-md bg-subtle p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={choice === o.key}
          title={o.label}
          onClick={() => pick(o.key)}
          className={cx(
            'flex h-6 flex-1 items-center justify-center rounded text-ink-3 transition-colors hover:text-ink',
            choice === o.key && 'bg-surface text-ink shadow-card',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={o.d} />
          </svg>
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
