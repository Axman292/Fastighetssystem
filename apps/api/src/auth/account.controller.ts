import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import { parse } from '../common/validation';
import { systemDb } from '../db/db';
import { appUser, companyGroup, mfaRecoveryCode, userSecurity, userSession } from '../db/schema';
import { hashPassword, hashToken, verifyPassword } from './password';
import { AllowDuringMfaSetup, Ctx, RequestContext } from './request-context';
import { assertPassword, clientMeta, ensureSecurityRow, logEvent, revokeSessions } from './security';
import { newRecoveryCodes, newTotpSecret, openSecret, otpauthUrl, sealSecret, verifyTotp } from './totp';

const passwordSchema = z.object({ currentPassword: z.string().min(1, 'Ange ditt nuvarande lösenord'), newPassword: z.string() });
const codeSchema = z.object({ code: z.string().trim().min(6).max(10) });
const disableSchema = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(10) });

/** Mitt konto: lösenord, tvåstegsverifiering och inloggade enheter. */
@Controller('account')
@AllowDuringMfaSetup()
export class AccountController {
  @Get()
  async get(@Ctx() ctx: RequestContext) {
    const db = systemDb();
    await ensureSecurityRow(ctx.userId);
    const [sec] = await db.select().from(userSecurity).where(eq(userSecurity.userId, ctx.userId));
    const codes = await db
      .select({ h: mfaRecoveryCode.codeHash })
      .from(mfaRecoveryCode)
      .where(and(eq(mfaRecoveryCode.userId, ctx.userId), isNull(mfaRecoveryCode.usedAt)));
    const sessions = await db
      .select()
      .from(userSession)
      .where(and(eq(userSession.userId, ctx.userId), gt(userSession.expiresAt, new Date())))
      .orderBy(desc(userSession.lastSeenAt));
    const [group] = await db.select().from(companyGroup).where(eq(companyGroup.id, ctx.groupId));
    return {
      name: ctx.name,
      email: ctx.email,
      mfaEnabled: !!sec.totpEnabledAt,
      mfaEnabledAt: sec.totpEnabledAt,
      recoveryCodesLeft: codes.length,
      passwordChangedAt: sec.passwordChangedAt,
      lastLoginAt: sec.lastLoginAt,
      requireMfa: group.requireMfa,
      sessionIdleMinutes: group.sessionIdleMinutes,
      sessions: sessions.map((s) => ({
        id: s.tokenHash.slice(0, 16),
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.tokenHash === ctx.sessionTokenHash,
      })),
    };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const { currentPassword, newPassword } = parse(passwordSchema, body);
    const db = systemDb();
    const [user] = await db.select().from(appUser).where(eq(appUser.id, ctx.userId));
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new BadRequestException({
        message: 'Nuvarande lösenord stämmer inte',
        fields: [{ path: 'currentPassword', message: 'Nuvarande lösenord stämmer inte' }],
      });
    }
    try {
      assertPassword(newPassword, ctx.email);
    } catch (e) {
      const r = (e as BadRequestException).getResponse() as { message: string };
      throw new BadRequestException({ message: r.message, fields: [{ path: 'newPassword', message: r.message }] });
    }
    if (currentPassword === newPassword) throw new BadRequestException('Välj ett annat lösenord än det nuvarande');
    await db.update(appUser).set({ passwordHash: await hashPassword(newPassword) }).where(eq(appUser.id, ctx.userId));
    await ensureSecurityRow(ctx.userId);
    await db.update(userSecurity).set({ passwordChangedAt: new Date() }).where(eq(userSecurity.userId, ctx.userId));
    // Andra enheter loggas ut, den här sessionen behålls.
    await revokeSessions(ctx.userId, ctx.sessionTokenHash);
    await logEvent({ event: 'password_changed', groupId: ctx.groupId, userId: ctx.userId, email: ctx.email, meta: clientMeta(req) });
    return { ok: true };
  }

  /** Startar uppsättning: ny hemlighet och QR-kod att skanna med appen. */
  @Post('mfa/setup')
  @HttpCode(200)
  async setupMfa(@Ctx() ctx: RequestContext) {
    if (ctx.mfaEnabled) throw new BadRequestException('Tvåstegsverifiering är redan påslagen');
    const secret = newTotpSecret();
    await ensureSecurityRow(ctx.userId);
    await systemDb()
      .update(userSecurity)
      .set({ totpPendingSecret: sealSecret(secret) })
      .where(eq(userSecurity.userId, ctx.userId));
    const url = otpauthUrl(secret, ctx.email);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauthUrl: url, qrSvg };
  }

  /** Bekräftar med en första kod från appen. Svarar med reservkoder som visas en gång. */
  @Post('mfa/enable')
  @HttpCode(200)
  async enableMfa(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const { code } = parse(codeSchema, body);
    const db = systemDb();
    const [sec] = await db.select().from(userSecurity).where(eq(userSecurity.userId, ctx.userId));
    if (!sec?.totpPendingSecret) throw new BadRequestException('Starta uppsättningen igen');
    const step = verifyTotp(openSecret(sec.totpPendingSecret), code, null);
    if (step === null) {
      throw new BadRequestException({ message: 'Koden stämmer inte. Försök med nästa kod i appen.', fields: [{ path: 'code', message: 'Koden stämmer inte' }] });
    }
    await db
      .update(userSecurity)
      .set({ totpSecret: sec.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step })
      .where(eq(userSecurity.userId, ctx.userId));
    const codes = await this.replaceRecoveryCodes(ctx.userId);
    await logEvent({ event: 'mfa_enabled', groupId: ctx.groupId, userId: ctx.userId, email: ctx.email, meta: clientMeta(req) });
    return { recoveryCodes: codes };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  async disableMfa(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const { password, code } = parse(disableSchema, body);
    const db = systemDb();
    const [group] = await db.select().from(companyGroup).where(eq(companyGroup.id, ctx.groupId));
    if (group.requireMfa) throw new ForbiddenException('Tvåstegsverifiering krävs för alla användare och kan inte stängas av');
    const [user] = await db.select().from(appUser).where(eq(appUser.id, ctx.userId));
    const [sec] = await db.select().from(userSecurity).where(eq(userSecurity.userId, ctx.userId));
    if (!sec?.totpSecret) throw new BadRequestException('Tvåstegsverifiering är inte påslagen');
    const okPw = await verifyPassword(password, user.passwordHash);
    const step = verifyTotp(openSecret(sec.totpSecret), code, sec.totpLastStep ?? null);
    if (!okPw || step === null) throw new BadRequestException('Lösenordet eller koden stämmer inte');
    await clearMfa(ctx.userId);
    await logEvent({ event: 'mfa_disabled', groupId: ctx.groupId, userId: ctx.userId, email: ctx.email, meta: clientMeta(req) });
    return { ok: true };
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async newCodes(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const { code } = parse(codeSchema, body);
    const db = systemDb();
    const [sec] = await db.select().from(userSecurity).where(eq(userSecurity.userId, ctx.userId));
    if (!sec?.totpSecret) throw new BadRequestException('Tvåstegsverifiering är inte påslagen');
    const step = verifyTotp(openSecret(sec.totpSecret), code, sec.totpLastStep ?? null);
    if (step === null) throw new BadRequestException('Koden stämmer inte');
    await db.update(userSecurity).set({ totpLastStep: step }).where(eq(userSecurity.userId, ctx.userId));
    const codes = await this.replaceRecoveryCodes(ctx.userId);
    await logEvent({ event: 'recovery_codes_created', groupId: ctx.groupId, userId: ctx.userId, email: ctx.email, meta: clientMeta(req) });
    return { recoveryCodes: codes };
  }

  /** Loggar ut en annan enhet, eller alla andra med id "others". */
  @Post('sessions/:id/logout')
  @HttpCode(200)
  async logoutSession(@Ctx() ctx: RequestContext, @Param('id') id: string, @Req() req: Request) {
    const db = systemDb();
    const sessions = await db.select({ h: userSession.tokenHash }).from(userSession).where(eq(userSession.userId, ctx.userId));
    for (const s of sessions) {
      if (s.h === ctx.sessionTokenHash) continue;
      if (id === 'others' || s.h.startsWith(id)) await db.delete(userSession).where(eq(userSession.tokenHash, s.h));
    }
    await logEvent({
      event: 'sessions_revoked',
      groupId: ctx.groupId,
      userId: ctx.userId,
      email: ctx.email,
      meta: clientMeta(req),
      detail: id === 'others' ? 'Alla andra enheter' : 'En enhet',
    });
    return { ok: true };
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const db = systemDb();
    const codes = newRecoveryCodes();
    await db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId));
    await db.insert(mfaRecoveryCode).values(codes.map((c) => ({ userId, codeHash: hashToken(c) })));
    return codes;
  }
}

/** Tar bort tvåstegsverifiering och reservkoder för en användare. */
export async function clearMfa(userId: string): Promise<void> {
  const db = systemDb();
  await ensureSecurityRow(userId);
  await db
    .update(userSecurity)
    .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null })
    .where(eq(userSecurity.userId, userId));
  await db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId));
}
