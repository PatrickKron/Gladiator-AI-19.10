import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Loading, PageHeader, Panel } from '../components/ui.js';

type ModelRow = {
  id: number;
  name: string;
  version: number;
  modelType: string;
  symbol: string | null;
  timeframe: string | null;
  metrics: Record<string, number> | null;
  hyperparams: Record<string, unknown> | null;
  trainedAt: string;
  isActive: boolean;
};

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

const pct = (n: number | undefined) => n != null ? `${(n * 100).toFixed(1)}%` : '—';
const num3 = (n: number | undefined) => n != null ? n.toFixed(3) : '—';

export function MlModels() {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [stats, setStats] = useState<LabelStats | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      trpc.ml.modelMetrics.query(),
      trpc.ml.labelStats.query({}),
    ]).then(([m, s]) => {
      if (!cancelled) {
        setModels(m.models as ModelRow[]);
        setStats(s);
      }
    }).catch(() => {
      if (!cancelled) {
        setModels([]);
        setStats(null);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const pos = 'var(--color-pos)';
  const neg = 'var(--color-neg)';

  return (
    <div>
      <PageHeader title={t('ml.title')} subtitle={t('ml.subtitle')} />

      {/* Label Statistics */}
      {stats && stats.total > 0 && (
        <Panel label={t('ml.labelStats')} stagger={1}>
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <p className="label">{t('ml.total')}</p>
              <p className="num mt-1 text-lg">{stats.total}</p>
            </div>
            <div>
              <p className="label">{t('ml.winRate')}</p>
              <p className="num mt-1 text-lg" style={{ color: (stats.winRate ?? 0) >= 0.5 ? pos : neg }}>
                {stats.winRate != null ? pct(stats.winRate) : '—'}
              </p>
            </div>
            <div>
              <p className="label">{t('ml.wins')}</p>
              <p className="num mt-1 text-lg" style={{ color: pos }}>{stats.wins}</p>
            </div>
            <div>
              <p className="label">{t('ml.losses')}</p>
              <p className="num mt-1 text-lg" style={{ color: neg }}>{stats.losses}</p>
            </div>
          </div>
          {(stats.byDirection.long.total > 0 || stats.byDirection.short.total > 0) && (
            <div className="mt-4 flex gap-6 text-sm">
              <p className="label shrink-0">{t('ml.byDirection')}:</p>
              {stats.byDirection.long.total > 0 && (
                <span className="num">
                  {t('ml.long')}: {stats.byDirection.long.wins}/{stats.byDirection.long.total}
                  <span className="ml-1" style={{ color: pos }}>
                    ({((stats.byDirection.long.wins / stats.byDirection.long.total) * 100).toFixed(0)}%)
                  </span>
                </span>
              )}
              {stats.byDirection.short.total > 0 && (
                <span className="num">
                  {t('ml.short')}: {stats.byDirection.short.wins}/{stats.byDirection.short.total}
                  <span className="ml-1" style={{ color: pos }}>
                    ({((stats.byDirection.short.wins / stats.byDirection.short.total) * 100).toFixed(0)}%)
                  </span>
                </span>
              )}
            </div>
          )}
        </Panel>
      )}

      {/* Models List */}
      <Panel label={t('ml.modelName')} stagger={2}>
        {models === null ? (
          <Loading />
        ) : models.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--color-mut)' }}>{t('ml.noModels')}</p>
        ) : (
          <div className="space-y-3">
            {models.map((m) => {
              const metrics = m.metrics;
              const isExpanded = expanded === m.id;
              return (
                <div
                  key={m.id}
                  className="rounded border p-3"
                  style={{ borderColor: m.isActive ? 'rgba(46,124,246,0.4)' : 'var(--color-line)' }}
                >
                  <button
                    onClick={() => setExpanded(isExpanded ? null : m.id)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="num font-medium">{m.name}</span>
                      <span className="label">v{m.version}</span>
                      <span
                        className="rounded border px-1.5 py-0.5 text-[10px]"
                        style={
                          m.isActive
                            ? { borderColor: 'rgba(61,220,151,0.5)', color: pos }
                            : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                        }
                      >
                        {m.isActive ? t('ml.active') : t('ml.inactive')}
                      </span>
                    </div>
                    <span className="label shrink-0">
                      {new Date(m.trainedAt).toLocaleDateString()}
                    </span>
                  </button>

                  {isExpanded && metrics && (
                    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
                      <div className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-5">
                        <div>
                          <p className="label">{t('ml.accuracy')}</p>
                          <p className="num mt-0.5">{pct(metrics.accuracy)}</p>
                        </div>
                        <div>
                          <p className="label">{t('ml.precision')}</p>
                          <p className="num mt-0.5">{pct(metrics.precision)}</p>
                        </div>
                        <div>
                          <p className="label">{t('ml.recall')}</p>
                          <p className="num mt-0.5">{pct(metrics.recall)}</p>
                        </div>
                        <div>
                          <p className="label">{t('ml.f1')}</p>
                          <p className="num mt-0.5">{num3(metrics.f1)}</p>
                        </div>
                        <div>
                          <p className="label">{t('ml.auc')}</p>
                          <p className="num mt-0.5">{num3(metrics.auc)}</p>
                        </div>
                      </div>

                      {m.hyperparams && (
                        <div className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
                          nTrees={String((m.hyperparams as Record<string, unknown>).nTrees ?? '?')} ·
                          maxDepth={String((m.hyperparams as Record<string, unknown>).maxDepth ?? '?')} ·
                          {m.symbol ?? 'global'} · {m.timeframe ?? 'all TFs'}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
