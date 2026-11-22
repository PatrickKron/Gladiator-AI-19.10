import { macd, rsi } from './indicators.js';
import type { Candle } from './types.js';

/**
 * Echte, deterministische & look-ahead-freie Divergenz-Erkennung für RSI & MACD-Histogramm.
 *
 * Ein Pivot an Index `p` gilt erst an Index `confirmedAt = p + rightBars` als bestätigt —
 * beim Auswerten an Bar `i` werden daher nur Divergenzen mit `confirmedAt <= i` sichtbar.
 * - `bullish`        (Regulär):    Preis tieferes Tief, Indikator höheres Tief
 * - `bearish`        (Regulär):    Preis höheres Hoch, Indikator tieferes Hoch
 * - `hidden_bullish` (Versteckt):  Preis höheres Tief, Indikator tieferes Tief
 * - `hidden_bearish` (Versteckt):  Preis tieferes Hoch, Indikator höheres Hoch
 */

export type DivergenceIndicator = 'rsi' | 'macd';
export type DivergenceKind = 'bullish' | 'bearish' | 'hidden_bullish' | 'hidden_bearish';

export type DivergenceEvent = {
  /** Index der zweiten Pivot-Kerze (an der die Divergenz im Chart markiert wird). */
  index: number;
  /** Erster Bar, an dem der Pivot vollständig bestätigt ist (`index + rightBars`, look-ahead-frei). */
  confirmedAt: number;
  /** Index der vorherigen Vergleichs-Pivot-Kerze. */
  prevIndex: number;
  indicator: DivergenceIndicator;
  kind: DivergenceKind;
  price: number;
  prevPrice: number;
  indValue: number;
  prevIndValue: number;
};

export interface DivergenceOptions {
  indicator?: DivergenceIndicator;
  rsiPeriod?: number;
  leftBars?: number;
  rightBars?: number;
  minBarsBetween?: number;
  maxBarsBetween?: number;
}

function findPivots(candles: readonly Candle[], left: number, right: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= h) isHigh = false;
      if (candles[j]!.low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

export function detectDivergences(candles: readonly Candle[], opts: DivergenceOptions = {}): DivergenceEvent[] {
  const indicator: DivergenceIndicator = opts.indicator ?? 'rsi';
  const left = Math.max(1, opts.leftBars ?? 3);
  const right = Math.max(1, opts.rightBars ?? 3);
  const minGap = Math.max(2, opts.minBarsBetween ?? 5);
  const maxGap = Math.max(minGap + 1, opts.maxBarsBetween ?? 60);

  if (candles.length < left + right + 20) return [];
  const closes = candles.map((c) => c.close);
  const series: (number | null)[] =
    indicator === 'rsi' ? rsi(closes, opts.rsiPeriod ?? 14) : macd(closes, 12, 26, 9).histogram;

  const { highs, lows } = findPivots(candles, left, right);
  const out: DivergenceEvent[] = [];

  // Bullish & Hidden Bullish über Pivot-Tiefs
  for (let k = 1; k < lows.length; k++) {
    const p2 = lows[k]!;
    const p1 = lows[k - 1]!;
    const gap = p2 - p1;
    if (gap < minGap || gap > maxGap) continue;
    const v1 = series[p1];
    const v2 = series[p2];
    if (v1 == null || v2 == null) continue;
    const pr1 = candles[p1]!.low;
    const pr2 = candles[p2]!.low;
    const confirmedAt = p2 + right;
    if (pr2 < pr1 && v2 > v1) {
      out.push({ index: p2, confirmedAt, prevIndex: p1, indicator, kind: 'bullish', price: pr2, prevPrice: pr1, indValue: v2, prevIndValue: v1 });
    } else if (pr2 > pr1 && v2 < v1) {
      out.push({ index: p2, confirmedAt, prevIndex: p1, indicator, kind: 'hidden_bullish', price: pr2, prevPrice: pr1, indValue: v2, prevIndValue: v1 });
    }
  }

  // Bearish & Hidden Bearish über Pivot-Hochs
  for (let k = 1; k < highs.length; k++) {
    const p2 = highs[k]!;
    const p1 = highs[k - 1]!;
    const gap = p2 - p1;
    if (gap < minGap || gap > maxGap) continue;
    const v1 = series[p1];
    const v2 = series[p2];
    if (v1 == null || v2 == null) continue;
    const pr1 = candles[p1]!.high;
    const pr2 = candles[p2]!.high;
    const confirmedAt = p2 + right;
    if (pr2 > pr1 && v2 < v1) {
      out.push({ index: p2, confirmedAt, prevIndex: p1, indicator, kind: 'bearish', price: pr2, prevPrice: pr1, indValue: v2, prevIndValue: v1 });
    } else if (pr2 < pr1 && v2 > v1) {
      out.push({ index: p2, confirmedAt, prevIndex: p1, indicator, kind: 'hidden_bearish', price: pr2, prevPrice: pr1, indValue: v2, prevIndValue: v1 });
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Kombiniert RSI- und MACD-Divergenzen für Chart & Analyse. */
export function detectAllDivergences(candles: readonly Candle[]): DivergenceEvent[] {
  return [...detectDivergences(candles, { indicator: 'rsi' }), ...detectDivergences(candles, { indicator: 'macd' })].sort(
    (a, b) => a.index - b.index,
  );
}
