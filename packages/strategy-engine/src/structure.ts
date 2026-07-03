import { computeSwings } from './swings.js';
import type { Candle, StructureEvent } from './types.js';

export type StructureOptions = {
  leftBars?: number;
  rightBars?: number;
};

/**
 * Marktstruktur-Erkennung (05_ §3, Pine-Referenz):
 * - BOS  = Schlusskurs-Bruch des letzten bestätigten Swing-Levels IN Trendrichtung
 *   (bzw. erster Bruch ohne etablierten Trend).
 * - CHoCH = erster Schlusskurs-Bruch GEGEN den zuvor etablierten Trend.
 *
 * Look-ahead-frei: Ein Swing wird erst ab seinem `confirmedAt`-Bar als
 * Referenz aktiv. Gebrochene Level werden verbraucht (max. ein Ereignis
 * pro Level); Dochte ohne Schlusskurs-Bruch zählen nicht.
 */
export function detectStructure(candles: Candle[], opts: StructureOptions = {}): StructureEvent[] {
  const leftBars = opts.leftBars ?? 8;
  const rightBars = opts.rightBars ?? 8;
  const swings = computeSwings(candles, leftBars, rightBars);

  // Aktivierung in confirmedAt-Reihenfolge (bei Pivots monoton mit index)
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  const events: StructureEvent[] = [];
  let trend: 'none' | 'bull' | 'bear' = 'none';
  let refHigh: (typeof highs)[number] | null = null;
  let refLow: (typeof lows)[number] | null = null;
  let hi = 0;
  let li = 0;

  for (let i = 0; i < candles.length; i++) {
    // Neu bestätigte Swings werden zur aktuellen Referenz („letztes Swing-Hoch/-Tief")
    while (hi < highs.length && highs[hi]!.confirmedAt <= i) {
      refHigh = highs[hi]!;
      hi++;
    }
    while (li < lows.length && lows[li]!.confirmedAt <= i) {
      refLow = lows[li]!;
      li++;
    }

    const close = candles[i]!.close;

    if (refHigh && close > refHigh.price) {
      events.push({
        kind: trend === 'bear' ? 'CHoCH' : 'BOS',
        direction: 'bullish',
        index: i,
        brokenLevel: refHigh.price,
        swingIndex: refHigh.index,
      });
      trend = 'bull';
      refHigh = null; // Level verbraucht — kein Dauerfeuer
    }

    if (refLow && close < refLow.price) {
      events.push({
        kind: trend === 'bull' ? 'CHoCH' : 'BOS',
        direction: 'bearish',
        index: i,
        brokenLevel: refLow.price,
        swingIndex: refLow.index,
      });
      trend = 'bear';
      refLow = null;
    }
  }

  return events;
}
