import { createParamDecorator, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { DbContext } from '../db/db';

export const ALL_COMPANIES = 'all';

export interface CompanyAccess {
  companyId: string;
  companyName: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
}

/** Inloggad användare och valt bolag för ett anrop. */
export interface RequestContext {
  requestId: string;
  userId: string;
  groupId: string;
  name: string;
  email: string;
  isGroupAdmin: boolean;
  access: CompanyAccess[];
  /** Valt bolag, eller null när hela koncernen visas. */
  activeCompanyId: string | null;
  /** sha256 av sessionens token, för att känna igen den aktuella sessionen. */
  sessionTokenHash?: string;
  mfaEnabled?: boolean;
  /** Koncernen kräver tvåstegsverifiering och användaren har inte slagit på den än. */
  mfaSetupRequired?: boolean;
  sessionIdleMinutes?: number;
}

export type AuthedRequest = Request & { ctx?: RequestContext };

export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): RequestContext => {
  const req = host.switchToHttp().getRequest<AuthedRequest>();
  if (!req.ctx) throw new ForbiddenException();
  return req.ctx;
});

export const PUBLIC_KEY = 'public';
/** Markerar en route som öppen utan inloggning. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const MFA_SETUP_KEY = 'allow-during-mfa-setup';
/** Route som får användas innan tvåstegsverifiering är uppsatt (när koncernen kräver det). */
export const AllowDuringMfaSetup = () => SetMetadata(MFA_SETUP_KEY, true);

/** Bolag som får läsas i anropet: valt bolag, eller alla i koncernvyn. */
export function readableCompanyIds(ctx: RequestContext): string[] {
  if (ctx.activeCompanyId) return [ctx.activeCompanyId];
  return ctx.access.map((a) => a.companyId);
}

export function dbContext(ctx: RequestContext, companyIds = readableCompanyIds(ctx)): DbContext {
  return { userId: ctx.userId, groupId: ctx.groupId, companyIds, requestId: ctx.requestId };
}

/**
 * Kräver att exakt ett bolag är valt och att användaren har rättigheten där.
 * Skrivningar görs alltid i ett bolag, även när koncernvyn visas.
 */
export function requireCompany(ctx: RequestContext, permission: string): string {
  if (!ctx.activeCompanyId) {
    throw new ForbiddenException('Välj ett bolag för att göra ändringar');
  }
  requirePermission(ctx, ctx.activeCompanyId, permission);
  return ctx.activeCompanyId;
}

export function requirePermission(ctx: RequestContext, companyId: string, permission: string): void {
  const access = ctx.access.find((a) => a.companyId === companyId);
  if (!access || !access.permissions.includes(permission)) {
    throw new ForbiddenException('Du saknar behörighet för detta');
  }
}

export function requireGroupAdmin(ctx: RequestContext): void {
  if (!ctx.isGroupAdmin) throw new ForbiddenException('Kräver koncernadministratör');
}
