/**
 * Kennzahlen — IMMER netto (08_ §3a). Nicht definierbare Werte sind null
 * (z. B. ProfitFactor ohne Verlierer) — nie erfundene Zahlen.
 */

export type TradeLike = { netPnl: number; rMultiple: number };

export type Metrics = {
  tradeCount: number;
  netPnl: number;
  winRate: number | null;
  profitFactor: number | null;
  /** Erwartungswert in R (Mittel der R-Multiples, netto). */
  expectancy: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  maxDrawdownPct: number;
  netReturnPct: number;
  sharpe: number | null;
  sortino: number | null;
};

export function maxDrawdownPct(equity: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    else if (peak > 0) maxDd = Math.max(maxDd, ((peak - v) / peak) * 100);
  }
  return maxDd;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeMetrics(
  trades: TradeLike[],
  equityCurve: number[],
  opts: { barsPerYear?: number } = {},
): Metrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);

  const start = equityCurve[0] ?? 0;
  const end = equityCurve[equityCurve.length - 1] ?? start;

  // Bar-Returns der Equity-Kurve für Sharpe/Sortino, annualisiert
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!;
    if (prev > 0) returns.push(equityCurve[i]! / prev - 1);
  }
  const barsPerYear = opts.barsPerYear ?? 365 * 24;
  const annual = Math.sqrt(barsPerYear);

  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (returns.length >= 2) {
    const m = mean(returns);
    const s = std(returns);
    sharpe = s > 0 ? (m / s) * annual : null;
    const downside = returns.filter((r) => r < 0);
    if (downside.length >= 1) {
      const dd = Math.sqrt(downside.reduce((a, r) => a + r ** 2, 0) / downside.length);
      sortino = dd > 0 ? (m / dd) * annual : null;
    }
  }

  return {
    tradeCount: trades.length,
    netPnl,
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: trades.length > 0 ? mean(trades.map((t) => t.rMultiple)) : null,
    avgWinR: wins.length > 0 ? mean(wins.map((t) => t.rMultiple)) : null,
    avgLossR: losses.length > 0 ? mean(losses.map((t) => t.rMultiple)) : null,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    netReturnPct: start > 0 ? ((end - start) / start) * 100 : 0,
    sharpe,
    sortino,
  };
}
