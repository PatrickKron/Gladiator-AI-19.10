/**
 * Trailing-Stop (rein, getestet): Der Stop folgt dem besten Kurs seit
 * Aktivierung im festen %-Abstand — und wird NUR verschärft, nie zurück-
 * gesetzt. Der PositionMonitor ruft das je Tick mit dem ECHTEN Live-Preis auf
 * (Minuten-Granularität wie alle Paper-Schutz-Orders). Die Backtest-Engine
 * nutzt DIESELBE Funktion je abgeschlossener Kerze — eine Wahrheit für
 * Backtest und Live.
 */
export type TrailInput = {
  direction: 'long' | 'short';
  /** Abstand in Prozent (z. B. 2 = 2 %). */
  pct: number;
  /** Bester Kurs seit Aktivierung (Long: Hoch, Short: Tief); null = noch keiner. */
  peak: number | null;
  price: number;
  currentStop: number;
};

/** Neuer Peak und — falls enger als der aktuelle — neuer Stop (sonst null). */
export function trailStep(i: TrailInput): { peak: number | null; stop: number | null } {
  if (!(i.pct > 0 && i.pct < 100) || !Number.isFinite(i.price) || i.price <= 0) return { peak: i.peak, stop: null };
  const long = i.direction === 'long';
  const peak = i.peak === null ? i.price : long ? Math.max(i.peak, i.price) : Math.min(i.peak, i.price);
  const candidate = long ? peak * (1 - i.pct / 100) : peak * (1 + i.pct / 100);
  const tighter = long ? candidate > i.currentStop : candidate < i.currentStop;
  return { peak, stop: tighter ? candidate : null };
}
