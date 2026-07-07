import { describe, expect, it } from 'vitest';
import { parseSubAgentSpec, type Candle } from '@gladiator/strategy-engine';
import { backtestSubAgent } from './sub-agent-backtest.js';

/** Kerzen mit einem klaren Dip in der Mitte, danach Erholung. */
function dipCandles(): Candle[] {
  const closes: number[] = [];
  // 40 Bars steigend auf 120, dann Dip auf 100 (−16 %), dann Erholung > 130.
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5); // 100 → ~119.5
  for (let i = 0; i < 10; i++) closes.push(120 - i * 2); // Dip 120 → 102
  for (let i = 0; i < 60; i++) closes.push(102 + i * 0.8); // Erholung 102 → ~149
  return closes.map((c, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0) + i * 3_600_000),
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1000,
  }));
}

function spec(overrides: Record<string, unknown> = {}) {
  const r = parseSubAgentSpec({
    side: 'long',
    setupType: 'swing',
    timeframe: '1h',
    dataSources: ['price'],
    entryRules: { price: { dipFromHighPct: 8, dipLookback: 30 } },
    exitRules: { takeProfitPct: 12, stopLossPct: 6 },
    riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 5, cooldownMinutes: 0 },
    ...overrides,
  });
  if (!r.ok) throw new Error('spec invalid: ' + r.errors.join(', '));
  return r.spec;
}

describe('backtestSubAgent', () => {
  it('erzeugt echte Trades mit Netto-Kosten aus einer Preis-Dip-Regel', () => {
    const res = backtestSubAgent(dipCandles(), spec());
    expect(res.notBacktestable).toBe(false);
    expect(res.priceOnly).toBe(true);
    expect(res.trades.length).toBeGreaterThan(0);
    // Netto-Kostenpfad ist Pflicht: jeder Trade zahlt Gebühren.
    expect(res.trades.every((t) => t.fees > 0)).toBe(true);
    expect(res.metrics.tradeCount).toBe(res.trades.length);
  });

  it('weist Live-only-Quellen ehrlich als übersprungen aus (kein Fake)', () => {
    const res = backtestSubAgent(
      dipCandles(),
      spec({
        dataSources: ['price', 'macro'],
        entryRules: { price: { dipFromHighPct: 8, dipLookback: 30 }, macro: { vix: { lt: 25 } } },
      }),
    );
    expect(res.priceOnly).toBe(false);
    expect(res.skippedConditions.some((s) => s.includes('Makro'))).toBe(true);
  });

  it('markiert Agenten ohne Preisbedingung als nicht rücktestbar (statt Fake-Ergebnis)', () => {
    const res = backtestSubAgent(
      dipCandles(),
      spec({ dataSources: ['news'], entryRules: { news: { anyKeyword: ['etf'], withinMin: 120 } } }),
    );
    expect(res.notBacktestable).toBe(true);
    expect(res.trades.length).toBe(0);
  });
});
