export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** Anropar API:et via /api. companyId skickas som header när ett visst bolag ska användas. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; companyId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.companyId) headers['x-company-id'] = options.companyId;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      window.location.href = '/login?utloggad=1';
    }
    if (res.status === 401 && typeof window !== 'undefined' && path === '/auth/me') {
      window.location.href = '/login';
    }
    if (res.status === 403 && data.code === 'mfa_setup_required' && typeof window !== 'undefined' && window.location.pathname !== '/konto') {
      window.location.href = '/konto';
    }
    throw new ApiError(res.status, data.message ?? 'Något gick fel', data.fields ?? []);
  }
  return data as T;
}

export interface CompanyAccess {
  companyId: string;
  companyName: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
}

export interface Me {
  user: { id: string; name: string; email: string; isGroupAdmin: boolean; mfaEnabled: boolean };
  companies: CompanyAccess[];
  activeCompanyId: string | null;
  /** Koncernen kräver tvåstegsverifiering och den är inte uppsatt än. */
  mfaSetupRequired: boolean;
  sessionIdleMinutes: number;
}

export interface Company {
  id: string;
  name: string;
  orgNr: string;
  vatNr: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  fiscalYearStart: number;
  hogiaClientId: string | null;
  invoiceEmail: string | null;
  fTax: boolean;
  invoiceFooter: string | null;
  roundToKrona: boolean;
  active: boolean;
  updatedAt: string;
  reminderFeeOre: number;
  reminderGraceDays: number;
  reminderDueDays: number;
  lateInterestBp: number;
  lateInterestReference: boolean;
  lateInterestMarginBp: number;
  lateInterestMinOre: number;
  lateInterestMethod: 'next_notice' | 'invoice';
  lateInterestFrom: string;
  badDebtAccount: string;
}

export interface BankAccount {
  id: string;
  companyId: string;
  companyName: string;
  purpose: string;
  bankName: string | null;
  clearingNr: string | null;
  accountNr: string | null;
  iban: string | null;
}

export interface CostCenter {
  id: string;
  companyId: string;
  companyName: string;
  code: string;
  name: string;
  active: boolean;
}

export interface AuditRow {
  id: number;
  occurredAt: string;
  companyId: string;
  tableName: string;
  rowId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  userName: string | null;
}
