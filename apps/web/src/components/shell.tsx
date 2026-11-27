'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ThemeToggle } from './theme';
import { cx } from './ui';

const nav: { href: string; label: string; icon: ReactNode; soon?: boolean }[] = [
  { href: '/', label: 'Översikt', icon: <Icon d="M3 10.5 10 4l7 6.5V17h-5v-4H8v4H3z" /> },
  { href: '/bolag', label: 'Bolag', icon: <Icon d="M4 17V5h8v12M12 9h4v8M7 8h2M7 11h2M7 14h2" /> },
  { href: '/fastigheter', label: 'Fastigheter', icon: <Icon d="M3 17h14M5 17V8l5-3 5 3v9" /> },
  { href: '/objekt', label: 'Objekt', icon: <Icon d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z" /> },
  { href: '/kunder', label: 'Hyresgäster', icon: <Icon d="M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c0-3 3-5 6-5s6 2 6 5" /> },
  { href: '/avtal', label: 'Avtal', icon: <Icon d="M6 3h6l3 3v11H6zM9 9h4M9 12h4" /> },
  { href: '/avisering', label: 'Avisering', icon: <Icon d="M4 6h12v9H4zM4 6l6 5 6-5" /> },
  { href: '/fakturor', label: 'Fakturor', icon: <Icon d="M6 3h8v14l-2-1.5-2 1.5-2-1.5L6 17zM8.5 7h3M8.5 10h3" /> },
  { href: '/inbetalningar', label: 'Inbetalningar', icon: <Icon d="M3 7h14v9H3zM3 10h14M6 13h3" /> },
  { href: '/paminnelser', label: 'Påminnelser', icon: <Icon d="M10 3a5 5 0 0 0-5 5v3l-1.5 3h13L15 11V8a5 5 0 0 0-5-5zM8 16a2 2 0 0 0 4 0" /> },
  { href: '/reskontra', label: 'Kundreskontra', icon: <Icon d="M4 4h12v12H4zM4 8h12M8 8v8" /> },
  { href: '/leverantorer', label: 'Leverantörer', icon: <Icon d="M3 6h9v8H3zM12 9h3l2 2.5V14h-5M6 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM14 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" /> },
  { href: '/leverantorsfakturor', label: 'Leverantörsfakturor', icon: <Icon d="M6 3h8v14l-2-1.5-2 1.5-2-1.5L6 17zM8.5 7h3M8.5 10h3M8.5 13h2" /> },
  { href: '/ekonomi', label: 'Ekonomi', icon: <Icon d="M4 16V9M8 16V5M12 16v-5M16 16V7" /> },
];

const admin = [
  { href: '/artiklar', label: 'Artiklar', icon: <Icon d="M4 5h12M4 10h12M4 15h7M15 13l2 2-2 2" /> },
  { href: '/kontoplan', label: 'Kontoplan', icon: <Icon d="M4 4h12v12H4zM4 8h12M4 12h12M8 4v12" /> },
  { href: '/import', label: 'Importcentral', icon: <Icon d="M10 3v9M6 8l4 4 4-4M4 14v3h12v-3" /> },
  { href: '/anvandare', label: 'Användare', icon: <Icon d="M8 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 16c0-3 3-4.5 6-4.5s6 1.5 6 4.5M14 4a2.5 2.5 0 0 1 0 5M16 11.5c1.5.5 2.5 1.8 2.5 4" /> },
  { href: '/logg', label: 'Revisionslogg', icon: <Icon d="M10 4v6l4 2M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" /> },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me } = useSession();

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col border-r border-line bg-canvas px-3 py-3">
        <CompanySwitcher />
        <nav className="mt-4 space-y-0.5">
          {nav.map((n) => (
            <NavItem key={n.label} {...n} active={n.href === '/' ? pathname === '/' : pathname.startsWith(n.href) && n.href !== '#'} />
          ))}
        </nav>
        <div className="mt-6 px-2 text-[11.5px] font-medium text-ink-3">Administration</div>
        <nav className="mt-1 space-y-0.5">
          {admin.map((n) => (
            <NavItem key={n.label} {...n} active={pathname.startsWith(n.href)} />
          ))}
        </nav>
        <ThemeToggle className="mx-2 mt-auto" />
        <div className="mt-2 flex items-center gap-2 rounded-md px-2 py-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
            {initials(me.user.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{me.user.name}</div>
            <div className="truncate text-[11.5px] text-ink-3">{me.user.email}</div>
          </div>
          <button
            className="rounded p-1 text-ink-3 hover:bg-subtle hover:text-ink"
            title="Logga ut"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' });
              window.location.href = '/login';
            }}
          >
            <Icon d="M8 4H4v12h4M12 7l3 3-3 3M15 10H8" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-10 py-8">
        <div className="mx-auto max-w-[1120px]">{children}</div>
      </main>
    </div>
  );
}

function NavItem({ href, label, icon, active, soon }: { href: string; label: string; icon: ReactNode; active: boolean; soon?: boolean }) {
  if (soon) {
    return (
      <span className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-ink-3" title="Kommer i en senare fas">
        {icon}
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={cx(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium',
        active ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-subtle hover:text-ink',
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

/** Bolagsväljaren: byter bolag utan ny inloggning, eller visar hela koncernen. */
function CompanySwitcher() {
  const { me, active, switchCompany } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const label = active ? active.companyName : 'Hela koncernen';
  const many = me.companies.length > 1;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-[11px] font-semibold text-on-accent">
          {active ? initials(active.companyName) : 'K'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{label}</div>
          <div className="truncate text-[11.5px] text-ink-3">{active ? active.roleName : `${me.companies.length} bolag`}</div>
        </div>
        <Icon d="M7 8l3-3 3 3M7 12l3 3 3-3" />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-40 mt-1 rounded-lg bg-surface p-1 shadow-pop">
          {many && (
            <Option selected={!active} onClick={() => switchCompany(null).then(() => setOpen(false))}>
              <span className="font-medium">Hela koncernen</span>
              <span className="ml-auto text-[11.5px] text-ink-3">läsläge</span>
            </Option>
          )}
          {many && <div className="my-1 border-t border-line" />}
          {me.companies.map((c) => (
            <Option key={c.companyId} selected={active?.companyId === c.companyId} onClick={() => switchCompany(c.companyId).then(() => setOpen(false))}>
              <span className="truncate">{c.companyName}</span>
            </Option>
          ))}
        </div>
      )}
    </div>
  );
}

function Option({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-subtle', selected && 'bg-subtle')}
    >
      <span className={cx('size-1.5 shrink-0 rounded-full', selected ? 'bg-accent' : 'bg-transparent')} />
      {children}
    </button>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d={d} />
    </svg>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÅÄÖåäö]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}
