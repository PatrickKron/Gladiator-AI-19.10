import { describe, expect, it } from 'vitest';
import { parseInstructionDsl, SMC_CORE_DEFAULTS, type Candle, type InstructionDsl, type SetupCandidate } from '@gladiator/strategy-engine';
import { ZERO_COSTS } from './engine.js';
import type { Metrics } from './metrics.js';
import {
  diffParams,
  dslGrid,
  judgeOptimization,
  MAX_GRID,
  OPTIMIZATION_THRESHOLDS,
  paramsKey,
  pickProposal,
  runOptimizationStudy,
  smcCoreGrid,
} from './optimize.js';

/**
 * Nacht-Optimierung (08_ §4/§5): Grid → Walk-Forward → Vergleich mit der
 * aktuellen Version auf DENSELBEN OOS-Fenstern → nur bei klarem Vorsprung ein
 * VORSCHLAG. Alles rein/deterministisch getestet (keine DB, kein Zufall).
 */

const metrics = (over: Partial<Metrics> = {}): Metrics => ({
  tradeCount: 40,
  netPnl: 500,
  winRate: 0.5,
  profitFactor: 1.4,
  expectancy: 0.2,
  avgWinR: 1,
  avgLossR: -1,
  maxDrawdownPct: 8,
  netReturnPct: 5,
  sharpe: 1,
  sortino: 1.2,
  ...over,
});
const holdout = { fromTs: new Date(0), tradeCount: 15, expectancy: 0.3, profitFactor: 1.5 };

describe('paramsKey', () => {
  it('ist unabhängig von der Schlüssel-Reihenfolge (stabile Identität eines Parametersatzes)', () => {
    expect(paramsKey({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(paramsKey({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(paramsKey({ a: 1 })).not.toBe(paramsKey({ a: 2 }));
  });
});

describe('smcCoreGrid (kleines, begrenztes SMC-Grid)', () => {
  const grid = smcCoreGrid(SMC_CORE_DEFAULTS);
  it('enthält die aktuelle Version, ist eindeutig und ≤ MAX_GRID', () => {
    expect(grid.length).toBeGreaterThan(1);
    expect(grid.length).toBeLessThanOrEqual(MAX_GRID);
    expect(grid.map(paramsKey)).toContain(paramsKey(SMC_CORE_DEFAULTS));
    expect(new Set(grid.map(paramsKey)).size).toBe(grid.length);
  });
  it('variiert nur Swing-Bars und EMA-Nähe, innerhalb der erlaubten Grenzen', () => {
    for (const p of grid) {
      expect(p.swingLeftBars).toBeGreaterThanOrEqual(2);
      expect(p.swingLeftBars).toBeLessThanOrEqual(30);
      expect(p.emaProximityPct).toBeGreaterThanOrEqual(0.1);
      expect(p.emaProximityPct).toBeLessThanOrEqual(10);
      expect(p.rsiPeriod).toBe(SMC_CORE_DEFAULTS.rsiPeriod);
      expect(p.emaTrendPeriod).toBe(SMC_CORE_DEFAULTS.emaTrendPeriod);
    }
    expect(new Set(grid.map((p) => p.swingLeftBars))).toEqual(new Set([6, 8, 10]));
  });
  it('klemmt an der Untergrenze (Swing 2 bleibt ≥ 2)', () => {
    const g = smcCoreGrid({ ...SMC_CORE_DEFAULTS, swingLeftBars: 2, swingRightBars: 2 });
    expect(Math.min(...g.map((p) => p.swingLeftBars))).toBe(2);
    expect(new Set(g.map(paramsKey)).size).toBe(g.length);
  });
});

const BASE_DSL: InstructionDsl = (() => {
  const r = parseInstructionDsl({
    id: 'opt-test',
    symbol: 'BTC/USDT',
    timeframe: '4h',
    direction: 'long',
    when: { all: [{ trend: 'EMA200_up' }] },
    stopLoss: { type: 'ATR', mult: 2 },
    takeProfits: [{ rr: 1 }, { rr: 2 }],
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.dsl;
})();

describe('dslGrid (Risiko-/Exit-Parameter einer DSL-Strategie)', () => {
  const grid = dslGrid(BASE_DSL);
  it('alle Varianten sind gültige DSL, eindeutig, ≤ MAX_GRID, inkl. aktueller Version', () => {
    expect(grid.length).toBeLessThanOrEqual(MAX_GRID);
    expect(grid.map(paramsKey)).toContain(paramsKey(BASE_DSL));
    expect(new Set(grid.map(paramsKey)).size).toBe(grid.length);
    for (const d of grid) expect(parseInstructionDsl(d).ok).toBe(true);
  });
  it('variiert Stop-Multiplikator, TP-RR und Trailing — Einstiegslogik bleibt unverändert', () => {
    const mults = new Set(grid.map((d) => (d.stopLoss.type === 'ATR' ? d.stopLoss.mult : NaN)));
    expect(mults).toEqual(new Set([1.5, 2, 2.5]));
    const rr1 = new Set(grid.map((d) => d.takeProfits[0]!.rr));
    expect(rr1).toEqual(new Set([0.8, 1, 1.25]));
    expect(grid.some((d) => d.trailingStop !== undefined)).toBe(true);
    for (const d of grid) {
      expect(d.when).toEqual(BASE_DSL.when);
      expect(d.symbol).toBe(BASE_DSL.symbol);
      expect(d.direction).toBe(BASE_DSL.direction);
    }
  });
  it('vorhandener Trailing-Stop → Varianten „aus", halber und doppelter Abstand', () => {
    const g = dslGrid({ ...BASE_DSL, trailingStop: { pct: 2 } });
    const trails = new Set(g.map((d) => d.trailingStop?.pct ?? null));
    expect(trails).toEqual(new Set([null, 1, 2, 4]));
    expect(g.length).toBeLessThanOrEqual(MAX_GRID);
  });
  it('%-Stop wird ebenfalls skaliert', () => {
    const g = dslGrid({ ...BASE_DSL, stopLoss: { type: 'pct', pct: 2 } });
    expect(new Set(g.map((d) => (d.stopLoss.type === 'pct' ? d.stopLoss.pct : NaN)))).toEqual(new Set([1.5, 2, 2.5]));
  });
});

describe('pickProposal (stabilster IS-Sieger über alle Fenster)', () => {
  it('häufigster Sieger gewinnt', () => {
    const r = pickProposal([{ a: 1 }, { a: 2 }, { a: 2 }, { a: 1 }, { a: 2 }]);
    expect(r).toEqual({ params: { a: 2 }, wins: 3, total: 5 });
  });
  it('Gleichstand → der jüngere Sieger (aktuelleres Marktregime)', () => {
    const r = pickProposal([{ a: 1 }, { a: 2 }, { a: 1 }, { a: 2 }]);
    expect(r?.params).toEqual({ a: 2 });
  });
  it('keine Fenster → null (nichts erfinden)', () => {
    expect(pickProposal([])).toBeNull();
  });
});

describe('judgeOptimization (klar besser? sonst KEIN Vorschlag)', () => {
  const base = metrics({ expectancy: 0.1, profitFactor: 1.2, tradeCount: 40 });
  const good = metrics({ expectancy: 0.3, profitFactor: 1.6, tradeCount: 40 });
  const ok = { baseline: base, candidate: good, holdout, differsFromCurrent: true, wins: 3, windows: 4 };

  it('klar besser (Erwartung + PF mit Marge, genug Trades, Holdout besteht) → Vorschlag', () => {
    const v = judgeOptimization(ok);
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
  });
  it('identisch mit aktueller Version → kein Vorschlag', () => {
    expect(judgeOptimization({ ...ok, differsFromCurrent: false }).passed).toBe(false);
  });
  it('Erwartung nur minimal besser (< Marge) → kein Vorschlag', () => {
    const v = judgeOptimization({ ...ok, candidate: { ...good, expectancy: base.expectancy! + OPTIMIZATION_THRESHOLDS.minExpectancyGainR / 2 } });
    expect(v.passed).toBe(false);
    expect(v.checks.find((c) => c.name === 'expectancyGain')?.passed).toBe(false);
  });
  it('PF nicht um die Marge besser → kein Vorschlag', () => {
    const v = judgeOptimization({ ...ok, candidate: { ...good, profitFactor: 1.25 } });
    expect(v.checks.find((c) => c.name === 'profitFactorGain')?.passed).toBe(false);
    expect(v.passed).toBe(false);
  });
  it('zu wenige OOS-Trades → kein Vorschlag', () => {
    const v = judgeOptimization({ ...ok, candidate: { ...good, tradeCount: 12 } });
    expect(v.checks.find((c) => c.name === 'oosTrades')?.passed).toBe(false);
    expect(v.passed).toBe(false);
  });
  it('jüngster OOS-Abschnitt besteht nicht (Validitäts-Gate inkl. Holdout) → kein Vorschlag', () => {
    const v = judgeOptimization({ ...ok, holdout: { ...holdout, expectancy: -0.2, profitFactor: 0.7 } });
    expect(v.checks.find((c) => c.name === 'validity')?.passed).toBe(false);
    expect(v.passed).toBe(false);
  });
  it('instabil (gewinnt nur 1 von 4 Fenstern) → kein Vorschlag', () => {
    const v = judgeOptimization({ ...ok, wins: 1, windows: 4 });
    expect(v.checks.find((c) => c.name === 'stability')?.passed).toBe(false);
  });
  it('Baseline ohne Trades: Kandidat muss allein alle Gates bestehen', () => {
    const empty = metrics({ tradeCount: 0, expectancy: null, profitFactor: null, winRate: null });
    expect(judgeOptimization({ ...ok, baseline: empty }).passed).toBe(true);
  });
});

// ── Synthetischer, deterministischer Markt (wie walkforward.test): stetig steigend ──
function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 100,
  }));
}
type P = { direction: 'long' | 'short' };
function makeEvaluator(params: P) {
  return (cs: Candle[], i: number): SetupCandidate[] => {
    if (i % 10 !== 5 || i + 1 >= cs.length) return [];
    const c = cs[i]!;
    const sign = params.direction === 'long' ? 1 : -1;
    return [
      {
        direction: params.direction,
        setupType: 'swing',
        entry: c.close,
        stopLoss: c.close - sign * 5,
        takeProfits: [c.close + sign * 5, c.close + sign * 10, c.close + sign * 15],
        score: 8,
        riskClass: 'low',
        confluence: [],
        session: 'london',
        brokenLevel: 0,
        structureKind: 'BOS',
        emaRegime: 'above',
        marketPhase: 'bull',
      },
    ];
  };
}
const base = { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] };

describe('runOptimizationStudy (Grid-Walk-Forward vs. aktuelle Version, gleiche OOS-Fenster)', () => {
  it('aktuelle Version verliert, Kandidat gewinnt klar → Vorschlag mit Vorher/Nachher', () => {
    const study = runOptimizationStudy([{ key: 'TEST 1h', candles: candles(1200), base }], {
      current: { direction: 'short' } as P,
      grid: [{ direction: 'short' }, { direction: 'long' }] as P[],
      makeEvaluator,
      isBars: 200,
      oosBars: 200,
      warmupBars: 50,
    });
    expect(study.windows).toBeGreaterThanOrEqual(4);
    expect(study.proposal?.params).toEqual({ direction: 'long' });
    expect(study.baseline.netPnl).toBeLessThan(0);
    expect(study.candidate.netPnl).toBeGreaterThan(0);
    expect(study.candidate.tradeCount).toBeGreaterThanOrEqual(OPTIMIZATION_THRESHOLDS.minOosTrades);
    expect(study.verdict.passed).toBe(true);
    // Gleiches OOS-Raster für Baseline und Kandidat
    expect(study.markets[0]!.windows).toBe(study.windows);
    expect(study.oosFrom).not.toBeNull();
    expect(study.oosTo!.getTime()).toBeGreaterThan(study.oosFrom!.getTime());
  });

  it('aktuelle Version ist bereits die beste → kein Vorschlag (nichts ändert sich automatisch)', () => {
    const study = runOptimizationStudy([{ key: 'TEST 1h', candles: candles(1200), base }], {
      current: { direction: 'long' } as P,
      grid: [{ direction: 'short' }, { direction: 'long' }] as P[],
      makeEvaluator,
      isBars: 200,
      oosBars: 200,
      warmupBars: 50,
    });
    expect(study.proposal?.params).toEqual({ direction: 'long' });
    expect(study.verdict.passed).toBe(false);
    expect(study.verdict.checks.find((c) => c.name === 'differs')?.passed).toBe(false);
  });

  it('mehrere Märkte werden gepoolt; aktuelle Version fehlt im Grid → wird ergänzt', () => {
    const study = runOptimizationStudy(
      [
        { key: 'A', candles: candles(700), base },
        { key: 'B', candles: candles(700), base },
      ],
      { current: { direction: 'short' } as P, grid: [{ direction: 'long' }] as P[], makeEvaluator, isBars: 200, oosBars: 200, warmupBars: 50 },
    );
    expect(study.markets).toHaveLength(2);
    expect(study.candidate.tradeCount).toBe(study.markets[0]!.candidateOos.tradeCount + study.markets[1]!.candidateOos.tradeCount);
    expect(study.gridSize).toBe(2);
  });

  it('zu wenig Kerzen → keine Fenster, ehrlich kein Vorschlag', () => {
    const study = runOptimizationStudy([{ key: 'X', candles: candles(150), base }], {
      current: { direction: 'short' } as P,
      grid: [{ direction: 'long' }] as P[],
      makeEvaluator,
      isBars: 200,
      oosBars: 200,
    });
    expect(study.windows).toBe(0);
    expect(study.proposal).toBeNull();
    expect(study.verdict.passed).toBe(false);
  });

  it('Grid über MAX_GRID wird abgelehnt (Laufzeit begrenzt)', () => {
    const big = Array.from({ length: MAX_GRID + 1 }, (_, k) => ({ direction: k % 2 ? 'long' : 'short', k })) as unknown as P[];
    expect(() =>
      runOptimizationStudy([{ key: 'X', candles: candles(400), base }], {
        current: { direction: 'short' } as P,
        grid: big,
        makeEvaluator,
        isBars: 200,
        oosBars: 100,
      }),
    ).toThrow(/Grid/);
  });
});

describe('diffParams (was ändert der Vorschlag? — für Briefing/UI)', () => {
  it('listet nur geänderte Pfade, verschachtelt und in Arrays', () => {
    const a = { stopLoss: { type: 'ATR', mult: 2 }, takeProfits: [{ rr: 1 }, { rr: 2 }], symbol: 'BTC/USDT' };
    const b = { stopLoss: { type: 'ATR', mult: 2.5 }, takeProfits: [{ rr: 1 }, { rr: 2.5 }], symbol: 'BTC/USDT', trailingStop: { pct: 1 } };
    expect(diffParams(a, b)).toEqual([
      { path: 'stopLoss.mult', from: 2, to: 2.5 },
      { path: 'takeProfits.1.rr', from: 2, to: 2.5 },
      { path: 'trailingStop.pct', from: null, to: 1 },
    ]);
  });
  it('entfernter Trailing-Stop erscheint als „→ null"', () => {
    expect(diffParams({ trailingStop: { pct: 2 } }, {})).toEqual([{ path: 'trailingStop.pct', from: 2, to: null }]);
  });
  it('identisch → leer', () => {
    expect(diffParams(SMC_CORE_DEFAULTS, { ...SMC_CORE_DEFAULTS })).toEqual([]);
  });
});
