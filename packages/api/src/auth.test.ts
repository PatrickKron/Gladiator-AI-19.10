/**
 * Auth-Integrationstests — laufen gegen die echte TimescaleDB (DATABASE_URL).
 * Auf dem Server via scripts/ci.sh; lokal ohne DATABASE_URL übersprungen.
 * JWT_SECRET wird testkontrolliert gesetzt (das ist KEIN Laufzeit-Fallback —
 * der Server-Boot bricht ohne JWT_SECRET weiterhin ab, siehe eigener Test).
 */
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, requireEnv, type Db } from '@gladiator/db';
import type pg from 'pg';
import { createApp } from './app.js';
import { appRouter } from './routers/index.js';
import { buildContext, createCallerFactory } from './trpc.js';
import { login, register } from './auth/service.js';
import { signAccessToken, verifyAccessToken } from './auth/tokens.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[auth.test] DATABASE_URL nicht gesetzt — Auth-Tests übersprungen (Server-CI ist maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const email = (label: string) => `auth-test-${label}-${RUN}@test.invalid`;
const PASSWORD = 'sehr-sicheres-passwort-123';

describe.skipIf(!hasDb)('Auth (JWT + Refresh, ein User-Typ)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    // Test-User inkl. Sessions (cascade) und Audit-Spuren entfernen
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${'auth-test-%' + RUN + '%'})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${'auth-test-%' + RUN + '%'}`);
    await pool.end();
  });

  const callerFor = async (authHeader?: string) =>
    createCaller(await buildContext({ db, authorizationHeader: authHeader ?? null }));

  it('register → me: neuer User bekommt Token-Paar und ist authentifiziert', async () => {
    const caller = await callerFor();
    const res = await caller.auth.register({ email: email('reg'), password: PASSWORD, name: 'Test' });
    expect(res.user.email).toBe(email('reg'));
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    // User-Objekt hat KEINE role (ein User-Typ)
    expect('role' in res.user).toBe(false);

    const me = await (await callerFor(`Bearer ${res.accessToken}`)).auth.me();
    expect(me.email).toBe(email('reg'));
  });

  it('doppelte Registrierung → CONFLICT', async () => {
    const caller = await callerFor();
    await caller.auth.register({ email: email('dup'), password: PASSWORD });
    await expect(caller.auth.register({ email: email('dup'), password: PASSWORD })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('login: falsches Passwort und unbekannte E-Mail → UNAUTHORIZED (gleiche Meldung)', async () => {
    const caller = await callerFor();
    await caller.auth.register({ email: email('login'), password: PASSWORD });

    const ok = await caller.auth.login({ email: email('login'), password: PASSWORD });
    expect(ok.accessToken).toBeTruthy();

    const wrongPw = caller.auth.login({ email: email('login'), password: 'falsches-passwort-123' });
    const unknown = caller.auth.login({ email: email('gibtsnicht'), password: PASSWORD });
    await expect(wrongPw).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(unknown).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const [msg1, msg2] = await Promise.all([wrongPw.catch((e) => e.message), unknown.catch((e) => e.message)]);
    expect(msg1).toBe(msg2);
  });

  it('me ohne Token / mit manipuliertem Token → UNAUTHORIZED (kein Demo-User-Fallback)', async () => {
    await expect((await callerFor()).auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const { accessToken } = await (await callerFor()).auth.register({ email: email('tamper'), password: PASSWORD });
    const tampered = accessToken.slice(0, -4) + 'XXXX';
    await expect((await callerFor(`Bearer ${tampered}`)).auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refresh rotiert: alter Refresh-Token ist danach ungültig, Reuse revoked alle Sessions', async () => {
    const caller = await callerFor();
    const first = await caller.auth.register({ email: email('rot'), password: PASSWORD });

    const second = await caller.auth.refresh({ refreshToken: first.refreshToken });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(verifyAccessToken(second.accessToken)?.email).toBe(email('rot'));

    // Reuse des alten (rotierten) Tokens → UNAUTHORIZED + alle Sessions tot
    await expect(caller.auth.refresh({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.auth.refresh({ refreshToken: second.refreshToken })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('logout entwertet den Refresh-Token (und ist idempotent)', async () => {
    const caller = await callerFor();
    const { refreshToken } = await caller.auth.register({ email: email('out'), password: PASSWORD });
    await caller.auth.logout({ refreshToken });
    await caller.auth.logout({ refreshToken }); // idempotent, wirft nicht
    await expect(caller.auth.refresh({ refreshToken })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('v1-Kompatibilität: bestehender bcrypt-Hash (bcryptjs) funktioniert beim Login', async () => {
    // Simuliert einen aus v1 portierten User: Hash direkt in DB, Login über v2-Service.
    const legacyHash = bcrypt.hashSync('mein-altes-v1-passwort', 10);
    await db.execute(sql`INSERT INTO users (email, password_hash) VALUES (${email('v1')}, ${legacyHash})`);
    const res = await login(db, { email: email('v1'), password: 'mein-altes-v1-passwort' });
    expect(res.user.email).toBe(email('v1'));
  });

  it('Auth-Ereignisse landen im audit_log', async () => {
    const res = await register(db, { email: email('audit'), password: PASSWORD });
    const rows = await db.execute(
      sql`SELECT action FROM audit_log WHERE user_id = ${res.user.id} ORDER BY id`,
    );
    expect(rows.rows.map((r) => r.action)).toContain('auth.register');
  });

  it('Boot-Abbruch-Semantik: ohne JWT_SECRET wirft das Signieren sofort', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => signAccessToken({ userId: 'x', email: 'x@x.de' })).toThrow(/JWT_SECRET/);
      expect(() => requireEnv('JWT_SECRET')).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

describe.skipIf(!hasDb)('HTTP-Ebene (Express + tRPC)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${'auth-test-http-%' + RUN + '%'})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${'auth-test-http-%' + RUN + '%'}`);
    await pool.end();
  });

  it('GET /health → 200 mit echtem DB-Status', async () => {
    const res = await request(createApp(db)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: 'up' });
  });

  it('auth.me ohne Token → HTTP 401; mit Token → 200', async () => {
    const app = createApp(db);
    const unauth = await request(app).get('/api/trpc/auth.me');
    expect(unauth.status).toBe(401);

    const reg = await request(app)
      .post('/api/trpc/auth.register')
      .send({ email: `auth-test-http-${RUN}@test.invalid`, password: PASSWORD })
      .set('content-type', 'application/json');
    expect(reg.status).toBe(200);
    const accessToken = reg.body?.result?.data?.accessToken as string;
    expect(accessToken).toBeTruthy();

    const me = await request(app).get('/api/trpc/auth.me').set('authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body?.result?.data?.email).toBe(`auth-test-http-${RUN}@test.invalid`);
  });

  it('Security-Header gesetzt (helmet), x-powered-by entfernt', async () => {
    const res = await request(createApp(db)).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
