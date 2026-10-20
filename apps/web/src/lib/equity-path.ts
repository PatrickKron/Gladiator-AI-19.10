/**
 * Equity-Kurven-Geometrie (Labor, Workshop, Demo, Vermögen): x folgt der ZEIT,
 * nicht der Punkt-Nummer. Die Backtest-Engine schreibt während eines offenen
 * Trades keine Punkte — nach Index verteilt schrumpfte ein langer Trade auf
 * einen Schritt, und Gewinn + direkt folgender Verlust sah aus wie eine Nadel.
 * `step` zeichnet realisiertes Kapital als Treppe (Wert gilt bis zum nächsten
 * Punkt). Rein und unit-getestet.
 */

export type EquityXYOptions = {
  width: number;
  height: number;
  /** Abstand oben/unten in px. */
  pad?: number;
  step?: boolean;
  /** Gemeinsame Bereiche (Overlay mehrerer Kurven); sonst aus den Punkten. */
  tMin?: number;
  tMax?: number;
  min?: number;
  max?: number;
};

export function equityXY(points: { ts: string; equity: number }[], o: EquityXYOptions): [number, number][] {
  const pad = o.pad ?? 8;
  const n = points.length;
  if (n === 0) return [];
  const times = points.map((p) => Date.parse(p.ts));
  const validTimes = times.every((t) => Number.isFinite(t));
  const tMin = o.tMin ?? (validTimes ? Math.min(...times) : 0);
  const tMax = o.tMax ?? (validTimes ? Math.max(...times) : 0);
  const byTime = validTimes && tMax > tMin;
  const x = (i: number) => (byTime ? ((times[i]! - tMin) / (tMax - tMin)) * o.width : n <= 1 ? 0 : (i / (n - 1)) * o.width);

  const values = points.map((p) => p.equity);
  const min = o.min ?? Math.min(...values);
  const max = o.max ?? Math.max(...values);
  const span = max - min;
  const y = (v: number) => (span > 0 ? o.height - pad - ((v - min) / span) * (o.height - 2 * pad) : o.height / 2);

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const xi = x(i);
    const yi = y(values[i]!);
    if (o.step && i > 0) out.push([xi, out[out.length - 1]![1]]);
    out.push([xi, yi]);
  }
  return out;
}

export const toPolyline = (pts: [number, number][]) => pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
