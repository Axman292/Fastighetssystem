import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearLimits } from '../src/auth/rate-limit';
import { currentStep, totpCode } from '../src/auth/totp';
import { ADMIN_EMAIL, ADMIN_PW, login, startApp } from './helpers';

/** Säker inloggning: tvåstegsverifiering, inbjudan, nytt lösenord, spärr, timeout och logg. */
let app: INestApplication;
let stop: () => Promise<void>;
let http: ReturnType<typeof request>;
let db: Client;
const outbox = mkdtempSync(join(tmpdir(), 'fs-outbox-'));

beforeAll(async () => {
  process.env.OUTBOX_DIR = outbox;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;
  process.env.AUTH_SECRET = 'test-hemlighet';
  ({ app, stop } = await startApp('fastighet_test_auth'));
  http = request(app.getHttpServer());
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
  await stop();
});

beforeEach(() => clearLimits());

function linkFromOutbox(prefix: string): string {
  const file = readdirSync(outbox).filter((f) => f.startsWith(prefix)).sort().pop();
  if (!file) throw new Error('Inget mejl i utkorgen');
  const raw = readFileSync(join(outbox, file), 'utf8').replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const m = raw.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Ingen länk i mejlet');
  return m[1];
}

async function companyId(agent: ReturnType<typeof request.agent>, name = 'P Dahlqvist Förvaltning AB') {
  const companies = await agent.get('/companies').expect(200);
  return companies.body.find((c: { name: string }) => c.name === name).id as string;
}

describe('inbjudan och nytt lösenord', () => {
  it('bjuder in en användare som väljer eget lösenord via länken', async () => {
    const admin = await login(app);
    const id = await companyId(admin);
    await admin.post('/auth/switch-company').send({ companyId: id }).expect(200);
    const created = await admin
      .post('/users')
      .send({ name: 'Eva Ekonomi', email: 'eva@example.se', roleKey: 'finance' })
      .expect(201);
    expect(created.body.invite.emailStatus).toBe('test');
    const token = new URL(created.body.invite.link).searchParams.get('token')!;

    const info = await http.get(`/auth/token/${token}`).expect(200);
    expect(info.body).toMatchObject({ valid: true, purpose: 'invite', email: 'eva@example.se' });

    // Kan inte logga in innan lösenord är valt
    await http.post('/auth/login').send({ email: 'eva@example.se', password: 'vad-som-helst-12' }).expect(401);

    await http.post('/auth/password/set').send({ token, password: 'kort' }).expect(400);
    await http.post('/auth/password/set').send({ token, password: 'Långt-och-eget-lösen-7' }).expect(200);
    await http.post('/auth/password/set').send({ token, password: 'Ett-annat-lösen-8899' }).expect(400);

    const eva = await login(app, 'eva@example.se', 'Långt-och-eget-lösen-7');
    const me = await eva.get('/auth/me').expect(200);
    expect(me.body.companies).toHaveLength(1);
    expect(me.body.companies[0].roleKey).toBe('finance');

    const list = await admin.get('/users').expect(200);
    const row = list.body.memberships.find((m: { email: string }) => m.email === 'eva@example.se');
    expect(row).toMatchObject({ hasPassword: true, mfaEnabled: false, invitePending: false });
  });

  it('skickar länk för nytt lösenord och svarar lika för okända adresser', async () => {
    await http.post('/auth/password/forgot').send({ email: 'finns-inte@example.se' }).expect(200);
    await http.post('/auth/password/forgot').send({ email: 'eva@example.se' }).expect(200);
    const token = linkFromOutbox('losenord-');
    const eva = await login(app, 'eva@example.se', 'Långt-och-eget-lösen-7');
    await http.post('/auth/password/set').send({ token, password: 'Helt-nytt-lösen-2026' }).expect(200);
    // Alla sessioner loggas ut när lösenordet byts via länk
    await eva.get('/auth/me').expect(401);
    await http.post('/auth/login').send({ email: 'eva@example.se', password: 'Långt-och-eget-lösen-7' }).expect(401);
    await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
  });

  it('begränsar antalet begäran om nytt lösenord', async () => {
    for (let i = 0; i < 3; i++) await http.post('/auth/password/forgot').send({ email: 'x@example.se' }).expect(200);
    await http.post('/auth/password/forgot').send({ email: 'x@example.se' }).expect(429);
  });
});

describe('kontospärr', () => {
  it('spärrar kontot efter fem fel och administratören kan häva spärren', async () => {
    for (let i = 0; i < 5; i++) {
      await http.post('/auth/login').send({ email: 'eva@example.se', password: 'fel-lösenord' }).expect(401);
    }
    const locked = await http.post('/auth/login').send({ email: 'eva@example.se', password: 'Helt-nytt-lösen-2026' }).expect(401);
    expect(locked.body.message).toContain('spärrat');

    const admin = await login(app);
    const list = await admin.get('/users').expect(200);
    const eva = list.body.memberships.find((m: { email: string }) => m.email === 'eva@example.se');
    expect(eva.lockedUntil).toBeTruthy();
    await admin.post(`/users/${eva.userId}/unlock`).expect(200);
    await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
  });

  it('inaktiverat konto kan inte logga in', async () => {
    const admin = await login(app);
    const list = await admin.get('/users').expect(200);
    const eva = list.body.memberships.find((m: { email: string }) => m.email === 'eva@example.se');
    const session = await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
    await admin.post(`/users/${eva.userId}/deactivate`).expect(200);
    await session.get('/auth/me').expect(401);
    await http.post('/auth/login').send({ email: 'eva@example.se', password: 'Helt-nytt-lösen-2026' }).expect(401);
    await admin.post(`/users/${eva.userId}/activate`).expect(200);
    await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
  });
});

describe('tvåstegsverifiering', () => {
  let secret = '';
  let recovery: string[] = [];

  it('slår på med QR-kod och första koden', async () => {
    const admin = await login(app);
    const setup = await admin.post('/account/mfa/setup').expect(200);
    expect(setup.body.qrSvg).toContain('<svg');
    secret = setup.body.secret.replace(/\s/g, '');
    await admin.post('/account/mfa/enable').send({ code: '000000' }).expect(400);
    const enabled = await admin.post('/account/mfa/enable').send({ code: totpCode(secret, currentStep()) }).expect(200);
    recovery = enabled.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    const account = await admin.get('/account').expect(200);
    expect(account.body).toMatchObject({ mfaEnabled: true, recoveryCodesLeft: 10 });

    // Hemligheten sparas krypterad
    const row = await db.query(`select totp_secret from user_security s join app_user u on u.id = s.user_id where u.email = $1`, [ADMIN_EMAIL]);
    expect(row.rows[0].totp_secret.startsWith('v1:')).toBe(true);
  });

  it('kräver kod vid inloggning och godtar inte samma kod två gånger', async () => {
    const step1 = await http.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.headers['set-cookie']).toBeUndefined();
    await http.post('/auth/login/mfa').send({ ticket: step1.body.ticket, code: '123456' }).expect(401);

    // Koden från uppsättningen är redan använd; nästa tidssteg godtas
    const agent = request.agent(app.getHttpServer());
    const s = await agent.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
    await agent.post('/auth/login/mfa').send({ ticket: s.body.ticket, code: totpCode(secret, currentStep() + 1) }).expect(200);
    await agent.get('/auth/me').expect(200);

    const again = await http.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
    await http.post('/auth/login/mfa').send({ ticket: again.body.ticket, code: totpCode(secret, currentStep() + 1) }).expect(401);
  });

  it('reservkod fungerar en gång', async () => {
    const a = await http.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
    await http.post('/auth/login/mfa').send({ ticket: a.body.ticket, code: recovery[0].toUpperCase() }).expect(200);
    const b = await http.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
    await http.post('/auth/login/mfa').send({ ticket: b.body.ticket, code: recovery[0] }).expect(401);
  });

  it('administratören kan nollställa en annan användares tvåstegsverifiering', async () => {
    const eva = await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
    const setup = await eva.post('/account/mfa/setup').expect(200);
    const evaSecret = setup.body.secret.replace(/\s/g, '');
    await eva.post('/account/mfa/enable').send({ code: totpCode(evaSecret, currentStep()) }).expect(200);
    const s = await http.post('/auth/login').send({ email: 'eva@example.se', password: 'Helt-nytt-lösen-2026' }).expect(200);
    expect(s.body.mfaRequired).toBe(true);

    const admin = await adminAgent(secret, recovery[1]);
    const list = await admin.get('/users').expect(200);
    const row = list.body.memberships.find((m: { email: string }) => m.email === 'eva@example.se');
    expect(row.mfaEnabled).toBe(true);
    await admin.post(`/users/${row.userId}/reset-mfa`).expect(200);
    await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
  });
});

describe('koncernens säkerhetsinställningar', () => {
  it('kräver tvåstegsverifiering för alla när det är påslaget', async () => {
    const admin = await adminAgent('', '');
    await admin.put('/users/security-settings').send({ requireMfa: true, sessionIdleMinutes: 30 }).expect(200);

    const eva = await login(app, 'eva@example.se', 'Helt-nytt-lösen-2026');
    const me = await eva.get('/auth/me').expect(200);
    expect(me.body.mfaSetupRequired).toBe(true);
    const blocked = await eva.get('/companies').expect(403);
    expect(blocked.body.code).toBe('mfa_setup_required');
    await eva.get('/account').expect(200);

    const setup = await eva.post('/account/mfa/setup').expect(200);
    await eva
      .post('/account/mfa/enable')
      .send({ code: totpCode(setup.body.secret.replace(/\s/g, ''), currentStep()) })
      .expect(200);
    await eva.get('/companies').expect(200);

    await admin.put('/users/security-settings').send({ requireMfa: false, sessionIdleMinutes: 30 }).expect(200);
  });

  it('loggar ut efter inaktivitet', async () => {
    const admin = await adminAgent('', '');
    await admin.put('/users/security-settings').send({ requireMfa: false, sessionIdleMinutes: 10 }).expect(200);
    await db.query(`update user_session set last_seen_at = now() - interval '11 minutes'`);
    await admin.get('/auth/me').expect(401);
    const fresh = await adminAgent('', '');
    await fresh.get('/auth/me').expect(200);
    await fresh.put('/users/security-settings').send({ requireMfa: false, sessionIdleMinutes: 30 }).expect(200);
  });

  it('inloggningsloggen visar lyckade och misslyckade försök', async () => {
    const admin = await adminAgent('', '');
    const log = await admin.get('/users/login-log').expect(200);
    const events = new Set(log.body.map((e: { event: string }) => e.event));
    for (const e of ['login_ok', 'login_failed', 'account_locked', 'mfa_failed', 'mfa_enabled', 'invite_sent', 'password_reset', 'session_timeout']) {
      expect(events).toContain(e);
    }
  });
});

/** Loggar in administratören, som har tvåstegsverifiering från testerna ovan. */
let adminSecret = '';
async function adminAgent(secret: string, _recovery: string) {
  if (secret) adminSecret = secret;
  const agent = request.agent(app.getHttpServer());
  const s = await agent.post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PW }).expect(200);
  if (s.body.mfaRequired) {
    // Varje kod får bara användas en gång: ta bort spärren för senaste steg i testet.
    await db.query(`update user_security set totp_last_step = null`);
    await agent.post('/auth/login/mfa').send({ ticket: s.body.ticket, code: totpCode(adminSecret, currentStep()) }).expect(200);
  }
  return agent;
}
