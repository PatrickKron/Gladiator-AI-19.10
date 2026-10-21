import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { appLocale } from '../lib/locale.js';

type AgentRow = {
  id: string;
  name: string;
  strategyType: string;
  status: string;
  riskBudget: string;
  createdAt: string;
  latestPerformance: {
    returnPct: string | null;
    sharpeRatio: string | null;
    maxDrawdown: string | null;
    winRate: string | null;
    weight: string | null;
  } | null;
  episodeCount: number;
  totalTrades: number;
};

type WeightRow = {
  agentId: string;
  agentName: string;
  strategyType: string;
  weight: number;
  riskContribution: number;
};

const STRATEGY_TYPES = [
  'momentum',
  'mean_reversion',
  'breakout',
  'volatility_regime',
  'trend_following',
] as const;

const pct = (v: string | number | null | undefined) => {
  if (v == null) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? '—' : `${(n * 100).toFixed(1)}%`;
};

const num2 = (v: string | number | null | undefined) => {
  if (v == null) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? '—' : n.toFixed(2);
};

const STATUS_COLORS: Record<string, string> = {
  paper: 'rgba(79,209,255,0.5)',
  sandbox: 'rgba(255,199,0,0.5)',
  live: 'rgba(61,220,151,0.5)',
  retired: 'rgba(255,255,255,0.15)',
};

/** Kurzlebige Inline-Meldung pro Agent (statt alert()). */
type AgentNote = { agentId: string; kind: 'ok' | 'err'; text: string };

export function RlAgents({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [weights, setWeights] = useState<WeightRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createStrategy, setCreateStrategy] = useState<string>(STRATEGY_TYPES[0]);
  const [createBudget, setCreateBudget] = useState('0.1');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [note, setNote] = useState<AgentNote | null>(null);
  const [episodeBusy, setEpisodeBusy] = useState<string | null>(null);

  const loadData = () => {
    Promise.all([
      trpc.rl.agents.query(),
      trpc.rl.portfolioWeights.query(),
    ]).then(([a, w]) => {
      setAgents(a.agents as AgentRow[]);
      setWeights(w.weights as WeightRow[]);
      setLoadError(null);
    }).catch((err) => {
      // Fehler ≠ „keine Agenten": ehrlich anzeigen statt leerem Zustand.
      setLoadError(err instanceof Error ? err.message : t('common.error'));
      setAgents((prev) => prev ?? []);
      setWeights((prev) => prev ?? []);
    });
  };

  useEffect(() => { loadData(); }, []);

  const pos = 'var(--color-pos)';
  const neg = 'var(--color-neg)';
  const cyan = 'var(--color-cyan)';

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await trpc.rl.createAgent.mutate({
        name: createName.trim(),
        strategyType: createStrategy as typeof STRATEGY_TYPES[number],
        riskBudget: parseFloat(createBudget) || 0.1,
      });
      setCreateName('');
      setShowCreate(false);
      loadData();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setCreating(false);
    }
  };

  const handlePromote = async (agentId: string) => {
    if (!window.confirm(t('rl.promoteConfirm'))) return;
    try {
      const res = await trpc.rl.promoteAgent.mutate({ agentId, confirm: true });
      if (res.promoted) {
        setNote({ agentId, kind: 'ok', text: t('rl.promoted') });
        loadData();
      } else {
        setNote({ agentId, kind: 'err', text: res.reason ?? t('rl.notEligible') });
      }
    } catch (err) {
      setNote({ agentId, kind: 'err', text: err instanceof Error ? err.message : t('common.error') });
    }
  };

  const handleRetire = async (agentId: string) => {
    if (!window.confirm(t('rl.retireConfirm'))) return;
    try {
      const res = await trpc.rl.retireAgent.mutate({ agentId, confirm: true });
      if (res.retired) {
        setNote({ agentId, kind: 'ok', text: t('rl.retiredNote') });
        loadData();
      } else {
        setNote({ agentId, kind: 'err', text: res.reason ?? t('common.error') });
      }
    } catch (err) {
      setNote({ agentId, kind: 'err', text: err instanceof Error ? err.message : t('common.error') });
    }
  };

  const handleRunEpisode = async (agentId: string) => {
    setEpisodeBusy(agentId);
    setNote(null);
    try {
      await trpc.rl.runEpisode.mutate({ agentId });
      setNote({ agentId, kind: 'ok', text: `${t('rl.episodeStarted')} — ${t('rl.episodeHint')}` });
      loadData();
    } catch (err) {
      setNote({ agentId, kind: 'err', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setEpisodeBusy(null);
    }
  };

  const createButton = (
    <button
      onClick={() => setShowCreate(!showCreate)}
      className="rounded border px-3 py-1.5 text-sm transition-colors"
      style={{ borderColor: 'rgba(46,124,246,0.5)', color: cyan }}
    >
      + {t('rl.createAgent')}
    </button>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex justify-end">{createButton}</div>
      ) : (
        <PageHeader title={t('rl.title')} subtitle={t('rl.subtitle')} right={createButton} />
      )}

      {loadError && <ErrorBox message={`${t('rl.loadError')}: ${loadError}`} />}

      {/* Create Agent Form */}
      {showCreate && (
        <Panel label={t('rl.createTitle')} stagger={0} className="mb-5">
          <p className="mb-4 text-xs" style={{ color: 'var(--color-mut)' }}>{t('rl.createHint')}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label mb-1 block">{t('rl.name')}</label>
              <input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                className="field w-full rounded px-3 py-2 text-sm"
                placeholder="z.B. Momentum-Alpha"
              />
            </div>
            <div>
              <label className="label mb-1 block">{t('rl.strategy')}</label>
              <select
                value={createStrategy}
                onChange={e => setCreateStrategy(e.target.value)}
                className="field w-full rounded px-3 py-2 text-sm"
              >
                {STRATEGY_TYPES.map(st => (
                  <option key={st} value={st}>{t(`rl.${st}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label mb-1 block">{t('rl.riskBudget')}</label>
              <input
                type="number"
                value={createBudget}
                onChange={e => setCreateBudget(e.target.value)}
                min="0.01"
                max="1.0"
                step="0.05"
                className="field w-full rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          {createError && (
            <p className="mt-3 text-xs" style={{ color: neg }}>{t('rl.createError')}: {createError}</p>
          )}
          <div className="mt-4">
            <button
              onClick={handleCreate}
              disabled={creating || !createName.trim()}
              className="rounded px-4 py-2 text-sm font-medium transition-colors"
              style={{
                background: 'linear-gradient(92deg, rgba(46,124,246,0.25), rgba(139,92,246,0.15))',
                border: '1px solid rgba(99,140,255,0.4)',
                color: 'var(--color-ink)',
                opacity: creating || !createName.trim() ? 0.5 : 1,
              }}
            >
              {creating ? t('rl.creating') : t('rl.createAgent')}
            </button>
          </div>
        </Panel>
      )}

      {/* HRP Portfolio Allocation */}
      {weights && weights.length > 0 && (
        <Panel label={t('rl.portfolioTitle')} stagger={1} className="mb-5">
          <p className="mb-3 text-xs" style={{ color: 'var(--color-mut)' }}>{t('rl.portfolioHint')}</p>
          <div className="space-y-2">
            {weights.map(w => (
              <div key={w.agentId} className="flex items-center gap-3">
                <span className="num w-32 shrink-0 truncate text-sm">{w.agentName}</span>
                <span className="label w-24 shrink-0 text-xs">{t(`rl.${w.strategyType}` as const)}</span>
                <div className="flex-1">
                  <div
                    className="h-5 rounded"
                    style={{
                      width: `${Math.max(2, w.weight * 100)}%`,
                      background: 'linear-gradient(90deg, rgba(46,124,246,0.4), rgba(139,92,246,0.25))',
                      border: '1px solid rgba(99,140,255,0.3)',
                    }}
                  />
                </div>
                <span className="num w-14 shrink-0 text-right text-sm" style={{ color: cyan }}>
                  {(w.weight * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Agent Cards */}
      <Panel label={t('rl.performanceTitle')} stagger={2}>
        {agents === null ? (
          <Loading />
        ) : agents.length === 0 ? (
          <div className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            <p>{t('rl.noAgents')}</p>
            <p className="mt-2">{t('rl.noAgentsHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map(agent => {
              const isExpanded = expanded === agent.id;
              const perf = agent.latestPerformance;
              const statusColor = STATUS_COLORS[agent.status] ?? 'var(--color-line)';

              return (
                <div
                  key={agent.id}
                  className="rounded border p-3"
                  style={{ borderColor: agent.status === 'live' ? 'rgba(61,220,151,0.4)' : 'var(--color-line)' }}
                >
                  <button
                    onClick={() => setExpanded(isExpanded ? null : agent.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num font-medium">{agent.name}</span>
                      <span
                        className="rounded border px-1.5 py-0.5 text-[10px] uppercase"
                        style={{ borderColor: statusColor, color: statusColor }}
                      >
                        {t(`rl.${agent.status}` as const)}
                      </span>
                      <span className="label text-xs">{t(`rl.${agent.strategyType}` as const)}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="num" style={{ color: perf?.sharpeRatio && parseFloat(perf.sharpeRatio) > 0 ? pos : neg }}>
                        S: {num2(perf?.sharpeRatio)}
                      </span>
                      <span className="num">
                        {agent.episodeCount} {t('rl.episodes')}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
                      {perf === null && agent.episodeCount === 0 && (
                        <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                          {t('rl.noPerformance')} {t('rl.noPerformanceHint')}
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                        <div>
                          <p className="label">{t('rl.return')}</p>
                          <p className="num mt-0.5" style={{
                            color: perf?.returnPct && parseFloat(perf.returnPct) > 0 ? pos : neg,
                          }}>
                            {pct(perf?.returnPct)}
                          </p>
                        </div>
                        <div>
                          <p className="label">{t('rl.sharpe')}</p>
                          <p className="num mt-0.5">{num2(perf?.sharpeRatio)}</p>
                        </div>
                        <div>
                          <p className="label">{t('rl.maxDrawdown')}</p>
                          <p className="num mt-0.5" style={{ color: neg }}>{pct(perf?.maxDrawdown)}</p>
                        </div>
                        <div>
                          <p className="label">{t('rl.winRate')}</p>
                          <p className="num mt-0.5">{pct(perf?.winRate)}</p>
                        </div>
                        <div>
                          <p className="label">{t('rl.trades')}</p>
                          <p className="num mt-0.5">{agent.totalTrades}</p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center gap-3 text-xs" style={{ color: 'var(--color-mut)' }}>
                        {t('rl.riskBudget')}: {(parseFloat(agent.riskBudget) * 100).toFixed(0)}% ·
                        {t('rl.weight')}: {perf?.weight ? `${(parseFloat(perf.weight) * 100).toFixed(1)}%` : '—'} ·
                        {new Date(agent.createdAt).toLocaleDateString(appLocale())}
                      </div>

                      {note?.agentId === agent.id && (
                        <p
                          className="mt-3 rounded border p-2 text-xs"
                          style={
                            note.kind === 'ok'
                              ? { borderColor: 'rgba(61,220,151,0.4)', color: pos }
                              : { borderColor: 'rgba(255,92,108,0.4)', color: neg }
                          }
                        >
                          {note.text}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => handleRunEpisode(agent.id)}
                          disabled={episodeBusy !== null}
                          className="rounded border px-3 py-1 text-xs transition-colors disabled:opacity-50"
                          style={{ borderColor: 'rgba(46,124,246,0.4)', color: cyan }}
                        >
                          {episodeBusy === agent.id ? t('rl.episodeRunning') : t('rl.runEpisode')}
                        </button>
                        {(agent.status === 'paper' || agent.status === 'sandbox') && (
                          <button
                            onClick={() => handlePromote(agent.id)}
                            className="rounded border px-3 py-1 text-xs transition-colors"
                            style={{ borderColor: 'rgba(61,220,151,0.4)', color: pos }}
                          >
                            {t('rl.promote')}
                          </button>
                        )}
                        {agent.status !== 'retired' && (
                          <button
                            onClick={() => handleRetire(agent.id)}
                            className="rounded border px-3 py-1 text-xs transition-colors"
                            style={{ borderColor: 'rgba(255,92,108,0.35)', color: neg }}
                          >
                            {t('rl.retire')}
                          </button>
                        )}
                        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                          {t('rl.episodeHint')}
                        </span>
                      </div>
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
