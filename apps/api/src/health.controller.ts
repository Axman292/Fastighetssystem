import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/request-context';
import { getPool } from './db/db';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  async health() {
    await getPool().query('select 1');
    return { ok: true };
  }
}
