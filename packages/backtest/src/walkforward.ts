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
 */

export type WalkForwardConfig<P> = {
  paramGrid: P[];
  makeEvaluator: (params: P) => Evaluator;
  /** Länge des In-Sample-Fensters in Bars. */
  isBars: number;
  /** Länge des Out-of-Sample-Fensters in Bars. */
  oosBars: number;
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

export function runWalkForward<P>(candles: Candle[], config: WalkForwardConfig<P>): WalkForwardResult<P> {
  const { isBars, oosBars, paramGrid, makeEvaluator, base } = config;
  if (paramGrid.length === 0) throw new Error('Walk-Forward: leeres Parameter-Grid.');

  const windows: WalkForwardWindow<P>[] = [];
  const oosTrades: BacktestTrade[] = [];
  const oosEquitySteps: number[] = [base.initialEquity];

  for (let start = 0; start + isBars + oosBars <= candles.length; start += oosBars) {
    const isSlice = candles.slice(start, start + isBars);
    const oosSlice = candles.slice(start + isBars, start + isBars + oosBars);

    // In-Sample: bestes Grid-Element nach Netto-PnL (Tiebreak: Expectancy)
    let best: { params: P; metrics: Metrics } | null = null;
    for (const params of paramGrid) {
      const res = runBacktest(isSlice, { ...base, evaluate: makeEvaluator(params) });
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
    const oosRes = runBacktest(oosSlice, { ...base, evaluate: makeEvaluator(best!.params) });
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
