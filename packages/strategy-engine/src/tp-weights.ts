/**
 * Teil-Exit-Gewichte auf die Take-Profits — EINE Funktion für Backtest-Engine
 * und Live-Executor (Regel 6: eine Wahrheit). Ohne Strategie-Vorgabe gilt
 * Ausführungs-Schema A (decker S010): TP1 50 %, TP2 30 %, TP3 20 %.
 */
export const DEFAULT_TP_WEIGHTS: readonly number[] = [0.5, 0.3, 0.2];

/** Der Live-Executor platziert höchstens so viele TP-Orders (DSL-Gewichte sind darauf begrenzt). */
export const MAX_LIVE_TAKE_PROFITS = 3;

/**
 * Gewichte auf die tatsächlich vorhandenen TPs verteilen:
 * - weniger TPs als Gewichte → Restgewicht auf den letzten TP (Summe bleibt 1),
 * - mehr TPs als Gewichte → überzählige TPs bekommen 0.
 */
export function tpFractions(weights: readonly number[], tpCount: number): number[] {
  if (tpCount <= 0) return [];
  if (tpCount >= weights.length) {
    return [...weights, ...Array<number>(tpCount - weights.length).fill(0)];
  }
  const out = weights.slice(0, tpCount);
  const rest = weights.slice(tpCount).reduce((a, b) => a + b, 0);
  out[out.length - 1]! += rest;
  return out;
}
