/**
 * Steuer-Export (trading.exportTrades) und Protokoll (system.auditLog) gegen
 * die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 * Die Trades hier sind Test-Datensätze im Test-User — keine Laufzeitdaten.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[export-audit.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `export-audit-test-${RUN}@test.invalid`;
const OTHER = `export-audit-other-${RUN}@test.invalid`;
const { users, executedTrades, auditLog } = schema;

describe.skipIf(!hasDb)('Steuer-Export + Protokoll', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Export' });
    userId = res.user.id;
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    otherId = (await register(db, { email: OTHER, password: 'sehr-sicheres-passwort-123' })).user.id;

    const trade = {
      venue: 'paper-internal',
      direction: 'long' as const,
      qty: '0.5',
      entryPrice: '40000',
      exitPrice: '41000',
      grossPnl: '500',
      makerTakerFee: '12.5',
      fundingPaid: '1.25',
      netPnl: '486.25',
      mode: 'paper' as const,
    };
    await db.insert(executedTrades).values([
      { ...trade, userId, symbol: 'BTC/USDT', entryTs: new Date('2025-01-10T12:00:00Z'), exitTs: new Date('2025-01-12T12:00:00Z') },
      { ...trade, userId, symbol: 'ETH/USDT', entryTs: new Date('2023-01-01T00:00:00Z'), exitTs: new Date('2024-06-01T00:00:00Z') },
      // offen → nicht im Export
      { ...trade, userId, symbol: 'SOL/USDT', entryTs: new Date('2025-02-01T00:00:00Z'), exitTs: null, exitPrice: null, netPnl: null },
      // fremder User → nie im Export
      { ...trade, userId: otherId, symbol: 'XRP/USDT', entryTs: new Date('2025-01-01T00:00:00Z'), exitTs: new Date('2025-01-02T00:00:00Z') },
    ]);

    await db.insert(auditLog).values([
      { actor: 'system', userId, action: 'order.risk_check.passed', entityType: 'signal', entityId: 'a', details: { n: 1 } },
      { actor: 'user', userId, action: 'position.protection.updated', entityType: 'position', entityId: 'b' },
      { actor: 'user', userId, action: 'order_like.not_prefix', entityType: 'x', entityId: 'c' },
      { actor: 'user', userId: otherId, action: 'order.executed', entityType: 'order', entityId: 'fremd' },
    ]);
  });

  afterAll(async () => {
    for (const id of [userId, otherId]) {
      await db.delete(executedTrades).where(eq(executedTrades.userId, id));
      await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${id}`);
      await db.delete(users).where(eq(users.id, id));
    }
    await pool.end();
  });

  it('exportTrades: nur eigene, geschlossene Trades; Hinweiszeile + deutsche Kopfzeile', async () => {
    const csv = await caller.trading.exportTrades({ format: 'csv' });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# Hinweis: Paper-Trades sind simuliert/);
    expect(lines[1]!.startsWith('Symbol;Richtung;Eröffnet;Geschlossen;Haltedauer (Tage)')).toBe(true);
    const rows = lines.slice(2);
    expect(rows).toHaveLength(2);
    expect(csv).not.toContain('XRP/USDT');
    expect(csv).not.toContain('SOL/USDT');
    // chronologisch: ETH (2024, > 1 Jahr gehalten) vor BTC (2025)
    expect(rows[0]!.startsWith('ETH/USDT;long;')).toBe(true);
    expect(rows[0]!.endsWith(';ja')).toBe(true);
    expect(rows[1]).toContain(';2.00;0.5;40000;41000;500;12.5;1.25;486.25;paper;paper-internal;nein');
  });

  it('exportTrades: Jahresfilter nach Veräußerungsjahr', async () => {
    const csv = await caller.trading.exportTrades({ format: 'csv', year: 2024 });
    const rows = csv.trimEnd().split('\n').slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startsWith('ETH/USDT')).toBe(true);
  });

  it('auditLog: eigene Einträge, neueste zuerst, keine fremden', async () => {
    const res = await caller.system.auditLog({ limit: 200 });
    const mine = res.items.filter((r) => ['a', 'b', 'c', 'fremd'].includes(r.entityId ?? ''));
    expect(mine.map((r) => r.entityId)).toEqual(['c', 'b', 'a']);
    expect(typeof mine[0]!.id).toBe('string');
    expect(mine.find((r) => r.entityId === 'a')!.details).toEqual({ n: 1 });
  });

  it('auditLog: Filter Aktions-Präfix (Unterstrich ist kein Wildcard) und Entity-Typ', async () => {
    const byPrefix = await caller.system.auditLog({ actionPrefix: 'order.' });
    expect(byPrefix.items.every((r) => r.action.startsWith('order.'))).toBe(true);
    expect(byPrefix.items.some((r) => r.entityId === 'a')).toBe(true);
    expect(byPrefix.items.some((r) => r.entityId === 'c')).toBe(false);

    const underscore = await caller.system.auditLog({ actionPrefix: 'order_' });
    expect(underscore.items.every((r) => r.action.startsWith('order_'))).toBe(true);

    const byEntity = await caller.system.auditLog({ entityType: 'position' });
    expect(byEntity.items.every((r) => r.entityType === 'position')).toBe(true);
    expect(byEntity.items.some((r) => r.entityId === 'b')).toBe(true);
  });

  it('auditLog: Zeitraum-Filter und Keyset-Pagination', async () => {
    const future = await caller.system.auditLog({ from: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.items).toHaveLength(0);
    expect(future.nextCursor).toBeNull();

    const p1 = await caller.system.auditLog({ limit: 1, entityType: 'signal' });
    expect(p1.items).toHaveLength(1);
    const all = await caller.system.auditLog({ limit: 200, entityType: 'signal' });
    if (all.items.length > 1) {
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await caller.system.auditLog({ limit: 1, entityType: 'signal', cursor: p1.nextCursor! });
      expect(BigInt(p2.items[0]!.id) < BigInt(p1.items[0]!.id)).toBe(true);
    } else {
      expect(p1.nextCursor).toBeNull();
    }
  });
});
