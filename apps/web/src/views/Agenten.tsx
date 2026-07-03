import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Agenten-Übersicht (Phase 5/6): aktive vs. ehrlich deaktivierte Agenten,
 * LLM-Provider + Kosten-Wächter, echte Urteils-Statistik aus signal_reviews.
 */

type Status = Awaited<ReturnType<typeof trpc.agents.status.query>>;

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

      {status === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : (
        <>
          {/* Aktive Agenten */}
          <Panel label={t('agents.activeTitle')} stagger={1}>
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
          <Panel label={t('agents.disabledTitle')} stagger={2} className="mt-5">
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
          <Panel label={t('agents.llmTitle')} stagger={3} className="mt-5">
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
          <Panel label={t('agents.statsTitle', { count: 500 })} stagger={4} className="mt-5">
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

          <p className="reveal mt-6 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)', '--stagger': 5 } as React.CSSProperties}>
            {t('agents.guardrail')}
          </p>
        </>
      )}
    </div>
  );
}
