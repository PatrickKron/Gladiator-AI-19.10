import { describe, expect, it } from 'vitest';
import type { Candle } from '@gladiator/strategy-engine';
import { conditionsSchema, type CompareOp, type Condition, type Operand } from './conditions.js';
import { evaluateScreen, ScreenEvaluator } from './evaluate.js';
import { SCREEN_PRESETS } from './presets.js';

/**
 * Screener-Auswertung, rein und deterministisch: jede Erwartung aus Kerzen
 * abgeleitet, die von Hand nachvollziehbar sind. Kein Zufall.
 */

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;
const CTX = { timeframe: '60', tickerid: 'BINANCE:TESTUSDT' };

function bar(i: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { ts: new Date(T0 + i * H), open: o, high: h, low: l, close: c, volume: v };
}

/** Gleichmäßiger Anstieg 100 → 100 + 0,5·n (jede Kerze +0,5). */
function uptrend(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => bar(i, 100 + i * 0.5, 100.8 + i * 0.5, 99.9 + i * 0.5, 100.5 + i * 0.5));
}

const cmp = (left: Operand, op: CompareOp, right: Operand): Condition => ({ kind: 'compare', left, op, right });

describe('Vergleiche', () => {
  it('Preis über EMA 20 im Aufwärtstrend, Zahl gegen Zahl, Änderung über n Kerzen', () => {
    const candles = uptrend(80);
    const r = evaluateScreen(
      candles,
      [
        cmp({ kind: 'price' }, '>', { kind: 'indicator', id: 'ema', plot: 'plot0', inputs: { length: 20 } }),
        cmp({ kind: 'change', bars: 10 }, '>=', { kind: 'number', value: 3 }),
        cmp({ kind: 'change', bars: 10 }, '>', { kind: 'number', value: 50 }),
      ],
      CTX,
    );
    expect(r.results[0]!.ok).toBe(true);
    expect(r.results[0]!.left).toBeCloseTo(100.5 + 79 * 0.5, 9);
    expect(r.results[0]!.right).toBeLessThan(r.results[0]!.left!); // EMA hinkt im Trend
    // Änderung: close[79] = 140, close[69] = 135 → +3,70 %
    expect(r.results[1]!.left).toBeCloseTo((140 - 135) / 135 * 100, 9);
    expect(r.results[1]!.ok).toBe(true);
    expect(r.results[2]!.ok).toBe(false);
    expect(r.matches).toBe(false); // UND-Verknüpfung
    expect(r.close).toBe(140);
    expect(r.changePct).toBeCloseTo((140 - 139.5) / 139.5 * 100, 9);
    expect(r.time).toBe(Math.floor((T0 + 79 * H) / 1000));
  });

  it('„kreuzt nach oben“ nur, wenn die vorletzte Kerze noch darunter lag', () => {
    const flat = Array.from({ length: 40 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    // letzte Kerze schließt über 102, vorletzte darunter → kreuzt
    const crossing = [...flat.slice(0, 39), bar(39, 100, 103, 99.5, 102.5)];
    const c = [cmp({ kind: 'price' }, 'crosses_above', { kind: 'number', value: 102 })];
    expect(evaluateScreen(crossing, c, CTX).results[0]!.ok).toBe(true);
    // beide über 102 → kein Kreuzen
    const above = [...flat.slice(0, 38), bar(38, 103, 103.5, 102.5, 103), bar(39, 103, 103.5, 102.5, 103)];
    expect(evaluateScreen(above, c, CTX).results[0]!.ok).toBe(false);
    // nach unten
    const down = [...flat.slice(0, 39), bar(39, 100, 100.5, 97, 97.5)];
    expect(evaluateScreen(down, [cmp({ kind: 'price' }, 'crosses_below', { kind: 'number', value: 99 })], CTX).results[0]!.ok).toBe(true);
  });

  it('Volumen gegen das Vielfache des Durchschnittsvolumens', () => {
    const candles = uptrend(40).map((c, i) => ({ ...c, volume: i === 39 ? 5000 : 1000 }));
    const spike = cmp({ kind: 'volume' }, '>', { kind: 'volume_avg', bars: 20, mult: 2 });
    const r = evaluateScreen(candles, [spike], CTX).results[0]!;
    // Durchschnitt der letzten 20 Kerzen: (19 × 1000 + 5000) / 20 = 1200 → ×2 = 2400 < 5000
    expect(r.right).toBeCloseTo(2400, 9);
    expect(r.left).toBe(5000);
    expect(r.ok).toBe(true);
    expect(evaluateScreen(uptrend(40), [spike], CTX).results[0]!.ok).toBe(false);
  });

  it('unbekannter Indikator und fehlender Plot → ehrlicher Hinweis, kein Treffer, kein Abbruch', () => {
    const candles = uptrend(40);
    const r = evaluateScreen(
      candles,
      [cmp({ kind: 'indicator', id: 'gibt-es-nicht' }, '>', { kind: 'number', value: 0 }), cmp({ kind: 'indicator', id: 'rsi', plot: 'plot99' }, '>', { kind: 'number', value: 0 })],
      CTX,
    );
    expect(r.results[0]!.ok).toBe(false);
    expect(r.results[0]!.note).toMatch(/Unbekannter Indikator/);
    expect(r.results[1]!.ok).toBe(false);
    expect(r.results[1]!.note).toMatch(/plot99/);
  });

  it('zu wenige Kerzen → nichts entscheiden', () => {
    const r = evaluateScreen(uptrend(10), [cmp({ kind: 'price' }, '>', { kind: 'number', value: 0 })], CTX);
    expect(r.matches).toBe(false);
    expect(r.results[0]!.note).toMatch(/Zu wenige Kerzen/);
  });

  it('Standard-Plot = erster sichtbarer Plot des Katalogs', () => {
    expect(ScreenEvaluator.defaultPlot('rsi')).toBe('plot0');
    expect(ScreenEvaluator.defaultPlot('gibt-es-nicht')).toBeNull();
  });
});

describe('Muster, Struktur, Liquidität, Range', () => {
  /** 70 fallende Kerzen, dann kleine schwarze und große weiße Kerze, die sie umschließt (Engulfing bullish an Kerze 71). */
  function engulfing(): Candle[] {
    const c: Candle[] = [];
    for (let i = 0; i < 70; i++) c.push(bar(i, 200 - i, 200.6 - i, 199 - i, 199.5 - i));
    c.push(bar(70, 130, 130.3, 129.6, 129.8)); // kleine schwarze Kerze
    c.push(bar(71, 129.5, 131.5, 129.3, 131.2)); // große weiße Kerze umschließt sie
    return c;
  }

  it('Kerzenmuster in den letzten n Kerzen', () => {
    const candles = engulfing();
    expect(evaluateScreen(candles, [{ kind: 'pattern', id: 'engulfing-bullish', withinBars: 1 }], CTX).results[0]!.ok).toBe(true);
    // eine Kerze später liegt das Muster außerhalb von „innerhalb 1“, aber innerhalb 2
    const later = [...candles, bar(72, 131, 131.4, 130.8, 131.1)];
    expect(evaluateScreen(later, [{ kind: 'pattern', id: 'engulfing-bullish', withinBars: 1 }], CTX).results[0]!.ok).toBe(false);
    expect(evaluateScreen(later, [{ kind: 'pattern', id: 'engulfing-bullish', withinBars: 2 }], CTX).results[0]!.ok).toBe(true);
    expect(evaluateScreen(candles, [{ kind: 'pattern', id: 'engulfing-bearish', withinBars: 5 }], CTX).results[0]!.ok).toBe(false);
  });

  /** Seitwärts, Swing-Hoch bei 110 (@20, bestätigt @28), später Schluss darüber → bullisher BOS an Kerze 40. */
  function bos(): Candle[] {
    const c: Candle[] = [];
    for (let i = 0; i < 20; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    c.push(bar(20, 100, 110, 99.5, 101));
    for (let i = 21; i < 40; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    c.push(bar(40, 100, 112, 99.5, 111));
    for (let i = 41; i < 46; i++) c.push(bar(i, 111, 111.5, 110.5, 111));
    return c;
  }

  it('Struktur-Ereignis innerhalb n Kerzen, Richtung beachtet', () => {
    const candles = bos();
    expect(evaluateScreen(candles, [{ kind: 'structure', event: 'BOS', direction: 'bullish', withinBars: 6 }], CTX).results[0]!.ok).toBe(true);
    expect(evaluateScreen(candles, [{ kind: 'structure', event: 'BOS', direction: 'bullish', withinBars: 5 }], CTX).results[0]!.ok).toBe(false);
    expect(evaluateScreen(candles, [{ kind: 'structure', event: 'BOS', direction: 'bearish', withinBars: 20 }], CTX).results[0]!.ok).toBe(false);
    expect(evaluateScreen(candles, [{ kind: 'structure', event: 'CHoCH', withinBars: 20 }], CTX).results[0]!.ok).toBe(false);
  });

  /** Swing-Hoch bei 110 (@20), Docht darüber ohne Schluss (@40) = Buy-Side-Sweep; danach ruhig. */
  function sweep(): Candle[] {
    const c: Candle[] = [];
    for (let i = 0; i < 20; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    c.push(bar(20, 100, 110, 99.5, 101));
    for (let i = 21; i < 40; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    c.push(bar(40, 100, 110.8, 99.5, 100.2));
    for (let i = 41; i < 46; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    return c;
  }

  it('Liquiditäts-Sweep und offene Equal Highs', () => {
    const candles = sweep();
    expect(evaluateScreen(candles, [{ kind: 'liquidity', what: 'sweep_buy_side', withinBars: 6 }], CTX).results[0]!.ok).toBe(true);
    expect(evaluateScreen(candles, [{ kind: 'liquidity', what: 'sweep_buy_side', withinBars: 5 }], CTX).results[0]!.ok).toBe(false);
    expect(evaluateScreen(candles, [{ kind: 'liquidity', what: 'sweep_sell_side', withinBars: 20 }], CTX).results[0]!.ok).toBe(false);
    // zwei gleich hohe Hochs ohne Sweep → offenes Equal-High-Level
    const eq: Candle[] = [];
    for (let i = 0; i < 20; i++) eq.push(bar(i, 100, 100.5, 99.5, 100));
    eq.push(bar(20, 100, 110, 99.5, 101));
    for (let i = 21; i < 40; i++) eq.push(bar(i, 100, 100.5, 99.5, 100));
    eq.push(bar(40, 100, 110.05, 99.5, 101));
    for (let i = 41; i < 55; i++) eq.push(bar(i, 100, 100.5, 99.5, 100));
    expect(evaluateScreen(eq, [{ kind: 'liquidity', what: 'eqh_open', withinBars: 30 }], CTX).results[0]!.ok).toBe(true);
    expect(evaluateScreen(eq, [{ kind: 'liquidity', what: 'eql_open', withinBars: 30 }], CTX).results[0]!.ok).toBe(false);
  });

  it('Dealing Range: Lage des Schlusskurses', () => {
    // Swing-Tief bei 90 (@20), danach Anstieg bis 110 → Schluss oben = Premium
    const c: Candle[] = [];
    for (let i = 0; i < 20; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    c.push(bar(20, 100, 100.5, 90, 99));
    for (let i = 21; i < 30; i++) c.push(bar(i, 100, 100.5, 99.5, 100));
    for (let i = 30; i < 50; i++) c.push(bar(i, 100 + (i - 30) * 0.5, 100.5 + (i - 30) * 0.5, 99.5 + (i - 30) * 0.5, 100 + (i - 30) * 0.5));
    const r = evaluateScreen(c, [{ kind: 'range', zone: 'premium' }, { kind: 'range', zone: 'discount' }], CTX);
    expect(r.results[0]!.ok).toBe(true);
    expect(r.results[1]!.ok).toBe(false);
    expect(r.results[0]!.left).toBeGreaterThan(90); // Lage in % der Range
  });
});

describe('Vorlagen', () => {
  it('alle Vorlagen sind gültige Bedingungen und laufen ohne Abbruch', () => {
    const candles = uptrend(260);
    for (const p of SCREEN_PRESETS) {
      expect(conditionsSchema.safeParse(p.conditions).success, p.id).toBe(true);
      const r = evaluateScreen(candles, p.conditions, CTX);
      expect(r.results).toHaveLength(p.conditions.length);
      for (const res of r.results) expect(res.note === null || /Dealing Range|nicht definiert/.test(res.note), `${p.id}: ${res.note}`).toBe(true);
    }
    // Im klaren Aufwärtstrend: Preis > EMA 200 (Teil der Vorlage „überkauft im Abwärtstrend“ ist dann falsch)
    const ob = evaluateScreen(candles, SCREEN_PRESETS.find((p) => p.id === 'overbought_downtrend')!.conditions, CTX);
    expect(ob.results[1]!.ok).toBe(false);
  });

  it('zod lehnt fremde Felder und zu viele Bedingungen ab', () => {
    expect(conditionsSchema.safeParse([{ kind: 'range', zone: 'premium', extra: 1 }]).success).toBe(false);
    expect(conditionsSchema.safeParse([]).success).toBe(false);
    expect(conditionsSchema.safeParse(Array.from({ length: 9 }, () => ({ kind: 'range', zone: 'premium' }))).success).toBe(false);
    expect(conditionsSchema.safeParse([{ kind: 'compare', left: { kind: 'price' }, op: '>', right: { kind: 'number', value: 1 } }]).success).toBe(true);
  });
});
