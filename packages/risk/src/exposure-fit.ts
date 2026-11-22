/**
 * Erklärung fürs Order-Ticket (OFFENER_PLAN §2): Risiko-basiertes Sizing und
 * das Exposure-Limit je Asset widersprechen sich bei engen Stops. Die Größe
 * aus Risiko% ergibt Notional = Konto · Risiko% / Stop%; übersteigt das das
 * Limit, blockt das Gate. Diese Funktion rechnet das offen vor — sie ändert
 * kein Limit und keine Order, sie liefert nur Zahlen für den Hinweis.
 */
export type ExposureFitInput = {
  equity: number;
  riskPct: number;
  entry: number;
  stopLoss: number;
  maxExposurePct: number;
  existingExposurePct: number;
};

export type ExposureFit = {
  stopPct: number;
  /** Exposure (bestehend + neu) bei vollem Risiko%. */
  impliedExposurePct: number;
  fits: boolean;
  /** Größter Betrag, der das Limit noch einhält (USD, ≥ 0). */
  maxNotional: number;
  /** Tatsächliches Risiko in % des Kontos bei maxNotional. */
  riskPctAtMax: number;
  /** Ab diesem Stop-Abstand passt das volle Risiko% ins Limit; null wenn das Limit schon ausgeschöpft ist. */
  minStopPctForFullRisk: number | null;
};

export function exposureFit(i: ExposureFitInput): ExposureFit {
  const stopPct = i.entry > 0 ? (Math.abs(i.entry - i.stopLoss) / i.entry) * 100 : 0;
  const room = Math.max(0, i.maxExposurePct - i.existingExposurePct);
  if (!(i.equity > 0) || !(stopPct > 0)) {
    return { stopPct, impliedExposurePct: 0, fits: false, maxNotional: 0, riskPctAtMax: 0, minStopPctForFullRisk: null };
  }
  const newPct = (i.riskPct / stopPct) * 100;
  const impliedExposurePct = i.existingExposurePct + newPct;
  const maxNotional = (i.equity * room) / 100;
  return {
    stopPct,
    impliedExposurePct,
    fits: impliedExposurePct <= i.maxExposurePct + 1e-9,
    maxNotional,
    riskPctAtMax: (room * stopPct) / 100,
    minStopPctForFullRisk: room > 0 ? (i.riskPct / room) * 100 : null,
  };
}

export type SafeCappedInput = ExposureFitInput & {
  availableMargin: number;
  leverage: number;
  minNotional: number;
};

export type SafeCappedResult = {
  /** true = Risiko%-Sizing war größer als Exposure-/Margin-Budget und wurde konservativ gedeckelt. */
  capped: boolean;
  /** Sicherer Positionswert (USD) innerhalb von Exposure-Limit UND Margin; null wenn Budget < minNotional. */
  notional: number | null;
  /** Tatsächliches Risiko in % der Equity beim gedeckelten Betrag (immer ≤ riskPct). */
  effectiveRiskPct: number;
};

/**
 * Konservative automatische Deckelung fürs Standard-Sizing bei engen Stops:
 * Risiko% ÷ Stop% liefert bei 0,5–2 % Stop oft > 50 % Exposure und wurde bisher
 * pauschal abgelehnt. Diese Funktion deckelt den Vorschlag auf das kleinere aus
 * Exposure-Spielraum und verfügbarer Margin × Hebel — das Risiko wird dadurch
 * KLEINER (nie größer), alle harten Risk-Gates bleiben unverändert aktiv.
 */
export function safeCappedNotional(i: SafeCappedInput): SafeCappedResult {
  const fit = exposureFit(i);
  if (!(i.equity > 0) || !(fit.stopPct > 0) || !(i.leverage > 0) || !(i.availableMargin > 0)) {
    return { capped: false, notional: null, effectiveRiskPct: 0 };
  }
  const riskNotional = (i.equity * (i.riskPct / 100)) / (fit.stopPct / 100);
  const marginBudget = i.availableMargin * i.leverage;
  const budgetCap = Math.min(fit.maxNotional, marginBudget);

  if (riskNotional <= budgetCap + 1e-9) {
    return {
      capped: false,
      notional: riskNotional >= i.minNotional ? riskNotional : null,
      effectiveRiskPct: i.riskPct,
    };
  }
  // 0,1 % Rundungspuffer, damit Lot-Abrundung / Gleitkomma nie minimal über dem Limit landet.
  const safeMax = Math.floor(budgetCap * 0.999 * 100) / 100;
  if (safeMax < i.minNotional) {
    return { capped: false, notional: null, effectiveRiskPct: 0 };
  }
  const effectiveRiskPct = Math.round(((safeMax * (fit.stopPct / 100)) / i.equity) * 10_000) / 100;
  return { capped: true, notional: safeMax, effectiveRiskPct };
}
