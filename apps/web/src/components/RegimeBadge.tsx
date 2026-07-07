import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

type RegimeData = {
  regime: string;
  confidence: number;
  components: { name: string; value: number }[];
};

const REGIME_COLORS: Record<string, string> = {
  bull: 'var(--color-pos)',
  bear: 'var(--color-neg)',
  sideways: 'var(--color-warn)',
  high_vol: 'var(--color-violet)',
  crisis: 'var(--color-neg)',
};

const REGIME_ICONS: Record<string, string> = {
  bull: '▲',
  bear: '▼',
  sideways: '◆',
  high_vol: '⚡',
  crisis: '⚠',
};

export function RegimeBadge({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<RegimeData | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    trpc.ml.regime
      .query({ symbol, timeframe })
      .then((r) => {
        if (!cancelled) setData(r.regime as RegimeData | null);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => { cancelled = true; };
  }, [symbol, timeframe]);

  if (data === undefined || data === null) return null;

  const color = REGIME_COLORS[data.regime] ?? 'var(--color-mut)';
  const icon = REGIME_ICONS[data.regime] ?? '?';

  return (
    <span
      className="num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] tracking-wider"
      style={{ borderColor: color, color }}
      title={`${t('regime.regime')}: ${t(`regime.${data.regime}` as const)} (${(data.confidence * 100).toFixed(0)}% ${t('regime.confidence')})`}
    >
      <span>{icon}</span>
      <span>{t(`regime.${data.regime}` as const)}</span>
    </span>
  );
}
