/**
 * Reine Fill-Planung für den PositionMonitor (06_ §5):
 * prüft Schutz-Orders (Stop/TP) gegen den aktuellen ECHTEN Preis.
 * Konservativ: Ist der Stop erreicht, zählt NUR der Stop (worst case) —
 * gleiche Konvention wie die Backtest-Engine („eine Wahrheit").
 */

export type OpenProtectionOrder = {
  id: string;
  type: 'stop_market' | 'take_profit_market';
  triggerPrice: number;
  /** Anteil der Ursprungsposition, den diese Order schließt. */
  qtyFraction: number;
};

export type PlannedFill = {
  id: string;
  type: OpenProtectionOrder['type'];
  triggerPrice: number;
  qtyFraction: number;
  /** true, wenn nach diesem Fill nichts mehr offen ist. */
  closesPosition: boolean;
};

export function planFills(
  direction: 'long' | 'short',
  openOrders: OpenProtectionOrder[],
  price: number,
): PlannedFill[] {
  const sign = direction === 'long' ? 1 : -1;

  const stop = openOrders.find((o) => o.type === 'stop_market');
  if (stop && (price - stop.triggerPrice) * sign <= 0) {
    return [{ ...stop, closesPosition: true }];
  }

  const tps = openOrders
    .filter((o) => o.type === 'take_profit_market')
    .sort((a, b) => (a.triggerPrice - b.triggerPrice) * sign);

  const hit = tps.filter((o) => (price - o.triggerPrice) * sign >= 0);
  const remainingAfter = tps.length - hit.length;
  return hit.map((o, idx) => ({
    ...o,
    closesPosition: remainingAfter === 0 && idx === hit.length - 1,
  }));
}
