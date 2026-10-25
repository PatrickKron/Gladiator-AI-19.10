/**
 * COT je Asset gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 * Fixture-Zeilen liegen im Jahr 2000 (kollidieren nie mit echten Reports) und werden exakt
 * wieder entfernt. Geprüft wird die Spiegelung (USD/JPY ↔ Yen-Kontrakt) und dass ein
 * Aktien-Ticker wie GOLD keinen COT-Markt mehr bekommt.
 */
import { and, eq, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { getCotHistory, getCotSnapshot } from './cot.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[cot.db.test] DATABASE_URL nicht gesetzt — übersprungen.');

const { cotReports } = schema;
const YEN = '097741';
const CUTOFF = new Date('2001-01-01T00:00:00Z');

describe.skipIf(!hasDb)('getCotSnapshot / getCotHistory je Symbol', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const rows = [
      { d: '2000-01-04', long: 60_000, short: 40_000 },
      { d: '2000-01-11', long: 70_000, short: 30_000 },
      { d: '2000-01-18', long: 30_000, short: 50_000 },
    ];
    for (const r of rows) {
      await db
        .insert(cotReports)
        .values({
          marketCode: YEN,
          marketName: 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE (Testfixture)',
          label: 'JAPANESE_YEN',
          reportDate: new Date(`${r.d}T00:00:00Z`),
          openInterest: '200000',
          noncommLong: String(r.long),
          noncommShort: String(r.short),
          commLong: '0',
          commShort: '0',
          source: 'cftc',
        })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await db.delete(cotReports).where(and(eq(cotReports.marketCode, YEN), lt(cotReports.reportDate, CUTOFF)));
    await pool.end();
  });

  it('USD/JPY ist der gespiegelte Yen-Kontrakt: Netto, Perzentil und Status drehen exakt', async () => {
    const [direct] = await getCotSnapshot(db, '6J=F');
    const [mirror] = await getCotSnapshot(db, 'USDJPY=X');
    expect(direct!.market.label).toBe('JAPANESE_YEN');
    expect(mirror!.market.label).toBe('JAPANESE_YEN');
    expect(direct!.inverse).toBe(false);
    expect(mirror!.inverse).toBe(true);
    expect(mirror!.weeks).toBe(direct!.weeks);
    expect(mirror!.weeks).toBeGreaterThan(0);
    expect(mirror!.positioning.netRatio).toBeCloseTo(-direct!.positioning.netRatio, 12);
    expect(mirror!.positioning.percentile).toBeCloseTo(1 - direct!.positioning.percentile, 12);
    expect((mirror!.market as Record<string, unknown>).cftcName).toBeUndefined();
  });

  it('Verlauf: aufsteigend, gespiegelt für USD/JPY; Aktie ohne COT-Markt → null', async () => {
    const direct = await getCotHistory(db, '6J=F');
    const mirror = await getCotHistory(db, 'USDJPY=X');
    expect(direct!.points.length).toBeGreaterThan(0);
    expect(mirror!.points.map((p) => p.netRatio)).toEqual(direct!.points.map((p) => -p.netRatio));
    const dates = direct!.points.map((p) => Date.parse(p.reportDate));
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
    expect(await getCotHistory(db, 'AAPL')).toBeNull();
  });

  it('Aktien-Ticker GOLD (Barrick) bekommt keinen Gold-COT mehr', async () => {
    expect(await getCotSnapshot(db, 'GOLD')).toEqual([]);
    expect((await getCotSnapshot(db, 'GC=F'))[0]?.market.label).toBe('GOLD');
  });
});
