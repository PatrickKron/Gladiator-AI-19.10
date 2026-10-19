import type { Candle } from '@gladiator/strategy-engine';
import { runBacktest, type BacktestConfig, type BacktestTrade, type Evaluator } from './engine.js';
import { computeMetrics, type Metrics } from './metrics.js';

/**
 * Walk-Forward (08_ §4): rollierende In-Sample-Optimierung (Parameter-Grid),
 * Validierung ausschließlich auf dem darauffolgenden, UNGESEHENEN
 * Out-of-Sample-Fenster. Der Evaluator eines Fensters sieht nur die Kerzen
 * seines Fensters — kein Datenleck zwischen IS und OOS.
 *
 * Auswahlkriterium in-sample: Netto-PnL (bei Gleichstand: höherer Expectancy).
 *
 * Optionaler Warmup: Indikatoren wie EMA200 brauchen Historie. Mit `warmupBars`
 * bekommt jedes Fenster die unmittelbar VORANGEHENDEN Kerzen als reine
 * Indikator-Historie mit — gehandelt wird erst ab dem Fensterstart. Das ist
 * Vergangenheit, kein Look-ahead; ohne Warmup wären die ersten ~200 Bars jedes
 * OOS-Fensters „tot" (Evaluator liefert mangels EMA nichts).
 */

export type WalkForwardConfig<P> = {
  paramGrid: P[];
  makeEvaluator: (params: P) => Evaluator;
  /** Länge des In-Sample-Fensters in Bars. */
  isBars: number;
  /** Länge des Out-of-Sample-Fensters in Bars. */
  oosBars: number;
  /** Vorangehende Kerzen als Indikator-Historie je Fenster (Default 0 = keine). */
  warmupBars?: number;
  base: Omit<BacktestConfig, 'evaluate'>;
};

export type WalkForwardWindow<P> = {
  isStart: number;
  isEnd: number;
  oosStart: number;
  oosEnd: number;
  bestParams: P;
  isMetrics: Metrics;
  oosMetrics: Metrics;
};

export type WalkForwardResult<P> = {
  windows: WalkForwardWindow<P>[];
  /** Alle OOS-Trades zusammengeführt und gemeinsam bewertet (netto). */
  combinedOos: Metrics;
  oosTrades: BacktestTrade[];
};

/** Evaluator, der erst ab Slice-Index `from` handelt (davor nur Historie). */
function tradingFrom(evaluate: Evaluator, from: number): Evaluator {
  return from <= 0 ? evaluate : (cs, i) => (i < from ? [] : evaluate(cs, i));
}

export function runWalkForward<P>(candles: Candle[], config: WalkForwardConfig<P>): WalkForwardResult<P> {
  const { isBars, oosBars, paramGrid, makeEvaluator, base } = config;
  const warmup = Math.max(0, Math.floor(config.warmupBars ?? 0));
  if (paramGrid.length === 0) throw new Error('Walk-Forward: leeres Parameter-Grid.');

  /** Fenster [start, end) plus bis zu `warmup` vorangehende Kerzen als Historie. */
  const run = (start: number, end: number, evaluate: Evaluator) => {
    const from = Math.max(0, start - warmup);
    return runBacktest(candles.slice(from, end), { ...base, evaluate: tradingFrom(evaluate, start - from) });
  };

  const windows: WalkForwardWindow<P>[] = [];
  const oosTrades: BacktestTrade[] = [];
  const oosEquitySteps: number[] = [base.initialEquity];

  for (let start = 0; start + isBars + oosBars <= candles.length; start += oosBars) {
    // In-Sample: bestes Grid-Element nach Netto-PnL (Tiebreak: Expectancy)
    let best: { params: P; metrics: Metrics } | null = null;
    for (const params of paramGrid) {
      const res = run(start, start + isBars, makeEvaluator(params));
      if (
        best === null ||
        res.metrics.netPnl > best.metrics.netPnl ||
        (res.metrics.netPnl === best.metrics.netPnl &&
          (res.metrics.expectancy ?? -Infinity) > (best.metrics.expectancy ?? -Infinity))
      ) {
        best = { params, metrics: res.metrics };
      }
    }

    // Out-of-Sample: NUR mit den IS-Siegern, auf ungesehenen Bars
    const oosRes = run(start + isBars, start + isBars + oosBars, makeEvaluator(best!.params));
    oosTrades.push(...oosRes.trades);
    for (const t of oosRes.trades) {
      oosEquitySteps.push(oosEquitySteps[oosEquitySteps.length - 1]! + t.netPnl);
    }

    windows.push({
      isStart: start,
      isEnd: start + isBars,
      oosStart: start + isBars,
      oosEnd: start + isBars + oosBars,
      bestParams: best!.params,
      isMetrics: best!.metrics,
      oosMetrics: oosRes.metrics,
    });
  }

  return {
    windows,
    combinedOos: computeMetrics(oosTrades, oosEquitySteps, { barsPerYear: base.barsPerYear }),
    oosTrades,
  };
}
