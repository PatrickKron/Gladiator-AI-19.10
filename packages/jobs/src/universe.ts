import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { backfillOhlcv, TIMEFRAME_MS } from '@gladiator/market-data';

/**
 * Scan-Universum (Patrick-Lücke 1/5): Basis BTC/ETH/SOL + mit Stern markierte
 * Krypto-Favoriten (Binance-Paare). Neue Symbole werden vor dem ersten Scan
 * mit ECHTEN Kerzen backfilled — keine Fantasie-Historie.
 */

export const BASE_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
/**
 * Cap des Signal-Scans: 40 Symbole (Patricks Mängelliste 2026-10-22: 12 war viel zu eng).
 * Reihenfolge = Priorität (Asset-Register 2026-10-25): Basis-Symbole, dann Favoriten nach dem
 * JÜNGSTEN Stern — wer über 40 Favoriten hat, verliert die ältesten aus dem Scan, nie die
 * neuesten (früher alphabetisch abgeschnitten). Charts, Kerzen-Refresh und Alarme kennen
 * daneben jedes registrierte Asset (asset-register.ts).
 */
export const MAX_UNIVERSE = 40;
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

/** Pur: Basis + normalisierte Favoriten-Paare (Eingabe in Prioritäts-Reihenfolge), dedupliziert, Cap. */
export function buildUniverse(favoritePairs: (string | null | undefined)[]): string[] {
  const out = [...BASE_SYMBOLS];
  for (const raw of favoritePairs) {
    const symbol = normalizeTradingPair(raw);
    if (symbol && !out.includes(symbol)) out.push(symbol);
    if (out.length >= MAX_UNIVERSE) break;
  }
  return out;
}

/**
 * Universum aus der DB: Basis + Krypto-Favoriten aller User (ein User-Typ), jüngster Stern zuerst.
 * Nur Binance-Paare (Assets mit anderer Kerzenquelle bleiben draußen — der Signal-Scan ist
 * Krypto; venue-bewusster Scan ist ein eigener Schritt).
 */
export async function scanUniverse(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT a.trading_pair AS pair, max(f.created_at) AS fav_at
    FROM asset_favorites f
    JOIN assets a ON a.id = f.asset_id
    WHERE a.trading_pair IS NOT NULL AND (a.candle_venue IS NULL OR a.candle_venue = 'binance')
    GROUP BY a.trading_pair
    ORDER BY fav_at DESC, pair
  `);
  return buildUniverse((rows.rows as { pair: string | null }[]).map((r) => r.pair));
}

/**
 * Backfill-Plan je Timeframe (Feature A: alle verfügbaren TFs). sinceDays so
 * gewählt, dass jeder TF ausreichend Kerzen für EMA200/Scans/Backtests bekommt,
 * ohne das Rate-Limit unnötig zu strapazieren. Die kleinen TFs (5m/30m) decken
 * ein kürzeres, dafür engmaschiges Fenster ab; die großen (1w/1M) reichen weit
 * zurück. Idempotent + inkrementell (ensureCandles lädt nur den Rückstand nach).
 */
const BACKFILL_PLAN: { timeframe: string; sinceDays: number }[] = [
  { timeframe: '5m', sinceDays: 20 }, // ~5.760 Kerzen — engmaschig, kurzes Fenster
  { timeframe: '15m', sinceDays: 60 }, // ~5.700 Kerzen — genug für EMA200 + Scans
  { timeframe: '30m', sinceDays: 120 }, // ~5.760 Kerzen
  { timeframe: '1h', sinceDays: 400 },
  { timeframe: '2h', sinceDays: 500 },
  { timeframe: '4h', sinceDays: 500 },
  { timeframe: '12h', sinceDays: 900 },
  { timeframe: '1d', sinceDays: 730 },
  { timeframe: '1w', sinceDays: 2555 }, // ~7 Jahre → ~365 Wochen-Kerzen
  { timeframe: '1M', sinceDays: 3650 }, // ~10 Jahre → soweit die Börse zurückreicht
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
      // Nur Binance-Kerzen zählen — ein gleichnamiges Symbol einer anderen Quelle darf den Rückstand nie verdecken.
      const last = await db.execute(
        sql`SELECT max(ts) AS ts FROM ohlcv WHERE venue = 'binance' AND symbol = ${symbol} AND timeframe = ${plan.timeframe}`,
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
  return (TIMEFRAME_MS as Record<string, number>)[tf] ?? 3_600_000;
}
