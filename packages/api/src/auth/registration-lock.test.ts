/**
 * Registrierungs-Sperre (Einzelnutzer-System): existiert schon ein User, ist
 * auth.register zu — außer ALLOW_REGISTRATION=1. Gegen die ECHTE DB
 * (lokal ohne DATABASE_URL übersprungen); der Leer-DB-Fall per Stub.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from '../routers/index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { REGISTRATION_CLOSED_MESSAGE, register, registrationOpen } from './service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const email = (label: string) => `reglock-test-${label}-${RUN}@test.invalid`;
const PASSWORD = 'sehr-sicheres-passwort-123';
const SAVED = process.env.ALLOW_REGISTRATION;

afterEach(() => {
  if (SAVED === undefined) delete process.env.ALLOW_REGISTRATION;
  else process.env.ALLOW_REGISTRATION = SAVED;
});

describe('registrationOpen (Stub-DB)', () => {
  /** Minimal-Stub der Drizzle-Kette select().from().limit() — nur im Test. */
  const stubDb = (rows: unknown[]) =>
    ({ select: () => ({ from: () => ({ limit: async () => rows }) }) }) as unknown as Db;

  it('leere DB → offen (erster User = Patrick)', async () => {
    delete process.env.ALLOW_REGISTRATION;
    expect(await registrationOpen(stubDb([]))).toBe(true);
  });

  it('User vorhanden → zu; nur ALLOW_REGISTRATION=1 öffnet, andere Werte nicht', async () => {
    delete process.env.ALLOW_REGISTRATION;
    expect(await registrationOpen(stubDb([{ id: 'x' }]))).toBe(false);
    process.env.ALLOW_REGISTRATION = 'true';
    expect(await registrationOpen(stubDb([{ id: 'x' }]))).toBe(false);
    process.env.ALLOW_REGISTRATION = '1';
    expect(await registrationOpen(stubDb([{ id: 'x' }]))).toBe(true);
  });
});

describe.skipIf(!hasDb)('Registrierungs-Sperre (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    // Sicherstellen, dass mindestens ein User existiert
    process.env.ALLOW_REGISTRATION = '1';
    await register(db, { email: email('first'), password: PASSWORD });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${'reglock-test-%' + RUN + '%'})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${'reglock-test-%' + RUN + '%'}`);
    await pool.end();
  });

  it('auth.register → FORBIDDEN mit klarer Meldung, kein User angelegt, Versuch auditiert', async () => {
    delete process.env.ALLOW_REGISTRATION;
    const caller = createCaller(await buildContext({ db, authorizationHeader: null }));
    await expect(caller.auth.register({ email: email('second'), password: PASSWORD })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: REGISTRATION_CLOSED_MESSAGE,
    });
    expect(REGISTRATION_CLOSED_MESSAGE).toBe('Registrierung geschlossen — Gladiator ist ein Einzelnutzer-System.');
    const rows = await db.execute(sql`SELECT id FROM users WHERE email = ${email('second')}`);
    expect(rows.rows).toHaveLength(0);
    const audit = await db.execute(
      sql`SELECT action FROM audit_log WHERE action = 'auth.register.rejected' AND ts > now() - interval '1 minute'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('ALLOW_REGISTRATION=1 → Registrierung möglich', async () => {
    process.env.ALLOW_REGISTRATION = '1';
    const caller = createCaller(await buildContext({ db, authorizationHeader: null }));
    const res = await caller.auth.register({ email: email('allowed'), password: PASSWORD });
    expect(res.user.email).toBe(email('allowed'));
  });
});
