import type { Db } from '@gladiator/db';
import { aggregateCandles, closedCandles, getOhlcv } from '@gladiator/market-data';
import type { Candle } from '@gladiator/strategy-engine';
import { AGGREGATE_LOOKBACK_MS, scanSourceTimeframe } from './scan-targets.js';

/**
 * Kerzen je Kursquelle für Pipelines (A3): Binance unverändert aus der DB (die Abfrage wie
 * angefragt), Börsen-Quellen (Yahoo/Twelve Data) speichern kein 4h — dann 1h laden, nur bis
 * `until` abgeschlossene Kerzen nehmen (look-ahead-frei) und zu 4h zusammenfassen. Nichts wird
 * aufgefüllt oder erfunden.
 */
export async function loadSourceCandles(
  db: Db,
  p: { venue: string; symbol: string; timeframe: string; since?: Date; until?: Date; limit?: number; now?: Date },
): Promise<Candle[]> {
  const sourceTf = scanSourceTimeframe(p.venue, p.timeframe);
  if (sourceTf === p.timeframe) {
    return getOhlcv(db, {
      venue: p.venue,
      symbol: p.symbol,
      timeframe: p.timeframe,
      ...(p.since ? { since: p.since } : {}),
      ...(p.until ? { until: p.until } : {}),
      ...(p.limit ? { limit: p.limit } : {}),
    });
  }
  const end = p.until ?? p.now ?? new Date();
  const raw = await getOhlcv(db, {
    venue: p.venue,
    symbol: p.symbol,
    timeframe: sourceTf,
    since: p.since ?? new Date(end.getTime() - AGGREGATE_LOOKBACK_MS),
    until: end,
  });
  const out = aggregateCandles(closedCandles(raw, sourceTf, end), sourceTf, p.timeframe, end);
  return p.limit ? out.slice(-p.limit) : out;
}
