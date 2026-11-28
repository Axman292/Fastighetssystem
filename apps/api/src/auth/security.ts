import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { systemDb } from '../db/db';
import { authToken, loginEvent, userSecurity, userSession } from '../db/schema';
import { deliverEmail } from '../billing/delivery';
import { hashToken, newSessionToken } from './password';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export function clientMeta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

// ---------------------------------------------------------------------
// Lösenordsregler
// ---------------------------------------------------------------------

const COMMON = [
  'password', 'lösenord', 'losenord', 'qwerty', '123456', 'abc123', 'sommar', 'vinter', 'hösten', 'varen',
  'fastighet', 'hyresgäst', 'admin', 'welcome', 'välkommen',
];

export const PASSWORD_MIN = 12;

/** Null om lösenordet duger, annars en förklaring på svenska. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Lösenordet ska vara minst ${PASSWORD_MIN} tecken`;
  if (password.length > 200) return 'Lösenordet får vara högst 200 tecken';
  const lower = password.toLowerCase();
  if (new Set(lower).size < 5) return 'Lösenordet har för få olika tecken';
  if (email && lower.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    return 'Lösenordet får inte innehålla din e-postadress';
  }
  if (COMMON.some((w) => lower.replace(/[^a-zåäö]/g, '') === w || lower.startsWith(w + '123'))) {
    return 'Lösenordet är för vanligt, välj ett annat';
  }
  return null;
}

export function assertPassword(password: string, email?: string): void {
  const problem = passwordProblem(password, email);
  if (problem) {
    throw new BadRequestException({ message: problem, fields: [{ path: 'password', message: problem }] });
  }
}

// ---------------------------------------------------------------------
// Inloggningslogg
// ---------------------------------------------------------------------

export const EVENT_LABELS: Record<string, string> = {
  login_ok: 'Inloggad',
  login_failed: 'Fel lösenord',
  login_locked: 'Spärrat konto',
  login_inactive: 'Inaktiverat konto',
  mfa_failed: 'Fel engångskod',
  logout: 'Utloggad',
  session_timeout: 'Utloggad efter inaktivitet',
  password_changed: 'Bytte lösenord',
  password_reset_requested: 'Bad om nytt lösenord',
  password_reset: 'Nytt lösenord via e-postlänk',
  invite_sent: 'Inbjudan skickad',
  invite_accepted: 'Tog emot inbjudan',
  mfa_enabled: 'Slog på tvåstegsverifiering',
  mfa_disabled: 'Stängde av tvåstegsverifiering',
  mfa_reset_by_admin: 'Tvåstegsverifiering nollställd av administratör',
  recovery_codes_created: 'Nya reservkoder',
  account_locked: 'Kontot spärrades efter för många fel',
  account_unlocked: 'Spärren hävd av administratör',
  user_deactivated: 'Användaren inaktiverades',
  user_activated: 'Användaren aktiverades',
  sessions_revoked: 'Utloggad från alla enheter',
  security_settings_changed: 'Ändrade säkerhetsinställningar',
};

export async function logEvent(e: {
  event: keyof typeof EVENT_LABELS | string;
  groupId?: string | null;
  userId?: string | null;
  email?: string | null;
  meta?: ClientMeta;
  detail?: string | null;
}): Promise<void> {
  await systemDb()
    .insert(loginEvent)
    .values({
      event: e.event,
      groupId: e.groupId ?? null,
      userId: e.userId ?? null,
      email: e.email ?? null,
      ip: e.meta?.ip ?? null,
      userAgent: e.meta?.userAgent?.slice(0, 300) ?? null,
      detail: e.detail ?? null,
    } as typeof loginEvent.$inferInsert);
}

// ---------------------------------------------------------------------
// Engångslänkar (inbjudan, nytt lösenord) och inloggningssteg
// ---------------------------------------------------------------------

export type TokenPurpose = 'invite' | 'password_reset' | 'login_mfa';

export const TOKEN_HOURS: Record<TokenPurpose, number> = { invite: 7 * 24, password_reset: 1, login_mfa: 5 / 60 };

/** Skapar en ny engångstoken. Äldre oanvända av samma slag för användaren slutar gälla. */
export async function issueToken(userId: string, purpose: TokenPurpose, createdBy?: string | null): Promise<string> {
  const token = newSessionToken();
  const db = systemDb();
  if (purpose !== 'login_mfa') {
    await db
      .update(authToken)
      .set({ usedAt: new Date() })
      .where(and(eq(authToken.userId, userId), eq(authToken.purpose, purpose), isNull(authToken.usedAt)));
  }
  await db.insert(authToken).values({
    tokenHash: hashToken(token),
    userId,
    purpose,
    createdBy: createdBy ?? null,
    expiresAt: new Date(Date.now() + TOKEN_HOURS[purpose] * 3600_000),
  });
  return token;
}

export async function ensureSecurityRow(userId: string): Promise<void> {
  await systemDb().insert(userSecurity).values({ userId }).onConflictDoNothing();
}

export async function revokeSessions(userId: string, exceptTokenHash?: string): Promise<void> {
  const db = systemDb();
  const rows = await db.select({ h: userSession.tokenHash }).from(userSession).where(eq(userSession.userId, userId));
  for (const r of rows) {
    if (r.h !== exceptTokenHash) await db.delete(userSession).where(eq(userSession.tokenHash, r.h));
  }
}

// ---------------------------------------------------------------------
// E-post med länkar
// ---------------------------------------------------------------------

/** Webbadressen till systemet, för länkar i e-post. APP_URL har företräde. */
export function appUrl(req?: Request): string {
  const fromEnv = process.env.APP_URL?.trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const host = req?.header('x-forwarded-host') ?? req?.header('host') ?? 'localhost:3000';
  const proto = req?.header('x-forwarded-proto') ?? (process.env.COOKIE_SECURE === 'true' ? 'https' : 'http');
  return `${proto.split(',')[0]}://${host.split(',')[0]}`;
}

export async function sendAuthMail(to: string, subject: string, text: string, fileBase: string) {
  try {
    return await deliverEmail({ fromName: 'Fastighetssystem', to, subject, text, attachments: [] }, fileBase);
  } catch (err) {
    return { status: 'failed' as const, note: (err as Error).message };
  }
}

export function inviteMailText(name: string, inviter: string, link: string): string {
  return [
    `Hej ${name}!`,
    '',
    `${inviter} har bjudit in dig till Fastighetssystem.`,
    'Klicka på länken för att välja ditt lösenord. Länken gäller i 7 dagar och kan bara användas en gång.',
    '',
    link,
    '',
    'Har du inte väntat dig det här kan du bortse från meddelandet.',
  ].join('\n');
}

export function resetMailText(name: string, link: string): string {
  return [
    `Hej ${name}!`,
    '',
    'Någon (förhoppningsvis du) har bett om ett nytt lösenord till Fastighetssystem.',
    'Klicka på länken för att välja ett nytt. Länken gäller i 1 timme och kan bara användas en gång.',
    '',
    link,
    '',
    'Har du inte bett om det kan du bortse från meddelandet. Ditt lösenord är då oförändrat.',
  ].join('\n');
}
