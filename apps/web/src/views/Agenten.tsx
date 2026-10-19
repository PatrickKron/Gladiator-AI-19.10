import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { FeatureCard } from './Funktionen.js';
import { NAV_PAGES } from '../lib/navigation.js';

/**
 * Agenten-Übersicht (Phase 5/6): EIGENE Agenten des Users (Werkstatt/RL, mit
 * Erstellen-Einstieg — vorher gab es hier nichts zum Anlegen und die Seite
 * wirkte „kaputt"), dazu der eingebaute Schwarm (aktiv/deaktiviert),
 * LLM-Provider + Kosten-Wächter, echte Urteils-Statistik aus signal_reviews.
 */

type Status = Awaited<ReturnType<typeof trpc.agents.status.query>>;
type MyAgent = Awaited<ReturnType<typeof trpc.subAgents.list.query>>[number];
type RlList = Awaited<ReturnType<typeof trpc.rl.agents.query>>;

const MY_STATUS_COLOR: Record<string, string> = {
  active: 'var(--color-pos)',
  paused: 'var(--color-warn)',
  archived: 'var(--color-mut)',
};

/**
 * „Meine Agenten": eigene Werkstatt- und RL-Agenten mit direktem
 * Erstellen-Einstieg — DIE Antwort auf „wo erstelle ich einen Agenten?".
 */
function MyAgentsPanel() {
  const { t } = useTranslation();
  const [mine, setMine] = useState<MyAgent[] | null>(null);
  const [rl, setRl] = useState<RlList['agents'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([trpc.subAgents.list.query(), trpc.rl.agents.query()])
      .then(([subs, rlRes]) => {
        setMine(subs);
        setRl(rlRes.agents);
      })
      .catch((err: unknown) => {
        setMine([]);
        setRl([]);
        setLoadError(err instanceof Error ? err.message : t('common.error'));
      });
  }, []);

  const activeRl = (rl ?? []).filter((a) => (a as { status?: string }).status !== 'retired');

  return (
    <Panel label={t('agents.myTitle')} stagger={1}>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('agents.myHint')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href="#/werkstatt" className="rounded border px-3 py-2 text-xs font-medium transition-colors"
          style={{ borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-cyan)', background: 'rgba(79,209,255,0.08)' }}>
          + {t('agents.createWorkshopCta')}
        </a>
        <a href="#/intelligenz?tab=rl" className="rounded border px-3 py-2 text-xs font-medium transition-colors"
          style={{ borderColor: 'rgba(139,92,246,0.5)', color: 'var(--color-violet)', background: 'rgba(139,92,246,0.08)' }}>
          + {t('agents.createRlCta')}
        </a>
      </div>
      {loadError && <ErrorBox message={loadError} />}
      {mine === null ? (
        <div className="mt-4"><Loading /></div>
      ) : mine.length === 0 && activeRl.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-mut)' }}>{t('agents.myEmpty')}</p>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {mine.map((a) => (
            <a key={a.id} href="#/werkstatt" className="rounded-[0.625rem] border p-4 transition-colors hover:border-cyan-400/40"
              style={{ borderColor: 'rgba(79,209,255,0.2)' }}>
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
                <span>{a.name}</span>
                <span className="rounded border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--color-line)', color: MY_STATUS_COLOR[a.status] ?? 'var(--color-mut)' }}>
                  {t(`workshop.status_${a.status}`)}
                </span>
              </p>
              <p className="num mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
                {t('agents.myStats', { open: a.openPositions, trades: a.closedTrades })}
                {a.closedTrades > 0 && (
                  <span className="ml-2" style={{ color: a.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {a.netPnl >= 0 ? '+' : ''}{a.netPnl.toFixed(2)} $
                  </span>
                )}
              </p>
            </a>
          ))}
          {activeRl.map((a) => (
            <a key={a.id} href="#/intelligenz?tab=rl" className="rounded-[0.625rem] border p-4 transition-colors"
              style={{ borderColor: 'rgba(139,92,246,0.25)' }}>
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
                <span>{a.name}</span>
                <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-violet)' }}>
                  RL · {a.strategyType}
                </span>
              </p>
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

const AGENT_META: Record<string, { nameKey: string; descKey: string }> = {
  technik: { nameKey: 'signals.agentTechnik', descKey: 'agents.technikDesc' },
  risk: { nameKey: 'signals.agentRisk', descKey: 'agents.riskDesc' },
  devil: { nameKey: 'signals.agentDevil', descKey: 'agents.devilDesc' },
  portfolio: { nameKey: 'signals.agentPortfolio', descKey: 'agents.portfolioDesc' },
  makro: { nameKey: 'signals.agentMakro', descKey: 'agents.makroDesc' },
  shadow: { nameKey: 'signals.agentShadow', descKey: 'agents.shadowDesc' },
};

const VOTE_COLOR: Record<string, string> = {
  confirm: 'var(--color-pos)',
  caution: 'var(--color-warn)',
  reject: 'var(--color-neg)',
};

export function Agenten() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.agents.status
      .query()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
  }, []);

  const statsByAgent = new Map<string, { vote: string; n: number; avg: number }[]>();
  for (const s of status?.stats ?? []) {
    const list = statsByAgent.get(s.agent) ?? [];
    list.push({ vote: s.vote, n: s.n, avg: s.avg_confidence });
    statsByAgent.set(s.agent, list);
  }

  return (
    <div>
      <PageHeader title={t('agents.title')} subtitle={t('agents.subtitle')} />
      {error && <ErrorBox message={error} />}

      {/* Eigene Agenten zuerst — inkl. Erstellen-Einstieg (Werkstatt/RL) */}
      <MyAgentsPanel />

      {/* Werkzeuge: aus der Funktions-Registry — neue Agenten-Werkzeuge erscheinen automatisch */}
      <section className="reveal mt-5" style={{ '--stagger': 2 } as React.CSSProperties}>
        <h2 className="label mb-3">{t('ia.toolsTitle')}</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {NAV_PAGES
            .filter((p) => p.area === 'agents' && p.id !== 'agents')
            .map((p) => (
              <FeatureCard key={p.id} page={p} />
            ))}
        </div>
      </section>

      {status === null ? (
        <div className="glass mt-5 p-6">
          <Loading />
        </div>
      ) : (
        <>
          {/* Aktive Schwarm-Agenten (eingebaut, nicht erstellbar) */}
          <Panel label={t('agents.activeTitle')} stagger={2} className="mt-5">
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {status.active.map((a) => {
                const meta = AGENT_META[a.agent];
                const stats = statsByAgent.get(a.agent) ?? [];
                return (
                  <div key={a.agent} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(79,209,255,0.25)' }}>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="neon-dot neon-dot--on" />
                      {meta ? t(meta.nameKey) : a.agent}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                      {meta ? t(meta.descKey) : ''}
                    </p>
                    {stats.length > 0 && (
                      <p className="num mt-2 flex flex-wrap gap-2 text-[11px]">
                        {stats.map((s) => (
                          <span key={s.vote} style={{ color: VOTE_COLOR[s.vote] ?? 'var(--color-mut)' }}>
                            {s.vote} ×{s.n} (Ø {(s.avg * 100).toFixed(0)} %)
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Deaktivierte Agenten — ehrlich mit Grund */}
          <Panel label={t('agents.disabledTitle')} stagger={3} className="mt-5">
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {status.disabled.map((d) => {
                const meta = AGENT_META[d.agent];
                return (
                  <div key={d.agent} className="rounded-[0.625rem] border border-dashed p-4" style={{ borderColor: 'rgba(139,92,246,0.35)' }}>
                    <p className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--color-mut)' }}>
                      <span className="neon-dot neon-dot--violet" />
                      {meta ? t(meta.nameKey) : d.agent} · {t('common.disabled')}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                      {meta ? t(meta.descKey) : ''}
                    </p>
                    <p className="mt-2 text-xs" style={{ color: 'var(--color-violet)' }}>
                      {d.reason}
                    </p>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* LLM & Kosten-Wächter */}
          <Panel label={t('agents.llmTitle')} stagger={4} className="mt-5">
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('agents.provider')}</span>
                <span className="num" style={{ color: status.llm.configured ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                  {status.llm.provider ?? t('agents.providerNone')}
                </span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('agents.budget')}</span>
                <span className="num">
                  {status.llm.dailyBudgetUsd.toFixed(2)} $ {t('common.perDay')}
                </span>
              </li>
            </ul>
          </Panel>

          {/* Urteils-Statistik */}
          <Panel label={t('agents.statsTitle', { count: 500 })} stagger={5} className="mt-5">
            {status.stats.length === 0 ? (
              <Empty text={t('agents.noStats')} />
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1.5 pr-4 font-normal">Agent</th>
                      <th className="py-1.5 pr-4 font-normal">{t('agents.votes')}</th>
                      <th className="py-1.5 pr-4 text-right font-normal">×</th>
                      <th className="py-1.5 text-right font-normal">{t('agents.avgConfidence')}</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {status.stats.map((s) => (
                      <tr key={`${s.agent}-${s.vote}`} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                        <td className="py-1.5 pr-4">{AGENT_META[s.agent] ? t(AGENT_META[s.agent]!.nameKey) : s.agent}</td>
                        <td className="py-1.5 pr-4" style={{ color: VOTE_COLOR[s.vote] ?? 'var(--color-ink)' }}>
                          {s.vote}
                        </td>
                        <td className="py-1.5 pr-4 text-right">{s.n}</td>
                        <td className="py-1.5 text-right">{(s.avg_confidence * 100).toFixed(0)} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <p className="reveal mt-6 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)', '--stagger': 6 } as React.CSSProperties}>
            {t('agents.guardrail')}
          </p>
        </>
      )}
    </div>
  );
}
