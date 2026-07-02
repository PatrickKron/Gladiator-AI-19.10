/** Mini-Chart aus ECHTEN Kerzen (Close-Preise). Keine Daten → ehrlicher Hinweis. */
export function Sparkline({ closes, width = 220, height = 48 }: { closes: number[]; width?: number; height?: number }) {
  if (closes.length < 2) {
    return <p className="text-xs text-mut">Noch keine Kerzen in der DB.</p>;
  }
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const step = width / (closes.length - 1);
  const points = closes.map((c, i) => `${(i * step).toFixed(1)},${(height - ((c - min) / span) * height).toFixed(1)}`);
  const up = closes[closes.length - 1]! >= closes[0]!;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="max-w-full overflow-visible">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={up ? 'var(--color-pos)' : 'var(--color-neg)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
