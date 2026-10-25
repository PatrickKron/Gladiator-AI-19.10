/**
 * Kerzen speichern als Upsert (Asset-Register 2026-10-25): Die letzte, beim Laden noch offene
 * Kerze muss beim nächsten Refresh ihren endgültigen Stand bekommen — mit DoNothing behielt sie
 * für immer unvollständige Hoch/Tief/Schluss/Volumen. Reine Zeilen-Abbildung plus Upsert gegen
 * die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { candleRows, upsertCandles } from './candle-store.js';

describe('candleRows', () => {
  it('bildet geprüfte Kerzen auf OHLCV-Zeilen ab (numeric als String, Zeit als Date)', () => {
    const ts = new Date('2026-10-25T10:00:00Z');
    expect(candleRows('yahoo', 'SAP.DE', '1h', [{ ts, open: 1, high: 2.5, low: 0.5, close: 2, volume: 10 }])).toEqual([
      { venue: 'yahoo', symbol: 'SAP.DE', timeframe: '1h', ts, open: '1', high: '2.5', low: '0.5', close: '2', volume: '10' },
    ]);
    expect(candleRows('binance', 'BTC/USDT', '5m', [])).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('upsertCandles gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  const VENUE = `cs-${process.pid}`;
  const SYMBOL = `CS${process.pid}/USDT`;
  const ts = new Date('2026-10-25T10:00:00Z');
  const ts2 = new Date('2026-10-25T11:00:00Z');

  beforeAll(() => {
    ({ db, pool } = createDb());
  });
  afterAll(async () => {
    await db.delete(schema.ohlcv).where(and(eq(schema.ohlcv.venue, VENUE), eq(schema.ohlcv.symbol, SYMBOL)));
    await pool.end();
  });

  const read = async () =>
    (await db.select().from(schema.ohlcv).where(and(eq(schema.ohlcv.venue, VENUE), eq(schema.ohlcv.symbol, SYMBOL), eq(schema.ohlcv.ts, ts))))[0];

  it('zweimal dieselbe Kerze mit anderen Werten ⇒ der zweite (endgültige) Stand gewinnt; identisch ⇒ nichts geschrieben', async () => {
    // erste Speicherung: Kerze noch offen
    expect(await upsertCandles(db, candleRows(VENUE, SYMBOL, '1h', [{ ts, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }]))).toBe(1);
    // Refresh: Kerze geschlossen (neues Hoch, anderer Schluss, mehr Volumen) + eine neue Kerze
    const written = await upsertCandles(
      db,
      candleRows(VENUE, SYMBOL, '1h', [
        { ts, open: 100, high: 103, low: 98, close: 102, volume: 55 },
        { ts: ts2, open: 102, high: 104, low: 101, close: 103, volume: 20 },
      ]),
    );
    expect(written).toBe(2);
    const row = await read();
    expect(row).toMatchObject({ open: '100', high: '103', low: '98', close: '102', volume: '55' });
    // derselbe Stand noch einmal: keine Zeile geändert (idempotent, kein unnötiges Umschreiben)
    expect(await upsertCandles(db, candleRows(VENUE, SYMBOL, '1h', [{ ts, open: 100, high: 103, low: 98, close: 102, volume: 55 }]))).toBe(0);
  });
});
