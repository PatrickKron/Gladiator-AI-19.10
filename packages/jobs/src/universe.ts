import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { backfillOhlcv } from '@gladiator/market-data';

/**
 * Scan-Universum (Patrick-Lücke 1/5): Basis BTC/ETH/SOL + mit Stern markierte
 * Krypto-Favoriten (Binance-Paare). Neue Symbole werden vor dem ersten Scan
 * mit ECHTEN Kerzen backfilled — keine Fantasie-Historie.
 */

export const BASE_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const MAX_UNIVERSE = 12;
const QUOTES = ['USDT', 'USDC'];

/** "BTCUSDT"/"btc/usdt" → "BTC/USDT"; Nicht-Krypto (AAPL) → ehrlich null. */
export function normalizeTradingPair(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().replaceAll('/', '');
  for (const quote of QUOTES) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, -quote.length)}/${quote}`;
    }
  }
  return null;
}

/** Pur: Basis + normalisierte Favoriten-Paare, dedupliziert, Cap. */
export function buildUniverse(favoritePairs: (string | null | undefined)[]): string[] {
  const out = [...BASE_SYMBOLS];
  for (const raw of favoritePairs) {
    const symbol = normalizeTradingPair(raw);
    if (symbol && !out.includes(symbol)) out.push(symbol);
    if (out.length >= MAX_UNIVERSE) break;
  }
  return out;
}

/** Universum aus der DB: Basis + Krypto-Favoriten aller User (ein User-Typ). */
export async function scanUniverse(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT a.trading_pair AS pair
    FROM asset_favorites f
    JOIN assets a ON a.id = f.asset_id
    WHERE a.trading_pair IS NOT NULL
    ORDER BY pair
  `);
  return buildUniverse((rows.rows as { pair: string | null }[]).map((r) => r.pair));
}

const BACKFILL_PLAN: { timeframe: string; sinceDays: number }[] = [
  { timeframe: '15m', sinceDays: 60 }, // ~5.700 Kerzen — genug für EMA200 + Scans
  { timeframe: '1h', sinceDays: 400 },
  { timeframe: '4h', sinceDays: 500 },
  { timeframe: '1d', sinceDays: 730 },
];

/**
 * Stellt echte Kerzen für ein Symbol sicher (inkrementell ab letztem Stand).
 * Wird vom Scan-Job für Favoriten aufgerufen; Fehler werden gemeldet, nie geraten.
 */
export async function ensureCandles(db: Db, symbol: string): Promise<{ symbol: string; inserted: number; errors: string[] }> {
  let inserted = 0;
  const errors: string[] = [];
  for (const plan of BACKFILL_PLAN) {
    try {
      const last = await db.execute(
        sql`SELECT max(ts) AS ts FROM ohlcv WHERE symbol = ${symbol} AND timeframe = ${plan.timeframe}`,
      );
      const lastTs = (last.rows[0] as { ts: string | null }).ts;
      const since = lastTs ? new Date(lastTs) : new Date(Date.now() - plan.sinceDays * 86_400_000);
      // Frisch genug (< 2 Kerzenintervalle alt)? Dann nichts tun.
      if (lastTs && Date.now() - new Date(lastTs).getTime() < 2 * intervalMs(plan.timeframe)) continue;
      const res = await backfillOhlcv(db, { symbol, timeframe: plan.timeframe, since });
      inserted += res.inserted;
    } catch (err) {
      errors.push(`${symbol}@${plan.timeframe}: ${String(err)}`);
    }
  }
  return { symbol, inserted, errors };
}

function intervalMs(tf: string): number {
  return { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[tf] ?? 3_600_000;
}
