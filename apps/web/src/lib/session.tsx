'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, CompanyAccess, Me } from './api';

interface Session {
  me: Me;
  active: CompanyAccess | null;
  /** Byter bolag utan ny inloggning. null = hela koncernen. */
  switchCompany: (companyId: string | null) => Promise<void>;
  can: (permission: string, companyId?: string | null) => boolean;
  refresh: () => Promise<void>;
  /** Ökar vid bolagsbyte så att vyer kan hämta om sina data. */
  version: number;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const switchCompany = useCallback(
    async (companyId: string | null) => {
      await api('/auth/switch-company', { method: 'POST', body: { companyId: companyId ?? 'all' } });
      await refresh();
      setVersion((v) => v + 1);
    },
    [refresh],
  );

  if (!me) {
    return <div className="flex h-screen items-center justify-center text-[13px] text-ink-3">Laddar…</div>;
  }

  const active = me.companies.find((c) => c.companyId === me.activeCompanyId) ?? null;
  const can = (permission: string, companyId: string | null = me.activeCompanyId) =>
    !!companyId && !!me.companies.find((c) => c.companyId === companyId)?.permissions.includes(permission);

  return (
    <SessionContext.Provider value={{ me, active, switchCompany, can, refresh, version }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession utanför SessionProvider');
  return s;
}
