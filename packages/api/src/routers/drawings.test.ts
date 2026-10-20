/**
 * Chart-Zeichnungen gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): CRUD, Nutzer-Scoping (fremder User sieht/löscht nichts),
 * Validierung (Ankerzahl je Art, endliche Zahlen, Limit pro Symbol).
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { MAX_DRAWINGS_PER_SYMBOL } from '@gladiator/core';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[drawings.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL_A = `drawings-a-${RUN}@test.invalid`;
const EMAIL_B = `drawings-b-${RUN}@test.invalid`;
const SYMBOL = `TEST${process.pid}/USDT`;
const OTHER_SYMBOL = `TESTB${process.pid}/USDT`;
const { users, chartDrawings } = schema;
const T0 = 1_760_000_000;

describe.skipIf(!hasDb)('Chart-Zeichnungen: CRUD, Scoping, Validierung', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let b: ReturnType<typeof createCaller>;
  let userAId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const ra = await register(db, { email: EMAIL_A, password: 'sehr-sicheres-passwort-123', name: 'A' });
    const rb = await register(db, { email: EMAIL_B, password: 'sehr-sicheres-passwort-123', name: 'B' });
    userAId = ra.user.id;
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    b = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${rb.accessToken}` }));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${EMAIL_A}, ${EMAIL_B}))`);
    // chart_drawings hängt per ON DELETE CASCADE am User
    await db.delete(users).where(inArray(users.email, [EMAIL_A, EMAIL_B]));
    await pool.end();
  });

  it('ohne Token → UNAUTHORIZED', async () => {
    const anon = createCaller(await buildContext({ db }));
    await expect(anon.drawings.list({ symbol: SYMBOL })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  let hlineId: string;
  let trendId: string;

  it('create (hline/trend/fib) → list nur für Symbol, Zahlen bleiben Zahlen', async () => {
    const h = await a.drawings.create({ symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: 64_250.5 }] });
    hlineId = h.id;
    expect(h.kind).toBe('hline');
    expect(h.points).toEqual([{ time: T0, price: 64_250.5 }]);
    expect(h.style).toBeNull();

    const tr = await a.drawings.create({
      symbol: SYMBOL,
      kind: 'trend',
      points: [
        { time: T0, price: 60_000 },
        { time: T0 + 3600 * 10, price: 62_000 },
      ],
      style: { color: '#4fd1ff', lineWidth: 2 },
    });
    trendId = tr.id;
    expect(tr.style).toEqual({ color: '#4fd1ff', lineWidth: 2 });

    await a.drawings.create({
      symbol: SYMBOL,
      kind: 'fib',
      points: [
        { time: T0, price: 58_000 },
        { time: T0 + 7200, price: 66_000 },
      ],
    });
    await a.drawings.create({ symbol: OTHER_SYMBOL, kind: 'hline', points: [{ time: T0, price: 1.5 }] });

    const list = await a.drawings.list({ symbol: SYMBOL });
    expect(list.map((d) => d.kind)).toEqual(['hline', 'trend', 'fib']);
    expect(typeof list[0]!.points[0]!.price).toBe('number');
    expect((await a.drawings.list({ symbol: OTHER_SYMBOL })).length).toBe(1);
  });

  it('update: Anker verschieben + Stil; Ankerzahl muss zur gespeicherten Art passen', async () => {
    const up = await a.drawings.update({
      id: trendId,
      points: [
        { time: T0 + 60, price: 60_100 },
        { time: T0 + 3600 * 12, price: 63_000 },
      ],
      style: { color: '#f5b642' },
    });
    expect(up.points[1]).toEqual({ time: T0 + 3600 * 12, price: 63_000 });
    expect(up.style).toEqual({ color: '#f5b642' });
    expect(new Date(up.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(up.createdAt).getTime());

    await expect(a.drawings.update({ id: hlineId, points: [{ time: T0, price: 1 }, { time: T0 + 1, price: 2 }] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('Scoping: fremder User sieht, ändert und löscht nichts', async () => {
    expect(await b.drawings.list({ symbol: SYMBOL })).toEqual([]);
    await expect(b.drawings.update({ id: hlineId, points: [{ time: T0, price: 1 }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.drawings.delete({ id: hlineId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const cleared = await b.drawings.clear({ symbol: SYMBOL });
    expect(cleared.deleted).toBe(0);
    expect((await a.drawings.list({ symbol: SYMBOL })).length).toBe(3);
  });

  it('Validierung: falsche Ankerzahl, NaN/Unendlich, ≤0, ms-Zeit, unbekannte Art, schlechter Stil', async () => {
    const bad = [
      { symbol: SYMBOL, kind: 'hline', points: [] },
      { symbol: SYMBOL, kind: 'trend', points: [{ time: T0, price: 1 }] },
      { symbol: SYMBOL, kind: 'fib', points: [{ time: T0, price: 1 }, { time: T0 + 1, price: 2 }, { time: T0 + 2, price: 3 }] },
      { symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: Number.NaN }] },
      { symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: Number.POSITIVE_INFINITY }] },
      { symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: 0 }] },
      { symbol: SYMBOL, kind: 'hline', points: [{ time: T0 * 1000, price: 5 }] },
      { symbol: SYMBOL, kind: 'trend', points: [{ time: T0, price: 1 }, { time: T0, price: 2 }] },
      { symbol: SYMBOL, kind: 'fib', points: [{ time: T0, price: 2 }, { time: T0 + 60, price: 2 }] },
      { symbol: SYMBOL, kind: 'circle', points: [{ time: T0, price: 5 }] },
      { symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: 5 }], style: { color: 'red' } },
      { symbol: '', kind: 'hline', points: [{ time: T0, price: 5 }] },
    ];
    for (const input of bad) {
      await expect(a.drawings.create(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await a.drawings.list({ symbol: SYMBOL })).length).toBe(3);
  });

  it(`Limit: max. ${MAX_DRAWINGS_PER_SYMBOL} Zeichnungen pro Symbol`, async () => {
    const existing = (await a.drawings.list({ symbol: SYMBOL })).length;
    const rows = Array.from({ length: MAX_DRAWINGS_PER_SYMBOL - existing }, (_, i) => ({
      userId: userAId,
      symbol: SYMBOL,
      kind: 'hline' as const,
      points: [{ time: T0 + i, price: 100 + i }],
    }));
    await db.insert(chartDrawings).values(rows);
    await expect(a.drawings.create({ symbol: SYMBOL, kind: 'hline', points: [{ time: T0, price: 5 }] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // anderes Symbol ist unabhängig
    await expect(a.drawings.create({ symbol: OTHER_SYMBOL, kind: 'hline', points: [{ time: T0, price: 5 }] })).resolves.toBeTruthy();
  });

  it('delete (einzeln) und clear (alle des Symbols, nur eigene)', async () => {
    await a.drawings.delete({ id: hlineId });
    const after = await a.drawings.list({ symbol: SYMBOL });
    expect(after.some((d) => d.id === hlineId)).toBe(false);
    await expect(a.drawings.delete({ id: hlineId })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const res = await a.drawings.clear({ symbol: SYMBOL });
    expect(res.deleted).toBe(after.length);
    expect(await a.drawings.list({ symbol: SYMBOL })).toEqual([]);
    expect((await a.drawings.list({ symbol: OTHER_SYMBOL })).length).toBe(2);
    const left = await db.select().from(chartDrawings).where(eq(chartDrawings.userId, userAId));
    expect(left.every((r) => r.symbol === OTHER_SYMBOL)).toBe(true);
  });
});
