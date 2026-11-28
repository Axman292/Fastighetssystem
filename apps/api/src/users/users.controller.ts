import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { parse } from '../common/validation';
import { systemDb, withContext } from '../db/db';
import { appUser, authToken, company, companyGroup, loginEvent, membership, role, userSecurity } from '../db/schema';
import { hashPassword } from '../auth/password';
import { clearMfa } from '../auth/account.controller';
import { Ctx, dbContext, readableCompanyIds, RequestContext, requireCompany, requireGroupAdmin } from '../auth/request-context';
import {
  appUrl,
  assertPassword,
  clientMeta,
  ensureSecurityRow,
  EVENT_LABELS,
  inviteMailText,
  issueToken,
  logEvent,
  revokeSessions,
  sendAuthMail,
} from '../auth/security';

const ROLE_KEYS = ['group_admin', 'finance', 'manager', 'approver', 'reader', 'auditor'] as const;

const createSchema = z.object({
  email: z.string().email('Ange en giltig e-postadress').transform((v) => v.trim().toLowerCase()),
  name: z.string().trim().min(2, 'Ange namnet').max(200),
  /** Utan lösenord skickas en inbjudan där användaren väljer eget lösenord. */
  password: z.string().optional(),
  roleKey: z.enum(ROLE_KEYS),
});

const grantSchema = z.object({ roleKey: z.enum(ROLE_KEYS) });

const settingsSchema = z.object({
  requireMfa: z.boolean(),
  sessionIdleMinutes: z.number().int().min(5, 'Minst 5 minuter').max(720, 'Högst 12 timmar'),
});

@Controller('users')
export class UsersController {
  /** Användare med tillgång till valt bolag (eller koncernens bolag i koncernvyn), med säkerhetsstatus. */
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const ids = readableCompanyIds(ctx);
    const result = await withContext(dbContext(ctx), async (db) => {
      const rows = await db
        .select({
          userId: appUser.id,
          name: appUser.name,
          email: appUser.email,
          isGroupAdmin: appUser.isGroupAdmin,
          active: appUser.active,
          companyId: membership.companyId,
          companyName: company.name,
          roleKey: role.key,
          roleName: role.name,
        })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .innerJoin(company, eq(company.id, membership.companyId))
        .innerJoin(role, eq(role.id, membership.roleId))
        .where(inArray(membership.companyId, ids))
        .orderBy(asc(appUser.name), asc(company.name));
      const admins = await db
        .select({ id: appUser.id, name: appUser.name, email: appUser.email, active: appUser.active })
        .from(appUser)
        .where(eq(appUser.isGroupAdmin, true));
      return { memberships: rows, groupAdmins: admins };
    });

    // Säkerhetsstatus per användare
    const userIds = [...new Set([...result.memberships.map((m) => m.userId), ...result.groupAdmins.map((a) => a.id)])];
    const status: Record<string, { mfaEnabled: boolean; lastLoginAt: Date | null; lockedUntil: Date | null; hasPassword: boolean; invitePending: boolean }> = {};
    if (userIds.length) {
      const db = systemDb();
      const sec = await db
        .select({ id: appUser.id, hasPw: appUser.passwordHash, sec: userSecurity })
        .from(appUser)
        .leftJoin(userSecurity, eq(userSecurity.userId, appUser.id))
        .where(and(inArray(appUser.id, userIds), eq(appUser.groupId, ctx.groupId)));
      const invites = await db
        .select({ userId: authToken.userId })
        .from(authToken)
        .where(
          and(
            inArray(authToken.userId, userIds),
            eq(authToken.purpose, 'invite'),
            isNull(authToken.usedAt),
            gt(authToken.expiresAt, new Date()),
          ),
        );
      const pending = new Set(invites.map((i) => i.userId));
      for (const s of sec) {
        status[s.id] = {
          mfaEnabled: !!s.sec?.totpEnabledAt,
          lastLoginAt: s.sec?.lastLoginAt ?? null,
          lockedUntil: s.sec?.lockedUntil && s.sec.lockedUntil > new Date() ? s.sec.lockedUntil : null,
          hasPassword: !!s.hasPw,
          invitePending: pending.has(s.id),
        };
      }
    }
    return {
      memberships: result.memberships.map((m) => ({ ...m, ...status[m.userId] })),
      groupAdmins: result.groupAdmins.map((a) => ({ ...a, ...status[a.id] })),
    };
  }

  @Get('roles')
  roles(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (db) =>
      db.select({ key: role.key, name: role.name, description: role.description }).from(role),
    );
  }

  /**
   * Bjuder in en användare till valt bolag. Finns e-postadressen redan i koncernen
   * får den befintliga användaren rollen i bolaget i stället.
   */
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const companyId = requireCompany(ctx, 'user.manage');
    const data = parse(createSchema, body);
    if (data.password !== undefined && data.password !== '') assertPassword(data.password, data.email);
    const passwordHash = data.password ? await hashPassword(data.password) : null;

    const [existing] = await systemDb().select().from(appUser).where(eq(appUser.email, data.email));
    if (existing && existing.groupId !== ctx.groupId) throw new BadRequestException('E-postadressen används redan');

    const user = await withContext(dbContext(ctx), async (db) => {
      const u = existing
        ? { id: existing.id, name: existing.name, email: existing.email }
        : (
            await db
              .insert(appUser)
              .values({ groupId: ctx.groupId, email: data.email, name: data.name, passwordHash })
              .returning({ id: appUser.id, name: appUser.name, email: appUser.email })
          )[0];
      const roleId = await roleIdFor(db, data.roleKey);
      await db
        .insert(membership)
        .values({ companyId, userId: u.id, roleId })
        .onConflictDoUpdate({ target: [membership.userId, membership.companyId], set: { roleId } });
      return u;
    });
    await ensureSecurityRow(user.id);
    if (passwordHash) {
      await systemDb().update(userSecurity).set({ passwordChangedAt: new Date() }).where(eq(userSecurity.userId, user.id));
    }

    if (existing || passwordHash) return { ...user, existing: !!existing, invite: null };
    const invite = await this.sendInvite(ctx, user.id, req);
    return { ...user, existing: false, invite };
  }

  /** Skickar en ny inbjudan (eller länk för nytt lösenord om användaren redan har ett). */
  @Post(':userId/invite')
  @HttpCode(200)
  async resendInvite(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    await this.requireManageUser(ctx, userId);
    return this.sendInvite(ctx, userId, req);
  }

  /** Ger en befintlig användare en roll i valt bolag, eller byter rollen. */
  @Post(':userId/membership')
  @HttpCode(200)
  async grant(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'user.manage');
    const { roleKey } = parse(grantSchema, body);
    return withContext(dbContext(ctx), async (db) => {
      const [user] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId));
      if (!user) throw new NotFoundException('Användaren finns inte');
      const roleId = await roleIdFor(db, roleKey);
      await db
        .insert(membership)
        .values({ companyId, userId, roleId })
        .onConflictDoUpdate({ target: [membership.userId, membership.companyId], set: { roleId } });
      return { ok: true };
    });
  }

  @Delete(':userId/membership')
  @HttpCode(204)
  async revoke(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string) {
    const companyId = requireCompany(ctx, 'user.manage');
    await withContext(dbContext(ctx), (db) =>
      db.delete(membership).where(and(eq(membership.userId, userId), eq(membership.companyId, companyId))),
    );
  }

  /** Stänger av ett konto helt (alla bolag) och loggar ut det. Kräver koncernadministratör. */
  @Post(':userId/deactivate')
  @HttpCode(200)
  async deactivate(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    requireGroupAdmin(ctx);
    if (userId === ctx.userId) throw new BadRequestException('Du kan inte inaktivera dig själv');
    const user = await this.groupUser(ctx, userId);
    await withContext(dbContext(ctx), (db) => db.update(appUser).set({ active: false }).where(eq(appUser.id, userId)));
    await revokeSessions(userId);
    await logEvent({ event: 'user_deactivated', groupId: ctx.groupId, userId, email: user.email, meta: clientMeta(req), detail: `Av ${ctx.name}` });
    return { ok: true };
  }

  @Post(':userId/activate')
  @HttpCode(200)
  async activate(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    requireGroupAdmin(ctx);
    const user = await this.groupUser(ctx, userId);
    await withContext(dbContext(ctx), (db) => db.update(appUser).set({ active: true }).where(eq(appUser.id, userId)));
    await logEvent({ event: 'user_activated', groupId: ctx.groupId, userId, email: user.email, meta: clientMeta(req), detail: `Av ${ctx.name}` });
    return { ok: true };
  }

  /** När någon tappat telefonen: tar bort tvåstegsverifieringen så att den kan sättas upp igen. */
  @Post(':userId/reset-mfa')
  @HttpCode(200)
  async resetMfa(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    requireGroupAdmin(ctx);
    if (userId === ctx.userId) throw new BadRequestException('Stäng av din egen tvåstegsverifiering under Mitt konto');
    const user = await this.groupUser(ctx, userId);
    await clearMfa(userId);
    await revokeSessions(userId);
    await logEvent({ event: 'mfa_reset_by_admin', groupId: ctx.groupId, userId, email: user.email, meta: clientMeta(req), detail: `Av ${ctx.name}` });
    return { ok: true };
  }

  @Post(':userId/unlock')
  @HttpCode(200)
  async unlock(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    requireGroupAdmin(ctx);
    const user = await this.groupUser(ctx, userId);
    await ensureSecurityRow(userId);
    await systemDb().update(userSecurity).set({ lockedUntil: null, failedLogins: 0 }).where(eq(userSecurity.userId, userId));
    await logEvent({ event: 'account_unlocked', groupId: ctx.groupId, userId, email: user.email, meta: clientMeta(req), detail: `Av ${ctx.name}` });
    return { ok: true };
  }

  @Post(':userId/logout')
  @HttpCode(200)
  async logoutUser(@Ctx() ctx: RequestContext, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    requireGroupAdmin(ctx);
    const user = await this.groupUser(ctx, userId);
    await revokeSessions(userId, userId === ctx.userId ? ctx.sessionTokenHash : undefined);
    await logEvent({ event: 'sessions_revoked', groupId: ctx.groupId, userId, email: user.email, meta: clientMeta(req), detail: `Av ${ctx.name}` });
    return { ok: true };
  }

  /** Inloggningslogg för koncernen, nyast först. */
  @Get('login-log')
  async loginLog(@Ctx() ctx: RequestContext, @Query('before') before?: string, @Query('userId') userId?: string) {
    requireGroupAdmin(ctx);
    const rows = await systemDb()
      .select({
        id: loginEvent.id,
        occurredAt: loginEvent.occurredAt,
        event: loginEvent.event,
        email: loginEvent.email,
        ip: loginEvent.ip,
        userAgent: loginEvent.userAgent,
        detail: loginEvent.detail,
        userName: appUser.name,
      })
      .from(loginEvent)
      .leftJoin(appUser, eq(appUser.id, loginEvent.userId))
      .where(
        and(
          eq(loginEvent.groupId, ctx.groupId),
          before ? lt(loginEvent.id, Number(before)) : undefined,
          userId && /^[0-9a-f-]{36}$/i.test(userId) ? eq(loginEvent.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(loginEvent.id))
      .limit(200);
    return rows.map((r) => ({ ...r, label: EVENT_LABELS[r.event] ?? r.event }));
  }

  @Get('security-settings')
  async settings(@Ctx() ctx: RequestContext) {
    const [g] = await systemDb().select().from(companyGroup).where(eq(companyGroup.id, ctx.groupId));
    return { requireMfa: g.requireMfa, sessionIdleMinutes: g.sessionIdleMinutes };
  }

  @Put('security-settings')
  async saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    requireGroupAdmin(ctx);
    const data = parse(settingsSchema, body);
    await systemDb().update(companyGroup).set(data).where(eq(companyGroup.id, ctx.groupId));
    await logEvent({
      event: 'security_settings_changed',
      groupId: ctx.groupId,
      userId: ctx.userId,
      email: ctx.email,
      meta: clientMeta(req),
      detail: `Tvåstegsverifiering ${data.requireMfa ? 'krävs' : 'frivillig'}, utloggning efter ${data.sessionIdleMinutes} min inaktivitet`,
    });
    return data;
  }

  private async sendInvite(ctx: RequestContext, userId: string, req: Request) {
    const user = await this.groupUser(ctx, userId);
    if (!user.active) throw new BadRequestException('Användaren är inaktiverad');
    const purpose = user.passwordHash ? 'password_reset' : 'invite';
    const token = await issueToken(userId, purpose, ctx.userId);
    const link = `${appUrl(req)}/nytt-losenord?token=${token}`;
    const mail = await sendAuthMail(
      user.email,
      purpose === 'invite' ? 'Inbjudan till Fastighetssystem' : 'Nytt lösenord till Fastighetssystem',
      inviteMailText(user.name, ctx.name, link),
      `inbjudan-${userId}`,
    );
    await logEvent({
      event: 'invite_sent',
      groupId: ctx.groupId,
      userId,
      email: user.email,
      meta: clientMeta(req),
      detail: `Av ${ctx.name}. ${mail.status === 'sent' ? 'E-post skickad' : `E-post ej skickad: ${mail.note ?? 'testläge'}`}`,
    });
    return { link, emailStatus: mail.status, emailNote: mail.note, expiresInDays: purpose === 'invite' ? 7 : null };
  }

  /** Den som har user.manage i valt bolag får hantera användare med roll där. Koncernadministratören alla. */
  private async requireManageUser(ctx: RequestContext, userId: string) {
    if (ctx.isGroupAdmin) return;
    const companyId = requireCompany(ctx, 'user.manage');
    const [m] = await systemDb()
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.companyId, companyId)));
    if (!m) throw new ForbiddenException('Användaren har ingen roll i valt bolag');
  }

  private async groupUser(ctx: RequestContext, userId: string) {
    const [u] = await systemDb()
      .select()
      .from(appUser)
      .where(and(eq(appUser.id, userId), eq(appUser.groupId, ctx.groupId)));
    if (!u) throw new NotFoundException('Användaren finns inte');
    return u;
  }
}

async function roleIdFor(db: Parameters<Parameters<typeof withContext>[1]>[0], key: string): Promise<string> {
  const [r] = await db.select({ id: role.id }).from(role).where(eq(role.key, key));
  if (!r) throw new NotFoundException('Rollen finns inte');
  return r.id;
}
