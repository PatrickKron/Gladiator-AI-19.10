import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import type { Candle } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type CostModel, type EvaluatorSetup } from './engine.js';

const { signals } = schema;

/**
 * „Was wäre passiert" (OFFENER_PLAN §3): Engine-Signale werden nur durch
 * Patricks Bestätigung oder einen seiner Agenten ausgeführt — fast alle laufen
 * deshalb unbearbeitet ab. Diese Auswertung rechnet abgelaufene Signale mit
 * DERSELBEN Backtest-Engine auf den echten Kerzen danach nach: Entry zum
 * Signal-Preis am Close der letzten geschlossenen Kerze (wie eine Bestätigung
 * sofort), Stop zuerst, TP-Gewichte, Break-Even, Trailing, netto nach Kosten.
 * Hypothetisch und so gekennzeichnet — fließt NICHT in echte Trade-Statistiken.
 */

export type HindsightSignal = {
  id: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  trailPct: number | null;
  createdAt: Date;
};

export type HindsightStatus = 'closed' | 'open' | 'no_data';

export type HindsightOutcome = {
  status: HindsightStatus;
  /** Netto-R (bei 'open' auf den letzten Close); null ohne Daten. */
  rMultiple: number | null;
  exitReason: 'tp' | 'sl' | 'be' | 'trail' | null;
  exitTs: Date | null;
  barsHeld: number | null;
};

/** Max. Kerzen nach dem Signal, die nachgerechnet werden (danach ehrlich „noch offen"). */
export const HINDSIGHT_MAX_BARS = 500;

/**
 * Pure: Ergebnis eines Signals auf gegebenen Kerzen (aufsteigend, ts = Kerzen-Open).
 * Entry-Kerze = letzte Kerze, die zum Signal-Zeitpunkt GESCHLOSSEN war — kein Look-ahead.
 */
export function hindsightOutcome(
  signal: HindsightSignal,
  candles: Candle[],
  timeframeMs: number,
  costs: CostModel = DEFAULT_COSTS,
): HindsightOutcome {
  const none: HindsightOutcome = { status: 'no_data', rMultiple: null, exitReason: null, exitTs: null, barsHeld: null };
  const created = signal.createdAt.getTime();
  let entryIdx = -1;
  for (let k = 0; k < candles.length; k++) {
    if (candles[k]!.ts.getTime() + timeframeMs <= created) entryIdx = k;
    else break;
  }
  if (entryIdx < 0 || entryIdx >= candles.length - 1) return none; // keine Folge-Kerze → nichts zu sagen

  const window = candles.slice(entryIdx, entryIdx + 1 + HINDSIGHT_MAX_BARS);
  // Nur die Ausstiegs-Mechanik zählt; Score/Session/Regime sind hier reine Füllwerte.
  const setup: EvaluatorSetup = {
    direction: signal.direction,
    setupType: signal.setupType,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfits: signal.takeProfits,
    score: 0,
    riskClass: 'medium',
    confluence: [],
    session: 'off',
    emaRegime: signal.direction === 'long' ? 'above' : 'below',
    marketPhase: signal.direction === 'long' ? 'bull' : 'bear',
    ...(signal.trailPct ? { trailPct: signal.trailPct } : {}),
  };
  const result = runBacktest(window, {
    evaluate: (_c, i) => (i === 0 ? [setup] : []),
    initialEquity: 10_000,
    riskPctPerTrade: 1,
    costModel: costs,
    barsPerYear: Math.round((365 * 86_400_000) / timeframeMs),
    tpWeights: [0.5, 0.3, 0.2],
  });
  const trade = result.trades[0];
  if (!trade) return none; // z. B. Stop auf Entry-Höhe → kein gültiges Risiko
  const reason = trade.exitReason;
  const open = reason === 'end-of-data';
  return {
    status: open ? 'open' : 'closed',
    rMultiple: trade.rMultiple,
    exitReason: reason === 'end-of-data' ? null : reason,
    exitTs: open ? null : trade.exitTs,
    barsHeld: trade.barsHeld,
  };
}

export type HindsightSummary = {
  total: number;
  closed: number;
  open: number;
  noData: number;
  wins: number;
  losses: number;
  /** Nur abgeschlossene; null wenn keine. */
  winRate: number | null;
  expectancyR: number | null;
  sumR: number;
  profitFactor: number | null;
};

export function summarizeHindsight(items: { status: HindsightStatus; rMultiple: number | null }[]): HindsightSummary {
  const closed = items.filter((i) => i.status === 'closed' && i.rMultiple !== null);
  const rs = closed.map((i) => i.rMultiple!);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, r) => a + r, 0);
  const grossLoss = -losses.reduce((a, r) => a + r, 0);
  const sumR = rs.reduce((a, r) => a + r, 0);
  return {
    total: items.length,
    closed: closed.length,
    open: items.filter((i) => i.status === 'open').length,
    noData: items.filter((i) => i.status === 'no_data').length,
    wins: wins.length,
    losses: losses.length,
    winRate: rs.length ? wins.length / rs.length : null,
    expectancyR: rs.length ? sumR / rs.length : null,
    sumR,
    profitFactor: rs.length === 0 ? null : grossLoss === 0 ? null : grossWin / grossLoss,
  };
}

const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export type HindsightItem = HindsightOutcome & {
  signalId: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: string;
  source: string;
  score: number;
  createdAt: Date;
};

/** Abgelaufene Signale (neueste zuerst, max. limit) gegen echte Kerzen nachrechnen. */
export async function evaluateExpiredSignals(
  db: Db,
  opts: { limit?: number; strategyIds?: string[] } = {},
): Promise<{ items: HindsightItem[]; summary: HindsightSummary }> {
  const where = opts.strategyIds?.length
    ? and(eq(signals.status, 'expired'), inArray(signals.strategyId, opts.strategyIds))
    : eq(signals.status, 'expired');
  const rows = await db
    .select()
    .from(signals)
    .where(where)
    .orderBy(desc(signals.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));

  const items: HindsightItem[] = [];
  for (const s of rows) {
    const tfMs = TF_MS[s.timeframe];
    const sig: HindsightSignal = {
      id: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: s.direction,
      setupType: s.setupType,
      entry: Number(s.entry),
      stopLoss: Number(s.stopLoss),
      takeProfits: (s.takeProfits as string[]).map(Number),
      trailPct: s.trailPct === null ? null : Number(s.trailPct),
      createdAt: s.createdAt,
    };
    let outcome: HindsightOutcome = { status: 'no_data', rMultiple: null, exitReason: null, exitTs: null, barsHeld: null };
    if (tfMs) {
      const candles = await getOhlcv(db, {
        symbol: s.symbol,
        timeframe: s.timeframe,
        since: new Date(s.createdAt.getTime() - 3 * tfMs),
        until: new Date(s.createdAt.getTime() + (HINDSIGHT_MAX_BARS + 2) * tfMs),
      });
      outcome = hindsightOutcome(sig, candles, tfMs);
    }
    items.push({
      ...outcome,
      signalId: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: s.direction,
      setupType: s.setupType,
      source: s.source,
      score: Number(s.score),
      createdAt: s.createdAt,
    });
  }
  return { items, summary: summarizeHindsight(items) };
}
