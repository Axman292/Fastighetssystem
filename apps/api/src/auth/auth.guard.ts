import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthedRequest, MFA_SETUP_KEY, PUBLIC_KEY } from './request-context';

export const SESSION_COOKIE = 'fs_session';
export const COMPANY_COOKIE = 'fs_company';

/** Global vakt: alla routes kräver inloggning om de inte är märkta @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token: string | undefined = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Inte inloggad');
    const requested = (req.header('x-company-id') ?? req.cookies?.[COMPANY_COOKIE]) as string | undefined;
    const ctx = await this.auth.resolve(token, requested, { ip: req.ip, userAgent: req.header('user-agent') });
    if (!ctx) throw new UnauthorizedException('Sessionen har gått ut');
    req.ctx = ctx;
    if (ctx.mfaSetupRequired) {
      const allowed = this.reflector.getAllAndOverride<boolean>(MFA_SETUP_KEY, [context.getHandler(), context.getClass()]);
      if (!allowed) {
        throw new ForbiddenException({
          message: 'Slå på tvåstegsverifiering under Mitt konto innan du fortsätter.',
          code: 'mfa_setup_required',
        });
      }
    }
    return true;
  }
}
