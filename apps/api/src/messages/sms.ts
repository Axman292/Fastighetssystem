import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryMode } from '../billing/delivery';

/**
 * SMS till hyresgäster.
 *
 * Två leverantörer stöds, valda med SMS_PROVIDER:
 *  - "brevo": samma Brevo-konto och BREVO_API_KEY som för e-post. SMS-krediter köps i Brevo.
 *  - "46elks": svensk SMS-tjänst. ELKS_API_USERNAME och ELKS_API_PASSWORD från 46elks.se.
 * Utan SMS_PROVIDER (eller utan nyckel) körs testläge: meddelandet sparas som .txt-fil i
 * OUTBOX_DIR och når ingen.
 *
 * Avsändarnamnet är SMS_FROM (högst 11 bokstäver och siffror), annars bolagets namn förkortat.
 *
 * Spärr för testmiljöer: när EMAIL_ALLOWLIST_ONLY=true eller SMS_ALLOWLIST_ONLY=true skickas
 * SMS bara till numren i SMS_ALLOWLIST (kommaseparerad). Andra hanteras som testläge.
 */
export type SmsMode = 'brevo' | '46elks' | 'test';

export function smsMode(): SmsMode {
  const p = (process.env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (p === 'brevo' && process.env.BREVO_API_KEY) return 'brevo';
  if ((p === '46elks' || p === 'elks') && process.env.ELKS_API_USERNAME && process.env.ELKS_API_PASSWORD) return '46elks';
  return 'test';
}

/**
 * Gör om ett telefonnummer till internationellt format (+46701234567).
 * Null om det inte går att tolka. mobile=false när ett svenskt nummer inte är ett mobilnummer.
 */
export function normalizePhone(input: string | null | undefined): { e164: string; mobile: boolean } | null {
  if (!input) return null;
  let s = input.trim().replace(/[\s\-().\/]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('0')) s = `+46${s.slice(1)}`;
  else if (!s.startsWith('+') && s.startsWith('46')) s = `+${s}`;
  if (!/^\+\d{8,15}$/.test(s)) return null;
  if (s.startsWith('+46')) {
    const national = s.slice(3);
    if (national.startsWith('0')) s = `+46${national.slice(1)}`;
    return { e164: s, mobile: /^\+467[02369]\d{7}$/.test(s) };
  }
  return { e164: s, mobile: true };
}

/** Null om numret får ta emot SMS, annars en förklaring till spärren. */
export function smsAllowlistBlock(e164: string): string | null {
  if (process.env.EMAIL_ALLOWLIST_ONLY !== 'true' && process.env.SMS_ALLOWLIST_ONLY !== 'true') return null;
  const list = (process.env.SMS_ALLOWLIST ?? '')
    .split(/[,;]+/)
    .map((x) => normalizePhone(x)?.e164)
    .filter(Boolean);
  return list.includes(e164) ? null : `Inte skickat: testmiljön skickar bara SMS till tillåtna testnummer och ${e164} finns inte bland dem.`;
}

/** Tecken som ryms i GSM-alfabetet. Annat (till exempel emoji) gör SMS:et kortare per del. */
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

/** Antal SMS-delar ett meddelande blir, och tecken per del. */
export function smsParts(text: string): { chars: number; parts: number; perPart: number; unicode: boolean } {
  const unicode = !GSM.test(text);
  const extended = unicode ? 0 : (text.match(/[\^{}\\[~\]|€]/g) ?? []).length;
  const chars = [...text].length + extended;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const parts = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi);
  return { chars, parts, perPart: parts > 1 ? multi : single, unicode };
}

/** Avsändarnamn: SMS_FROM eller bolagets namn, högst 11 tecken a–z och 0–9. */
export function smsSender(companyName: string): string {
  const raw = (process.env.SMS_FROM?.trim() || companyName)
    .replace(/[åä]/g, 'a').replace(/[ÅÄ]/g, 'A').replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/\b(AB|HB|KB)\b/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
  const s = raw.slice(0, 11);
  return /^[A-Za-z]/.test(s) && s.length >= 3 ? s : 'Hyresvard';
}

export interface OutgoingSms {
  from: string;
  to: string; // +46...
  text: string;
}

async function sendElks(m: OutgoingSms): Promise<void> {
  const auth = Buffer.from(`${process.env.ELKS_API_USERNAME}:${process.env.ELKS_API_PASSWORD}`).toString('base64');
  const res = await fetch(process.env.ELKS_API_URL ?? 'https://api.46elks.com/a1/sms', {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ from: m.from, to: m.to, message: m.text }).toString(),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401) throw new Error('46elks nekade inloggningen (401). Kontrollera ELKS_API_USERNAME och ELKS_API_PASSWORD.');
    throw new Error(`46elks svarade ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

async function sendBrevoSms(m: OutgoingSms): Promise<void> {
  const res = await fetch(process.env.BREVO_SMS_URL ?? 'https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: m.from, recipient: m.to.replace(/^\+/, ''), content: m.text, type: 'transactional', unicodeEnabled: true }),
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
    if (res.status === 402) throw new Error('Brevo: SMS-krediterna är slut. Köp fler SMS i Brevo.');
    throw new Error(`Brevo svarade ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/** Skickar ett SMS, eller sparar det som .txt i OUTBOX_DIR i testläge och när numret spärras. */
export async function deliverSms(m: OutgoingSms, fileBase: string): Promise<{ status: 'sent' | 'test'; note: string | null }> {
  const mode = smsMode();
  const block = mode === 'test' ? null : smsAllowlistBlock(m.to);
  if (mode === 'test' || block) {
    const dir = deliveryMode().outbox;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${fileBase}.sms.txt`), `Från: ${m.from}\nTill: ${m.to}\n\n${m.text}\n`, 'utf8');
    return { status: 'test', note: block };
  }
  if (mode === 'brevo') await sendBrevoSms(m);
  else await sendElks(m);
  return { status: 'sent', note: null };
}
