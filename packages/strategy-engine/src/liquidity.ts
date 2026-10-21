import { atr } from './indicators.js';
import { computeSwings } from './swings.js';
import type { Candle, SwingPoint } from './types.js';

/**
 * Liquidität und Dealing Range (05_ §3, Smart-Money-Konzepte; eigene Umsetzung,
 * kein Port):
 * - Equal Highs / Equal Lows: aufeinanderfolgende Swing-Hochs (-Tiefs) innerhalb
 *   einer ATR-Toleranz → ein Liquiditäts-Pool (dort liegen gehäuft Stops).
 * - Sweep: eine Kerze dochtet ÜBER ein bestätigtes Hoch (bzw. UNTER ein Tief),
 *   schließt aber wieder dies- bzw. jenseits → Liquidität abgeholt, kein Bruch.
 *   Schließt sie jenseits, ist es ein Bruch (Struktur, siehe structure.ts) und
 *   kein Sweep. Ein Level wird vom ersten Sweep oder Bruch verbraucht.
 * - Dealing Range: letzter bestätigter Swing (Hoch oder Tief, je nachdem, was
 *   jünger ist) bis zum Extrem des laufenden Schenkels. Oberhalb der Mitte
 *   (Equilibrium) ist der Preis „Premium“, unterhalb „Discount“.
 *
 * Alles look-ahead-frei: Swings zählen erst ab `confirmedAt`; Sweeps liegen
 * danach; die Range am Bar i nutzt nur Kerzen ≤ i.
 */

export type LiquidityLevel = {
  kind: 'eqh' | 'eql';
  /** Mittel der zusammengefassten Swing-Preise. */
  price: number;
  /** Indizes der beteiligten Swings (≥ 2, aufsteigend). */
  swingIndices: number[];
  /** Index des letzten Swings. */
  index: number;
  /** Ab diesem Bar ist das Level erkennbar (confirmedAt des letzten Swings). */
  confirmedAt: number;
  /** Erster Docht durch das Level ohne Schluss jenseits. */
  sweptAt?: number;
  /** Erster Schluss jenseits des Levels (dann Bruch, kein Pool mehr). */
  brokenAt?: number;
};

export type LiquiditySweep = {
  /** buy-side = Liquidität über Hochs (Docht nach oben), sell-side = unter Tiefs. */
  side: 'buy-side' | 'sell-side';
  /** Kerze, die den Docht gesetzt hat. */
  index: number;
  level: number;
  /** Betroffener Swing (bei Equal-Levels der letzte des Clusters). */
  swingIndex: number;
  source: 'swing' | 'eqh' | 'eql';
};

export type LiquidityOptions = {
  leftBars?: number;
  rightBars?: number;
  /** ATR-Periode für die Toleranz der Equal Highs/Lows. */
  atrPeriod?: number;
  /** Toleranz = eqAtrMult × ATR (am jüngeren Swing). */
  eqAtrMult?: number;
  /** Ohne ATR (Warmup): Toleranz als Anteil des Preises. */
  eqFallbackPct?: number;
};

const DEFAULTS = { leftBars: 8, rightBars: 8, atrPeriod: 14, eqAtrMult: 0.1, eqFallbackPct: 0.001 };

/** Equal Highs / Equal Lows aus bestätigten Swings (Cluster aufeinanderfolgender Swings gleicher Art). */
export function detectEqualLevels(candles: Candle[], swings: SwingPoint[], opts: LiquidityOptions = {}): LiquidityLevel[] {
  const o = { ...DEFAULTS, ...opts };
  const atrSeries = atr(candles, o.atrPeriod);
  const tolerance = (i: number, price: number) => {
    const a = atrSeries[i];
    return a != null && a > 0 ? o.eqAtrMult * a : o.eqFallbackPct * price;
  };
  const levels: LiquidityLevel[] = [];

  for (const type of ['high', 'low'] as const) {
    const pts = swings.filter((s) => s.type === type).sort((a, b) => a.index - b.index);
    let cluster: SwingPoint[] = [];
    const flush = () => {
      if (cluster.length >= 2) {
        const last = cluster[cluster.length - 1]!;
        levels.push({
          kind: type === 'high' ? 'eqh' : 'eql',
          price: cluster.reduce((s, p) => s + p.price, 0) / cluster.length,
          swingIndices: cluster.map((p) => p.index),
          index: last.index,
          confirmedAt: last.confirmedAt,
        });
      }
      cluster = [];
    };
    for (const p of pts) {
      const prev = cluster[cluster.length - 1];
      if (prev && Math.abs(p.price - prev.price) <= tolerance(p.index, p.price) && !brokenBetween(candles, type, prev, p)) {
        cluster.push(p);
      } else {
        flush();
        cluster = [p];
      }
    }
    flush();
  }

  // Verbrauch: erster Sweep oder Bruch nach der Bestätigung
  for (const lv of levels) resolveLevel(candles, lv.kind === 'eqh' ? 'high' : 'low', lv.price, lv.confirmedAt, lv);
  return levels.sort((a, b) => a.index - b.index);
}

/** Zwischen zwei Swings schon ein Schluss jenseits des älteren Levels? Dann kein Equal Level, sondern ein Bruch. */
function brokenBetween(candles: Candle[], type: 'high' | 'low', a: SwingPoint, b: SwingPoint): boolean {
  for (let j = a.index + 1; j < b.index; j++) {
    const close = candles[j]!.close;
    if (type === 'high' ? close > a.price : close < a.price) return true;
  }
  return false;
}

/** Erster Docht (sweptAt) bzw. Schluss (brokenAt) jenseits des Levels ab `from` + 1. */
function resolveLevel(candles: Candle[], type: 'high' | 'low', price: number, from: number, out: { sweptAt?: number; brokenAt?: number }): void {
  for (let j = from + 1; j < candles.length; j++) {
    const c = candles[j]!;
    const beyondClose = type === 'high' ? c.close > price : c.close < price;
    const beyondWick = type === 'high' ? c.high > price : c.low < price;
    if (beyondClose) {
      out.brokenAt = j;
      return;
    }
    if (beyondWick) {
      out.sweptAt = j;
      return;
    }
  }
}

/**
 * Sweeps über bestätigte Swing-Hochs/-Tiefs und Equal-Levels. Ein Swing, der
 * Teil eines Equal-Levels ist, wird nicht zusätzlich einzeln gewertet (sonst
 * zwei Marker auf derselben Kerze).
 */
export function detectSweeps(candles: Candle[], swings: SwingPoint[], levels: LiquidityLevel[]): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  const inLevel = new Set<string>();
  for (const lv of levels) {
    for (const i of lv.swingIndices) inLevel.add(`${lv.kind === 'eqh' ? 'high' : 'low'}:${i}`);
    if (lv.sweptAt !== undefined) {
      sweeps.push({ side: lv.kind === 'eqh' ? 'buy-side' : 'sell-side', index: lv.sweptAt, level: lv.price, swingIndex: lv.index, source: lv.kind });
    }
  }
  for (const s of swings) {
    if (inLevel.has(`${s.type}:${s.index}`)) continue;
    const r: { sweptAt?: number; brokenAt?: number } = {};
    resolveLevel(candles, s.type, s.price, s.confirmedAt, r);
    if (r.sweptAt !== undefined) {
      sweeps.push({ side: s.type === 'high' ? 'buy-side' : 'sell-side', index: r.sweptAt, level: s.price, swingIndex: s.index, source: 'swing' });
    }
  }
  return sweeps.sort((a, b) => a.index - b.index || a.swingIndex - b.swingIndex);
}

/** Equal Levels + Sweeps in einem Aufruf (Chart, Screener, Scoring). */
export function detectLiquidity(candles: Candle[], opts: LiquidityOptions = {}): { swings: SwingPoint[]; levels: LiquidityLevel[]; sweeps: LiquiditySweep[] } {
  const o = { ...DEFAULTS, ...opts };
  const swings = computeSwings(candles, o.leftBars, o.rightBars);
  const levels = detectEqualLevels(candles, swings, o);
  return { swings, levels, sweeps: detectSweeps(candles, swings, levels) };
}

export type DealingRange = {
  high: number;
  low: number;
  /** Bar-Index des Range-Hochs bzw. -Tiefs (Swing oder Extrem des laufenden Schenkels). */
  highIndex: number;
  lowIndex: number;
  /** Mitte der Range. */
  equilibrium: number;
  /** Lage des Schlusskurses in der Range, 0 = Tief … 1 = Hoch. */
  position: number;
  zone: 'premium' | 'discount' | 'equilibrium';
};

/** Equilibrium-Band: ±2,5 % um die Mitte gilt als „fair“ (weder Premium noch Discount). */
const EQ_BAND = 0.025;

/**
 * Dealing Range am Bar i: der jüngste bestätigte Swing bestimmt den Anker —
 * ein Swing-Tief eröffnet einen Aufwärtsschenkel (Range = Tief … höchstes Hoch
 * seit dem Tief), ein Swing-Hoch einen Abwärtsschenkel (Hoch … tiefstes Tief).
 * Nur Kerzen ≤ i, Swings nur mit confirmedAt ≤ i.
 */
export function dealingRangeAt(candles: Candle[], swings: SwingPoint[], i: number): DealingRange | null {
  if (i < 0 || i >= candles.length) return null;
  let anchor: SwingPoint | null = null;
  for (const s of swings) {
    if (s.confirmedAt > i) continue;
    if (!anchor || s.index > anchor.index || (s.index === anchor.index && s.type === 'low')) anchor = s;
  }
  if (!anchor) return null;

  let high: number;
  let low: number;
  let highIndex: number;
  let lowIndex: number;
  if (anchor.type === 'low') {
    low = anchor.price;
    lowIndex = anchor.index;
    high = -Infinity;
    highIndex = anchor.index;
    for (let j = anchor.index; j <= i; j++) {
      const h = candles[j]!.high;
      if (h > high) {
        high = h;
        highIndex = j;
      }
    }
  } else {
    high = anchor.price;
    highIndex = anchor.index;
    low = Infinity;
    lowIndex = anchor.index;
    for (let j = anchor.index; j <= i; j++) {
      const l = candles[j]!.low;
      if (l < low) {
        low = l;
        lowIndex = j;
      }
    }
  }
  if (!(high > low)) return null;

  const equilibrium = (high + low) / 2;
  const position = Math.min(1, Math.max(0, (candles[i]!.close - low) / (high - low)));
  const zone = position > 0.5 + EQ_BAND ? 'premium' : position < 0.5 - EQ_BAND ? 'discount' : 'equilibrium';
  return { high, low, highIndex, lowIndex, equilibrium, position, zone };
}

/** Dealing Range an der letzten Kerze. */
export function premiumDiscount(candles: Candle[], opts: Pick<LiquidityOptions, 'leftBars' | 'rightBars'> = {}): DealingRange | null {
  const o = { ...DEFAULTS, ...opts };
  return dealingRangeAt(candles, computeSwings(candles, o.leftBars, o.rightBars), candles.length - 1);
}
