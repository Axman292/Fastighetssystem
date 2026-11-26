import { Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { systemDb } from '../db/db';
import { appUser, company, membership, role, rolePermission, userSession } from '../db/schema';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from './password';
import { ALL_COMPANIES, CompanyAccess, RequestContext } from './request-context';

const SESSION_HOURS = 12;

/**
 * Inloggning med e-post och lösenord. BankID läggs till som ytterligare
 * metod som också slutar i createSession(), se README.
 */
@Injectable()
export class AuthService {
  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const db = systemDb();
    const [user] = await db
      .select()
      .from(appUser)
      .where(eq(appUser.email, email.trim().toLowerCase()));
    // Jämför alltid ett lösenord så att svarstiden inte avslöjar om kontot finns.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !user.active || !ok) throw new UnauthorizedException('Fel e-post eller lösenord');
    return this.createSession(user.id, meta);
  }

  async createSession(userId: string, meta: { ip?: string; userAgent?: string }) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
    await systemDb().insert(userSession).values({
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    });
    return { token, expiresAt };
  }

  async logout(token: string) {
    await systemDb().delete(userSession).where(eq(userSession.tokenHash, hashToken(token)));
  }

  /** Bygger anropets kontext från sessionscookie och valt bolag. */
  async resolve(token: string, requestedCompany: string | undefined): Promise<RequestContext | null> {
    const db = systemDb();
    const [row] = await db
      .select({ user: appUser })
      .from(userSession)
      .innerJoin(appUser, eq(appUser.id, userSession.userId))
      .where(and(eq(userSession.tokenHash, hashToken(token)), gt(userSession.expiresAt, new Date())));
    if (!row || !row.user.active) return null;
    const user = row.user;
    const access = await this.loadAccess(user.id, user.groupId, user.isGroupAdmin);

    let activeCompanyId: string | null = null;
    if (requestedCompany && requestedCompany !== ALL_COMPANIES) {
      activeCompanyId = access.some((a) => a.companyId === requestedCompany) ? requestedCompany : null;
    } else if (!requestedCompany && access.length === 1) {
      activeCompanyId = access[0].companyId;
    }

    return {
      requestId: randomUUID(),
      userId: user.id,
      groupId: user.groupId,
      name: user.name,
      email: user.email,
      isGroupAdmin: user.isGroupAdmin,
      access,
      activeCompanyId,
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
