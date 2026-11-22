import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { notifySafe } from './notify.js';

const { demoPositions, demoTrades, executedTrades, positions, signals, users } = schema;

/**
 * Tägliches Abend-Trade-Review (Welle 18):
 * Fasst alle echten Trades des Tages (Demo + Agent/Live) netto zusammen,
 * ermittelt besten/schwächsten Trade, Trefferquote, Ø R-Multiple, offene
 * Positionen und generiert klare, deterministische Reflexionspunkte.
 * Kein Fake: 0 Trades → ehrliche Tages-Zusammenfassung ohne erfundene Werte.
 */

export type ReviewTradeItem = {
  id: string;
  source: 'demo' | 'agent';
  symbol: string;
  direction: 'long' | 'short';
  netPnl: number;
  rMultiple: number | null;
  reason: string;
  exitTs: string;
};

export type EveningReviewSummary = {
  day: string;
  totalTrades: number;
  demoTradesCount: number;
  agentTradesCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  avgR: number | null;
  bestTrade: ReviewTradeItem | null;
  worstTrade: ReviewTradeItem | null;
  openDemoPositions: number;
  openAgentPositions: number;
  signalsToday: number;
  trades: ReviewTradeItem[];
  lessons: string[];
  headline: string;
};

/** Pure, deterministische Auswertung für TDD & Live-Endpunkt. */
export function summarizeEveningReview(input: {
  day: string;
  trades: ReviewTradeItem[];
  openDemoPositions: number;
  openAgentPositions: number;
  signalsToday: number;
}): EveningReviewSummary {
  const sorted = [...input.trades].sort((a, b) => Date.parse(b.exitTs) - Date.parse(a.exitTs));
  const totalTrades = sorted.length;
  const demoTradesCount = sorted.filter((t) => t.source === 'demo').length;
  const agentTradesCount = sorted.filter((t) => t.source === 'agent').length;
  const wins = sorted.filter((t) => t.netPnl > 0).length;
  const losses = sorted.filter((t) => t.netPnl < 0).length;
  const winRatePct = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : null;
  const netPnlUsd = Math.round(sorted.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;

  const rVals = sorted.map((t) => t.rMultiple).filter((v): v is number => v !== null && Number.isFinite(v));
  const avgR = rVals.length > 0 ? Math.round((rVals.reduce((s, v) => s + v, 0) / rVals.length) * 100) / 100 : null;

  let bestTrade: ReviewTradeItem | null = null;
  let worstTrade: ReviewTradeItem | null = null;
  for (const t of sorted) {
    if (!bestTrade || t.netPnl > bestTrade.netPnl) bestTrade = t;
    if (!worstTrade || t.netPnl < worstTrade.netPnl) worstTrade = t;
  }

  const lessons: string[] = [];
  if (totalTrades === 0) {
    lessons.push('Heute wurden keine Trades geschlossen — Geduld und selektives Abwarten schützen Kapital.');
    if (input.openDemoPositions + input.openAgentPositions > 0) {
      lessons.push(
        `Noch ${input.openDemoPositions + input.openAgentPositions} offene Position(en) — prüfe vor dem Tagesabschluss, ob alle Stop-Loss-Orders sitzen.`,
      );
    }
  } else {
    if (netPnlUsd >= 0) {
      lessons.push(`Positiver Handelstag (+${netPnlUsd.toFixed(2)} $ netto bei ${wins}/${totalTrades} Gewinnern) — erfolgreiche Setups kurz notieren.`);
    } else {
      lessons.push(`Negativer Handelstag (${netPnlUsd.toFixed(2)} $ netto) — prüfe beim schwächsten Trade, ob Einstieg und Stop-Loss regelkonform waren.`);
    }
    if (avgR !== null && avgR < 0) {
      lessons.push(`Durchschnittliches R liegt bei ${avgR.toFixed(2)}R — achte darauf, Gewinner laufen zu lassen und Verluste strikt am Plan-Stop zu kappen.`);
    } else if (avgR !== null && avgR >= 0.5) {
      lessons.push(`Starkes Chance-Risiko-Verhältnis (${avgR.toFixed(2)}R Ø) — dein Trade-Management zahlt sich aus.`);
    }
    const slCount = sorted.filter((t) => t.reason === 'sl').length;
    if (slCount >= 3 && slCount / totalTrades >= 0.6) {
      lessons.push(`${slCount} von ${totalTrades} Trades liefen in den Stop-Loss — prüfe, ob der Stop zu eng an der aktuellen Volatilität (ATR) lag.`);
    }
    if (totalTrades >= 8) {
      lessons.push(`Hohe Aktivität (${totalTrades} Trades heute) — Overtrading-Check: Waren alle Setups A+-Qualität?`);
    }
  }

  const headline =
    totalTrades === 0
      ? `Tagesabschluss ${input.day}: Keine geschlossenen Trades (${input.openDemoPositions + input.openAgentPositions} offen)`
      : `Tagesabschluss ${input.day}: ${totalTrades} Trade(s) · ${netPnlUsd >= 0 ? '+' : ''}${netPnlUsd.toFixed(2)} $ netto (${wins}W / ${losses}L)`;

  return {
    day: input.day,
    totalTrades,
    demoTradesCount,
    agentTradesCount,
    wins,
    losses,
    winRatePct,
    netPnlUsd,
    avgR,
    bestTrade,
    worstTrade,
    openDemoPositions: input.openDemoPositions,
    openAgentPositions: input.openAgentPositions,
    signalsToday: input.signalsToday,
    trades: sorted.slice(0, 25),
    lessons,
    headline,
  };
}

/** Lädt alle echten Trades, offenen Positionen und Signale des heutigen Tages aus der DB. */
export async function buildEveningReview(db: Db, userId: string, now = new Date()): Promise<EveningReviewSummary> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const day = dayStart.toISOString().slice(0, 10);

  const [demoClosed, agentClosed, openDemo, openAgent, todaySignals] = await Promise.all([
    db
      .select()
      .from(demoTrades)
      .where(and(eq(demoTrades.userId, userId), gte(demoTrades.exitTs, dayStart)))
      .orderBy(desc(demoTrades.exitTs))
      .limit(100),
    db
      .select()
      .from(executedTrades)
      .where(and(eq(executedTrades.userId, userId), isNotNull(executedTrades.exitTs), gte(executedTrades.exitTs, dayStart)))
      .orderBy(desc(executedTrades.exitTs))
      .limit(100),
    db.select({ id: demoPositions.id }).from(demoPositions).where(eq(demoPositions.userId, userId)),
    db.select({ id: positions.id }).from(positions).where(eq(positions.userId, userId)),
    db.select({ id: signals.id }).from(signals).where(gte(signals.createdAt, dayStart)),
  ]);

  const trades: ReviewTradeItem[] = [
    ...demoClosed.map((t) => ({
      id: t.id,
      source: 'demo' as const,
      symbol: t.symbol,
      direction: t.direction,
      netPnl: Number(t.netPnl),
      rMultiple: t.rMultiple !== null ? Number(t.rMultiple) : null,
      reason: t.reason,
      exitTs: t.exitTs.toISOString(),
    })),
    ...agentClosed.map((t) => ({
      id: t.id,
      source: 'agent' as const,
      symbol: t.symbol,
      direction: t.direction,
      netPnl: Number(t.netPnl),
      rMultiple: t.rMultiple !== null ? Number(t.rMultiple) : null,
      reason: t.mode,
      exitTs: (t.exitTs ?? t.entryTs).toISOString(),
    })),
  ];

  return summarizeEveningReview({
    day,
    trades,
    openDemoPositions: openDemo.length,
    openAgentPositions: openAgent.length,
    signalsToday: todaySignals.length,
  });
}

let lastNotifiedDay: string | null = null;

/** Sendet abends eine einmalige Tages-Review-Benachrichtigung pro Tag (In-App + Telegram, falls aktiv). */
export async function runEveningReviewNotification(db: Db, now = new Date()): Promise<{ sent: boolean; day: string }> {
  const day = now.toISOString().slice(0, 10);
  if (lastNotifiedDay === day) return { sent: false, day };
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  if (!user) return { sent: false, day };

  const review = await buildEveningReview(db, user.id, now);
  lastNotifiedDay = day;
  const body = [
    review.headline,
    review.avgR !== null ? `Ø R-Multiple: ${review.avgR >= 0 ? '+' : ''}${review.avgR.toFixed(2)}R` : null,
    review.bestTrade ? `Bester Trade: ${review.bestTrade.symbol} (${review.bestTrade.netPnl >= 0 ? '+' : ''}${review.bestTrade.netPnl.toFixed(2)} $)` : null,
    review.lessons[0] ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

  await notifySafe(db, {
    userId: user.id,
    kind: 'briefing',
    severity: 'info',
    title: `🌙 Abend-Rückblick (${day})`,
    body,
    link: '#/',
  });
  return { sent: true, day };
}
