import type { PoolClient } from 'pg';

/**
 * Nyckeltal som andra moduler lägger till på startsidan, till exempel öppna
 * felanmälningar. En modul registrerar en funktion här, så visas talet som ett
 * eget kort utan att startsidan behöver ändras.
 *
 * Funktionen körs i samma transaktion som resten av startsidan, med bolagens
 * radnivåsäkerhet på. Returnera null för att inte visa kortet.
 */
export interface DashboardExtra {
  key: string;
  label: string;
  /** Det stora talet, färdigformaterat (till exempel "4"). */
  value: string;
  sub?: string;
  /** Sidan som listar det som räknats. */
  href: string;
  tone?: 'neutral' | 'warn' | 'bad';
}

export type DashboardExtraProvider = (client: PoolClient) => Promise<DashboardExtra | null>;

export const DASHBOARD_EXTRAS: DashboardExtraProvider[] = [];

export function registerDashboardExtra(provider: DashboardExtraProvider): void {
  DASHBOARD_EXTRAS.push(provider);
}
