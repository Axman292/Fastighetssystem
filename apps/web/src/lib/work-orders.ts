export type WorkOrderStatus = 'new' | 'assigned' | 'in_progress' | 'waiting' | 'done' | 'closed' | 'cancelled';
export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent';
type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export const STATUS_LABEL: Record<WorkOrderStatus, { label: string; tone: Tone }> = {
  new: { label: 'Ny', tone: 'accent' },
  assigned: { label: 'Hos hantverkare', tone: 'warn' },
  in_progress: { label: 'Pågår', tone: 'warn' },
  waiting: { label: 'Väntar', tone: 'neutral' },
  done: { label: 'Åtgärdad', tone: 'good' },
  closed: { label: 'Avslutad', tone: 'neutral' },
  cancelled: { label: 'Makulerad', tone: 'neutral' },
};

export const PRIORITY_LABEL: Record<WorkOrderPriority, { label: string; tone: Tone }> = {
  urgent: { label: 'Akut', tone: 'bad' },
  high: { label: 'Hög', tone: 'warn' },
  normal: { label: 'Normal', tone: 'neutral' },
  low: { label: 'Låg', tone: 'neutral' },
};

export const CATEGORY_LABEL: Record<string, string> = {
  plumbing: 'Vatten och avlopp',
  electric: 'El och belysning',
  appliance: 'Vitvaror',
  heating: 'Värme',
  ventilation: 'Ventilation',
  lock: 'Lås, dörrar och nycklar',
  windows: 'Fönster och balkong',
  surfaces: 'Golv, väggar och tak',
  pests: 'Skadedjur',
  laundry: 'Tvättstuga',
  outdoor: 'Utemiljö och trapphus',
  cleaning: 'Städning och sophantering',
  parking: 'Parkering och garage',
  other: 'Övrigt',
};

export const SOURCE_LABEL: Record<string, string> = {
  form: 'Felanmälningsformuläret',
  manual: 'Registrerat manuellt',
  phone: 'Telefon',
  email: 'E-post',
  inspection: 'Besiktning',
};

export interface WorkOrderRow {
  id: string;
  companyId: string;
  companyName: string;
  orderNr: number;
  title: string;
  category: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  source: string;
  propertyId: string;
  propertyName: string;
  objectId: string | null;
  objectNr: string | null;
  customerId: string | null;
  customerName: string | null;
  reporterName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  createdAt: string;
  doneAt: string | null;
  overdue: boolean;
  photoCount: number;
  costOre: number;
}

export interface WorkOrderEvent {
  id: string;
  kind: string;
  body: string | null;
  visibility: 'internal' | 'reporter' | 'supplier';
  author: string | null;
  createdAt: string;
}

export interface WorkOrderDetail extends WorkOrderRow {
  description: string | null;
  location: string | null;
  propertyDesignation: string;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  apartmentNr: string | null;
  floor: number | null;
  customerNr: number | null;
  reporterEmail: string | null;
  reporterPhone: string | null;
  masterKeyOk: boolean;
  accessNote: string | null;
  notifyReporter: boolean;
  assigneeEmail: string | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  costEstimateOre: number | null;
  chargeable: boolean;
  resolution: string | null;
  sentToSupplierAt: string | null;
  closedAt: string | null;
  anonymizedAt: string | null;
  createdByName: string | null;
  statusUrl?: string;
  supplierUrl?: string | null;
  supplierToken: string | null;
  publicToken: string;
  events: WorkOrderEvent[];
  photos: { id: string; fileName: string; mimeType: string; sizeBytes: number; description: string | null; createdAt: string }[];
  costs: { id: string; supplierInvoiceId: string; entryNr: number; invoiceNr: string; supplierName: string; invoiceDate: string; netOre: number; totalOre: number; status: string }[];
}

export interface WorkOrderOptions {
  properties: { id: string; name: string; designation: string }[];
  objects: { id: string; propertyId: string; objectNr: string; type: string; apartmentNr: string | null; customerId: string | null; customerName: string | null }[];
  users: { id: string; name: string; email: string }[];
  suppliers: { id: string; name: string; email: string | null; phone: string | null }[];
  categories: { value: string; label: string }[];
  priorities: { value: WorkOrderPriority; label: string }[];
  statuses: { value: WorkOrderStatus; label: string }[];
}

export interface WorkOrderSummary {
  new: number;
  open: number;
  urgent: number;
  late: number;
  atSupplier: number;
  toClose: number;
  last30: number;
  avgDays: number | null;
}

export const OPEN: WorkOrderStatus[] = ['new', 'assigned', 'in_progress', 'waiting'];

/** Visar hur länge sedan, t.ex. "3 dagar sedan". */
export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'nyss';
  if (min < 60) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} tim sedan`;
  const d = Math.round(h / 24);
  return d === 1 ? 'i går' : `${d} dagar sedan`;
}
