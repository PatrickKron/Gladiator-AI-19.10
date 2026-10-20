/**
 * „Was wäre passiert" — abgelaufene Signale mit DERSELBEN Engine nachrechnen
 * (Entry am Signal-Kerzen-Close, Stop zuerst, TP-Gewichte, Break-Even, netto).
 * Pure Tests mit handgebauten Kerzen; DB-Teil nur mit DATABASE_URL.
 */
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { Candle } from '@gladiator/strategy-engine';
import { hindsightOutcome, summarizeHindsight, evaluateExpiredSignals, type HindsightSignal } from './hindsight.js';
import { ZERO_COSTS } from './engine.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

function bar(k: number, o: number, h: number, l: number, c: number): Candle {
  return { ts: new Date(T0 + k * H), open: o, high: h, low: l, close: c, volume: 100 };
}

const base: HindsightSignal = {
  id: 's1',
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  entry: 100,
  stopLoss: 95,
  takeProfits: [110],
  trailPct: null,
  // Signal entsteht nach dem Close der Kerze k=2 (Kerze 2 läuft 02:00–03:00)
  createdAt: new Date(T0 + 3 * H + 60_000),
};

describe('hindsightOutcome', () => {
  it('TP getroffen → +2 R (ohne Kosten), Exit-Grund tp', () => {
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 105, 99, 104), bar(4, 104, 111, 103, 110)];
    const r = hindsightOutcome(base, candles, H, ZERO_COSTS);
    expect(r.status).toBe('closed');
    expect(r.exitReason).toBe('tp');
    expect(r.rMultiple).toBeCloseTo(2, 6);
    expect(r.exitTs?.toISOString()).toBe(new Date(T0 + 4 * H).toISOString());
  });

  it('Stop zuerst (konservativ, wie die Engine) → −1 R', () => {
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 111, 94, 100)];
    const r = hindsightOutcome(base, candles, H, ZERO_COSTS);
    expect(r.exitReason).toBe('sl');
    expect(r.rMultiple).toBeCloseTo(-1, 6);
  });

  it('Kosten machen das Ergebnis netto schlechter', () => {
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 111, 99, 110)];
    const gross = hindsightOutcome(base, candles, H, ZERO_COSTS);
    const net = hindsightOutcome(base, candles, H);
    expect(net.rMultiple!).toBeLessThan(gross.rMultiple!);
  });

  it('weder Stop noch Ziel erreicht → noch offen, R auf den letzten Close (ehrlich markiert)', () => {
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 103, 99, 102.5)];
    const r = hindsightOutcome(base, candles, H, ZERO_COSTS);
    expect(r.status).toBe('open');
    expect(r.rMultiple).toBeCloseTo(0.5, 6);
  });

  it('keine Kerze nach dem Signal → no_data (nichts erfunden)', () => {
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100)];
    expect(hindsightOutcome(base, candles, H, ZERO_COSTS).status).toBe('no_data');
    expect(hindsightOutcome(base, [], H, ZERO_COSTS).status).toBe('no_data');
  });

  it('kein Look-ahead: die noch laufende Signal-Kerze ist nicht die Entry-Kerze', () => {
    // Signal mitten in Kerze 3 → Entry-Bezug ist Kerze 2 (letzte geschlossene); Kerze 3 zählt als erste Folge-Kerze
    const sig = { ...base, createdAt: new Date(T0 + 3.5 * H) };
    const candles = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 111, 99, 110)];
    expect(hindsightOutcome(sig, candles, H, ZERO_COSTS).exitReason).toBe('tp');
  });

  it('Short spiegelbildlich', () => {
    const sig: HindsightSignal = { ...base, direction: 'short', stopLoss: 105, takeProfits: [90] };
    const candles = [bar(0, 101, 102, 100, 101), bar(1, 101, 102, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 101, 89, 90)];
    const r = hindsightOutcome(sig, candles, H, ZERO_COSTS);
    expect(r.exitReason).toBe('tp');
    expect(r.rMultiple).toBeCloseTo(2, 6);
  });
});

describe('summarizeHindsight', () => {
  it('zählt nur abgeschlossene für Trefferquote/Erwartung, offene + ohne Daten separat', () => {
    const s = summarizeHindsight([
      { status: 'closed', rMultiple: 2 },
      { status: 'closed', rMultiple: -1 },
      { status: 'closed', rMultiple: -1 },
      { status: 'open', rMultiple: 0.4 },
      { status: 'no_data', rMultiple: null },
    ]);
    expect(s).toMatchObject({ total: 5, closed: 3, open: 1, noData: 1, wins: 1, losses: 2 });
    expect(s.winRate).toBeCloseTo(1 / 3, 6);
    expect(s.expectancyR).toBeCloseTo(0, 6);
    expect(s.sumR).toBeCloseTo(0, 6);
    expect(s.profitFactor).toBeCloseTo(1, 6);
  });

  it('keine abgeschlossenen → Kennzahlen null statt 0', () => {
    const s = summarizeHindsight([{ status: 'no_data', rMultiple: null }]);
    expect(s.winRate).toBeNull();
    expect(s.expectancyR).toBeNull();
    expect(s.profitFactor).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('evaluateExpiredSignals (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let strategyId: string;
  const SYMBOL = `HS${process.pid}${Date.now() % 100000}/USDT`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [s] = await db.insert(schema.strategies).values({ slug: `hindsight-${crypto.randomUUID()}`, name: 'Hindsight', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const rows = [bar(0, 99, 100, 98, 99), bar(1, 99, 101, 98, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 105, 99, 104), bar(4, 104, 111, 103, 110)].map((c) => ({
      venue: 'binance',
      symbol: SYMBOL,
      timeframe: '1h',
      ts: c.ts,
      open: String(c.open),
      high: String(c.high),
      low: String(c.low),
      close: String(c.close),
      volume: String(c.volume),
    }));
    await db.insert(schema.ohlcv).values(rows);
    const common = {
      source: 'engine' as const,
      strategyId,
      symbol: SYMBOL,
      timeframe: '1h',
      assetClass: 'crypto' as const,
      venueType: 'cex' as const,
      direction: 'long' as const,
      setupType: 'swing' as const,
      entry: '100',
      stopLoss: '95',
      takeProfits: ['110'],
      score: '7',
      riskClass: 'low' as const,
      session: 'london' as const,
      createdAt: base.createdAt,
    };
    await db.insert(schema.signals).values([
      { ...common, status: 'expired' as const },
      { ...common, status: 'new' as const }, // nicht abgelaufen → zählt nicht
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYMBOL}`);
    await pool.end();
  });

  it('rechnet nur abgelaufene Signale mit echten Kerzen nach', async () => {
    const res = await evaluateExpiredSignals(db, { strategyIds: [strategyId] });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ symbol: SYMBOL, status: 'closed', exitReason: 'tp' });
    expect(res.items[0]!.rMultiple!).toBeGreaterThan(1.9);
    expect(res.summary).toMatchObject({ total: 1, closed: 1, wins: 1 });
  });
});
