import type { FieldDef } from '@/components/form';

export interface Supplier {
  id: string;
  companyId: string;
  companyName: string;
  supplierNr: number;
  name: string;
  orgNr: string | null;
  vatNr: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  paymentTermsDays: number;
  defaultAccount: string | null;
  notes: string | null;
  active: boolean;
  invoiceCount?: number;
  unpaidOre?: number;
  overdueOre?: number;
  thisYearOre?: number;
  lastYearOre?: number;
  lastInvoiceDate?: string | null;
}

export interface SupplierInvoiceRow {
  id: string;
  companyId: string;
  companyName: string;
  entryNr: number;
  kind: string;
  status: string;
  supplierId: string;
  supplierName: string;
  supplierNr: number;
  invoiceNr: string;
  invoiceDate: string;
  dueDate: string;
  ocr: string | null;
  description: string | null;
  netOre: number;
  vatOre: number;
  totalOre: number;
  paidOre: number;
  balanceOre: number;
  overdue: boolean;
  hasDocument: boolean;
  properties: string | null;
  fullyCoded: boolean;
}

export interface SupplierInvoiceLine {
  id?: string;
  accountNumber: string;
  accountName?: string | null;
  description: string | null;
  propertyId: string | null;
  propertyName?: string | null;
  objectId: string | null;
  objectNr?: string | null;
  costCenterId: string | null;
  costCenter?: string | null;
  netOre: number;
  vatOre: number;
  vatDeductible: boolean;
  periodFrom: string | null;
  periodTo: string | null;
}

export interface SupplierInvoiceDetail extends SupplierInvoiceRow {
  roundingOre: number;
  cancelReason: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  createdAt: string;
  createdByName: string | null;
  supplierBankgiro: string | null;
  supplierPlusgiro: string | null;
  documentName: string | null;
  documentSize: number | null;
  lines: SupplierInvoiceLine[];
  payments: { id: string; paidDate: string; amountOre: number; method: string; reference: string | null; createdByName: string | null }[];
  events: { event: string; note: string | null; createdAt: string; userName: string | null }[];
  verification: { account: string; accountName: string | null; debitOre: number; creditOre: number; propertyName: string | null; costCenter: string | null; text: string | null }[];
}

export interface Account {
  id: string;
  companyId: string;
  companyName: string;
  number: string;
  name: string;
  type: string;
  active: boolean;
  source: string;
  reportGroup: string;
  reportGroupOverride: string | null;
  reportGroupLabel: string;
  defaultReportGroup: string;
  lineCount: number;
}

export const supplierFields: FieldDef[] = [
  { key: 'name', label: 'Namn', required: true },
  { key: 'orgNr', label: 'Organisationsnummer', half: true, placeholder: 'NNNNNN-NNNN' },
  { key: 'vatNr', label: 'Momsregistreringsnummer', half: true },
  { key: 'bankgiro', label: 'Bankgiro', half: true, placeholder: '123-4567' },
  { key: 'plusgiro', label: 'Plusgiro', half: true },
  { key: 'iban', label: 'IBAN', hint: 'För utländska leverantörer' },
  { key: 'email', label: 'E-post', half: true },
  { key: 'phone', label: 'Telefon', half: true },
  { key: 'addressLine', label: 'Adress' },
  { key: 'postalCode', label: 'Postnummer', half: true },
  { key: 'city', label: 'Ort', half: true },
  { key: 'paymentTermsDays', label: 'Betalningsvillkor (dagar)', type: 'number', half: true, hint: 'Används för förfallodagen' },
  { key: 'defaultAccount', label: 'Standardkonto', half: true, placeholder: '5170', hint: 'Föreslås på nya fakturor' },
  { key: 'notes', label: 'Anteckningar', type: 'textarea' },
];

export const EVENT_LABEL: Record<string, string> = {
  registered: 'Registrerad',
  updated: 'Ändrad',
  approved: 'Attesterad',
  unapproved: 'Attesten borttagen',
  paid: 'Betalning registrerad',
  payment_removed: 'Betalning borttagen',
  cancelled: 'Makulerad',
  document: 'Fil bifogad',
};
