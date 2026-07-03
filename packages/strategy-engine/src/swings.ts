import type { Candle, SwingPoint } from './types.js';

/**
 * Pivot-/Swing-Erkennung wie im Pine-Script (pivotHigh/pivotLow):
 * Ein Swing-Hoch @i ist STRIKT höher als die Highs der `leftBars` davor
 * und der `rightBars` danach (Plateaus zählen nicht → keine Doppel-Signale).
 *
 * WICHTIG (Marktstruktur über Swings statt 2-Kerzen-Vergleich, 05_ §2):
 * Ein Pivot ist erst `rightBars` Kerzen SPÄTER erkennbar — `confirmedAt`
 * trägt diesen Index. Verbraucher dürfen einen Swing erst ab `confirmedAt`
 * verwenden, sonst entsteht Look-ahead-Bias.
 */
export function computeSwings(candles: Candle[], leftBars = 8, rightBars = 8): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const { high, low } = candles[i]!;

    let isHigh = true;
    let isLow = true;
    for (let k = i - leftBars; k <= i + rightBars; k++) {
      if (k === i) continue;
      if (candles[k]!.high >= high) isHigh = false;
      if (candles[k]!.low <= low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) swings.push({ type: 'high', index: i, price: high, confirmedAt: i + rightBars });
    if (isLow) swings.push({ type: 'low', index: i, price: low, confirmedAt: i + rightBars });
  }

  return swings;
}
