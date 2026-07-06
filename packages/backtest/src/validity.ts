/**
 * Backtest-Validitäts-Gate (Patrick Vision 5): „selbstständig laufende
 * Strategien NUR, wenn per Backtest als valide bewiesen." Diese reine Funktion
 * entscheidet, ob ein Netto-Backtest die Mindestbedingungen erfüllt, damit eine
 * Strategie-Version in den Paper-Auto-Loop promotet werden darf.
 *
 * Bewusst konservativ + ehrlich: Werte sind NETTO (Gebühren/Slippage/Funding);
 * ProfitFactor null bedeutet „keine Verlusttrades" (gut, nicht schlecht).
 */

export type BacktestMetricsInput = {
  tradeCount: number;
  /** Bruch 0..1 (null = keine Trades). */
  winRate: number | null;
  /** grossWin/grossLoss; null = keine Verlusttrades. */
  profitFactor: number | null;
  /** Erwartungswert in R (null = keine Trades). */
  expectancy: number | null;
  /** Maximaler Drawdown in PROZENT (0..100). */
  maxDrawdownPct: number;
  sharpe: number | null;
  netReturnPct: number | null;
};

export type ValidityThresholds = {
  /** Statistisches Minimum an Trades für Aussagekraft. */
  minTrades: number;
  /** Muss netto profitabel sein (mit Marge). */
  minProfitFactor: number;
  /** Maximal erlaubter Drawdown in Prozent. */
  maxDrawdownPct: number;
  /** Mindest-Erwartung in R (>= 0 = im Mittel nicht verlustig). */
  minExpectancyR: number;
};

export const DEFAULT_VALIDITY_THRESHOLDS: ValidityThresholds = {
  minTrades: 30,
  minProfitFactor: 1.05,
  maxDrawdownPct: 40,
  minExpectancyR: 0,
};

export type ValidityCheck = { name: string; passed: boolean; detail: string };
export type ValidityVerdict = { passed: boolean; checks: ValidityCheck[]; reasons: string[] };

const pct = (n: number) => `${n.toFixed(1)} %`;

export function evaluateBacktestValidity(
  m: BacktestMetricsInput,
  thresholds: ValidityThresholds = DEFAULT_VALIDITY_THRESHOLDS,
): ValidityVerdict {
  const checks: ValidityCheck[] = [];

  // 1) Genug Trades
  const tradesOk = m.tradeCount >= thresholds.minTrades;
  checks.push({
    name: 'trades',
    passed: tradesOk,
    detail: tradesOk
      ? `${m.tradeCount} Trades (≥ ${thresholds.minTrades})`
      : `nur ${m.tradeCount} Trades — mindestens ${thresholds.minTrades} nötig für Aussagekraft`,
  });

  // 2) Netto profitabel (ProfitFactor). null = keine Verlusttrades → besteht.
  const pfOk = m.profitFactor === null ? true : m.profitFactor >= thresholds.minProfitFactor;
  checks.push({
    name: 'profitFactor',
    passed: pfOk,
    detail:
      m.profitFactor === null
        ? 'keine Verlusttrades (Profit-Factor ∞)'
        : pfOk
          ? `Profit-Factor ${m.profitFactor.toFixed(2)} (≥ ${thresholds.minProfitFactor})`
          : `Profit-Factor ${m.profitFactor.toFixed(2)} — nicht netto profitabel genug (≥ ${thresholds.minProfitFactor} nötig)`,
  });

  // 3) Drawdown im Rahmen
  const ddOk = m.maxDrawdownPct <= thresholds.maxDrawdownPct;
  checks.push({
    name: 'maxDrawdown',
    passed: ddOk,
    detail: ddOk
      ? `Max-Drawdown ${pct(m.maxDrawdownPct)} (≤ ${thresholds.maxDrawdownPct} %)`
      : `Max-Drawdown ${pct(m.maxDrawdownPct)} — über dem Limit von ${thresholds.maxDrawdownPct} %`,
  });

  // 4) Erwartung nicht negativ. null (keine Trades) → durchfallen (nicht raten).
  const expOk = m.expectancy !== null && m.expectancy >= thresholds.minExpectancyR;
  checks.push({
    name: 'expectancy',
    passed: expOk,
    detail:
      m.expectancy === null
        ? 'keine Trades — Erwartung nicht bestimmbar'
        : expOk
          ? `Erwartung ${m.expectancy.toFixed(2)} R (≥ ${thresholds.minExpectancyR})`
          : `Erwartung ${m.expectancy.toFixed(2)} R — negativ/zu niedrig (≥ ${thresholds.minExpectancyR} nötig)`,
  });

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    checks,
    reasons: failed.map((c) => c.detail),
  };
}
