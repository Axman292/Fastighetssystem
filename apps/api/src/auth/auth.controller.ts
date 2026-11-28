import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { parse } from '../common/validation';
import { systemDb } from '../db/db';
import { appUser } from '../db/schema';
import { COMPANY_COOKIE, SESSION_COOKIE } from './auth.guard';
import { AuthService } from './auth.service';
import { limitOrThrow, LIMITS } from './rate-limit';
import { ALL_COMPANIES, AllowDuringMfaSetup, Ctx, Public, RequestContext } from './request-context';
import { appUrl, assertPassword, clientMeta, issueToken, logEvent, resetMailText, sendAuthMail } from './security';

const loginSchema = z.object({ email: z.string().email('Ange en giltig e-postadress'), password: z.string().min(1) });
const mfaSchema = z.object({ ticket: z.string().min(10), code: z.string().trim().min(6).max(20) });
const forgotSchema = z.object({ email: z.string().email('Ange en giltig e-postadress') });
const setPasswordSchema = z.object({ token: z.string().min(10), password: z.string() });
const switchSchema = z.object({ companyId: z.union([z.literal(ALL_COMPANIES), z.string().uuid()]) });

export function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    expires,
  };
}

@Controller('auth')
@AllowDuringMfaSetup()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Steg 1. Svarar mfaRequired med en biljett när en engångskod också behövs. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(loginSchema, body);
    const result = await this.auth.login(email, password, clientMeta(req));
    if (result.kind === 'mfa') return { ok: false, mfaRequired: true, ticket: result.ticket };
    res.cookie(SESSION_COOKIE, result.token, cookieOptions(result.expiresAt));
    return { ok: true };
  }

  /** Steg 2: sexsiffrig kod från autentiseringsappen eller en reservkod. */
  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { ticket, code } = parse(mfaSchema, body);
    const session = await this.auth.loginMfa(ticket, code, clientMeta(req));
    res.cookie(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
    return { ok: true };
  }

  /** Skickar en länk för nytt lösenord. Svarar alltid lika, så att ingen kan ta reda på vilka konton som finns. */
  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  async forgot(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(forgotSchema, body);
    const normalized = email.trim().toLowerCase();
    limitOrThrow(`forgot-ip:${req.ip}`, LIMITS.forgotPerIp.limit, LIMITS.forgotPerIp.windowMs);
    limitOrThrow(`forgot-email:${normalized}`, LIMITS.forgotPerEmail.limit, LIMITS.forgotPerEmail.windowMs);
    const [user] = await systemDb().select().from(appUser).where(eq(appUser.email, normalized));
    if (user?.active) {
      const token = await issueToken(user.id, 'password_reset');
      const link = `${appUrl(req)}/nytt-losenord?token=${token}`;
      const mail = await sendAuthMail(user.email, 'Nytt lösenord till Fastighetssystem', resetMailText(user.name, link), `losenord-${user.id}`);
      await logEvent({
        event: 'password_reset_requested',
        groupId: user.groupId,
        userId: user.id,
        email: user.email,
        meta: clientMeta(req),
        detail: mail.status === 'sent' ? 'E-post skickad' : `E-post ej skickad: ${mail.note ?? 'testläge'}`,
      });
    }
    return { ok: true };
  }

  /** Visar vad en länk gäller innan användaren väljer lösenord. */
  @Public()
  @Get('token/:token')
  async token(@Param('token') token: string) {
    const info = await this.auth.tokenInfo(token);
    if (!info) return { valid: false };
    return { valid: true, purpose: info.purpose, email: info.email, name: info.name };
  }

  @Public()
  @Post('password/set')
  @HttpCode(200)
  async setPassword(@Body() body: unknown, @Req() req: Request) {
    const { token, password } = parse(setPasswordSchema, body);
    const info = await this.auth.tokenInfo(token);
    assertPassword(password, info?.email);
    return this.auth.setPasswordWithToken(token, password, clientMeta(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token, clientMeta(req));
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  }

  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return {
      user: {
        id: ctx.userId,
        name: ctx.name,
        email: ctx.email,
        isGroupAdmin: ctx.isGroupAdmin,
        mfaEnabled: !!ctx.mfaEnabled,
      },
      companies: ctx.access,
      activeCompanyId: ctx.activeCompanyId,
      mfaSetupRequired: !!ctx.mfaSetupRequired,
      sessionIdleMinutes: ctx.sessionIdleMinutes ?? 30,
    };
  }

  /** Byter aktivt bolag utan ny inloggning. "all" visar hela koncernen. */
  @Post('switch-company')
  @HttpCode(200)
  switchCompany(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { companyId } = parse(switchSchema, body);
    if (companyId !== ALL_COMPANIES && !ctx.access.some((a) => a.companyId === companyId)) {
      throw new ForbiddenException('Du har inte tillgång till bolaget');
    }
    res.cookie(COMPANY_COOKIE, companyId, { ...cookieOptions(), maxAge: 365 * 24 * 3600_000 });
    return { activeCompanyId: companyId === ALL_COMPANIES ? null : companyId };
  }
}
