/**
 * Phase-1-Rest gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 * Deterministisch über Fixture-Zeilen — die Netz-Syncs laufen als Boot-/Cron-Jobs
 * und melden Fehler ins Log (kein flakiger CI-Netzwerk-Test).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { getMacroSnapshot } from './macro.js';
import { getDerivativesSnapshot, derivativesFresh } from './derivatives.js';
import { upcomingEvents } from './calendar.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[phase1rest.test] DATABASE_URL nicht gesetzt — übersprungen.');

const { macroSeries, economicEvents, newsItems, fundingRates, openInterest } = schema;
const RUN = `${process.pid}-${Date.now()}`;

describe.skipIf(!hasDb)('Phase-1-Rest: Snapshots aus echten DB-Zeilen', () => {
  let db: Db;
  let pool: pg.Pool;
  const eventIds: string[] = [];

  beforeAll(async () => {
    ({ db, pool } = createDb());

    // 25 Tagespunkte je Makro-Serie (Quelle 'test' wird NICHT gelesen — wir
    // schreiben bewusst nach source 'yahoo' und räumen exakt diese Punkte ab).
    const start = Date.UTC(2000, 0, 1); // weit in der Vergangenheit → kollidiert nie mit echten Sync-Daten
    for (let i = 0; i < 25; i++) {
      const ts = new Date(start + i * 86_400_000);
      await db.insert(macroSeries).values([
        { source: 'yahoo', seriesId: 'VIX', ts, value: String(18 + (i % 3)) },
        { source: 'yahoo', seriesId: 'DXY', ts, value: String(100 + i * 0.1) },
        { source: 'yahoo', seriesId: 'US10Y', ts, value: String(4 + i * 0.01) },
      ]).onConflictDoNothing();
    }

    const [ev] = await db
      .insert(economicEvents)
      .values({
        source: 'test',
        externalId: `p1r-${RUN}`,
        title: 'CPI y/y (Testfixture)',
        country: 'USD',
        currency: 'USD',
        importance: 3,
        scheduledAt: new Date(Date.now() + 10 * 60_000),
      })
      .returning({ id: economicEvents.id });
    eventIds.push(ev!.id);

    await db.insert(newsItems).values({
      source: 'test',
      title: 'Test-News',
      url: `https://test.invalid/p1r-${RUN}`,
      publishedAt: new Date(),
    });

    const now = new Date();
    await db.insert(fundingRates).values({ venue: 'binanceusdm', symbol: `TESTP1R/${RUN.slice(0, 6)}`, ts: now, rate: '0.0001' }).onConflictDoNothing();
    await db
      .insert(openInterest)
      .values([
        { venue: 'binanceusdm', symbol: `TESTP1R/${RUN.slice(0, 6)}`, ts: now, openInterest: '110' },
        { venue: 'binanceusdm', symbol: `TESTP1R/${RUN.slice(0, 6)}`, ts: new Date(now.getTime() - 24 * 3_600_000), openInterest: '100' },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM macro_series WHERE source = 'yahoo' AND ts < '2001-01-01'`);
    if (eventIds.length > 0) await db.delete(economicEvents).where(inArray(economicEvents.id, eventIds));
    await db.delete(newsItems).where(eq(newsItems.source, 'test'));
    await db.delete(fundingRates).where(and(eq(fundingRates.venue, 'binanceusdm'), eq(fundingRates.symbol, `TESTP1R/${RUN.slice(0, 6)}`)));
    await db.delete(openInterest).where(and(eq(openInterest.venue, 'binanceusdm'), eq(openInterest.symbol, `TESTP1R/${RUN.slice(0, 6)}`)));
    await pool.end();
  });

  it('getMacroSnapshot liefert GRS aus den Serien (oder markiert alte Daten als nicht frisch)', async () => {
    const snap = await getMacroSnapshot(db);
    expect(snap.vix).not.toBeNull();
    expect(snap.grs).not.toBeNull();
    expect(snap.grs!.score).toBeGreaterThanOrEqual(0);
    expect(snap.grs!.score).toBeLessThanOrEqual(100);
    // fresh hängt davon ab, ob der echte macro-sync schon gelaufen ist — beides ist ehrlich:
    expect(typeof snap.fresh).toBe('boolean');
  });

  it('upcomingEvents enthält das High-Impact-Fixture-Event', async () => {
    const events = await upcomingEvents(db, { days: 1 });
    expect(events.some((e) => e.externalId === `p1r-${RUN}`)).toBe(true);
  });

  it('getDerivativesSnapshot berechnet die 24h-OI-Änderung aus echten Punkten', async () => {
    const snap = await getDerivativesSnapshot(db, [`TESTP1R/${RUN.slice(0, 6)}`]);
    expect(snap).toHaveLength(1);
    expect(snap[0]!.fundingRate).toBeCloseTo(0.0001, 8);
    expect(snap[0]!.oiChangePct24h).toBeCloseTo(10, 3); // 100 → 110
  });

  it('derivativesFresh ist true, wenn ein Funding-Punkt < 3 h alt ist', async () => {
    expect(await derivativesFresh(db)).toBe(true);
  });
});
