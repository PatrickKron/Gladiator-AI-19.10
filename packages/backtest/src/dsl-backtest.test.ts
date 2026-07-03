import { describe, expect, it } from 'vitest';
import { evaluateDslAt, parseInstructionDsl, type Candle, type InstructionDsl } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest } from './engine.js';

/**
 * DSL-Strategien im Backtest (Patrick-Lücke 3): dieselbe look-ahead-freie
 * Engine, derselbe Netto-Kostenpfad — der Evaluator kommt aus der DSL.
 */

function syntheticCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 6) * 2.5;
    const drift = i * 0.12;
    const close = 100 + drift + wave;
    candles.push({
      ts: new Date(Date.UTC(2026, 0, 1, 8) + i * 3_600_000),
      open: price,
      high: Math.max(price, close) + 0.6,
      low: Math.min(price, close) - 0.6,
      close,
      volume: 1000 + (i % 5) * 40,
    });
    price = close;
  }
  return candles;
}

const parsed = parseInstructionDsl({
  id: 'bt-test-ema-long',
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  when: { all: [{ trend: 'EMA200_up' }, { indicator: 'RSI', lt: 65 }] },
  entry: 'market',
  stopLoss: { type: 'pct', pct: 2 },
  takeProfits: [{ rr: 1.5 }, { rr: 3 }],
  risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
});
if (!parsed.ok) throw new Error('Fixture-DSL muss valide sein');
const dsl: InstructionDsl = parsed.dsl;

describe('DSL-Strategie durch die Backtest-Engine', () => {
  const candles = syntheticCandles(600);

  it('erzeugt echte Trades mit Netto-Kosten (Gebühren > 0) und R-Multiples', () => {
    const result = runBacktest(candles, {
      evaluate: (cs, i) => {
        const setup = evaluateDslAt(cs, i, dsl);
        return setup ? [setup] : [];
      },
      initialEquity: 10_000,
      riskPctPerTrade: 1,
      costModel: DEFAULT_COSTS,
      barsPerYear: 8760,
      tpWeights: [0.5, 0.3, 0.2],
      setupType: 'swing',
    });

    expect(result.trades.length).toBeGreaterThan(0);
    for (const t of result.trades) {
      expect(t.direction).toBe('long');
      expect(t.fees).toBeGreaterThan(0); // netto — Kostenmodell ist Pflicht
      expect(Number.isFinite(t.rMultiple)).toBe(true);
      expect(t.netPnl).toBeLessThan(t.grossPnl + 1e-9); // Kosten drücken netto unter brutto
    }
    expect(result.metrics.tradeCount).toBe(result.trades.length);
  });

  it('look-ahead-frei: identisches Ergebnis, wenn Zukunftskerzen fehlen', () => {
    const config = {
      evaluate: (cs: Candle[], i: number) => {
        const setup = evaluateDslAt(cs, i, dsl);
        return setup ? [setup] : [];
      },
      initialEquity: 10_000,
      riskPctPerTrade: 1,
      costModel: DEFAULT_COSTS,
      barsPerYear: 8760,
      tpWeights: [0.5, 0.3, 0.2],
      setupType: 'swing' as const,
    };
    const full = runBacktest(candles, config);
    const firstEntry = full.trades[0]!.entryTs.getTime();
    // Erster Trade muss auch entstehen, wenn die Daten kurz nach dem Entry enden
    const cutIdx = candles.findIndex((c) => c.ts.getTime() > firstEntry) + 30;
    const cut = runBacktest(candles.slice(0, cutIdx), config);
    expect(cut.trades[0]!.entryTs.getTime()).toBe(firstEntry);
  });
});
