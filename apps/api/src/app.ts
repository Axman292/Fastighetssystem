import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { DbErrorsFilter } from './common/db-errors.filter';
import { CompaniesController } from './companies/companies.controller';
import { HealthController } from './health.controller';
import { RegisterController } from './register/register.controller';
import { PropertiesController } from './properties/properties.controller';
import { ObjectsController } from './properties/objects.controller';
import { ImportController } from './properties/import.controller';
import { UsersController } from './users/users.controller';
import { CustomersController } from './customers/customers.controller';
import { ContractsController } from './contracts/contracts.controller';
import { KpiController } from './contracts/kpi.controller';
import { BillingRunsController } from './billing/billing-runs.controller';
import { InvoicesController, PaymentsController } from './billing/invoices.controller';
import { ChargesController } from './billing/charges.controller';

@Module({
  controllers: [
    HealthController,
    AuthController,
    CompaniesController,
    RegisterController,
    UsersController,
    AuditController,
    PropertiesController,
    ObjectsController,
    ImportController,
    CustomersController,
    ContractsController,
    KpiController,
    ChargesController,
    BillingRunsController,
    InvoicesController,
    PaymentsController,
  ],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DbErrorsFilter },
  ],
})
export class AppModule {}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  return app;
}
