import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { systemDb } from '../db/db';
import {
  appUser,
  authToken,
  company,
  companyGroup,
  membership,
  mfaRecoveryCode,
  role,
  rolePermission,
  userSecurity,
  userSession,
} from '../db/schema';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from './password';
import { isLimited, LIMITS, record } from './rate-limit';
import { ClientMeta, ensureSecurityRow, issueToken, logEvent } from './security';
import { normalizeRecoveryCode, openSecret, verifyTotp } from './totp';
import { ALL_COMPANIES, CompanyAccess, RequestContext } from './request-context';

/** Längsta tid en session gäller, även om den används hela tiden. */
const SESSION_HOURS = 12;
/** Hur ofta senaste aktivitet skrivs till databasen. */
const TOUCH_MS = 60_000;

export type LoginResult =
  | { kind: 'session'; token: string; expiresAt: Date }
  | { kind: 'mfa'; ticket: string };

/**
 * Inloggning med e-post och lösenord, och därefter engångskod från en
 * autentiseringsapp när användaren har tvåstegsverifiering påslagen.
 * BankID kan läggas till som ytterligare metod som också slutar i createSession().
 */
@Injectable()
export class AuthService {
  async login(email: string, password: string, meta: ClientMeta): Promise<LoginResult> {
    const ipKey = `login-ip:${meta.ip ?? 'okänd'}`;
    if (isLimited(ipKey, LIMITS.loginFailuresPerIp.limit, LIMITS.loginFailuresPerIp.windowMs)) {
      throw new UnauthorizedException('För många misslyckade försök från din anslutning. Vänta 15 minuter och försök igen.');
    }
    const db = systemDb();
    const normalized = email.trim().toLowerCase();
    const [row] = await db
      .select({ user: appUser, sec: userSecurity })
      .from(appUser)
      .leftJoin(userSecurity, eq(userSecurity.userId, appUser.id))
      .where(eq(appUser.email, normalized));
    const user = row?.user;
    const sec = row?.sec;

    if (user && sec?.lockedUntil && sec.lockedUntil > new Date()) {
      record(ipKey);
      await logEvent({ event: 'login_locked', groupId: user.groupId, userId: user.id, email: normalized, meta });
      const minutes = Math.max(1, Math.ceil((sec.lockedUntil.getTime() - Date.now()) / 60_000));
      throw new UnauthorizedException(
        `Kontot är tillfälligt spärrat efter för många felaktiga försök. Försök igen om ${minutes} min eller välj "Glömt lösenord".`,
      );
    }

    // Jämför alltid ett lösenord så att svarstiden inte avslöjar om kontot finns.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !ok) {
      record(ipKey);
      if (user) await this.registerFailure(user.id, user.groupId, normalized, meta, 'login_failed');
      else await logEvent({ event: 'login_failed', email: normalized, meta, detail: 'Okänd e-postadress' });
      throw new UnauthorizedException('Fel e-post eller lösenord');
    }
    if (!user.active) {
      await logEvent({ event: 'login_inactive', groupId: user.groupId, userId: user.id, email: normalized, meta });
      throw new UnauthorizedException('Kontot är inaktiverat. Kontakta din administratör.');
    }

    if (sec?.totpEnabledAt && sec.totpSecret) {
      await db.update(userSecurity).set({ failedLogins: 0 }).where(eq(userSecurity.userId, user.id));
      return { kind: 'mfa', ticket: await issueToken(user.id, 'login_mfa') };
    }
    return { kind: 'session', ...(await this.completeLogin(user.id, user.groupId, normalized, meta, null)) };
  }

  /** Andra steget: engångskod från appen eller en reservkod. */
  async loginMfa(ticket: string, code: string, meta: ClientMeta) {
    const ipKey = `login-ip:${meta.ip ?? 'okänd'}`;
    if (isLimited(ipKey, LIMITS.loginFailuresPerIp.limit, LIMITS.loginFailuresPerIp.windowMs)) {
      throw new UnauthorizedException('För många misslyckade försök. Vänta 15 minuter och försök igen.');
    }
    const db = systemDb();
    const [row] = await db
      .select({ token: authToken, user: appUser, sec: userSecurity })
      .from(authToken)
      .innerJoin(appUser, eq(appUser.id, authToken.userId))
      .innerJoin(userSecurity, eq(userSecurity.userId, appUser.id))
      .where(
        and(
          eq(authToken.tokenHash, hashToken(ticket)),
          eq(authToken.purpose, 'login_mfa'),
          isNull(authToken.usedAt),
          gt(authToken.expiresAt, new Date()),
        ),
      );
    if (!row || row.token.attempts >= 5 || !row.user.active || !row.sec.totpSecret) {
      throw new UnauthorizedException('Inloggningen har gått ut. Börja om med e-post och lösenord.');
    }
    const { user, sec } = row;

    let method: string | null = null;
    const step = verifyTotp(openSecret(sec.totpSecret!), code, sec.totpLastStep ?? null);
    if (step !== null) {
      await db.update(userSecurity).set({ totpLastStep: step }).where(eq(userSecurity.userId, user.id));
      method = 'med engångskod';
    } else {
      const recovery = normalizeRecoveryCode(code);
      if (recovery) {
        const used = await db
          .update(mfaRecoveryCode)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(mfaRecoveryCode.userId, user.id),
              eq(mfaRecoveryCode.codeHash, hashToken(recovery)),
              isNull(mfaRecoveryCode.usedAt),
            ),
          )
          .returning({ h: mfaRecoveryCode.codeHash });
        if (used.length) method = 'med reservkod';
      }
    }

    if (!method) {
      record(ipKey);
      await db
        .update(authToken)
        .set({ attempts: sql`${authToken.attempts} + 1` })
        .where(eq(authToken.tokenHash, row.token.tokenHash));
      await this.registerFailure(user.id, user.groupId, user.email, meta, 'mfa_failed');
      throw new UnauthorizedException('Fel kod. Kontrollera att klockan i telefonen stämmer och försök igen.');
    }
    await db.update(authToken).set({ usedAt: new Date() }).where(eq(authToken.tokenHash, row.token.tokenHash));
    return this.completeLogin(user.id, user.groupId, user.email, meta, method);
  }

  private async registerFailure(userId: string, groupId: string, email: string, meta: ClientMeta, event: string) {
    await ensureSecurityRow(userId);
    const [s] = await systemDb()
      .update(userSecurity)
      .set({ failedLogins: sql`${userSecurity.failedLogins} + 1` })
      .where(eq(userSecurity.userId, userId))
      .returning({ failed: userSecurity.failedLogins });
    await logEvent({ event, groupId, userId, email, meta });
    if (s && s.failed >= LIMITS.accountFailures) {
      await systemDb()
        .update(userSecurity)
        .set({ failedLogins: 0, lockedUntil: new Date(Date.now() + LIMITS.accountLockMinutes * 60_000) })
        .where(eq(userSecurity.userId, userId));
      await logEvent({ event: 'account_locked', groupId, userId, email, meta, detail: `${LIMITS.accountLockMinutes} minuter` });
    }
  }

  private async completeLogin(userId: string, groupId: string, email: string, meta: ClientMeta, detail: string | null) {
    await ensureSecurityRow(userId);
    await systemDb()
      .update(userSecurity)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(userSecurity.userId, userId));
    await logEvent({ event: 'login_ok', groupId, userId, email, meta, detail });
    return this.createSession(userId, meta);
  }

  async createSession(userId: string, meta: ClientMeta) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
    await systemDb()
      .insert(userSession)
      .values({
        tokenHash: hashToken(token),
        userId,
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      });
    return { token, expiresAt };
  }

  async logout(token: string, meta: ClientMeta) {
    const [s] = await systemDb()
      .delete(userSession)
      .where(eq(userSession.tokenHash, hashToken(token)))
      .returning({ userId: userSession.userId });
    if (s) {
      const [u] = await systemDb().select().from(appUser).where(eq(appUser.id, s.userId));
      if (u) await logEvent({ event: 'logout', groupId: u.groupId, userId: u.id, email: u.email, meta });
    }
  }

  /** Sätter ett nytt lösenord via en inbjudan eller en länk för nytt lösenord. */
  async setPasswordWithToken(token: string, password: string, meta: ClientMeta) {
    const info = await this.tokenInfo(token);
    if (!info) throw new BadRequestException('Länken är ogiltig eller har gått ut. Be om en ny.');
    const db = systemDb();
    await db
      .update(appUser)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(appUser.id, info.userId));
    await ensureSecurityRow(info.userId);
    await db
      .update(userSecurity)
      .set({ passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null })
      .where(eq(userSecurity.userId, info.userId));
    await db.update(authToken).set({ usedAt: new Date() }).where(eq(authToken.tokenHash, hashToken(token)));
    await db.delete(userSession).where(eq(userSession.userId, info.userId));
    await logEvent({
      event: info.purpose === 'invite' ? 'invite_accepted' : 'password_reset',
      groupId: info.groupId,
      userId: info.userId,
      email: info.email,
      meta,
    });
    return { email: info.email };
  }

  /** Vad en länk gäller, eller null om den inte går att använda. */
  async tokenInfo(token: string) {
    const [row] = await systemDb()
      .select({
        userId: appUser.id,
        groupId: appUser.groupId,
        email: appUser.email,
        name: appUser.name,
        active: appUser.active,
        purpose: authToken.purpose,
      })
      .from(authToken)
      .innerJoin(appUser, eq(appUser.id, authToken.userId))
      .where(and(eq(authToken.tokenHash, hashToken(token)), isNull(authToken.usedAt), gt(authToken.expiresAt, new Date())));
    if (!row || !row.active || row.purpose === 'login_mfa') return null;
    return row as typeof row & { purpose: 'invite' | 'password_reset' };
  }

  /** Bygger anropets kontext från sessionscookie och valt bolag. */
  async resolve(token: string, requestedCompany: string | undefined, meta?: ClientMeta): Promise<RequestContext | null> {
    const db = systemDb();
    const tokenHash = hashToken(token);
    const [row] = await db
      .select({ user: appUser, session: userSession, sec: userSecurity, group: companyGroup })
      .from(userSession)
      .innerJoin(appUser, eq(appUser.id, userSession.userId))
      .innerJoin(companyGroup, eq(companyGroup.id, appUser.groupId))
      .leftJoin(userSecurity, eq(userSecurity.userId, appUser.id))
      .where(and(eq(userSession.tokenHash, tokenHash), gt(userSession.expiresAt, new Date())));
    if (!row || !row.user.active) return null;
    const { user, session, group } = row;

    // Utloggning efter inaktivitet
    const idleMs = group.sessionIdleMinutes * 60_000;
    const since = Date.now() - session.lastSeenAt.getTime();
    if (since > idleMs) {
      await db.delete(userSession).where(eq(userSession.tokenHash, tokenHash));
      await logEvent({ event: 'session_timeout', groupId: user.groupId, userId: user.id, email: user.email, meta });
      return null;
    }
    if (since > TOUCH_MS) {
      await db.update(userSession).set({ lastSeenAt: new Date() }).where(eq(userSession.tokenHash, tokenHash));
    }

    const access = await this.loadAccess(user.id, user.groupId, user.isGroupAdmin);
    let activeCompanyId: string | null = null;
    if (requestedCompany && requestedCompany !== ALL_COMPANIES) {
      activeCompanyId = access.some((a) => a.companyId === requestedCompany) ? requestedCompany : null;
    } else if (!requestedCompany && access.length === 1) {
      activeCompanyId = access[0].companyId;
    }

    const mfaEnabled = !!row.sec?.totpEnabledAt;
    return {
      requestId: randomUUID(),
      userId: user.id,
      groupId: user.groupId,
      name: user.name,
      email: user.email,
      isGroupAdmin: user.isGroupAdmin,
      access,
      activeCompanyId,
      sessionTokenHash: tokenHash,
      mfaEnabled,
      mfaSetupRequired: group.requireMfa && !mfaEnabled,
      sessionIdleMinutes: group.sessionIdleMinutes,
    };
  }

  private async loadAccess(userId: string, groupId: string, isGroupAdmin: boolean): Promise<CompanyAccess[]> {
    const db = systemDb();
    const roles = await db
      .select({ id: role.id, key: role.key, name: role.name, permission: rolePermission.permission })
      .from(role)
      .leftJoin(rolePermission, eq(rolePermission.roleId, role.id));
    const roleInfo = new Map<string, { key: string; name: string; permissions: string[] }>();
    for (const r of roles) {
      const info = roleInfo.get(r.id) ?? { key: r.key, name: r.name, permissions: [] };
      if (r.permission) info.permissions.push(r.permission);
      roleInfo.set(r.id, info);
    }

    if (isGroupAdmin) {
      const adminRole = [...roleInfo.values()].find((r) => r.key === 'group_admin')!;
      const companies = await db
        .select({ id: company.id, name: company.name })
        .from(company)
        .where(and(eq(company.groupId, groupId), eq(company.active, true)))
        .orderBy(company.name);
      return companies.map((c) => ({
        companyId: c.id,
        companyName: c.name,
        roleKey: adminRole.key,
        roleName: adminRole.name,
        permissions: adminRole.permissions,
      }));
    }

    const rows = await db
      .select({ companyId: company.id, companyName: company.name, roleId: membership.roleId })
      .from(membership)
      .innerJoin(company, eq(company.id, membership.companyId))
      .where(
        and(
          eq(membership.userId, userId),
          eq(company.active, true),
          sql`(${membership.validUntil} is null or ${membership.validUntil} >= current_date)`,
        ),
      )
      .orderBy(company.name);
    return rows.map((r) => {
      const info = roleInfo.get(r.roleId)!;
      return {
        companyId: r.companyId,
        companyName: r.companyName,
        roleKey: info.key,
        roleName: info.name,
        permissions: info.permissions,
      };
    });
  }
}

let dummy: string | undefined;
async function dummyHash() {
  dummy ??= await hashPassword(randomUUID());
  return dummy;
}
