import { equityXY, toPolyline } from '../lib/equity-path.js';

/**
 * Ruhige Vermögenskurve (Design-System v3): Fläche + Linie + Endpunkt, keine
 * Achsenbeschriftung — die Zahl steht darüber. Zeichnet sich beim Öffnen
 * (CSS, respektiert reduced-motion). Daten: echte Momentaufnahmen.
 */
export function WealthCurve({ points, height = 72 }: { points: { ts: string; equity: number }[]; height?: number }) {
  if (points.length < 2) return null;
  const W = 600;
  const pts = equityXY(points, { width: W, height, pad: 4 });
  const line = toPolyline(pts);
  const [lx, ly] = pts[pts.length - 1]!;
  // Farbe sagt die Richtung: grün hoch, rot runter, grau bei unverändert (kein erfundener Gewinn)
  const delta = points[points.length - 1]!.equity - points[0]!.equity;
  const color = delta > 0 ? 'var(--color-pos)' : delta < 0 ? 'var(--color-neg)' : 'var(--color-mut)';
  const id = `wc-${Math.round(points[0]!.equity)}-${points.length}`;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="wealth-curve block w-full" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`${pts[0]![0].toFixed(1)},${height} ${line} ${lx.toFixed(1)},${height}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="3.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
