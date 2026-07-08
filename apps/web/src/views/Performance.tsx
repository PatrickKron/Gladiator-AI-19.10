import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';

const pct = (v: number | null | undefined) => {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
};

const num2 = (v: number | null | undefined) => {
  if (v == null) return '—';
  return v.toFixed(2);
};

const num4 = (v: number | null | undefined) => {
  if (v == null) return '—';
  return v.toFixed(4);
};

type DashboardMetrics = {
  totalReturn: number;
  avgSharpe: number;
  maxDrawdown: number;
  avgWinRate: number;
  totalTrades: number;
  sortino: number;
  calmar: number;
  var95: number;
  es95: number;
};

type TimeSeries = {
  ts: string;
  returnPct: number;
  sharpe: number;
  drawdown: number;
  winRate: number;
};

type DashboardData = {
  metrics: DashboardMetrics | null;
  dataPoints: number;
  timeSeries?: TimeSeries[];
};

type EquityPoint = { ts: string; value: number };

type RiskMetrics = {
  var95: number;
  var99: number;
  es95: number;
  maxDrawdown: number;
  currentDrawdown: number;
  sortino: number;
  sharpe: number;
};

type ModelVersion = {
  id: string;
  version: number;
  metrics: Record<string, number>;
  comparison: { improvement: number; shouldPromote: boolean; reason: string } | null;
  promoted: boolean;
  promotedAt: string | null;
  promotedBy: string | null;
  sampleCount: number | null;
  createdAt: string;
};

export function Performance({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [equity, setEquity] = useState<EquityPoint[] | null>(null);
  const [risk, setRisk] = useState<RiskMetrics | null>(null);
  const [versions, setVersions] = useState<ModelVersion[] | null>(null);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      trpc.rl.performanceDashboard.query({ period }),
      trpc.rl.equityCurve.query({ limit: 90 }),
      trpc.rl.riskMetrics.query({}),
      trpc.ml.modelVersions.query({}),
    ]).then(([d, e, r, v]) => {
      if (cancelled) return;
      setDashboard(d as DashboardData);
      setEquity((e as { curve: EquityPoint[] }).curve);
      setRisk((r as { metrics: RiskMetrics | null }).metrics);
      setVersions((v as { versions: ModelVersion[] }).versions);
      setLoading(false);
      setLoadError(null);
    }).catch((err) => {
      // Fehler ≠ „keine Daten": ehrlich anzeigen statt leerem Zustand.
      if (!cancelled) {
        setDashboard(null);
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : t('common.error'));
      }
    });
    return () => { cancelled = true; };
  }, [period]);

  const pos = 'var(--color-pos)';
  const neg = 'var(--color-neg)';
  const cyan = 'var(--color-cyan)';

  const periodSwitch = (
    <div className="flex gap-1">
      {(['daily', 'weekly', 'monthly'] as const).map(p => (
        <button
          key={p}
          onClick={() => setPeriod(p)}
          className="rounded border px-3 py-1 text-xs transition-colors"
          style={{
            borderColor: p === period ? 'rgba(46,124,246,0.5)' : 'var(--color-line)',
            color: p === period ? cyan : 'var(--color-mut)',
          }}
        >
          {t(`perf.${p}` as const)}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex justify-end">{periodSwitch}</div>
      ) : (
        <PageHeader title={t('perf.title')} subtitle={t('perf.subtitle')} right={periodSwitch} />
      )}

      {loadError && <ErrorBox message={`${t('perf.loadError')}: ${loadError}`} />}

      {loading ? <Loading /> : !dashboard?.metrics ? (
        <Panel label="" stagger={1}>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('perf.noData')}</p>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('perf.noDataHint')}</p>
        </Panel>
      ) : (
        <>
          {/* Key Metrics Grid */}
          <Panel label={t('perf.metricsTitle')} className="mb-5" stagger={1}>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
              <div>
                <p className="label">{t('perf.totalReturn')}</p>
                <p className="num mt-1 text-lg" style={{ color: dashboard.metrics.totalReturn >= 0 ? pos : neg }}>
                  {pct(dashboard.metrics.totalReturn)}
                </p>
              </div>
              <div>
                <p className="label">{t('perf.sharpe')}</p>
                <p className="num mt-1 text-lg" style={{ color: dashboard.metrics.avgSharpe >= 0 ? pos : neg }}>
                  {num2(dashboard.metrics.avgSharpe)}
                </p>
              </div>
              <div>
                <p className="label">{t('perf.maxDD')}</p>
                <p className="num mt-1 text-lg" style={{ color: neg }}>
                  {pct(dashboard.metrics.maxDrawdown)}
                </p>
              </div>
              <div>
                <p className="label">{t('perf.winRate')}</p>
                <p className="num mt-1 text-lg" style={{ color: dashboard.metrics.avgWinRate >= 0.5 ? pos : neg }}>
                  {pct(dashboard.metrics.avgWinRate)}
                </p>
              </div>
              <div>
                <p className="label">{t('perf.trades')}</p>
                <p className="num mt-1 text-lg">{dashboard.metrics.totalTrades}</p>
              </div>
            </div>

            {/* Secondary metrics */}
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="label">{t('perf.sortino')}</p>
                <p className="num mt-0.5">{num2(dashboard.metrics.sortino)}</p>
              </div>
              <div>
                <p className="label">{t('perf.calmar')}</p>
                <p className="num mt-0.5">{num2(dashboard.metrics.calmar)}</p>
              </div>
              <div>
                <p className="label">{t('perf.var95')}</p>
                <p className="num mt-0.5" style={{ color: neg }}>{num4(dashboard.metrics.var95)}</p>
              </div>
              <div>
                <p className="label">{t('perf.es95')}</p>
                <p className="num mt-0.5" style={{ color: neg }}>{num4(dashboard.metrics.es95)}</p>
              </div>
            </div>
          </Panel>

          {/* Equity Curve (text-based sparkline) */}
          {equity && equity.length > 0 && (
            <Panel label={t('perf.equityTitle')} className="mb-5" stagger={2}>
              <div className="overflow-x-auto">
                <div className="flex items-end gap-px" style={{ height: 80, minWidth: equity.length * 6 }}>
                  {(() => {
                    const values = equity.map(e => e.value);
                    const min = Math.min(...values);
                    const max = Math.max(...values);
                    const range = max - min || 1;
                    return equity.map((e, i) => {
                      const h = Math.max(2, ((e.value - min) / range) * 72);
                      const color = e.value >= 1.0 ? pos : neg;
                      return (
                        <div
                          key={i}
                          className="flex-1 rounded-t"
                          style={{ height: h, minWidth: 3, background: color, opacity: 0.7 }}
                          title={`${new Date(e.ts).toLocaleDateString()} · ${e.value.toFixed(4)}`}
                        />
                      );
                    });
                  })()}
                </div>
                <div className="mt-1 flex justify-between text-[10px]" style={{ color: 'var(--color-mut)' }}>
                  <span>{equity[0] && new Date(equity[0].ts).toLocaleDateString()}</span>
                  <span className="num">
                    {equity[equity.length - 1]?.value.toFixed(4)}
                  </span>
                  <span>{equity[equity.length - 1] && new Date(equity[equity.length - 1]!.ts).toLocaleDateString()}</span>
                </div>
              </div>
            </Panel>
          )}

          {/* Risk Metrics */}
          {risk && (
            <Panel label={t('perf.riskTitle')} className="mb-5" stagger={3}>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <p className="label">{t('perf.var95')}</p>
                  <p className="num mt-0.5" style={{ color: neg }}>{num4(risk.var95)}</p>
                </div>
                <div>
                  <p className="label">{t('perf.var99')}</p>
                  <p className="num mt-0.5" style={{ color: neg }}>{num4(risk.var99)}</p>
                </div>
                <div>
                  <p className="label">{t('perf.es95')}</p>
                  <p className="num mt-0.5" style={{ color: neg }}>{num4(risk.es95)}</p>
                </div>
                <div>
                  <p className="label">{t('perf.currentDD')}</p>
                  <p className="num mt-0.5" style={{ color: neg }}>{pct(risk.currentDrawdown)}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="label">{t('perf.maxDD')}</p>
                  <p className="num mt-0.5">{pct(risk.maxDrawdown)}</p>
                </div>
                <div>
                  <p className="label">{t('perf.sharpe')}</p>
                  <p className="num mt-0.5">{num2(risk.sharpe)}</p>
                </div>
                <div>
                  <p className="label">{t('perf.sortino')}</p>
                  <p className="num mt-0.5">{num2(risk.sortino)}</p>
                </div>
              </div>
            </Panel>
          )}

          {/* Monthly Returns Heatmap */}
          {dashboard.timeSeries && dashboard.timeSeries.length > 0 && (
            <Panel label={t('perf.returnsTitle')} className="mb-5" stagger={4}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="label pb-1 text-left">{t('perf.date')}</th>
                      <th className="label pb-1 text-right">{t('perf.return')}</th>
                      <th className="label pb-1 text-right">{t('perf.sharpe')}</th>
                      <th className="label pb-1 text-right">{t('perf.drawdown')}</th>
                      <th className="label pb-1 text-right">{t('perf.winRate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.timeSeries.slice(-30).map((row, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--color-line)' }}>
                        <td className="py-1 num">{new Date(row.ts).toLocaleDateString()}</td>
                        <td className="py-1 num text-right" style={{ color: row.returnPct >= 0 ? pos : neg }}>
                          {pct(row.returnPct)}
                        </td>
                        <td className="py-1 num text-right">{num2(row.sharpe)}</td>
                        <td className="py-1 num text-right" style={{ color: neg }}>{pct(row.drawdown)}</td>
                        <td className="py-1 num text-right">{pct(row.winRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* Model Versions */}
          {versions && versions.length > 0 && (
            <Panel label={t('perf.versionsTitle')} stagger={5}>
              <div className="space-y-2">
                {versions.map(v => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between rounded border p-2"
                    style={{ borderColor: v.promoted ? 'rgba(61,220,151,0.4)' : 'var(--color-line)' }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="num text-sm font-medium">v{v.version}</span>
                      {v.promoted && (
                        <span
                          className="rounded border px-1.5 py-0.5 text-[10px]"
                          style={{ borderColor: 'rgba(61,220,151,0.5)', color: pos }}
                        >
                          {t('perf.promoted')}
                        </span>
                      )}
                      <span className="label text-xs">
                        Acc: {v.metrics.accuracy != null ? `${(v.metrics.accuracy * 100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      {v.comparison && (
                        <span className="num" style={{ color: v.comparison.improvement > 0 ? pos : neg }}>
                          {v.comparison.improvement > 0 ? '+' : ''}
                          {(v.comparison.improvement * 100).toFixed(1)}pp
                        </span>
                      )}
                      <span style={{ color: 'var(--color-mut)' }}>
                        {v.sampleCount ?? '?'} samples
                      </span>
                      <span style={{ color: 'var(--color-mut)' }}>
                        {new Date(v.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
