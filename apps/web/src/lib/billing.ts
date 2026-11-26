/** Typer och etiketter för avisering. */

export interface RunRow {
  id: string;
  companyId: string;
  companyName: string;
  runNr: number;
  periodMonth: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  note: string | null;
  invoiceCount: number;
  netOre: number;
  vatOre: number;
  totalOre: number;
  blockingCount: number;
  warningCount: number;
  queuedCount: number;
  queuedPostCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  createdByName: string | null;
  issuedAt: string | null;
  issuedByName: string | null;
}

export const RUN_STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'accent' }> = {
  draft: { label: 'Under granskning', tone: 'warn' },
  issued: { label: 'Godkänd', tone: 'good' },
  cancelled: { label: 'Makulerad', tone: 'neutral' },
};
