import { describe, expect, it } from 'vitest';
import { withBinancePublic } from '@gladiator/market-data';
import { atr, bollinger, ema, macd, rsi, type Candle } from '@gladiator/strategy-engine';
import { candlesToBars, computeIndicator, firstDefinedTime, minTickOf, pineTimeframe, type ComputeBar } from './compute.js';

/** Deterministische Testkerzen (Sinus + Trend), keine Zufallswerte. */
function syntheticCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = 100 + i * 0.05 + Math.sin(i / 7) * 4 + Math.cos(i / 3) * 1.5;
    const high = Math.max(open, close) + 0.8 + Math.abs(Math.sin(i / 5));
    const low = Math.min(open, close) - 0.8 - Math.abs(Math.cos(i / 4));
    out.push({ ts: new Date(1_700_000_000_000 + i * 3_600_000), open, high, low, close, volume: 1000 + (i % 17) * 50 });
  }
  return out;
}

/** Bibliothek (Pine-Mathematik) gegen die Engine (Wahrheit der Signale): nach dem Warmup gleich. */
function expectSeriesEqual(lib: { time: number; value: number }[], bars: ComputeBar[], engine: (number | null)[], tail: number, tol: number) {
  const byTime = new Map(lib.map((p) => [p.time, p.value]));
  let compared = 0;
  for (let i = bars.length - tail; i < bars.length; i++) {
    const e = engine[i];
    const v = byTime.get(bars[i]!.time);
    expect(v, `Bar ${i}`).toBeDefined();
    expect(e, `Engine Bar ${i}`).not.toBeNull();
    expect(Math.abs(v! - e!) / Math.max(1, Math.abs(e!))).toBeLessThan(tol);
    compared++;
  }
  expect(compared).toBe(tail);
}

describe('computeIndicator (synthetische Kerzen)', () => {
  const candles = syntheticCandles(320);
  const bars = candlesToBars(candles);
  const closes = candles.map((c) => c.close);

  it('EMA/RSI/MACD/Bollinger stimmen exakt mit der Engine überein; ATR nach Warmup', () => {
    const e = computeIndicator('ema', bars, { length: 20 });
    expect(e.inputs.length).toBe(20);
    expectSeriesEqual(e.result.plots.plot0!, bars, ema(closes, 20), 200, 1e-9);

    const r = computeIndicator('rsi', bars, { length: 14 });
    expectSeriesEqual(r.result.plots.plot0!, bars, rsi(closes, 14), 200, 1e-9);

    const m = computeIndicator('macd', bars, { fastLength: 12, slowLength: 26, signalLength: 9 });
    const eng = macd(closes, 12, 26, 9);
    const plotIds = Object.keys(m.result.plots);
    // Linie, Signal und Histogramm liegen als Plots vor — je nach Id-Vergabe; wir finden sie über den Wert
    const find = (series: (number | null)[]) => plotIds.find((id) => {
      const pts = m.result.plots[id]!;
      const last = pts[pts.length - 1];
      const i = bars.length - 1;
      return last !== undefined && series[i] != null && Math.abs(last.value - series[i]!) < 1e-6;
    });
    expect(find(eng.macd), 'MACD-Linie').toBeDefined();
    expect(find(eng.signal), 'Signal').toBeDefined();
    expect(find(eng.histogram), 'Histogramm').toBeDefined();

    const b = computeIndicator('bb', bars, { length: 20, mult: 2 });
    const engB = bollinger(closes, 20, 2);
    const bbIds = Object.keys(b.result.plots);
    const bbFind = (series: (number | null)[]) => bbIds.find((id) => Math.abs(b.result.plots[id]!.at(-1)!.value - series[bars.length - 1]!) < 1e-6);
    expect(bbFind(engB.upper), 'oberes Band').toBeDefined();
    expect(bbFind(engB.middle), 'Mitte').toBeDefined();
    expect(bbFind(engB.lower), 'unteres Band').toBeDefined();

    // ATR: Pine glättet ab der ersten Kerze (TR[0] = High−Low), die Engine ab der zweiten —
    // der Unterschied klingt geometrisch ab; nach 300 Kerzen < 1e-6 relativ.
    const a = computeIndicator('atr', bars, { length: 14 });
    expectSeriesEqual(a.result.plots.plot0!, bars, atr(candles, 14), 20, 1e-6);
  });

  it('Eingaben werden bereinigt, Ergebnis ist JSON, Warmup-Zeit stimmt', () => {
    const e = computeIndicator('ema', bars, { length: '50', fremd: 'x' });
    expect(e.inputs.length).toBe(50);
    expect(e.inputs).not.toHaveProperty('fremd');
    expect(JSON.parse(JSON.stringify(e.result))).toEqual(e.result);
    expect(e.result).not.toHaveProperty('outputValues');
    expect(firstDefinedTime(e.result)).toBe(bars[49]!.time);
    expect(e.ms).toBeGreaterThanOrEqual(0);
  });

  it('Kerzenmuster: Bullish Engulfing wird genau dort erkannt, wo die Definition erfüllt ist', () => {
    // Abwärtstrend (Close unter SMA50) mit mittleren Körpern, dann kleine schwarze Kerze,
    // dann eine lange weiße Kerze, die sie umschließt — Marker genau auf dieser Kerze.
    const cs: Candle[] = [];
    const at = (i: number) => new Date(1_700_000_000_000 + i * 3_600_000);
    for (let i = 0; i < 70; i++) cs.push({ ts: at(i), open: 200 - i, high: 200.6 - i, low: 198.6 - i, close: 199 - i, volume: 1000 });
    cs.push({ ts: at(70), open: 130, high: 130.3, low: 129.2, close: 129.5, volume: 1000 }); // klein, schwarz
    cs.push({ ts: at(71), open: 129.4, high: 131.4, low: 129.1, close: 131, volume: 1000 }); // lang, weiß, umschließt
    for (let i = 72; i < 80; i++) cs.push({ ts: at(i), open: 131, high: 131.5, low: 130.5, close: 131.1, volume: 1000 });
    const b = candlesToBars(cs);
    const r = computeIndicator('engulfing-bullish', b, null);
    const marks = (r.result.markers ?? []).map((m) => m.time);
    expect(marks).toEqual([b[71]!.time]);
    // Ohne den Abwärtstrend (Erkennung aus) bleibt die Umschließung selbst ein Treffer
    const r2 = computeIndicator('engulfing-bullish', b, { detect_trend_based_on: 'No detection' });
    expect((r2.result.markers ?? []).map((m) => m.time)).toContain(b[71]!.time);
  });

  it('Unbekannter Indikator → Fehler; Helfer', () => {
    expect(() => computeIndicator('gibt-es-nicht', bars, null)).toThrow(/Unbekannter Indikator/);
    expect(minTickOf([{ time: 1, open: 1, high: 1, low: 1, close: 0.00001234 }])).toBe(1e-8);
    expect(minTickOf([{ time: 1, open: 1, high: 1, low: 1, close: 1234 }])).toBe(1);
    expect(pineTimeframe('4h')).toBe('240');
    expect(pineTimeframe('1d')).toBe('1D');
  });

  it('alle Katalog-Indikatoren rechnen mit Defaults ohne Fehler (Smoke); Zusatz-Zeitrahmen aus der DB', async () => {
    const { CATALOG } = await import('./catalog.js');
    // Tages-/Wochen-/Monatskerzen desselben Symbols (Pivots, Technicals, Seasonality) aus den Stundenkerzen gebildet
    const extraBars = { '1d': aggregate(bars, 86_400), '1w': aggregate(bars, 7 * 86_400), '1M': aggregate(bars, 30 * 86_400) };
    const failures: string[] = [];
    for (const e of CATALOG) {
      try {
        computeIndicator(e.id, bars, null, { timeframe: '60', tickerid: 'BINANCE:BTCUSDT', extraBars });
      } catch (err) {
        failures.push(`${e.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
    // Pivots nennen ihren Zusatz-Zeitrahmen (Wochenkerzen); mit DB-Kerzen rechnen sie darauf
    const pivots = CATALOG.find((e) => e.id === 'pivot-points-standard')!;
    expect(pivots.extraTimeframes).toEqual(['1w']);
    const withExtra = computeIndicator(pivots.id, bars, null, { timeframe: '60', tickerid: 'BINANCE:BTCUSDT', extraBars });
    expect(Object.keys(withExtra.result.plots).length + (withExtra.result.lines?.length ?? 0) + (withExtra.result.labels?.length ?? 0)).toBeGreaterThan(0);
  });
});

/** Kerzen zu größeren Zeitrahmen bündeln (nur für den Test). */
function aggregate(src: ComputeBar[], seconds: number): ComputeBar[] {
  const out: ComputeBar[] = [];
  for (const b of src) {
    const t = Math.floor(b.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = (last.volume ?? 0) + (b.volume ?? 0);
    } else out.push({ ...b, time: t });
  }
  return out;
}

describe('echte Kerzen (Binance, BTC/USDT 1h)', () => {
  it('Bibliothek und Engine liefern auf echten Kursen dieselben Werte', async () => {
    const raw = (await withBinancePublic((ex) => ex.fetchOHLCV('BTC/USDT', '1h', undefined, 500))) as number[][];
    expect(raw.length).toBeGreaterThan(400);
    const candles: Candle[] = raw.map((k) => ({ ts: new Date(k[0]!), open: k[1]!, high: k[2]!, low: k[3]!, close: k[4]!, volume: k[5]! }));
    const bars = candlesToBars(candles);
    const closes = candles.map((c) => c.close);
    expectSeriesEqual(computeIndicator('ema', bars, { length: 200 }).result.plots.plot0!, bars, ema(closes, 200), 100, 1e-9);
    expectSeriesEqual(computeIndicator('rsi', bars, { length: 14 }).result.plots.plot0!, bars, rsi(closes, 14), 300, 1e-9);
    expectSeriesEqual(computeIndicator('atr', bars, { length: 14 }).result.plots.plot0!, bars, atr(candles, 14), 50, 1e-6);
    // Supertrend läuft und hat genau eine Richtung je Kerze (Linie im Chart)
    const st = computeIndicator('supertrend', bars, null, { timeframe: '60', tickerid: 'BINANCE:BTCUSDT' });
    const pts = Object.values(st.result.plots).reduce((n, p) => n + p.length, 0);
    expect(pts).toBeGreaterThan(400);
  }, 60_000);
});
