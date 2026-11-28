import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Enkel spärr mot gissningsattacker i minnet (en server). Räknar händelser
 * per nyckel (t.ex. IP-adress) inom ett tidsfönster.
 */
const hits = new Map<string, number[]>();

function recent(key: string, windowMs: number, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

export function isLimited(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  return recent(key, windowMs, now).length >= limit;
}

export function record(key: string, now = Date.now()): void {
  const list = hits.get(key) ?? [];
  list.push(now);
  hits.set(key, list);
  // Håll minnet litet
  if (hits.size > 50_000) hits.delete(hits.keys().next().value!);
}

/** Kastar 429 om gränsen är nådd, annars räknas försöket. */
export function limitOrThrow(key: string, limit: number, windowMs: number): void {
  if (isLimited(key, limit, windowMs)) {
    throw new HttpException('För många försök. Vänta en stund och försök igen.', HttpStatus.TOO_MANY_REQUESTS);
  }
  record(key);
}

export function clearLimits(): void {
  hits.clear();
}

export const LIMITS = {
  /** Felaktiga inloggningar per IP-adress */
  loginFailuresPerIp: { limit: Number(process.env.LOGIN_FAILURES_PER_IP ?? 30), windowMs: 15 * 60_000 },
  /** Begäran om nytt lösenord per IP-adress och per e-postadress */
  forgotPerIp: { limit: 10, windowMs: 15 * 60_000 },
  forgotPerEmail: { limit: 3, windowMs: 60 * 60_000 },
  /** Felaktiga försök på kontot innan det spärras en stund */
  accountFailures: 5,
  accountLockMinutes: 15,
};
