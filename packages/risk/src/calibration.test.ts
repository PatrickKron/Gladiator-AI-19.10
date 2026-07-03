import { describe, expect, it } from 'vitest';
import { deriveAdaptiveGates } from './calibration.js';
import type { TradeAnalysis } from '@gladiator/backtest';

function emptyAnalysis(): TradeAnalysis {
  return { bySession: {}, byRegime: { above: undefined, below: undefined }, byDirectionRegime: {}, byPhase: { bull: undefined, bear: undefined }, byConfluence: {} };
}

describe('Selbst-Kalibrierung: Gates aus Evidenz ableiten (nur restriktiv)', () => {
  it('leitet „keine Longs unter EMA200" ab, wenn Expectancy negativ UND Stichprobe reicht', () => {
    const analysis = emptyAnalysis();
    analysis.byDirectionRegime['long|below'] = { trades: 38, netPnl: -1500, winRate: 0.31, expectancyR: -0.42 };
    analysis.byDirectionRegime['long|above'] = { trades: 60, netPnl: 900, winRate: 0.55, expectancyR: 0.12 };

    const gates = deriveAdaptiveGates(analysis, { symbol: 'BTC/USDT', timeframe: '1h' });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      kind: 'block',
      direction: 'long',
      emaRegime: 'below',
      symbol: 'BTC/USDT',
      timeframe: '1h',
    });
    expect(gates[0]!.reason).toMatch(/unter EMA200/i);
    expect(gates[0]!.evidence.trades).toBe(38);
  });

  it('KEIN Gate bei zu kleiner Stichprobe (Low-Sample-Schutz, 13_ §8)', () => {
    const analysis = emptyAnalysis();
    analysis.byDirectionRegime['long|below'] = { trades: 12, netPnl: -400, winRate: 0.2, expectancyR: -0.8 };
    expect(deriveAdaptiveGates(analysis, { minSample: 30 })).toHaveLength(0);
  });

  it('KEIN Gate bei positiver Expectancy — Kalibrierung verschärft nur, sie belohnt nicht', () => {
    const analysis = emptyAnalysis();
    analysis.byDirectionRegime['short|above'] = { trades: 80, netPnl: 2000, winRate: 0.6, expectancyR: 0.4 };
    expect(deriveAdaptiveGates(analysis, {})).toHaveLength(0);
  });

  it('Session-Gate: verlustige Session mit Stichprobe wird gesperrt', () => {
    const analysis = emptyAnalysis();
    analysis.bySession['asia'] = { trades: 45, netPnl: -900, winRate: 0.38, expectancyR: -0.2 };
    analysis.bySession['london'] = { trades: 50, netPnl: 1200, winRate: 0.58, expectancyR: 0.25 };

    const gates = deriveAdaptiveGates(analysis, {});
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ session: 'asia' });
    expect(gates[0]!.reason).toMatch(/asia/i);
  });

  it('Marktphasen-Gate: bear-Phase mit negativer Bilanz wird gesperrt', () => {
    const analysis = emptyAnalysis();
    analysis.byPhase.bear = { trades: 34, netPnl: -700, winRate: 0.35, expectancyR: -0.31 };
    const gates = deriveAdaptiveGates(analysis, {});
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ marketPhase: 'bear' });
  });

  it('Schwelle konfigurierbar: leicht negative Buckets unter der Toleranz erzeugen kein Gate', () => {
    const analysis = emptyAnalysis();
    analysis.bySession['asia'] = { trades: 100, netPnl: -50, winRate: 0.49, expectancyR: -0.03 };
    expect(deriveAdaptiveGates(analysis, { maxExpectancyR: -0.1 })).toHaveLength(0);
  });
});
