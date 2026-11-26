import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { appUser, company, membership, role } from '../db/schema';
import { hashPassword } from '../auth/password';
import { Ctx, dbContext, readableCompanyIds, RequestContext, requireCompany } from '../auth/request-context';

const createSchema = z.object({
  email: z.string().email('Ange en giltig e-postadress').transform((v) => v.trim().toLowerCase()),
  name: z.string().trim().min(2).max(200),
  password: z.string().min(12, 'Lösenordet ska vara minst 12 tecken'),
  roleKey: z.enum(['group_admin', 'finance', 'manager', 'approver', 'reader', 'auditor']),
});

const grantSchema = z.object({
  roleKey: z.enum(['group_admin', 'finance', 'manager', 'approver', 'reader', 'auditor']),
});

@Controller('users')
export class UsersController {
  /** Användare med tillgång till valt bolag (eller koncernens bolag i koncernvyn). */
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const ids = readableCompanyIds(ctx);
    return withContext(dbContext(ctx), async (db) => {
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
  }

  @Get('roles')
  roles(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), (db) =>
      db.select({ key: role.key, name: role.name, description: role.description }).from(role),
    );
  }

  /** Skapar en användare och ger den en roll i valt bolag. */
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'user.manage');
    const data = parse(createSchema, body);
    const passwordHash = await hashPassword(data.password);
    return withContext(dbContext(ctx), async (db) => {
      const [user] = await db
        .insert(appUser)
        .values({ groupId: ctx.groupId, email: data.email, name: data.name, passwordHash })
        .returning({ id: appUser.id, name: appUser.name, email: appUser.email });
      const roleId = await roleIdFor(db, data.roleKey);
      await db.insert(membership).values({ companyId, userId: user.id, roleId });
      return user;
    });
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
}

async function roleIdFor(db: Parameters<Parameters<typeof withContext>[1]>[0], key: string): Promise<string> {
  const [r] = await db.select({ id: role.id }).from(role).where(eq(role.key, key));
  if (!r) throw new NotFoundException('Rollen finns inte');
  return r.id;
}
