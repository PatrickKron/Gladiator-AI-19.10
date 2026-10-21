import { describe, expect, it } from 'vitest';
import { dealingRangeAt, detectEqualLevels, detectLiquidity, detectSweeps, premiumDiscount } from './liquidity.js';
import { computeSwings } from './swings.js';
import type { Candle } from './types.js';

/**
 * Liquidität (Equal Highs/Lows, Sweeps) und Dealing Range (Premium/Discount) —
 * deterministische Kerzen, jede Erwartung von Hand nachgerechnet. Alles
 * look-ahead-frei: ein Level zählt erst ab `confirmedAt`, ein Sweep liegt
 * immer danach.
 */

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

/** Kerze aus (open, high, low, close); Volumen konstant. */
function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { ts: new Date(T0 + i * H), open: o, high: h, low: l, close: c, volume: 1000 };
}

/** Ruhige Kerzen um `base` (Range 1,0) — Pivots stören sie nicht. */
function flat(n: number, base: number, start = 0): Candle[] {
  return Array.from({ length: n }, (_, k) => bar(start + k, base, base + 0.5, base - 0.5, base));
}

/**
 * Szenario: Seitwärts um 100, zwei Hochs bei 110 und 110,1 (Equal Highs),
 * danach ein Docht auf 110,6, der unter dem Level schließt (Sweep), dann
 * ein Schluss darüber (Bruch). Pivots 3/3, damit die Kerzen überschaubar bleiben.
 */
function eqhScenario(): Candle[] {
  const c: Candle[] = [];
  c.push(...flat(5, 100)); // 0–4
  c.push(bar(5, 100, 110, 99.5, 101)); // Swing-Hoch 1 @5 (110)
  c.push(...flat(5, 100, 6)); // 6–10
  c.push(bar(11, 100, 110.05, 99.5, 101)); // Swing-Hoch 2 @11 (110,05) — gleich hoch (Toleranz 0,1 % ohne ATR-Warmup)
  c.push(...flat(5, 100, 12)); // 12–16
  c.push(bar(17, 100, 110.6, 99.5, 100.2)); // Docht über das Level, Schluss darunter → Sweep (selbst ein Pivot, aber > Toleranz → kein Equal High)
  c.push(...flat(3, 100, 18)); // 18–20
  c.push(bar(21, 100, 112, 99.5, 111)); // Schluss über 110 → Bruch (kein Sweep mehr)
  c.push(...flat(5, 100, 22)); // 22–26
  return c;
}

describe('Equal Highs / Equal Lows', () => {
  it('fasst zwei Swing-Hochs innerhalb der Toleranz zu einem Level zusammen (look-ahead-frei)', () => {
    const candles = eqhScenario();
    const swings = computeSwings(candles, 3, 3);
    const levels = detectEqualLevels(candles, swings);
    expect(levels).toHaveLength(1);
    const lv = levels[0]!;
    expect(lv.kind).toBe('eqh');
    expect(lv.swingIndices).toEqual([5, 11]);
    expect(lv.price).toBeCloseTo(110.025, 9);
    expect(lv.index).toBe(11);
    expect(lv.confirmedAt).toBe(14); // 11 + rightBars 3
    expect(lv.sweptAt).toBe(17);
    expect(lv.brokenAt).toBeUndefined(); // nach dem Sweep ist das Level verbraucht
  });

  it('kein Level, wenn die Hochs weiter auseinander liegen als die Toleranz', () => {
    const candles = eqhScenario();
    candles[11] = bar(11, 100, 113, 99.5, 101); // 110 vs 113 → kein Equal High
    const swings = computeSwings(candles, 3, 3);
    expect(detectEqualLevels(candles, swings)).toHaveLength(0);
  });

  it('Equal Lows spiegelbildlich, Bruch per Schlusskurs statt Sweep', () => {
    const c: Candle[] = [];
    c.push(...flat(5, 100));
    c.push(bar(5, 100, 100.5, 90, 99)); // Swing-Tief @5 (90)
    c.push(...flat(5, 100, 6));
    c.push(bar(11, 100, 100.5, 90.05, 99)); // Swing-Tief @11 (90,05)
    c.push(...flat(5, 100, 12));
    c.push(bar(17, 100, 100.5, 88, 89)); // Schluss unter 90 → Bruch
    c.push(...flat(5, 100, 18));
    const swings = computeSwings(c, 3, 3);
    const levels = detectEqualLevels(c, swings);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.kind).toBe('eql');
    expect(levels[0]!.swingIndices).toEqual([5, 11]);
    expect(levels[0]!.brokenAt).toBe(17);
    expect(levels[0]!.sweptAt).toBeUndefined();
  });
});

describe('Liquiditäts-Sweeps', () => {
  it('Docht über ein bestätigtes Swing-Hoch mit Schluss darunter = Buy-Side-Sweep; Schluss darüber = kein Sweep', () => {
    const candles = eqhScenario();
    const swings = computeSwings(candles, 3, 3);
    const levels = detectEqualLevels(candles, swings);
    const sweeps = detectSweeps(candles, swings, levels);
    // Genau ein Sweep: Kerze 17 über das Equal-High-Level (Quelle eqh, nicht doppelt als Swing-Sweep)
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ side: 'buy-side', index: 17, source: 'eqh', swingIndex: 11 });
    expect(sweeps[0]!.level).toBeCloseTo(110.025, 9);
    for (const s of sweeps) expect(s.index).toBeGreaterThan(swings.find((w) => w.index === s.swingIndex)!.confirmedAt);
  });

  it('einzelnes Swing-Tief: Sell-Side-Sweep nur nach Bestätigung, danach verbraucht', () => {
    const c: Candle[] = [];
    c.push(...flat(5, 100));
    c.push(bar(5, 100, 100.5, 90, 99)); // Swing-Tief @5, bestätigt @8
    c.push(bar(6, 100, 100.5, 89.8, 99.9)); // Docht darunter VOR der Bestätigung → zählt nicht (und wäre kein Pivot mehr)
    c.push(...flat(4, 100, 7));
    c.push(bar(11, 100, 100.5, 89.5, 99.5)); // Docht unter 90, Schluss darüber → Sweep
    c.push(bar(12, 100, 100.5, 89.0, 99.5)); // zweiter Docht → Level schon verbraucht, kein zweiter Sweep
    c.push(...flat(5, 100, 13));
    const swings = computeSwings(c, 3, 3);
    // Kerze 6 unterbietet das Tief @5 → @5 ist KEIN Pivot (strikt); Pivot ist @6 (89,8)
    const low = swings.find((s) => s.type === 'low');
    expect(low).toMatchObject({ index: 6, price: 89.8, confirmedAt: 9 });
    const sweeps = detectSweeps(c, swings, []);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ side: 'sell-side', index: 11, source: 'swing', swingIndex: 6, level: 89.8 });
  });

  it('detectLiquidity bündelt Levels und Sweeps und bleibt deterministisch', () => {
    const candles = eqhScenario();
    const a = detectLiquidity(candles, { leftBars: 3, rightBars: 3 });
    const b = detectLiquidity(candles, { leftBars: 3, rightBars: 3 });
    expect(a).toEqual(b);
    expect(a.levels).toHaveLength(1);
    expect(a.sweeps.map((s) => s.index)).toEqual([17]);
  });
});

describe('Dealing Range / Premium–Discount', () => {
  /** Aufwärtstrend: Swing-Tief bei 90 (@5), danach steigende Kerzen bis 110. */
  function bullLeg(): Candle[] {
    const c: Candle[] = [];
    c.push(...flat(5, 100));
    c.push(bar(5, 100, 100.5, 90, 99)); // Swing-Tief @5 (90), bestätigt @8
    c.push(...flat(3, 100, 6));
    for (let i = 9; i < 20; i++) c.push(bar(i, 100 + (i - 9), 100.5 + (i - 9), 99.5 + (i - 9), 100 + (i - 9)));
    // Kerze 19: open 110, high 110,5, low 109,5, close 110
    return c;
  }

  it('Range vom bestätigten Swing-Tief bis zum Hoch des laufenden Schenkels; Schluss oben = Premium', () => {
    const candles = bullLeg();
    const swings = computeSwings(candles, 3, 3);
    const r = dealingRangeAt(candles, swings, 19);
    expect(r).not.toBeNull();
    expect(r!.low).toBe(90);
    expect(r!.high).toBe(110.5);
    expect(r!.lowIndex).toBe(5);
    expect(r!.highIndex).toBe(19);
    expect(r!.equilibrium).toBeCloseTo(100.25, 9);
    expect(r!.position).toBeCloseTo((110 - 90) / 20.5, 9);
    expect(r!.zone).toBe('premium');
  });

  it('vor der Bestätigung des Swings gibt es keine Range (look-ahead-frei); in der Mitte = Equilibrium, unten = Discount', () => {
    const candles = bullLeg();
    const swings = computeSwings(candles, 3, 3);
    expect(dealingRangeAt(candles, swings, 7)).toBeNull(); // Tief @5 erst @8 bestätigt
    // Kerze 9: close 100 → Range 90–100,5 → Position (100−90)/10,5 = 0,952 → Premium
    expect(dealingRangeAt(candles, swings, 9)!.zone).toBe('premium');
    // Eigener Schluss in der Mitte der Range
    const mid = [...candles.slice(0, 20), bar(20, 100, 100.5, 99.5, 100.25)];
    const r = dealingRangeAt(mid, computeSwings(mid, 3, 3), 20);
    expect(r!.zone).toBe('equilibrium');
    const low = [...candles.slice(0, 20), bar(20, 92, 92.5, 91.5, 92)];
    expect(dealingRangeAt(low, computeSwings(low, 3, 3), 20)!.zone).toBe('discount');
  });

  it('Abwärtsschenkel: Range vom bestätigten Swing-Hoch bis zum Tief seither', () => {
    const c: Candle[] = [];
    c.push(...flat(5, 100));
    c.push(bar(5, 100, 112, 99.5, 101)); // Swing-Hoch @5 (112)
    c.push(...flat(3, 100, 6));
    for (let i = 9; i < 20; i++) c.push(bar(i, 100 - (i - 9), 100.5 - (i - 9), 99.5 - (i - 9), 100 - (i - 9)));
    const r = premiumDiscount(c, { leftBars: 3, rightBars: 3 });
    expect(r).toMatchObject({ high: 112, highIndex: 5, low: 89.5, lowIndex: 19, zone: 'discount' });
    expect(r!.equilibrium).toBeCloseTo(100.75, 9);
  });

  it('ohne bestätigten Swing keine Range', () => {
    expect(premiumDiscount(flat(10, 100), { leftBars: 3, rightBars: 3 })).toBeNull();
  });
});
