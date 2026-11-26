import { Controller, Get, Query } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { withContext } from '../db/db';
import { appUser, auditLog } from '../db/schema';
import { Ctx, dbContext, readableCompanyIds, RequestContext } from '../auth/request-context';

@Controller('audit-log')
export class AuditController {
  /** Revisionslogg för de bolag där användaren har rättigheten audit.read. */
  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('table') table?: string,
    @Query('rowId') rowId?: string,
    @Query('before') before?: string,
  ) {
    const ids = readableCompanyIds(ctx).filter((id) =>
      ctx.access.find((a) => a.companyId === id)?.permissions.includes('audit.read'),
    );
    if (!ids.length) return [];
    return withContext(dbContext(ctx, ids), (db) =>
      db
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          companyId: auditLog.companyId,
          tableName: auditLog.tableName,
          rowId: auditLog.rowId,
          action: auditLog.action,
          before: auditLog.before,
          after: auditLog.after,
          userName: appUser.name,
        })
        .from(auditLog)
        .leftJoin(appUser, eq(appUser.id, auditLog.userId))
        .where(
          and(
            inArray(auditLog.companyId, ids),
            table ? eq(auditLog.tableName, table) : undefined,
            rowId ? eq(auditLog.rowId, rowId) : undefined,
            before ? lt(auditLog.id, Number(before)) : undefined,
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(100),
    );
  }
}
