/**
 * Preis-Alarme für jede Quelle (Asset-Register 2026-10-25): Binance über den echten Markpreis,
 * Yahoo/Twelve Data über den Schlusskurs der neuesten FRISCHEN Kerze — veraltete Kerzen lösen
 * nie aus (übersprungen + gemeldet). Reine Quellen-Wahl plus Lauf gegen die ECHTE DB
 * (Server-CI; lokal ohne DATABASE_URL übersprungen). Push/Telegram sind im Test aus.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { alertSource, checkPriceAlerts } from './alerts.js';

describe('alertSource', () => {
  it('gespeicherte Quelle gewinnt; Altbestand ohne Quelle: Krypto-Paar → Binance, sonst Register, sonst Binance', () => {
    expect(alertSource('yahoo', 'AAPL', null)).toBe('yahoo');
    expect(alertSource('twelvedata', 'MSFT', 'yahoo')).toBe('twelvedata');
    expect(alertSource(null, 'BTC/USDT', 'yahoo')).toBe('binance');
    expect(alertSource(null, 'AAPL', 'yahoo')).toBe('yahoo');
    expect(alertSource(undefined, 'AAPL', null)).toBe('binance'); // Markpreis meldet dann ehrlich einen Fehler
    expect(alertSource('kraken', 'SAP.DE', 'yahoo')).toBe('yahoo'); // unbekannte Quelle zählt nicht
  });
});

describe.skipIf(!process.env.DATABASE_URL)('checkPriceAlerts gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}${Date.now() % 100000}`;
  const FRESH = `PAF${RUN}.DE`;
  const STALE = `PAS${RUN}.DE`;
  const quiet = { notify: { pushConfigured: false, sendTelegram: async () => false } };
  const binance = { markPrice: async (s: string) => (s === 'BTC/USDT' ? 50_000 : Promise.reject(new Error(`kein Markt ${s}`))) };

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `price-alerts-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const now = Date.now();
    await db.insert(schema.ohlcv).values([
      { venue: 'yahoo', symbol: FRESH, timeframe: '15m', ts: new Date(now - 30 * 60_000), open: '10', high: '12', low: '9', close: '11', volume: '1' },
      { venue: 'yahoo', symbol: FRESH, timeframe: '1d', ts: new Date(now - 20 * 3_600_000), open: '9', high: '12', low: '8', close: '10', volume: '1' },
      { venue: 'yahoo', symbol: STALE, timeframe: '1h', ts: new Date(now - 30 * 86_400_000), open: '10', high: '12', low: '9', close: '11', volume: '1' },
    ]);
    await db.insert(schema.priceAlerts).values([
      { userId, symbol: FRESH, venue: 'yahoo', condition: 'above', price: '10.5', note: 'frisch' },
      { userId, symbol: STALE, venue: 'yahoo', condition: 'above', price: '10.5', note: 'veraltet' },
      { userId, symbol: FRESH, venue: 'yahoo', condition: 'below', price: '5', note: 'nicht erreicht' },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.ohlcv).where(inArray(schema.ohlcv.symbol, [FRESH, STALE]));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId)); // Alarme + Benachrichtigungen cascaden
    await pool.end();
  });

  it('frische Yahoo-Kerze löst aus (neuester Schlusskurs), veraltete wird übersprungen, nicht erreichte bleibt aktiv', async () => {
    const res = await checkPriceAlerts(db, binance, quiet);
    const mine = await db.select().from(schema.priceAlerts).where(eq(schema.priceAlerts.userId, userId));
    const fresh = mine.find((a) => a.note === 'frisch')!;
    const stale = mine.find((a) => a.note === 'veraltet')!;
    const low = mine.find((a) => a.note === 'nicht erreicht')!;
    expect(fresh.active).toBe(false);
    expect(Number(fresh.triggeredPrice)).toBe(11); // 15m-Schluss (neuer als die Tageskerze)
    expect(stale.active).toBe(true);
    expect(stale.triggeredAt).toBeNull();
    expect(low.active).toBe(true);
    expect(res.skipped.some((s) => s.includes(STALE) && /veraltet/.test(s))).toBe(true);
    expect(res.triggered).toBeGreaterThanOrEqual(1);
  });
});
