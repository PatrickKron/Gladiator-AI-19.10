import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

type LabelStats = {
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  byDirection: {
    long: { total: number; wins: number };
    short: { total: number; wins: number };
  };
};

export function MlInsights({ symbol }: { symbol: string }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<LabelStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.ml.labelStats
      .query({ symbol })
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!stats || stats.total === 0) return null;

  const pos = 'var(--color-pos)';
  const neg = 'var(--color-neg)';
  const wrColor = (stats.winRate ?? 0) >= 0.5 ? pos : neg;

  return (
    <div className="mt-5 rounded border p-4" style={{ borderColor: 'var(--color-line)' }}>
      <h3 className="label mb-3">{t('ml.insightsTitle')}</h3>
      <p className="mb-3 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('ml.insightsHint', { symbol: symbol.split('/')[0] })}
      </p>

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="label">{t('ml.total')}</p>
          <p className="num mt-0.5">{stats.total}</p>
        </div>
        <div>
          <p className="label">{t('ml.winRate')}</p>
          <p className="num mt-0.5" style={{ color: wrColor }}>
            {stats.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : '—'}
          </p>
        </div>
        <div>
          <p className="label">{t('ml.wins')}</p>
          <p className="num mt-0.5" style={{ color: pos }}>{stats.wins}</p>
        </div>
        <div>
          <p className="label">{t('ml.losses')}</p>
          <p className="num mt-0.5" style={{ color: neg }}>{stats.losses}</p>
        </div>
      </div>

      {(stats.byDirection.long.total > 0 || stats.byDirection.short.total > 0) && (
        <div className="mt-3">
          <p className="label mb-1">{t('ml.byDirection')}</p>
          <div className="flex gap-4 text-xs">
            {stats.byDirection.long.total > 0 && (
              <span className="num">
                {t('ml.long')}: {stats.byDirection.long.wins}/{stats.byDirection.long.total}
                <span style={{ color: pos }}> ({stats.byDirection.long.total > 0 ? ((stats.byDirection.long.wins / stats.byDirection.long.total) * 100).toFixed(0) : 0}%)</span>
              </span>
            )}
            {stats.byDirection.short.total > 0 && (
              <span className="num">
                {t('ml.short')}: {stats.byDirection.short.wins}/{stats.byDirection.short.total}
                <span style={{ color: pos }}> ({stats.byDirection.short.total > 0 ? ((stats.byDirection.short.wins / stats.byDirection.short.total) * 100).toFixed(0) : 0}%)</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
