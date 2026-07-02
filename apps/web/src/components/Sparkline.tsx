/** Mini-Chart aus ECHTEN Kerzen (Close-Preise): Cyan-Verlauf, weicher Glow, Flächen-Fade. */
export function Sparkline({
  closes,
  id,
  width = 240,
  height = 52,
}: {
  closes: number[];
  id: string;
  width?: number;
  height?: number;
}) {
  if (closes.length < 2) {
    return <p className="label">Noch keine Kerzen in der DB.</p>;
  }
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const step = width / (closes.length - 1);
  const pts = closes.map(
    (c, i) => [i * step, height - 6 - ((c - min) / span) * (height - 12)] as const,
  );
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  const up = closes[closes.length - 1]! >= closes[0]!;
  const stroke = up ? 'var(--color-pos)' : 'var(--color-neg)';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="max-w-full overflow-visible">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <polygon points={area} fill={`url(#${id}-fill)`} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        filter={`url(#${id}-glow)`}
        opacity="0.95"
      />
      <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="2.4" fill={stroke} filter={`url(#${id}-glow)`} />
    </svg>
  );
}
