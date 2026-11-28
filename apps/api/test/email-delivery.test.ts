import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowlistBlock, deliverEmail, deliveryMode, OutgoingMail } from '../src/billing/delivery';

const KEYS = ['BREVO_API_KEY', 'SMTP_HOST', 'MAIL_FROM', 'SMTP_FROM', 'EMAIL_ALLOWLIST', 'EMAIL_ALLOWLIST_ONLY', 'OUTBOX_DIR'];
const saved: Record<string, string | undefined> = {};

const mail = (to: string): OutgoingMail => ({
  fromName: 'Testbolaget "AB"',
  to,
  replyTo: 'hyror@example.se',
  subject: 'Hyresavi 1001 från Testbolaget AB',
  text: 'Hej',
  attachments: [{ filename: 'hyresavi-1001.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }],
});

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'outbox-'));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('e-postutskick', () => {
  it('väljer läge efter miljövariabler', () => {
    expect(deliveryMode().email).toBe('test');
    process.env.SMTP_HOST = 'smtp.example.se';
    expect(deliveryMode().email).toBe('smtp');
    process.env.BREVO_API_KEY = 'nyckel';
    expect(deliveryMode().email).toBe('brevo');
  });

  it('spärrlistan släpper bara igenom tillåtna adresser', () => {
    expect(allowlistBlock('vem@som.helst')).toBeNull();
    process.env.EMAIL_ALLOWLIST_ONLY = 'true';
    expect(allowlistBlock('test@gmail.com')).toMatch(/Inte skickat/);
    process.env.EMAIL_ALLOWLIST = 'Test@Gmail.com, @example.se';
    expect(allowlistBlock('test@gmail.com')).toBeNull();
    expect(allowlistBlock('anna@example.se')).toBeNull();
    expect(allowlistBlock('anna@example.se.evil.com')).not.toBeNull();
    expect(allowlistBlock('annan@gmail.com')).not.toBeNull();
  });

  it('skickar via Brevo med PDF-bilaga och avsändare från MAIL_FROM', async () => {
    process.env.BREVO_API_KEY = 'nyckel';
    process.env.MAIL_FROM = 'avier@exempel.se';
    process.env.EMAIL_ALLOWLIST_ONLY = 'true';
    process.env.EMAIL_ALLOWLIST = 'test@gmail.com';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: '<x>' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await deliverEmail(mail('test@gmail.com'), 'a')).toEqual({ status: 'sent', note: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('nyckel');
    const body = JSON.parse(init.body as string);
    expect(body.sender).toEqual({ name: 'Testbolaget "AB"', email: 'avier@exempel.se' });
    expect(body.to).toEqual([{ email: 'test@gmail.com' }]);
    expect(body.replyTo).toEqual({ email: 'hyror@example.se' });
    expect(body.attachment[0].name).toBe('hyresavi-1001.pdf');
    expect(Buffer.from(body.attachment[0].content, 'base64').toString()).toBe('%PDF-1.4 test');

    // Ej tillåten mottagare: inget anrop, sparas som testläge med förklaring.
    const blocked = await deliverEmail(mail('hyresgast@gmail.com'), 'b');
    expect(blocked.status).toBe('test');
    expect(blocked.note).toMatch(/hyresgast@gmail.com/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(process.env.OUTBOX_DIR!)).toContain('b.eml');
  });

  it('ger ett begripligt fel när Brevo nekar', async () => {
    process.env.BREVO_API_KEY = 'fel';
    process.env.MAIL_FROM = 'avier@exempel.se';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 })));
    await expect(deliverEmail(mail('test@gmail.com'), 'c')).rejects.toThrow(/BREVO_API_KEY/);
  });
});
