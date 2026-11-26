import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodemailer, { Transporter } from 'nodemailer';
import type { PoolClient } from 'pg';
import { renderInvoicePdf } from './invoice-pdf';
import { InvoiceDetail, loadInvoice } from './invoice-store';
import { peppolXml } from './peppol';

const TITLE: Record<string, string> = { rent_notice: 'Hyresavi', invoice: 'Faktura', credit_note: 'Kreditfaktura' };

/**
 * Utskick av fakturor.
 *
 * E-post skickas via SMTP när SMTP_HOST är satt. Utan SMTP körs testläge: meddelandet
 * sparas som .eml-fil i OUTBOX_DIR och leveransen markeras "test", så att inget når kunden.
 * E-faktura skickas via en Peppol-accesspunkt. Tills en sådan är ansluten sparas
 * Peppol-filen i OUTBOX_DIR och kan också laddas ned från fakturan.
 * Brev skrivs ut från körningen och markeras som skickade.
 */
export function deliveryMode(): { email: 'smtp' | 'test'; eInvoice: 'test'; outbox: string } {
  return {
    email: process.env.SMTP_HOST ? 'smtp' : 'test',
    eInvoice: 'test',
    outbox: resolve(process.env.OUTBOX_DIR ?? join(process.cwd(), 'outbox')),
  };
}

let transport: Transporter | undefined;
function smtp(): Transporter {
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

function mailFor(d: InvoiceDetail, pdf: Buffer, to: string) {
  const title = TITLE[d.kind] ?? 'Faktura';
  const from = process.env.SMTP_FROM ?? d.company.invoiceEmail ?? 'no-reply@example.se';
  const credit = d.kind === 'credit_note';
  const kr = (ore: number) => `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
  const text = credit
    ? `Hej,\n\nBifogat finns kreditfaktura ${d.invoiceNr} från ${d.company.name} på ${kr(-d.totalOre)}.\n\nVänliga hälsningar\n${d.company.name}`
    : `Hej,\n\nBifogat finns ${title.toLowerCase()} ${d.invoiceNr} från ${d.company.name}.\n\n` +
      `Att betala: ${kr(d.totalOre)}\nFörfallodatum: ${d.dueDate}\n` +
      (d.company.bankgiro ? `Bankgiro: ${d.company.bankgiro}\n` : d.company.plusgiro ? `Plusgiro: ${d.company.plusgiro}\n` : '') +
      `OCR-nummer: ${d.ocr}\n\nVänliga hälsningar\n${d.company.name}` +
      (d.company.invoiceEmail ? `\n${d.company.invoiceEmail}` : '');
  return {
    from: `"${d.company.name.replace(/"/g, '')}" <${from}>`,
    replyTo: d.company.invoiceEmail ?? undefined,
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
        const mail = mailFor(d, pdf, r.recipient);
        if (mode.email === 'smtp') {
          await smtp().sendMail(mail);
          await mark(client, r.id, 'sent');
          result.sent += 1;
        } else {
          const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail);
          save(mode.outbox, `${d.companyId}-${d.invoiceNr}-${r.id}.eml`, raw.message as Buffer);
          await mark(client, r.id, 'test');
          result.test += 1;
        }
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
