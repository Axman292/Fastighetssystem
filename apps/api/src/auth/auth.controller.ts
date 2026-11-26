import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { parse } from '../common/validation';
import { COMPANY_COOKIE, SESSION_COOKIE } from './auth.guard';
import { AuthService } from './auth.service';
import { ALL_COMPANIES, Ctx, Public, RequestContext } from './request-context';

const loginSchema = z.object({ email: z.string().email('Ange en giltig e-postadress'), password: z.string().min(1) });
const switchSchema = z.object({ companyId: z.union([z.literal(ALL_COMPANIES), z.string().uuid()]) });

function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    expires,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(loginSchema, body);
    const session = await this.auth.login(email, password, { ip: req.ip, userAgent: req.header('user-agent') });
    res.cookie(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
    return { ok: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  }

  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return {
      user: { id: ctx.userId, name: ctx.name, email: ctx.email, isGroupAdmin: ctx.isGroupAdmin },
      companies: ctx.access,
      activeCompanyId: ctx.activeCompanyId,
    };
  }

  /** Byter aktivt bolag utan ny inloggning. "all" visar hela koncernen. */
  @Post('switch-company')
  @HttpCode(200)
  switchCompany(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { companyId } = parse(switchSchema, body);
    if (companyId !== ALL_COMPANIES && !ctx.access.some((a) => a.companyId === companyId)) {
      return res.status(403).json({ message: 'Du har inte tillgång till bolaget' });
    }
    res.cookie(COMPANY_COOKIE, companyId, { ...cookieOptions(), maxAge: 365 * 24 * 3600_000 });
    return { activeCompanyId: companyId === ALL_COMPANIES ? null : companyId };
  }
}
