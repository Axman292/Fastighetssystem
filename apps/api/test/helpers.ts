import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';

export const ADMIN_EMAIL = 'admin@example.se';
export const ADMIN_PW = 'admin-lösenord-123';

const baseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';

/** Skapar en tom testdatabas, kör migreringar och seed och startar API:et. */
export async function startApp(dbName: string): Promise<{ app: INestApplication; stop: () => Promise<void> }> {
  const dbUrl = baseUrl.replace(/\/[^/]*$/, `/${dbName}`);
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  process.env.DATABASE_URL = dbUrl;
  const { migrate } = await import('../src/scripts/migrate');
  const { seed } = await import('../src/scripts/seed');
  await migrate(dbUrl, () => undefined);
  await seed(dbUrl, ADMIN_PW, () => undefined);

  const { createApp } = await import('../src/app');
  const app = await createApp();
  await app.init();
  return {
    app,
    stop: async () => {
      await app.close();
      const { closePool } = await import('../src/db/db');
      await closePool();
    },
  };
}

export async function login(app: INestApplication, email = ADMIN_EMAIL, password = ADMIN_PW) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/auth/login').send({ email, password }).expect(200);
  return agent;
}
