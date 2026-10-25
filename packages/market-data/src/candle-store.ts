import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type { Candle } from './candles.js';

const { ohlcv } = schema;

/**
 * EIN Speicherweg für echte Kerzen (Binance-Backfill, Yahoo, Twelve Data). Upsert auf den
 * Primärschlüssel (venue, symbol, timeframe, ts) statt DoNothing (Asset-Register 2026-10-25):
 * die letzte Kerze ist beim Laden oft noch offen — mit DoNothing behielt sie für immer ihr
 * unvollständiges Hoch/Tief/Schluss/Volumen, und kein Refresh konnte sie korrigieren. Jetzt
 * gewinnt der neueste Stand der Quelle (auch nachträgliche Yahoo-Anpassungen, z. B. Splits, im
 * geladenen Fenster). Unveränderte Kerzen werden nicht umgeschrieben (setWhere IS DISTINCT FROM),
 * dadurch bleibt der Lauf idempotent und die Zahl „geschrieben“ = neu ODER geändert.
 */

export type OhlcvRow = typeof ohlcv.$inferInsert;

/** Pur: geprüfte Kerzen → OHLCV-Zeilen (numeric als String, nie Float-Mischmasch). */
export function candleRows(venue: string, symbol: string, timeframe: string, candles: Candle[]): OhlcvRow[] {
  return candles.map((c) => ({
    venue,
    symbol,
    timeframe,
    ts: c.ts,
    open: String(c.open),
    high: String(c.high),
    low: String(c.low),
    close: String(c.close),
    volume: String(c.volume),
  }));
}

/** Zeilen upserten (500er-Blöcke wegen Parameterlimits). Rückgabe: neu eingefügte + geänderte Zeilen. */
export async function upsertCandles(db: Db, rows: OhlcvRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(ohlcv)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [ohlcv.venue, ohlcv.symbol, ohlcv.timeframe, ohlcv.ts],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
        },
        setWhere: sql`(${ohlcv.open}, ${ohlcv.high}, ${ohlcv.low}, ${ohlcv.close}, ${ohlcv.volume}) IS DISTINCT FROM (excluded.open, excluded.high, excluded.low, excluded.close, excluded.volume)`,
      });
    written += res.rowCount ?? 0;
  }
  return written;
}
