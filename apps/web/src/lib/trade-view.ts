/**
 * Jesse-artige Trade-Ansicht im visuellen Backtesting: einen Trade im Chart
 * heranzoomen und mit Vor/Zurück (Knöpfe oder ←/→) durch die Trades gehen.
 * Rein und unit-getestet; Zeiten in Sekunden (lightweight-charts UTCTimestamp).
 */

export type SecRange = { from: number; to: number };

/** Sichtfenster für einen Trade: Entry→Exit plus `padBars` Kerzen Rand, begrenzt aufs geladene Fenster. */
export function tradeFocusRange(entrySec: number, exitSec: number, barSec: number, padBars = 15, bounds?: { first: number; last: number }): SecRange {
  const lo = Math.min(entrySec, exitSec);
  const hi = Math.max(entrySec, exitSec);
  let from = lo - padBars * barSec;
  let to = hi + padBars * barSec;
  if (bounds) {
    from = Math.max(from, bounds.first);
    to = Math.min(to, bounds.last);
  }
  return { from, to };
}

/** Nächster/vorheriger Trade; ohne Auswahl startet „vor" beim ersten, „zurück" beim letzten. Kein Umlauf. */
export function stepTrade(current: number | null, delta: 1 | -1, count: number): number | null {
  if (count <= 0) return null;
  if (current === null) return delta === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/** Kerzenabstand = kleinste Differenz benachbarter Kerzen (Datenlücken verfälschen ihn nicht). */
export function barSpacingSec(bars: { time: number }[]): number | null {
  let best: number | null = null;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.time - bars[i - 1]!.time;
    if (d > 0 && (best === null || d < best)) best = d;
  }
  return best;
}
