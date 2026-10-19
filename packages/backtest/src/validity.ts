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
  /**
   * Jüngster Abschnitt des Backtests allein bewertet (Robustheit, 08 §4).
   * undefined = Aufrufer prüft das nicht (reine Kennzahl-Prüfung);
   * null = Backtest hat (noch) keine Holdout-Auswertung → nicht freigegeben.
   */
  holdout?: HoldoutMetrics | null;
};

export type HoldoutMetrics = {
  /** Beginn des jüngsten Abschnitts (Default: letzte 30 % des Zeitraums). */
  fromTs: Date;
  tradeCount: number;
  /** Mittleres R (null = keine Trades). */
  expectancy: number | null;
  /** null = keine Verlusttrades. */
  profitFactor: number | null;
};

/** Anteil des Backtest-Zeitraums, der als jüngster Abschnitt allein bestehen muss. */
export const HOLDOUT_FRACTION = 0.3;

/**
 * Kennzahlen NUR der Trades, die im jüngsten Abschnitt [to − 30 %, to] eröffnet
 * wurden. Fängt Strategien ab, deren Gesamtergebnis allein aus einer früheren
 * Marktphase stammt. Ehrlich benannt: das ist ein Robustheits-Check im selben
 * Datensatz — echtes Out-of-Sample liefert der Walk-Forward im Labor.
 */
export function holdoutMetrics(
  trades: { entryTs: Date; netPnl: number; rMultiple: number }[],
  from: Date,
  to: Date,
  fraction = HOLDOUT_FRACTION,
): HoldoutMetrics {
  const fromTs = new Date(to.getTime() - (to.getTime() - from.getTime()) * fraction);
  const recent = trades.filter((t) => t.entryTs >= fromTs);
  const grossWin = recent.filter((t) => t.netPnl > 0).reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(recent.filter((t) => t.netPnl < 0).reduce((a, t) => a + t.netPnl, 0));
  return {
    fromTs,
    tradeCount: recent.length,
    expectancy: recent.length > 0 ? recent.reduce((a, t) => a + t.rMultiple, 0) / recent.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

export type ValidityThresholds = {
  /** Statistisches Minimum an Trades für Aussagekraft. */
  minTrades: number;
  /** Muss netto profitabel sein (mit Marge). */
  minProfitFactor: number;
  /** Maximal erlaubter Drawdown in Prozent. */
  maxDrawdownPct: number;
  /** Mindest-Erwartung in R (>= 0 = im Mittel nicht verlustig). */
  minExpectancyR: number;
  /** Mindest-Trades im jüngsten Abschnitt. */
  minHoldoutTrades: number;
  /** Mindest-Profit-Factor im jüngsten Abschnitt. */
  minHoldoutProfitFactor: number;
};

export const DEFAULT_VALIDITY_THRESHOLDS: ValidityThresholds = {
  minTrades: 30,
  minProfitFactor: 1.05,
  maxDrawdownPct: 40,
  minExpectancyR: 0,
  minHoldoutTrades: 10,
  minHoldoutProfitFactor: 1,
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

  // 5) Robustheit: jüngster Abschnitt muss allein bestehen (nur wenn der Aufrufer ihn liefert).
  if (m.holdout !== undefined) {
    const h = m.holdout;
    if (h === null) {
      checks.push({
        name: 'holdout',
        passed: false,
        detail: 'Backtest ohne Auswertung des jüngsten Abschnitts — bitte neu laufen lassen (Robustheits-Check seit Session 10 Pflicht).',
      });
    } else {
      const enough = h.tradeCount >= thresholds.minHoldoutTrades;
      const expOkH = h.expectancy !== null && h.expectancy >= thresholds.minExpectancyR;
      const pfOkH = h.profitFactor === null ? h.tradeCount > 0 : h.profitFactor >= thresholds.minHoldoutProfitFactor;
      const passed = enough && expOkH && pfOkH;
      const pfText = h.profitFactor === null ? '∞' : h.profitFactor.toFixed(2);
      checks.push({
        name: 'holdout',
        passed,
        detail: passed
          ? `Jüngster Abschnitt besteht allein: ${h.tradeCount} Trades, Erwartung ${h.expectancy!.toFixed(2)} R, PF ${pfText}`
          : !enough
            ? `Im jüngsten Abschnitt (letzte ${Math.round(HOLDOUT_FRACTION * 100)} %) nur ${h.tradeCount} Trades — mindestens ${thresholds.minHoldoutTrades} nötig`
            : `Im jüngsten Abschnitt nicht profitabel (Erwartung ${h.expectancy?.toFixed(2) ?? '—'} R, PF ${pfText}) — das Ergebnis stammt aus einer früheren Marktphase`,
      });
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    checks,
    reasons: failed.map((c) => c.detail),
  };
}

/** Holdout aus dem gespeicherten metrics-JSON lesen (DB liefert fromTs als String); fehlt → null. */
export function readHoldout(metricsJson: unknown): HoldoutMetrics | null {
  const h = (metricsJson as { holdout?: Record<string, unknown> } | null)?.holdout;
  if (!h || typeof h.tradeCount !== 'number') return null;
  return {
    fromTs: new Date(String(h.fromTs)),
    tradeCount: h.tradeCount,
    expectancy: typeof h.expectancy === 'number' ? h.expectancy : null,
    profitFactor: typeof h.profitFactor === 'number' ? h.profitFactor : null,
  };
}
