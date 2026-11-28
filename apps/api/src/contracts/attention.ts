import type { PoolClient } from 'pg';
import { activeAlerts, AlertKind } from './alerts';

export type AttentionKind = AlertKind;

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  label: string;
  /** Datum som posten gäller, för sortering. */
  date: string;
  severity: 'high' | 'normal';
  overdue: boolean;
  message: string;
  action: string | null;
  link: string;
  contractId: string;
  contractNr: number;
  customerName: string;
  companyId: string;
  companyName: string;
  objects: string;
}

/**
 * Bevakningslista för avtal ("Att hantera"). Samma påminnelser som under
 * Avtal → Bevakning, med bolagets framförhållning och utan de som markerats
 * som klara eller skjutits upp.
 */
export async function attentionItems(client: PoolClient): Promise<AttentionItem[]> {
  const items = await activeAlerts(client);
  return items.map(({ ack: _ack, contractType: _t, ...i }) => i);
}
