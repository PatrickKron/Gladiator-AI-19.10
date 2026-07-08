/**
 * Geteilte Equity-Kurven-Bausteine (Inline-SVG, Muster aus dem Labor) —
 * kanonischer Ort für NEUE Views (Strategie-Workshop). Labor behält seine
 * lokalen Kopien bewusst unangetastet (additiv, nie destruktiv); Zusammenführung
 * ist als Folge-Aufgabe in WORKOVER.md notiert.
 */

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function MetricCard({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="glass p-4">
      <p className="label">{label}</p>
      <p
        className="num mt-1.5 text-xl font-semibold"
        style={{ color: tone === 'pos' ? 'var(--color-pos)' : tone === 'neg' ? 'var(--color-neg)' : 'var(--color-ink)' }}
      >
        {value}
      </p>
    </div>
  );
}

export const COMPARE_COLORS = ['#4fd1ff', '#3ddc97', '#f5b642', '#8b5cf6', '#e14ecf', '#ff5c6c'];

export type EquityPoint = { ts: string; equity: number };
export type ComparableRun = { key: string; label: string; color: string; equityCurve: EquityPoint[] };

export function EquityChart({ points, emptyText }: { points: EquityPoint[]; emptyText: string }) {
  if (points.length < 2) return <p className="label">{emptyText}</p>;
  const W = 860;
  const H = 220;
  const eq = points.map((p) => p.equity);
  const min = Math.min(...eq);
  const max = Math.max(...eq);
  const span = max - min || 1;
  const pts = eq.map((v, i) => [(i / (eq.length - 1)) * W, H - 8 - ((v - min) / span) * (H - 16)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = eq[eq.length - 1]! >= eq[0]!;
  const color = up ? 'var(--color-pos)' : 'var(--color-neg)';
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full">
        <defs>
          <linearGradient id="sw-eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill="url(#sw-eqfill)" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
        <text x="4" y="14" className="num" fill="var(--color-mut)" fontSize="11">
          {fmt(max, 0)} $
        </text>
        <text x="4" y={H - 4} className="num" fill="var(--color-mut)" fontSize="11">
          {fmt(min, 0)} $
        </text>
      </svg>
      <p className="label mt-1">
        {new Date(points[0]!.ts).toLocaleDateString('de-DE')} – {new Date(points[points.length - 1]!.ts).toLocaleDateString('de-DE')}
      </p>
    </div>
  );
}

/** Overlay mehrerer Equity-Kurven, jede auf %-Return ab Start normiert. */
export function MultiEquityChart({ runs, emptyText }: { runs: ComparableRun[]; emptyText: string }) {
  const withCurve = runs.filter((r) => r.equityCurve.length >= 2);
  if (withCurve.length === 0) return <p className="label">{emptyText}</p>;
  const W = 860;
  const H = 240;
  const series = withCurve.map((r) => {
    const start = r.equityCurve[0]!.equity || 1;
    return { ...r, pct: r.equityCurve.map((p) => (p.equity / start - 1) * 100) };
  });
  const allPct = series.flatMap((s) => s.pct);
  const min = Math.min(0, ...allPct);
  const max = Math.max(0, ...allPct);
  const span = max - min || 1;
  const y = (v: number) => H - 8 - ((v - min) / span) * (H - 16);
  const x = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full">
        <line x1="0" y1={y(0)} x2={W} y2={y(0)} stroke="rgba(139,148,184,0.3)" strokeWidth="1" strokeDasharray="4 4" />
        {series.map((s) => (
          <polyline
            key={s.key}
            points={s.pct.map((v, i) => `${x(i, s.pct.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        ))}
        <text x="4" y="14" className="num" fill="var(--color-mut)" fontSize="11">
          {fmt(max, 1)} %
        </text>
        <text x="4" y={H - 4} className="num" fill="var(--color-mut)" fontSize="11">
          {fmt(min, 1)} %
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded" style={{ background: s.color }} />
            <span style={{ color: 'var(--color-mut)' }}>{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
