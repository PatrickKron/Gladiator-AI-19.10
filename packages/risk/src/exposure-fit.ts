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
