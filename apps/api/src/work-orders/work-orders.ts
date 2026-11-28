import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { deliverEmail } from '../billing/delivery';

/**
 * Felanmälan och ärenden.
 *
 * En felanmälan kommer in via fastighetens formulär (utan inloggning) eller
 * registreras av personalen. Ärendet får ett löpnummer per bolag, en prioritet
 * med förslag på klart-datum, en ansvarig handläggare och vid behov en
 * hantverkare ur leverantörsregistret. Allt som händer loggas som händelser.
 * Kommentarer kan vara interna, synas för anmälaren eller för hantverkaren.
 */

export const STATUS = ['new', 'assigned', 'in_progress', 'waiting', 'done', 'closed', 'cancelled'] as const;
export type Status = (typeof STATUS)[number];
export const OPEN_STATUSES: Status[] = ['new', 'assigned', 'in_progress', 'waiting'];

export const STATUS_LABEL: Record<Status, string> = {
  new: 'Ny',
  assigned: 'Hos hantverkare',
  in_progress: 'Pågår',
  waiting: 'Väntar',
  done: 'Åtgärdad',
  closed: 'Avslutad',
  cancelled: 'Makulerad',
};

/** Statustext för anmälaren, utan interna detaljer. */
export const REPORTER_STATUS_LABEL: Record<Status, string> = {
  new: 'Mottagen',
  assigned: 'En hantverkare har fått ärendet',
  in_progress: 'Arbetet pågår',
  waiting: 'Väntar (till exempel på material)',
  done: 'Åtgärdad',
  closed: 'Avslutad',
  cancelled: 'Avslutad utan åtgärd',
};

export const PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITY)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Låg', normal: 'Normal', high: 'Hög', urgent: 'Akut' };
/** Förslag på klart-datum: dagar efter anmälan. */
export const PRIORITY_DAYS: Record<Priority, number> = { urgent: 1, high: 3, normal: 14, low: 30 };

export const CATEGORY = [
  'plumbing', 'electric', 'appliance', 'heating', 'ventilation', 'lock', 'windows',
  'surfaces', 'pests', 'laundry', 'outdoor', 'cleaning', 'parking', 'other',
] as const;
export type Category = (typeof CATEGORY)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
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

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function suggestedDueDate(priority: Priority, from: string): string {
  return addDays(from, PRIORITY_DAYS[priority]);
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------
// Spamskydd för formuläret
// ---------------------------------------------------------------------

const processSecret = randomBytes(32).toString('hex');
function formSecret(): string {
  return process.env.APP_SECRET_KEY || processSecret;
}

/** Biljett som formuläret får när det visas: tidpunkt + signatur. */
export function formTicket(token: string, now = Date.now()): string {
  const ts = String(now);
  const sig = createHmac('sha256', formSecret()).update(`${token}.${ts}`).digest('base64url').slice(0, 32);
  return `${ts}.${sig}`;
}

/** Minsta tid att fylla i formuläret. Robotar skickar direkt. */
export const MIN_FILL_MS = 3_000;
export const MAX_TICKET_AGE_MS = 24 * 60 * 60_000;

/** Null om biljetten är giltig, annars en förklaring. */
export function ticketProblem(token: string, ticket: string | undefined, now = Date.now()): string | null {
  const [ts, sig] = (ticket ?? '').split('.');
  if (!ts || !sig || !/^\d+$/.test(ts)) return 'Formuläret är för gammalt. Ladda om sidan och försök igen.';
  const expected = createHmac('sha256', formSecret()).update(`${token}.${ts}`).digest('base64url').slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Formuläret är för gammalt. Ladda om sidan och försök igen.';
  const age = now - Number(ts);
  if (age < MIN_FILL_MS) return 'Det gick lite för fort. Vänta några sekunder och skicka igen.';
  if (age > MAX_TICKET_AGE_MS) return 'Formuläret är för gammalt. Ladda om sidan och försök igen.';
  return null;
}

/** Enkla tecken på skräppost i texten: många länkar. */
export function looksLikeSpam(text: string): boolean {
  const links = (text.match(/https?:\/\/|www\./gi) ?? []).length;
  return links > 2;
}

// ---------------------------------------------------------------------
// Bilder
// ---------------------------------------------------------------------

export const PHOTO_TYPES = /^image\/(png|jpeg|webp|heic|heif|gif)$/;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export async function savePhotos(
  client: PoolClient,
  companyId: string,
  workOrderId: string,
  files: { originalname?: string; mimetype?: string; buffer: Buffer; size: number }[],
  description: string | null,
): Promise<number> {
  let n = 0;
  for (const f of files) {
    if (!f.buffer?.length) continue;
    const mime = f.mimetype || 'application/octet-stream';
    if (!PHOTO_TYPES.test(mime)) continue;
    const doc = (
      await client.query(
        `insert into document (company_id, kind, file_name, mime_type, sha256, size_bytes, entity_type, entity_id, description)
         values ($1, 'photo', $2, $3, $4, $5, 'work_order', $6, $7) returning id`,
        [companyId, (f.originalname || 'bild.jpg').slice(0, 200), mime, createHash('sha256').update(f.buffer).digest('hex'), f.size, workOrderId, description],
      )
    ).rows[0];
    await client.query('insert into document_content (id, company_id, content) values ($1, $2, $3)', [doc.id, companyId, f.buffer]);
    n++;
  }
  return n;
}

export async function photos(client: PoolClient, workOrderId: string) {
  return (
    await client.query(
      `select id, file_name as "fileName", mime_type as "mimeType", size_bytes::int as "sizeBytes", description, created_at as "createdAt"
       from document where entity_type = 'work_order' and entity_id = $1 order by created_at`,
      [workOrderId],
    )
  ).rows as { id: string; fileName: string; mimeType: string; sizeBytes: number; description: string | null; createdAt: string }[];
}

// ---------------------------------------------------------------------
// Händelser
// ---------------------------------------------------------------------

export async function addEvent(
  client: PoolClient,
  companyId: string,
  workOrderId: string,
  kind: string,
  body: string | null,
  opts: { visibility?: 'internal' | 'reporter' | 'supplier'; authorLabel?: string | null } = {},
) {
  await client.query(
    `insert into work_order_event (company_id, work_order_id, kind, body, visibility, author_label) values ($1, $2, $3, $4, $5, $6)`,
    [companyId, workOrderId, kind, body ? body.slice(0, 5000) : null, opts.visibility ?? 'internal', opts.authorLabel ?? null],
  );
}

export async function nextOrderNr(client: PoolClient, companyId: string): Promise<number> {
  await client.query(`select pg_advisory_xact_lock(hashtext('work_order:' || $1))`, [companyId]);
  return (await client.query('select coalesce(max(order_nr), 0) + 1 as nr from work_order where company_id = $1', [companyId])).rows[0].nr;
}

/**
 * Försöker koppla anmälan till hyresgästen: ett gällande avtal på objektet
 * (eller i fastigheten) vars hyresgäst har samma e-post eller telefon.
 */
export async function matchCustomer(
  client: PoolClient,
  propertyId: string,
  objectId: string | null,
  email: string | null,
  phone: string | null,
): Promise<string | null> {
  if (!email && !phone) return null;
  const digits = phone ? phone.replace(/\D/g, '').replace(/^46/, '0') : null;
  const r = await client.query(
    `select distinct c.id, (co.object_id = $2) as same_object
     from customer c
     join contract k on k.customer_id = c.id and k.status in ('active', 'terminated') and (k.end_date is null or k.end_date >= current_date)
     join contract_object co on co.contract_id = k.id
     join rental_object o on o.id = co.object_id and o.property_id = $1
     where ($3::text is not null and lower(c.email) = lower($3))
        or ($4::text is not null and length($4) >= 7 and regexp_replace(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), '^46', '0') = $4)
     order by same_object desc nulls last
     limit 2`,
    [propertyId, objectId, email, digits],
  );
  // Bara en entydig träff kopplas
  if (r.rows.length === 1 || (r.rows.length > 1 && r.rows[0].same_object && !r.rows[1].same_object)) return r.rows[0].id;
  return null;
}

// ---------------------------------------------------------------------
// Läsa ärenden
// ---------------------------------------------------------------------

export const LIST_SQL = `
  select w.id, w.company_id as "companyId", co.name as "companyName", w.order_nr as "orderNr", w.title, w.category, w.priority, w.status, w.source,
         w.property_id as "propertyId", p.name as "propertyName", w.object_id as "objectId", o.object_nr as "objectNr",
         w.customer_id as "customerId", cu.name as "customerName", w.reporter_name as "reporterName",
         w.assignee_user_id as "assigneeUserId", u.name as "assigneeName", w.supplier_id as "supplierId", s.name as "supplierName",
         w.due_date::text as "dueDate", w.scheduled_date::text as "scheduledDate", w.created_at as "createdAt", w.done_at as "doneAt",
         w.closed_at as "closedAt", w.updated_at as "updatedAt",
         (w.status = any($1::text[]) and w.due_date is not null and w.due_date < current_date) as overdue,
         (select count(*) from document d where d.entity_type = 'work_order' and d.entity_id = w.id)::int as "photoCount",
         coalesce((select sum(si.net_ore) from work_order_cost wc join supplier_invoice si on si.id = wc.supplier_invoice_id
                   where wc.work_order_id = w.id and si.status <> 'cancelled'), 0)::float as "costOre"
  from work_order w
  join company co on co.id = w.company_id
  join property p on p.id = w.property_id
  left join rental_object o on o.id = w.object_id
  left join customer cu on cu.id = w.customer_id
  left join app_user u on u.id = w.assignee_user_id
  left join supplier s on s.id = w.supplier_id`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type WorkOrderRow = Record<string, any> & {
  id: string; companyId: string; companyName: string; orderNr: number; title: string; description: string | null; category: string;
  location: string | null; priority: string; status: string; propertyId: string; propertyName: string; addressLine: string | null;
  postalCode: string | null; city: string | null; objectId: string | null; objectNr: string | null; apartmentNr: string | null;
  floor: number | null; reporterName: string | null; reporterEmail: string | null; reporterPhone: string | null; masterKeyOk: boolean;
  accessNote: string | null; notifyReporter: boolean; assigneeUserId: string | null; assigneeName: string | null; assigneeEmail: string | null;
  supplierId: string | null; supplierName: string | null; supplierEmail: string | null; dueDate: string | null; scheduledDate: string | null;
  costEstimateOre: number | null; publicToken: string; supplierToken: string | null; anonymizedAt: string | null; createdAt: string; doneAt: string | null;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function loadDetail(client: PoolClient, id: string) {
  const w = (
    await client.query(
      `select w.id, w.company_id as "companyId", co.name as "companyName", w.order_nr as "orderNr", w.source, w.title, w.description,
              w.category, w.location, w.priority, w.status,
              w.property_id as "propertyId", p.name as "propertyName", p.designation as "propertyDesignation",
              coalesce(o.address_line, p.address_line) as "addressLine", p.postal_code as "postalCode", p.city,
              w.object_id as "objectId", o.object_nr as "objectNr", o.apartment_nr as "apartmentNr", o.floor, o.type as "objectType",
              w.customer_id as "customerId", cu.name as "customerName", cu.customer_nr as "customerNr",
              w.reporter_name as "reporterName", w.reporter_email as "reporterEmail", w.reporter_phone as "reporterPhone",
              w.master_key_ok as "masterKeyOk", w.access_note as "accessNote", w.notify_reporter as "notifyReporter",
              w.assignee_user_id as "assigneeUserId", u.name as "assigneeName", u.email as "assigneeEmail",
              w.supplier_id as "supplierId", s.name as "supplierName", s.email as "supplierEmail", s.phone as "supplierPhone",
              w.due_date::text as "dueDate", w.scheduled_date::text as "scheduledDate",
              w.cost_estimate_ore::float as "costEstimateOre", w.chargeable, w.resolution,
              w.sent_to_supplier_at as "sentToSupplierAt", w.done_at as "doneAt", w.closed_at as "closedAt",
              w.public_token as "publicToken", w.supplier_token as "supplierToken", w.anonymized_at as "anonymizedAt",
              w.created_at as "createdAt", cb.name as "createdByName", w.updated_at as "updatedAt",
              (w.status in ('new','assigned','in_progress','waiting') and w.due_date is not null and w.due_date < current_date) as overdue
       from work_order w
       join company co on co.id = w.company_id
       join property p on p.id = w.property_id
       left join rental_object o on o.id = w.object_id
       left join customer cu on cu.id = w.customer_id
       left join app_user u on u.id = w.assignee_user_id
       left join app_user cb on cb.id = w.created_by
       left join supplier s on s.id = w.supplier_id
       where w.id = $1`,
      [id],
    )
  ).rows[0] as WorkOrderRow | undefined;
  if (!w) return null;
  const events = (
    await client.query(
      `select e.id, e.kind, e.body, e.visibility, coalesce(u.name, e.author_label) as author, e.created_at as "createdAt"
       from work_order_event e left join app_user u on u.id = e.created_by
       where e.work_order_id = $1 order by e.created_at, e.id`,
      [id],
    )
  ).rows as { id: string; kind: string; body: string | null; visibility: 'internal' | 'reporter' | 'supplier'; author: string | null; createdAt: string }[];
  const costs = (
    await client.query(
      `select wc.id, si.id as "supplierInvoiceId", si.entry_nr as "entryNr", si.invoice_nr as "invoiceNr", sp.name as "supplierName",
              si.invoice_date::text as "invoiceDate", si.net_ore::float as "netOre", si.total_ore::float as "totalOre", si.status
       from work_order_cost wc join supplier_invoice si on si.id = wc.supplier_invoice_id join supplier sp on sp.id = si.supplier_id
       where wc.work_order_id = $1 order by si.invoice_date`,
      [id],
    )
  ).rows;
  return { ...w, events, costs, photos: await photos(client, id) };
}

export type Detail = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;

// ---------------------------------------------------------------------
// E-post
// ---------------------------------------------------------------------

async function companyMail(client: PoolClient, companyId: string) {
  return (await client.query('select name, invoice_email as "invoiceEmail" from company where id = $1', [companyId])).rows[0] as {
    name: string;
    invoiceEmail: string | null;
  };
}

export async function getSettings(client: PoolClient, companyId: string) {
  const r = (
    await client.query(
      `select notify_emails as "notifyEmails", confirm_reporter as "confirmReporter", form_intro as "formIntro"
       from work_order_setting where company_id = $1`,
      [companyId],
    )
  ).rows[0];
  return (r ?? { notifyEmails: null, confirmReporter: true, formIntro: null }) as {
    notifyEmails: string | null;
    confirmReporter: boolean;
    formIntro: string | null;
  };
}

export function emailList(s: string | null | undefined): string[] {
  return (s ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

/** Skickar och loggar som händelse. Ett fel stoppar aldrig ärendet. */
export async function mailAndLog(
  client: PoolClient,
  companyId: string,
  w: { id: string; orderNr: number },
  to: string,
  subject: string,
  text: string,
  what: string,
  attachments: { filename: string; content: Buffer; contentType?: string }[] = [],
): Promise<'sent' | 'test' | 'failed'> {
  const c = await companyMail(client, companyId);
  let status: 'sent' | 'test' | 'failed';
  let note: string | null = null;
  try {
    const r = await deliverEmail(
      { fromName: c.name, replyTo: c.invoiceEmail, to, subject, text, attachments },
      `arende-${w.orderNr}-${what.replace(/\W+/g, '-')}-${Date.now()}`,
    );
    status = r.status;
    note = r.note;
  } catch (err) {
    status = 'failed';
    note = (err as Error).message;
  }
  const label = status === 'sent' ? 'skickad' : status === 'test' ? 'sparad i testläge, inte skickad' : 'kunde inte skickas';
  await addEvent(client, companyId, w.id, 'email', `${what} till ${to}: ${label}${note ? ` (${note})` : ''}`);
  return status;
}

function place(d: Pick<Detail, 'propertyName' | 'addressLine' | 'postalCode' | 'city' | 'objectNr' | 'apartmentNr' | 'floor' | 'location'>): string {
  return [
    `${d.propertyName}${d.addressLine ? `, ${d.addressLine}` : ''}${d.postalCode || d.city ? `, ${[d.postalCode, d.city].filter(Boolean).join(' ')}` : ''}`,
    d.objectNr ? `Objekt: ${d.objectNr}${d.apartmentNr ? ` (lgh ${d.apartmentNr})` : ''}${d.floor !== null && d.floor !== undefined ? `, våning ${d.floor}` : ''}` : null,
    d.location ? `Plats: ${d.location}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function newReportMail(d: Detail, link: string): { subject: string; text: string } {
  return {
    subject: `${d.priority === 'urgent' ? 'AKUT: ' : ''}Ny felanmälan ${d.orderNr}: ${d.title}`,
    text: [
      `En ny felanmälan har kommit in till ${d.companyName}.`,
      '',
      `Ärende: ${d.orderNr}`,
      `Kategori: ${CATEGORY_LABEL[d.category as Category] ?? d.category}`,
      `Prioritet: ${PRIORITY_LABEL[d.priority as Priority] ?? d.priority}`,
      place(d),
      '',
      d.description ?? '',
      '',
      `Anmält av: ${[d.reporterName, d.reporterPhone, d.reporterEmail].filter(Boolean).join(', ') || 'okänd'}`,
      d.masterKeyOk ? 'Hyresgästen godkänner att huvudnyckel används.' : 'Huvudnyckel får inte användas utan att hyresgästen kontaktas.',
      d.photos.length ? `${d.photos.length} bild(er) bifogade i ärendet.` : null,
      '',
      `Öppna ärendet: ${link}`,
    ]
      .filter((x) => x !== null)
      .join('\n'),
  };
}

export function receiptMail(d: Detail, statusLink: string): { subject: string; text: string } {
  return {
    subject: `Vi har tagit emot din felanmälan (ärende ${d.orderNr})`,
    text: [
      `Hej${d.reporterName ? ` ${d.reporterName}` : ''}!`,
      '',
      `Tack för din felanmälan. Den har fått ärendenummer ${d.orderNr}.`,
      '',
      `Ärende: ${d.title}`,
      place(d),
      '',
      'Du kan följa ärendet här:',
      statusLink,
      '',
      'Vid akuta fel som vattenläcka, strömavbrott eller utelåsning, ring oss eller jouren direkt.',
      '',
      'Vänliga hälsningar',
      d.companyName,
    ].join('\n'),
  };
}

export function statusMail(d: Detail, statusLink: string, message?: string | null): { subject: string; text: string } {
  const st = REPORTER_STATUS_LABEL[d.status as Status] ?? d.status;
  return {
    subject: `Ärende ${d.orderNr}: ${st}`,
    text: [
      `Hej${d.reporterName ? ` ${d.reporterName}` : ''}!`,
      '',
      `Ditt ärende ${d.orderNr} (${d.title}) har fått status: ${st}.`,
      message ? `\n${message}` : '',
      '',
      `Följ ärendet: ${statusLink}`,
      '',
      'Vänliga hälsningar',
      d.companyName,
    ].join('\n'),
  };
}

export function workOrderMail(d: Detail, link: string, message?: string | null): { subject: string; text: string } {
  const contact = d.reporterName || d.reporterPhone ? [d.reporterName, d.reporterPhone].filter(Boolean).join(', ') : null;
  return {
    subject: `Arbetsorder ${d.orderNr} från ${d.companyName}: ${d.title}`,
    text: [
      'Hej!',
      '',
      `${d.companyName} beställer följande arbete.`,
      '',
      `Arbetsorder: ${d.orderNr}`,
      `Prioritet: ${PRIORITY_LABEL[d.priority as Priority] ?? d.priority}${d.dueDate ? `, önskas klart senast ${d.dueDate}` : ''}`,
      d.scheduledDate ? `Planerat datum: ${d.scheduledDate}` : null,
      place(d),
      '',
      d.description ?? '',
      message ? `\nMeddelande: ${message}` : null,
      '',
      contact ? `Kontakt på plats: ${contact}` : null,
      d.masterKeyOk ? 'Hyresgästen godkänner att huvudnyckel används.' : 'Kontakta hyresgästen innan ni går in i lägenheten.',
      d.accessNote ? `Tillträde: ${d.accessNote}` : null,
      d.costEstimateOre ? `Kostnadsram: ${Math.round(d.costEstimateOre / 100).toLocaleString('sv-SE')} kr exkl. moms. Kontakta oss innan den överskrids.` : null,
      '',
      'Se bilder och kvittera när arbetet är utfört:',
      link,
      '',
      `Ange arbetsorder ${d.orderNr} på fakturan.`,
      '',
      'Vänliga hälsningar',
      d.companyName,
    ]
      .filter((x) => x !== null)
      .join('\n'),
  };
}
