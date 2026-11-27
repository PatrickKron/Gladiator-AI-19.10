/**
 * Intelligente Hebel- & Kapital-Vorbelegung für Signale (Welle 29):
 * - Hat eine Strategie einen expliziten Hebel (> 1×) hinterlegt, wird dieser als
 *   Strategie-Vorschlag übernommen.
 * - Hat die Strategie keinen festen Hebel (oder 1× = Standard / SMC-Core-Engine),
 *   wird der Vorbelegungs-Hebel deterministisch aus Setup-Typ (scalp/swing/position),
 *   Stop-Loss-Abstand (Liquidations-Sicherheitspuffer: SL liegt immer deutlich vor
 *   einer Isolated-Liquidation) und Signal-Qualität (Score / Risikoklasse) abgeleitet.
 * - Schlusskurs-Quellen (Yahoo / Twelve Data Spot-Aktien/ETFs) bleiben ehrlich bei 1×.
 */

export const EXCHANGE_MAX_LEVERAGE = 125;

export const EXCHANGE_LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 125] as const;

export type SignalLeverageInput = {
  entry: number;
  stopLoss: number;
  setupType?: 'scalp' | 'swing' | 'position' | string;
  score?: number;
  riskClass?: 'low' | 'medium' | 'high' | string;
  venue?: string;
  /** Expliziter Hebel aus der Strategie (DSL risk.maxLeveragePerTrade); wenn > 1, hat er Vorrang. */
  strategyLeverage?: number | null;
  /** Optionales Obergrenzen-Cap (Standard 125×). */
  maxAllowedLeverage?: number;
};

export function suggestSignalLeverage(input: SignalLeverageInput): number {
  const cap = Math.max(1, Math.min(EXCHANGE_MAX_LEVERAGE, Math.floor(input.maxAllowedLeverage ?? EXCHANGE_MAX_LEVERAGE)));
  const venue = (input.venue ?? 'binance').toLowerCase();
  if (venue === 'yahoo' || venue === 'twelvedata' || venue.startsWith('paper-close:')) {
    return 1;
  }

  if (
    typeof input.strategyLeverage === 'number' &&
    Number.isFinite(input.strategyLeverage) &&
    input.strategyLeverage > 1
  ) {
    return Math.max(1, Math.min(cap, Math.round(input.strategyLeverage)));
  }

  const entry = Number(input.entry);
  const stopLoss = Number(input.stopLoss);
  const stopPct =
    Number.isFinite(entry) && entry > 0 && Number.isFinite(stopLoss) && stopLoss > 0
      ? (Math.abs(entry - stopLoss) / entry) * 100
      : 2;

  // Sicherheitspuffer gegen vorzeitige Isolated-Liquidation:
  // Bei stopPct = 1 % erlaubt 45 / 1 = 45×; bei stopPct = 5 % maximal 9×.
  const safeMaxFromStop = stopPct > 0.05 ? Math.max(1, Math.floor(45 / stopPct)) : 20;

  const score = typeof input.score === 'number' && Number.isFinite(input.score) ? input.score : 7;
  const highConviction = score >= 8 || input.riskClass === 'low';
  const cautious = input.riskClass === 'high' || score < 6.5;

  let baseTarget: number;
  switch (input.setupType) {
    case 'scalp':
      baseTarget = highConviction ? 10 : cautious ? 5 : 8;
      break;
    case 'position':
      baseTarget = highConviction ? 4 : cautious ? 2 : 3;
      break;
    case 'swing':
    default:
      baseTarget = highConviction ? 6 : cautious ? 3 : 5;
      break;
  }

  return Math.max(1, Math.min(cap, safeMaxFromStop, baseTarget));
}
