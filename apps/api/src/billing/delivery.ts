import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodemailer, { Transporter } from 'nodemailer';
import type { PoolClient } from 'pg';
import { autogiroState, renderInvoicePdf } from './invoice-pdf';
import { InvoiceDetail, loadInvoice } from './invoice-store';
import { peppolXml } from './peppol';

const TITLE: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

/**
 * Utskick av fakturor, avier, påminnelser och kontoutdrag.
 *
 * E-post skickas på riktigt på ett av två sätt:
 *  - Brevo (HTTP-API) när BREVO_API_KEY är satt. Fungerar även där vanliga SMTP-portar är
 *    spärrade, till exempel på Renders gratisnivå.
 *  - SMTP när SMTP_HOST är satt (SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS).
 * Avsändaradressen tas från MAIL_FROM (eller SMTP_FROM). Bolagets fakturamejl blir svarsadress.
 * Utan Brevo eller SMTP körs testläge: meddelandet sparas som .eml-fil i OUTBOX_DIR och
 * leveransen markeras "test", så att inget når kunden.
 *
 * Spärr för testmiljöer: när EMAIL_ALLOWLIST_ONLY=true skickas e-post bara till adresser i
 * EMAIL_ALLOWLIST (kommaseparerad, "@domän.se" tillåter en hel domän). Andra mottagare
 * hanteras som testläge och får en förklaring på leveransen.
 *
 * E-faktura skickas via en Peppol-accesspunkt. Tills en sådan är ansluten sparas
 * Peppol-filen i OUTBOX_DIR och kan också laddas ned från fakturan.
 * Brev skrivs ut från körningen och markeras som skickade.
 */
export type EmailMode = 'brevo' | 'smtp' | 'test';

export function deliveryMode(): { email: EmailMode; eInvoice: 'test'; outbox: string } {
  return {
    email: process.env.BREVO_API_KEY ? 'brevo' : process.env.SMTP_HOST ? 'smtp' : 'test',
    eInvoice: 'test',
    outbox: resolve(process.env.OUTBOX_DIR ?? join(process.cwd(), 'outbox')),
  };
}

let transport: Transporter | undefined;
export function smtp(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/** Ett e-postmeddelande med valfria PDF-bilagor. */
export interface OutgoingMail {
  /** Visningsnamn för avsändaren, normalt bolagets namn. */
  fromName: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType?: string }[];
}

/** Avsändaradress: MAIL_FROM, SMTP_FROM, bolagets fakturamejl eller en platshållare. */
export function senderAddress(companyEmail?: string | null): string {
  return process.env.MAIL_FROM?.trim() || process.env.SMTP_FROM?.trim() || companyEmail || 'no-reply@example.se';
}

/** Null om adressen får ta emot e-post, annars en förklaring till varför den spärras. */
export function allowlistBlock(to: string): string | null {
  if (process.env.EMAIL_ALLOWLIST_ONLY !== 'true') return null;
  const list = (process.env.EMAIL_ALLOWLIST ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const addr = to.trim().toLowerCase();
  const ok = list.some((e) => (e.startsWith('@') ? addr.endsWith(e) : addr === e));
  return ok ? null : `Inte skickat: testmiljön skickar bara till tillåtna testadresser och ${to} finns inte bland dem.`;
}

function toNodemailer(m: OutgoingMail, from: string): nodemailer.SendMailOptions {
  return {
    from: `"${m.fromName.replace(/"/g, '')}" <${from}>`,
    replyTo: m.replyTo ?? undefined,
    to: m.to,
    subject: m.subject,
    text: m.text,
    attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType ?? 'application/pdf' })),
  };
}

/** Skickar via Brevos transaktions-API (https://developers.brevo.com/reference/sendtransacemail). */
async function sendBrevo(m: OutgoingMail, from: string): Promise<void> {
  const res = await fetch(process.env.BREVO_API_URL ?? 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: m.fromName.slice(0, 70), email: from },
      to: [{ email: m.to }],
      ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
      subject: m.subject,
      textContent: m.text,
      attachment: m.attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') })),
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string; code?: string };
      detail = body.message ?? body.code ?? '';
    } catch {
      /* tomt svar */
    }
    if (res.status === 401) throw new Error(`Brevo nekade nyckeln (401). Kontrollera BREVO_API_KEY. ${detail}`.trim());
    throw new Error(`Brevo svarade ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Skickar ett e-postmeddelande, eller sparar det som .eml i OUTBOX_DIR i testläge
 * och när mottagaren spärras av EMAIL_ALLOWLIST. note förklarar en spärr.
 */
export async function deliverEmail(m: OutgoingMail, fileBase: string): Promise<{ status: 'sent' | 'test'; note: string | null }> {
  const mode = deliveryMode();
  const from = senderAddress(m.replyTo);
  const block = mode.email === 'test' ? null : allowlistBlock(m.to);
  if (mode.email === 'test' || block) {
    const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(toNodemailer(m, from));
    save(mode.outbox, `${fileBase}.eml`, raw.message as Buffer);
    return { status: 'test', note: block };
  }
  if (mode.email === 'brevo') await sendBrevo(m, from);
  else await smtp().sendMail(toNodemailer(m, from));
  return { status: 'sent', note: null };
}

function mailFor(d: InvoiceDetail, pdf: Buffer, to: string): OutgoingMail {
  const title = TITLE[d.kind] ?? 'Faktura';
  const credit = d.kind === 'credit_note';
  const kr = (ore: number) => `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
  const ag = autogiroState(d);
  const text = credit
    ? `Hej,\n\nBifogat finns kreditfaktura ${d.invoiceNr} från ${d.company.name} på ${kr(-d.totalOre)}.\n\nVänliga hälsningar\n${d.company.name}`
    : ag === 'withdraw'
    ? `Hej,\n\nBifogat finns ${title.toLowerCase()} ${d.invoiceNr} från ${d.company.name}.\n\n` +
      `Belopp: ${kr(d.totalOre)}\nDras via autogiro: ${d.autogiro?.paymentDate ?? d.dueDate}\n\n` +
      `Beloppet dras automatiskt från ditt konto. Du ska inte betala själv. Se till att pengarna finns på kontot dagen före.\n\n` +
      `Vänliga hälsningar\n${d.company.name}` +
      (d.company.invoiceEmail ? `\n${d.company.invoiceEmail}` : '')
    : `Hej,\n\n${ag === 'failed' ? 'Dragningen via autogiro gick inte igenom, så du behöver betala själv. ' : ''}Bifogat finns ${title.toLowerCase()} ${d.invoiceNr} från ${d.company.name}.\n\n` +
      `Att betala: ${kr(d.totalOre)}\nFörfallodatum: ${d.dueDate}\n` +
      (d.company.bankgiro ? `Bankgiro: ${d.company.bankgiro}\n` : d.company.plusgiro ? `Plusgiro: ${d.company.plusgiro}\n` : '') +
      `OCR-nummer: ${d.ocr}\n\nVänliga hälsningar\n${d.company.name}` +
      (d.company.invoiceEmail ? `\n${d.company.invoiceEmail}` : '');
  return {
    fromName: d.company.name,
    replyTo: d.company.invoiceEmail,
    to,
    subject: `${title} ${d.invoiceNr} från ${d.company.name}`,
    text,
    attachments: [{ filename: `${title.toLowerCase()}-${d.invoiceNr}.pdf`, content: pdf, contentType: 'application/pdf' }],
  };
}

/** Skickar köade e-post- och e-fakturaleveranser. Brev lämnas köade tills de skrivits ut. */
export async function sendQueued(client: PoolClient, deliveryIds: string[]): Promise<{ sent: number; test: number; failed: number; post: number }> {
  const result = { sent: 0, test: 0, failed: 0, post: 0 };
  if (!deliveryIds.length) return result;
  const { rows } = await client.query(
    `select id, invoice_id as "invoiceId", channel, recipient from invoice_delivery
     where id = any($1) and status = 'queued' order by created_at for update`,
    [deliveryIds],
  );
  const mode = deliveryMode();
  for (const r of rows) {
    if (r.channel === 'post') {
      result.post += 1;
      continue;
    }
    try {
      const d = await loadInvoice(client, r.invoiceId);
      if (d.status !== 'issued') throw new Error('Fakturan är inte utfärdad');
      if (r.channel === 'email') {
        const pdf = await renderInvoicePdf(d);
        const out = await deliverEmail(mailFor(d, pdf, r.recipient), `${d.companyId}-${d.invoiceNr}-${r.id}`);
        await mark(client, r.id, out.status, out.note);
        result[out.status] += 1;
      } else {
        save(mode.outbox, `${d.companyId}-${d.invoiceNr}-${r.id}.xml`, Buffer.from(peppolXml(d), 'utf8'));
        await mark(client, r.id, 'test');
        result.test += 1;
      }
    } catch (err) {
      await mark(client, r.id, 'failed', (err as Error).message.slice(0, 500));
      result.failed += 1;
    }
  }
  return result;
}

async function mark(client: PoolClient, id: string, status: string, error: string | null = null) {
  await client.query(
    `update invoice_delivery set status = $2, error = $3, sent_at = case when $2 in ('sent','test') then now() else sent_at end where id = $1`,
    [id, status, error],
  );
}

function save(dir: string, name: string, data: Buffer) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
}
