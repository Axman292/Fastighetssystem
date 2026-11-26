/** Typer och texter för importcentralen. */

export interface ImportMeta {
  adapters: { key: string; label: string; description: string }[];
  entities: {
    key: string;
    label: string;
    labelPlural: string;
    available: boolean;
    unavailableReason?: string;
    fields: { key: string; label: string; type: string; required?: boolean; help?: string }[];
  }[];
}

export interface EntitySummary {
  total: number;
  new: number;
  update: number;
  unchanged: number;
  link: number;
  error: number;
  skipped: number;
  warnings: number;
}

export interface Validation {
  perEntity: Record<string, EntitySummary>;
  totals: EntitySummary;
  at: string;
}

export interface Metrics {
  properties: number;
  objects: number;
  customers: number;
  activeContracts: number;
  endedContracts: number;
  monthlyRentOre: number;
  annualRentOre: number;
  objectRentOre: number;
  unpaidInvoices: number | null;
  receivablesOre: number | null;
  accounts: number;
  suppliers: number;
  vouchers: number;
  documents: number;
}

export interface Reconciliation {
  generatedAt: string;
  system: Metrics;
  batch: Metrics;
  comparison: { key: string; label: string; unit: 'count' | 'ore'; source: number | null; control: number | null; imported: number | null; system: number | null }[];
  issues: { errors: number; warnings: number; skipped: number; byEntity: Record<string, { errors: number; warnings: number; skipped: number }> };
  invoicesAvailable: boolean;
}

export interface ApplyResult {
  created: Record<string, number>;
  updated: Record<string, number>;
  linked: Record<string, number>;
  errors: { entity: string; recordKey: string; label: string; message: string }[];
}

export interface TestResult {
  ok: boolean;
  at: string;
  result: ApplyResult;
  reconciliation: Reconciliation;
}

export interface Batch {
  id: string;
  companyId: string;
  companyName: string;
  batchNr: number;
  name: string;
  sourceSystem: string;
  status: 'draft' | 'validated' | 'tested' | 'committed' | 'rolled_back';
  defaultPropertyId: string | null;
  controlTotals: Record<string, number | null>;
  validation: Validation | null;
  testResult: TestResult | null;
  reconciliation: Reconciliation | null;
  validatedAt: string | null;
  testedAt: string | null;
  committedAt: string | null;
  committedByName: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  files: { id: string; fileName: string; format: string; sizeBytes: number; note: string | null; createdAt: string }[];
  tables: {
    id: string;
    fileId: string;
    name: string;
    profile: string;
    headers: string[];
    mapping: Record<string, string>;
    rows: number;
    sample: (string | number | boolean | null)[][] | null;
  }[];
  properties: { id: string; name: string; designation: string; addressLine: string | null }[];
  newProperties: string[];
  adapter: { key: string; label: string };
}

export interface ImportRow {
  id: string;
  entity: string;
  recordKey: string;
  label: string;
  status: 'new' | 'update' | 'unchanged' | 'link' | 'error' | 'skipped';
  issues: { level: 'error' | 'warning' | 'info'; message: string }[];
  changes: { field: string; label: string; current: unknown; incoming: unknown }[];
  sourceRow: number | null;
  fileName: string | null;
  tableName: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  approveUpdate: boolean;
  skip: boolean;
  overrides: Record<string, unknown>;
}

export const BATCH_STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }> = {
  draft: { label: 'Utkast', tone: 'neutral' },
  validated: { label: 'Kontrollerad', tone: 'accent' },
  tested: { label: 'Testad', tone: 'accent' },
  committed: { label: 'Genomförd', tone: 'good' },
  rolled_back: { label: 'Ångrad', tone: 'warn' },
};

export const ROW_STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }> = {
  new: { label: 'Ny', tone: 'good' },
  update: { label: 'Ändras', tone: 'warn' },
  unchanged: { label: 'Oförändrad', tone: 'neutral' },
  link: { label: 'Kopplas', tone: 'accent' },
  error: { label: 'Fel', tone: 'bad' },
  skipped: { label: 'Hoppas över', tone: 'neutral' },
};

export const FORMAT_LABEL: Record<string, string> = {
  xlsx: 'Excel',
  csv: 'CSV',
  xml: 'XML',
  sie: 'SIE 4',
  pdf: 'PDF',
  document: 'Dokument',
};

export async function uploadFiles(path: string, files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch(`/api${path}`, { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'Något gick fel');
  return data;
}
