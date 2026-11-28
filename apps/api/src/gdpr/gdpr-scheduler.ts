import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { getPool, withContext } from '../db/db';
import { run } from './gdpr';

const HOUR = 60 * 60 * 1000;

/**
 * Automatisk gallring: en gång per dygn för varje bolag där den är påslagen.
 * Kontrollen görs varje timme och när API:et startar. Stängs av med GDPR_AUTO=off
 * (och körs aldrig i testerna).
 */
@Injectable()
export class GdprScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly log = new Logger('GDPR');

  onApplicationBootstrap() {
    if (process.env.GDPR_AUTO === 'off' || process.env.VITEST) return;
    setTimeout(() => void this.tick(), 30_000).unref();
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      await runDueCompanies((m) => this.log.log(m));
    } catch (e) {
      this.log.error(`Automatisk gallring misslyckades: ${(e as Error).message}`);
    }
  }
}

/** Kör gallringen för de bolag som har automatisk gallring påslagen och inte kört i dag. */
export async function runDueCompanies(log: (m: string) => void = () => undefined): Promise<number> {
  const { rows } = await getPool().query(
    `select s.company_id as "companyId", c.group_id as "groupId", c.name
     from gdpr_setting s join company c on c.id = s.company_id
     where s.auto_enabled and c.active
       and (s.last_auto_run_at is null or s.last_auto_run_at < date_trunc('day', now()))`,
  );
  for (const r of rows) {
    const res = await withContext({ userId: '', groupId: r.groupId, companyIds: [r.companyId] }, (_db, client) =>
      run(client, r.companyId, 'auto'),
    );
    if (res.runId) {
      log(`${r.name}: ${res.anonymized} kunder anonymiserade, ${res.accounting} bokföringsunderlag rensade, ${res.imports} importer rensade`);
    }
  }
  return rows.length;
}
