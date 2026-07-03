import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { buildAccountState, loadRiskSettings } from '@gladiator/exchange';
import { getMacroSnapshot, latestNews, upcomingEvents } from '@gladiator/market-data';
import { CostGuard, envAnthropicProvider, guardedComplete } from '@gladiator/agents';
import { escapeHtml, sendTelegram, telegramConfigured } from './telegram.js';

const { briefings, executedTrades, signals, signalReviews, riskGates, users } = schema;

/**
 * Nacht-Pipeline + Morning-Briefing (08_ §5/§7): sammelt NUR echte Daten
 * (Konto, Gestern-Trades, offene Signale mit Schwarm-Urteil, Regime/GRS,
 * High-Impact-Events heute, Gates, News) und rendert deterministisch.
 * Optionale LLM-Erkenntnis NUR mit Provider — nie erfunden. Ein Briefing
 * pro UTC-Tag (idempotent); Versand via Telegram, wenn konfiguriert.
 */

export type BriefingData = {
  day: string;
  regime: { grs: number; label: string; vix: number | null; dxy: number | null; us10yPct: number | null } | null;
  account: { equity: number; dailyPnlPct: number; weeklyPnlPct: number; openPositions: number; consecutiveLosses: number };
  yesterday: { closedTrades: number; netPnl: number; wins: number };
  openSignals: { symbol: string; timeframe: string; direction: string; score: number; portfolioVote: string | null }[];
  highImpactEventsToday: { title: string; currency: string | null; timeUtc: string }[];
  activeGates: number;
  killSwitchActive: boolean;
  news: { source: string; title: string }[];
  llmInsight: string | null;
};

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)} %`;

/** Deterministischer Renderer (Telegram-HTML) — pure, TDD. */
export function renderBriefing(d: BriefingData): string {
  const lines: string[] = [];
  lines.push(`☀️ <b>Gladiator Morning-Briefing</b> · ${d.day}`);
  if (d.killSwitchActive) lines.push('🛑 <b>KILL-SWITCH AKTIV</b> — keine neuen Orders!');

  if (d.regime) {
    lines.push(
      `🧭 Regime: GRS <b>${Math.round(d.regime.grs)}</b> (${escapeHtml(d.regime.label)})` +
        ` · VIX ${d.regime.vix?.toFixed(1) ?? '—'} · DXY ${d.regime.dxy?.toFixed(1) ?? '—'} · US10Y ${d.regime.us10yPct?.toFixed(2) ?? '—'} %`,
    );
  } else {
    lines.push('🧭 Regime: Makro-Daten nicht verfügbar (Sync ausstehend) — keine erfundenen Werte.');
  }

  lines.push(
    `💼 Konto: <b>${d.account.equity.toLocaleString('de-DE', { maximumFractionDigits: 0 })} $</b>` +
      ` · Tag ${pct(d.account.dailyPnlPct)} · Woche ${pct(d.account.weeklyPnlPct)}` +
      ` · ${d.account.openPositions} offene Position(en)` +
      (d.account.consecutiveLosses > 0 ? ` · Verlustserie ${d.account.consecutiveLosses}` : ''),
  );

  lines.push(
    `📊 Gestern: ${d.yesterday.closedTrades} Trade(s), netto ${d.yesterday.netPnl >= 0 ? '+' : ''}${d.yesterday.netPnl.toFixed(2)} $` +
      (d.yesterday.closedTrades > 0 ? ` (${d.yesterday.wins} Gewinner)` : ''),
  );

  if (d.openSignals.length > 0) {
    lines.push('📡 Offene Signale:');
    for (const s of d.openSignals.slice(0, 5)) {
      lines.push(
        `  • ${s.direction === 'long' ? '🟢' : '🔴'} ${escapeHtml(s.symbol)} ${escapeHtml(s.timeframe)} · Score ${s.score.toFixed(1)}` +
          (s.portfolioVote ? ` · Schwarm: ${escapeHtml(s.portfolioVote)}` : ''),
      );
    }
  } else {
    lines.push('📡 Keine offenen Signale — die Engine wartet auf vollständige Confluences.');
  }

  if (d.highImpactEventsToday.length > 0) {
    lines.push('📅 High-Impact heute (No-Trade ±30 min):');
    for (const e of d.highImpactEventsToday.slice(0, 6)) {
      lines.push(`  • ${e.timeUtc} UTC ${escapeHtml(e.title)} (${escapeHtml(e.currency ?? '—')})`);
    }
  } else {
    lines.push('📅 Keine High-Impact-Events heute.');
  }

  lines.push(`🛡 Risk: ${d.activeGates} aktive Gates · SAFE-Regeln scharf.`);

  if (d.news.length > 0) {
    lines.push('📰 ' + d.news.slice(0, 3).map((n) => escapeHtml(n.title)).join(' · '));
  }

  if (d.llmInsight) {
    lines.push(`🤖 KI-Erkenntnis: ${escapeHtml(d.llmInsight)}`);
  }

  return lines.join('\n');
}

const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

/** Sammelt ausschließlich echte Daten für das Briefing. */
export async function buildBriefing(db: Db, now = new Date()): Promise<BriefingData> {
  const day = now.toISOString().slice(0, 10);
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) throw new Error('kein User vorhanden — Briefing ohne Konto-Kontext nicht möglich.');

  const state = await buildAccountState(db, user.id, now);
  const settings = await loadRiskSettings(db, user.id);
  const macro = await getMacroSnapshot(db);

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayStart = new Date(dayStart.getTime() - 86_400_000);
  const closed = await db
    .select()
    .from(executedTrades)
    .where(and(eq(executedTrades.userId, user.id), gte(executedTrades.createdAt, yesterdayStart)))
    .orderBy(desc(executedTrades.createdAt))
    .limit(100);
  const yesterdayTrades = closed.filter((t) => t.exitTs && t.exitTs >= yesterdayStart && t.exitTs < dayStart);

  const openSignalRows = await db
    .select()
    .from(signals)
    .where(eq(signals.status, 'new'))
    .orderBy(desc(signals.createdAt))
    .limit(5);
  const openSignals = [];
  for (const s of openSignalRows) {
    const [portfolio] = await db
      .select({ vote: signalReviews.vote })
      .from(signalReviews)
      .where(and(eq(signalReviews.signalId, s.id), eq(signalReviews.agent, 'portfolio')))
      .limit(1);
    openSignals.push({
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: s.direction,
      score: Number(s.score),
      portfolioVote: portfolio?.vote ?? null,
    });
  }

  const events = await upcomingEvents(db, { from: now, days: 1 });
  const highImpactEventsToday = events
    .filter((e) => (e.importance ?? 0) >= 3 && e.scheduledAt.toISOString().slice(0, 10) === day)
    .map((e) => ({
      title: e.title,
      currency: e.currency,
      timeUtc: `${String(e.scheduledAt.getUTCHours()).padStart(2, '0')}:${String(e.scheduledAt.getUTCMinutes()).padStart(2, '0')}`,
    }));

  const gates = await db.select().from(riskGates).where(eq(riskGates.isActive, true));
  const news = (await latestNews(db, 3)).map((n) => ({ source: n.source, title: n.title }));

  // Optionale LLM-Erkenntnis (08_ §5 Schritt 5) — NUR mit Provider, sonst null.
  let llmInsight: string | null = null;
  const llmProvider = envAnthropicProvider();
  if (llmProvider.configured && yesterdayTrades.length > 0) {
    try {
      const completion = await guardedComplete(llmProvider, llmGuard, {
        system:
          'Du bist der Analyse-Agent des Gladiator-Trading-Systems. Fasse in EINEM deutschen Satz die wichtigste, DATENGESTÜTZTE Erkenntnis aus den gestrigen Trades zusammen. Keine Spekulation über Daten, die du nicht siehst.',
        prompt: JSON.stringify(
          yesterdayTrades.map((t) => ({
            symbol: t.symbol,
            direction: t.direction,
            netPnl: Number(t.netPnl ?? 0),
            rMultiple: t.rMultiple ? Number(t.rMultiple) : null,
          })),
        ),
        maxTokens: 200,
      });
      llmInsight = completion.text.trim().slice(0, 300) || null;
    } catch (err) {
      console.warn('[briefing] LLM-Erkenntnis übersprungen:', String(err));
    }
  }

  return {
    day,
    regime:
      macro.fresh && macro.grs
        ? {
            grs: macro.grs.score,
            label: macro.grs.label,
            vix: macro.vix?.value ?? null,
            dxy: macro.dxy?.value ?? null,
            us10yPct: macro.us10y?.value ?? null,
          }
        : null,
    account: {
      equity: state.equity,
      dailyPnlPct: state.dailyPnlPct,
      weeklyPnlPct: state.weeklyPnlPct,
      openPositions: state.openPositions,
      consecutiveLosses: state.consecutiveLosses,
    },
    yesterday: {
      closedTrades: yesterdayTrades.length,
      netPnl: yesterdayTrades.reduce((a, t) => a + Number(t.netPnl ?? 0), 0),
      wins: yesterdayTrades.filter((t) => Number(t.netPnl ?? 0) > 0).length,
    },
    openSignals,
    highImpactEventsToday,
    activeGates: gates.length,
    killSwitchActive: settings.killSwitchActive,
    news,
    llmInsight,
  };
}

export type NightPipelineResult = { day: string; created: boolean; sent: boolean };

/** Nacht-Pipeline: Briefing bauen → persistieren (1×/Tag, idempotent) → Telegram. */
export async function runNightPipeline(db: Db, now = new Date()): Promise<NightPipelineResult> {
  const day = now.toISOString().slice(0, 10);
  const [existing] = await db.select().from(briefings).where(eq(briefings.day, day)).limit(1);
  if (existing) {
    // Bereits erzeugt — ggf. Versand nachholen, falls Telegram erst später konfiguriert wurde.
    if (!existing.sentAt && telegramConfigured()) {
      const ok = await sendTelegram(existing.text);
      if (ok) await db.update(briefings).set({ sentAt: new Date() }).where(eq(briefings.id, existing.id));
      return { day, created: false, sent: ok };
    }
    return { day, created: false, sent: existing.sentAt !== null };
  }

  const data = await buildBriefing(db, now);
  const text = renderBriefing(data);
  const [row] = await db.insert(briefings).values({ day, content: data, text }).returning();

  let sent = false;
  if (telegramConfigured()) {
    sent = await sendTelegram(text);
    if (sent) await db.update(briefings).set({ sentAt: new Date() }).where(eq(briefings.id, row!.id));
  }
  return { day, created: true, sent };
}

/** Neuestes Briefing (Dashboard-Panel). */
export async function latestBriefing(db: Db) {
  const [row] = await db.select().from(briefings).orderBy(desc(briefings.day)).limit(1);
  return row ?? null;
}
