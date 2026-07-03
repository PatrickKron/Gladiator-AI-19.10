import type { Candle } from './types.js';

/**
 * Einstiegszonen (05_ §3):
 * - Order Block: letzte Gegenkerze vor einer impulsiven Bewegung
 *   (Impuls-Range > 1,5 × Range der Gegenkerze UND Schluss jenseits deren Extrem).
 * - FVG: 3-Kerzen-Imbalance (bull: low[i+1] > high[i-1]; bear: high[i+1] < low[i-1]).
 * Beide sind erst ab `createdAt` (Schluss der Bestätigungskerze) verwendbar — look-ahead-frei.
 */

export type Zone = {
  kind: 'bullish-ob' | 'bearish-ob' | 'bullish-fvg' | 'bearish-fvg';
  /** Index der definierenden Kerze (OB: Gegenkerze; FVG: mittlere Kerze). */
  index: number;
  top: number;
  bottom: number;
  /** Ab diesem Bar-Index ist die Zone erkennbar. */
  createdAt: number;
  /** Erste Rückkehr des Preises in die Zone (OB) bzw. Füllung (FVG). */
  mitigatedAt?: number;
  filledAt?: number;
};

const IMPULSE_FACTOR = 1.5;

export function detectOrderBlocks(candles: Candle[], impulseFactor = IMPULSE_FACTOR): Zone[] {
  const zones: Zone[] = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const base = candles[i]!;
    const impulse = candles[i + 1]!;
    const baseRange = base.high - base.low;
    const impulseRange = impulse.high - impulse.low;
    if (baseRange <= 0 || impulseRange <= impulseFactor * baseRange) continue;

    const baseBearish = base.close < base.open;
    const baseBullish = base.close > base.open;
    const impulseBullish = impulse.close > impulse.open;
    const impulseBearish = impulse.close < impulse.open;

    if (baseBearish && impulseBullish && impulse.close > base.high) {
      zones.push({ kind: 'bullish-ob', index: i, top: base.high, bottom: base.low, createdAt: i + 1 });
    } else if (baseBullish && impulseBearish && impulse.close < base.low) {
      zones.push({ kind: 'bearish-ob', index: i, top: base.high, bottom: base.low, createdAt: i + 1 });
    }
  }

  // Mitigation: erste Rückkehr in die Zone NACH der Bestätigungskerze
  for (const z of zones) {
    for (let j = z.createdAt + 1; j < candles.length; j++) {
      const c = candles[j]!;
      const touches = z.kind === 'bullish-ob' ? c.low <= z.top : c.high >= z.bottom;
      if (touches) {
        z.mitigatedAt = j;
        break;
      }
    }
  }

  return zones;
}

export function detectFvgs(candles: Candle[]): Zone[] {
  const zones: Zone[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]!;
    const next = candles[i + 1]!;

    if (next.low > prev.high) {
      zones.push({ kind: 'bullish-fvg', index: i, bottom: prev.high, top: next.low, createdAt: i + 1 });
    } else if (next.high < prev.low) {
      zones.push({ kind: 'bearish-fvg', index: i, bottom: next.high, top: prev.low, createdAt: i + 1 });
    }
  }

  // Füllung: bull-FVG gefüllt, wenn low ≤ Gap-Boden; bear-FVG, wenn high ≥ Gap-Deckel
  for (const z of zones) {
    for (let j = z.createdAt + 1; j < candles.length; j++) {
      const c = candles[j]!;
      const filled = z.kind === 'bullish-fvg' ? c.low <= z.bottom : c.high >= z.top;
      if (filled) {
        z.filledAt = j;
        break;
      }
    }
  }

  return zones;
}
