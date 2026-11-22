import { useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';
import { openAssistant } from './AssistantPanel.js';
import { Loading } from './ui.js';

/**
 * Strukturiertes Tages-Briefing + Abend-Trade-Review (Welle 18):
 * Ersetzt die rohe Telegram-Text-Box durch 4 scannbare Briefing-Karten
 * (Marktlage · Konto & Risiko · Chancen & Termine · News & Handlungsrahmen)
 * sowie einen eigenen „Abend-Rückblick“-Reiter, in dem heutige Demo- &
 * Agenten-Trades sauber Revue passieren können.
 */

type StructuredBriefing = Awaited<ReturnType<typeof trpc.system.structuredBriefing.query>>;
type EveningReview = Awaited<ReturnType<typeof trpc.system.eveningReview.query>>;

function regimeGuidance(label: string | null | undefined, vix: number | null | undefined): string {
  if (!label) return 'Makro-Daten synchronisieren — nutze zunächst die reine Chart-Struktur.';
  if (label === 'risk-off' || (vix != null && vix >= 25)) {
    return 'Erhöhter Marktstress (Risk-Off): kleinere Positionsgrößen wählen, eng absichern und Hedging im Blick behalten.';
  }
  if (label === 'risk-on') {
    return 'Rückenwind am Gesamtmarkt (Risk-On): Trendfolge-Setups in Hauptrichtung bevorzugen.';
  }
  return 'Ausgeglichenes Umfeld (Neutral): selektiv nur saubere Setups mit klarem Chance-Risiko-Verhältnis handeln.';
}

export function DailyBriefingAndReview() {
  const defaultTab = new Date().getHours() >= 18 ? 'evening' : 'briefing';
  const [tab, setTab] = useState<'briefing' | 'evening'>(defaultTab);
  const [briefing, setBriefing] = useState<StructuredBriefing | null | undefined>(undefined);
  const [review, setReview] = useState<EveningReview | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void trpc.system.structuredBriefing
      .query()
      .then((res) => {
        if (!cancelled) setBriefing(res);
      })
      .catch(() => {
        if (!cancelled) setBriefing(null);
      });
    void trpc.system.eveningReview
      .query()
      .then((res) => {
        if (!cancelled) setReview(res);
      })
      .catch(() => {
        if (!cancelled) setReview(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loc = appLocale();
  const fmtMoney = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

  return (
    <section className="glass reveal mt-6 p-5" style={{ '--stagger': 3 } as React.CSSProperties}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label">Tages-Cockpit · Briefing & Abend-Rückblick</p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-mut)' }}>
            {tab === 'briefing'
              ? 'Alle relevanten Fakten des Tages strukturiert auf einen Blick — ohne Textwüste.'
              : 'Lass deine heutigen Demo- & Agenten-Trades abends strukturiert Revue passieren.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTab('briefing')}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
            style={
              tab === 'briefing'
                ? { borderColor: 'rgba(6,182,212,0.55)', background: 'rgba(6,182,212,0.14)', color: 'var(--color-ink)' }
                : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
            }
          >
            ☀️ Tages-Briefing
          </button>
          <button
            type="button"
            onClick={() => setTab('evening')}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
            style={
              tab === 'evening'
                ? { borderColor: 'rgba(139,92,246,0.55)', background: 'rgba(139,92,246,0.16)', color: 'var(--color-ink)' }
                : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
            }
          >
            🌙 Abend-Rückblick {review && review.totalTrades > 0 ? `(${review.totalTrades})` : ''}
          </button>
        </div>
      </div>

      {/* ── TAB 1: Strukturiertes Tages-Briefing (4 Karten) ── */}
      {tab === 'briefing' && (
        <div className="mt-4">
          {briefing === undefined ? (
            <Loading />
          ) : briefing === null ? (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              Briefing-Daten konnten gerade nicht geladen werden.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Handlungsrahmen für heute */}
              <div
                className="rounded-[0.625rem] border p-3.5 text-xs leading-relaxed"
                style={{
                  borderColor: briefing.killSwitchActive
                    ? 'var(--color-neg)'
                    : briefing.regime?.label === 'risk-off'
                      ? 'rgba(245,182,66,0.5)'
                      : 'rgba(6,182,212,0.4)',
                  background: 'rgba(15,23,42,0.45)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold" style={{ color: briefing.killSwitchActive ? 'var(--color-neg)' : 'var(--color-cyan)' }}>
                    {briefing.killSwitchActive ? '🛑 KILL-SWITCH AKTIV — alle neuen Orders gestoppt' : `📌 Handlungsrahmen für heute (${briefing.day})`}
                  </span>
                  <a href="#/marktlage" className="underline decoration-dotted" style={{ color: 'var(--color-cyan)' }}>
                    Details in Marktlage →
                  </a>
                </div>
                <p className="mt-1">{regimeGuidance(briefing.regime?.label, briefing.regime?.vix)}</p>
              </div>

              {/* 4 strukturierte Karten */}
              <div className="grid gap-3 md:grid-cols-2">
                {/* Karte 1: Marktlage & Makro */}
                <div className="rounded-lg border p-3.5 text-xs space-y-2" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">🧭 1 · Makro-Regime</p>
                  {briefing.regime ? (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="num text-base font-semibold" style={{ color: briefing.regime.label === 'risk-off' ? 'var(--color-neg)' : briefing.regime.label === 'risk-on' ? 'var(--color-pos)' : 'var(--color-warn)' }}>
                          GRS {Math.round(briefing.regime.grs)} · {briefing.regime.label.toUpperCase()}
                        </span>
                        <span className="num" style={{ color: 'var(--color-mut)' }}>
                          VIX {briefing.regime.vix?.toFixed(1) ?? '—'}
                        </span>
                      </div>
                      <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                        Dollar (DXY): {briefing.regime.dxy?.toFixed(1) ?? '—'} · US10Y-Zins: {briefing.regime.us10yPct?.toFixed(2) ?? '—'} %
                      </p>
                    </>
                  ) : (
                    <p style={{ color: 'var(--color-mut)' }}>Makro-Sync läuft noch — keine erfundenen Zahlen.</p>
                  )}
                </div>

                {/* Karte 2: Konto & Risiko */}
                <div className="rounded-lg border p-3.5 text-xs space-y-2" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">🛡️ 2 · Konto & Schutz</p>
                  <div className="flex items-baseline justify-between">
                    <span className="num text-base font-semibold">
                      {briefing.account.equity.toLocaleString(loc, { maximumFractionDigits: 0 })} $
                    </span>
                    <span className="num" style={{ color: briefing.account.dailyPnlPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      Tag {briefing.account.dailyPnlPct >= 0 ? '+' : ''}
                      {briefing.account.dailyPnlPct.toFixed(2)} %
                    </span>
                  </div>
                  <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    {briefing.account.openPositions} offene Pos. · {briefing.activeGates} aktive Gates · Gestern: {briefing.yesterday.closedTrades} Trade(s) ({fmtMoney(briefing.yesterday.netPnl)})
                  </p>
                </div>

                {/* Karte 3: Chancen & Offene Signale */}
                <div className="rounded-lg border p-3.5 text-xs space-y-2" style={{ borderColor: 'var(--color-line)' }}>
                  <div className="flex items-center justify-between">
                    <p className="label">📡 3 · Aktive Chancen ({briefing.openSignals.length})</p>
                    <a href="#/signals" className="text-[11px] hover:underline" style={{ color: 'var(--color-cyan)' }}>
                      Alle →
                    </a>
                  </div>
                  {briefing.openSignals.length === 0 ? (
                    <p style={{ color: 'var(--color-mut)' }}>
                      Aktuell kein offenes Signal — die Engine wartet auf vollständige Confluences.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {briefing.openSignals.slice(0, 4).map((s, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-2">
                          <a href={buildChartUrl(s.symbol, s.timeframe)} className="font-medium hover:underline">
                            <span style={{ color: s.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                              {s.direction === 'long' ? '▲' : '▼'}
                            </span>{' '}
                            {s.symbol} <span className="num" style={{ color: 'var(--color-mut)' }}>{s.timeframe}</span>
                          </a>
                          <span className="num text-[11px]" style={{ color: 'var(--color-cyan)' }}>
                            Score {s.score.toFixed(1)}{s.portfolioVote ? ` · ${s.portfolioVote}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Karte 4: Termine & News */}
                <div className="rounded-lg border p-3.5 text-xs space-y-2" style={{ borderColor: 'var(--color-line)' }}>
                  <div className="flex items-center justify-between">
                    <p className="label">📅 4 · Termine (No-Trade) & News</p>
                    <a href="#/kalender" className="text-[11px] hover:underline" style={{ color: 'var(--color-cyan)' }}>
                      Kalender →
                    </a>
                  </div>
                  {briefing.highImpactEventsToday.length > 0 ? (
                    <ul className="space-y-1">
                      {briefing.highImpactEventsToday.slice(0, 3).map((e, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-2">
                          <span className="truncate">{e.title}</span>
                          <span className="num shrink-0" style={{ color: 'var(--color-warn)' }}>
                            {e.timeUtc} UTC
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: 'var(--color-pos)' }}>✓ Heute keine High-Impact-Sperrtermine.</p>
                  )}
                  {briefing.news.length > 0 && (
                    <p className="truncate pt-1 text-[11px]" style={{ color: 'var(--color-mut)' }} title={briefing.news[0]?.title}>
                      📰 {briefing.news[0]?.title}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB 2: Abend-Rückblick (Tages-Trades Revue passieren lassen) ── */}
      {tab === 'evening' && (
        <div className="mt-4">
          {review === undefined ? (
            <Loading />
          ) : review === null ? (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              Abend-Rückblick konnte nicht geladen werden.
            </p>
          ) : (
            <div className="space-y-4">
              {/* KPI-Leiste */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">Tages-Trades</p>
                  <p className="num mt-1 text-lg font-semibold">{review.totalTrades}</p>
                  <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    {review.demoTradesCount} Demo · {review.agentTradesCount} Agent
                  </p>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">Netto-Ergebnis</p>
                  <p
                    className="num mt-1 text-lg font-semibold"
                    style={{ color: review.netPnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
                  >
                    {fmtMoney(review.netPnlUsd)}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    {review.wins} Gewinner · {review.losses} Verlierer
                  </p>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">Trefferquote / Ø R</p>
                  <p className="num mt-1 text-lg font-semibold">
                    {review.winRatePct !== null ? `${review.winRatePct.toFixed(1)} %` : '—'}
                  </p>
                  <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    Ø R: {review.avgR !== null ? `${review.avgR >= 0 ? '+' : ''}${review.avgR.toFixed(2)}R` : '—'}
                  </p>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="label">Offen über Nacht</p>
                  <p className="num mt-1 text-lg font-semibold">{review.openDemoPositions + review.openAgentPositions}</p>
                  <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    {review.signalsToday} Signale heute gescannt
                  </p>
                </div>
              </div>

              {/* Bester & schwächster Trade */}
              {(review.bestTrade || review.worstTrade) && (
                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  {review.bestTrade && (
                    <div className="rounded-lg border p-3" style={{ borderColor: 'rgba(34,197,94,0.35)' }}>
                      <p className="label" style={{ color: 'var(--color-pos)' }}>
                        🏆 Bester Trade heute
                      </p>
                      <p className="num mt-1 font-medium">
                        {review.bestTrade.symbol} ({review.bestTrade.direction.toUpperCase()}) ·{' '}
                        <span style={{ color: 'var(--color-pos)' }}>{fmtMoney(review.bestTrade.netPnl)}</span>
                        {review.bestTrade.rMultiple !== null ? ` (${review.bestTrade.rMultiple.toFixed(2)}R)` : ''}
                      </p>
                    </div>
                  )}
                  {review.worstTrade && review.worstTrade.id !== review.bestTrade?.id && (
                    <div className="rounded-lg border p-3" style={{ borderColor: 'rgba(239,68,68,0.35)' }}>
                      <p className="label" style={{ color: 'var(--color-neg)' }}>
                        🔍 Größter Lernpunkt heute
                      </p>
                      <p className="num mt-1 font-medium">
                        {review.worstTrade.symbol} ({review.worstTrade.direction.toUpperCase()}) ·{' '}
                        <span style={{ color: 'var(--color-neg)' }}>{fmtMoney(review.worstTrade.netPnl)}</span>
                        {review.worstTrade.rMultiple !== null ? ` (${review.worstTrade.rMultiple.toFixed(2)}R)` : ''}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Reflexionspunkte & Chat-Coaching */}
              <div className="rounded-lg border p-3.5 text-xs space-y-2" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}>
                <p className="label">📝 Abend-Reflexion</p>
                <ul className="list-disc space-y-1 pl-4 leading-relaxed">
                  {review.lessons.map((l, idx) => (
                    <li key={idx}>{l}</li>
                  ))}
                </ul>
                <div className="pt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      openAssistant(
                        `Lass uns meinen heutigen Handelstag (${review.day}) kurz Revue passieren lassen: ${review.totalTrades} Trades (${review.wins}W/${review.losses}L), Netto ${review.netPnlUsd.toFixed(2)} $, Ø R ${review.avgR ?? '—'}. Worauf sollte ich morgen besonders achten?`,
                      )
                    }
                    className="tbtn px-3 py-1 text-[11px]"
                    style={{ borderColor: 'rgba(139,92,246,0.5)', color: 'var(--color-violet)' }}
                  >
                    💬 Tages-Trades im Chat besprechen
                  </button>
                  <a href="#/traden?tab=historie" className="tbtn px-3 py-1 text-[11px]">
                    Alle Trades ansehen →
                  </a>
                </div>
              </div>

              {/* Liste der heutigen Trades */}
              {review.trades.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs num">
                    <thead>
                      <tr className="label text-left">
                        <th className="py-1.5 pr-3 font-normal">Zeit</th>
                        <th className="py-1.5 pr-3 font-normal">Quelle</th>
                        <th className="py-1.5 pr-3 font-normal">Markt</th>
                        <th className="py-1.5 pr-3 font-normal">Richtung</th>
                        <th className="py-1.5 pr-3 text-right font-normal">Netto $</th>
                        <th className="py-1.5 font-normal">Ausstieg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.trades.slice(0, 10).map((tr) => (
                        <tr key={tr.id} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                          <td className="py-1.5 pr-3">{new Date(tr.exitTs).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="py-1.5 pr-3 uppercase" style={{ color: 'var(--color-mut)' }}>{tr.source}</td>
                          <td className="py-1.5 pr-3 font-medium">{tr.symbol}</td>
                          <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                            {tr.direction.toUpperCase()}
                          </td>
                          <td className="py-1.5 pr-3 text-right" style={{ color: tr.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                            {fmtMoney(tr.netPnl)}
                          </td>
                          <td className="py-1.5" style={{ color: 'var(--color-mut)' }}>{tr.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
