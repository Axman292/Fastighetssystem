export type ColumnType = 'text' | 'date' | 'money' | 'int' | 'number' | 'area' | 'pct';
export type Cell = string | number | null;

export interface ReportInfo {
  key: string;
  title: string;
  description: string;
  mode: 'period' | 'date';
}

export interface ReportSection {
  title?: string;
  description?: string;
  columns: { key: string; label: string; type: ColumnType; width?: number }[];
  rows: Record<string, Cell>[];
  totals?: Record<string, Cell>;
  empty?: string;
}

export interface Report extends ReportInfo {
  scope: string;
  filters: { label: string; value: string }[];
  generatedAt: string;
  sections: ReportSection[];
  notes?: string[];
}
