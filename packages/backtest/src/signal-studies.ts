import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { classifyEvent, loadSourceCandles, TIMEFRAME_MS } from '@gladiator/market-data';
import type { Candle } from '@gladiator/strategy-engine';
import { costModelForVenue, runBacktest, type CostModel, type EvaluatorSetup } from './engine.js';
import { HINDSIGHT_MAX_BARS, type HindsightSignal, type HindsightStatus } from './hindsight.js';

const { signals, strategies, economicEvents, signalStudies } = schema;

/**
 * Autonome Signal-Studien-Engine (Welle 23):
 * Bewertet SOWOHL benutzte (`filled`/`closed`/`confirmed`) als auch verpasste/ungenutzte
 * (`expired`/`rejected`) Signale eigenständig über 5 Studien-Parameter-Varianten,
 * ordnet Sessions und echte Wirtschaftskalender-Events (±120 Min.) zu und persistiert
 * die hypothetischen Netto-Ergebnisse getrennt von `executed_trades` in `signal_studies`.
 */

export const STUDY_VARIANT_IDS = [
  'baseline',
  'wide_sl',
  'conservative_tp1',
  'runner_trail',
  'no_be',
] as const;

export type StudyVariantId = (typeof STUDY_VARIANT_IDS)[number];

export type StudyVariantSpec = {
  id: StudyVariantId;
  label: string;
  shortLabel: string;
  description: string;
};

export const STUDY_VARIANTS: StudyVariantSpec[] = [
  {
    id: 'baseline',
    label: 'Original-Signal (Baseline)',
    shortLabel: 'Original',
    description: '1× Stop-Loss, TP-Schema 50/30/20, Stop nach TP1 auf Break-Even.',
  },
  {
    id: 'wide_sl',
    label: 'Weiterer Stop-Loss (1,5× SL)',
    shortLabel: '1,5× SL',
    description: '50 % mehr Spielraum am Stop — prüft, ob Stops zu eng lagen.',
  },
  {
    id: 'conservative_tp1',
    label: '100 % Exit am TP1',
    shortLabel: '100 % TP1',
    description: 'Kompletter Gewinnmitnahme-Exit am ersten Ziel für höhere Trefferquote.',
  },
  {
    id: 'runner_trail',
    label: 'Runner + 2 % Trailing-Stop',
    shortLabel: 'Runner+Trail',
    description: 'Gewichte 30/30/40 mit 2 %-Trailing-Stop für größere Trend-Ausbrüche.',
  },
  {
    id: 'no_be',
    label: 'Ohne Break-Even nach TP1',
    shortLabel: 'Ohne BE',
    description: 'Lässt den Original-Stop nach TP1 stehen statt früh auf Einstand zu ziehen.',
  },
];

export const STUDY_EVENT_CATEGORIES = [
  'none',
  'inflation',
  'central_bank',
  'labor',
  'growth_pmi',
  'other_high_impact',
] as const;

export type StudyEventCategory = (typeof STUDY_EVENT_CATEGORIES)[number];

export type SignalUsageGroup = 'used' | 'missed';

/** Ordnet einen Signal-Status sauber in „genutzt“ vs. „verpasst/ungenutzt“ ein. */
export function usageGroupOf(status: string): SignalUsageGroup | null {
  if (status === 'filled' || status === 'closed' || status === 'confirmed') return 'used';
  if (status === 'expired' || status === 'rejected') return 'missed';
  return null;
}

export type CalendarEventLike = {
  title: string;
  currency: string | null;
  importance: number | null;
  scheduledAt: Date;
};

export type SignalEventContext = {
  eventCategory: StudyEventCategory;
  eventTitle: string | null;
  eventDeltaMin: number | null;
};

/**
 * Findet das zeitlich nächste relevante Makro-Event (importance ≥ 2) im Fenster ±windowMin
 * um den Signal-Zeitpunkt (rein deterministisch, kein Look-ahead-Fake — Kalendertermine
 * stehen vorab fest).
 */
export function classifySignalEventContext(
  signalCreatedAt: Date,
  events: readonly CalendarEventLike[],
  windowMin = 120,
): SignalEventContext {
  const ts = signalCreatedAt.getTime();
  const windowMs = windowMin * 60_000;
  let best: { event: CalendarEventLike; absMs: number; deltaMin: number; sev: number } | null = null;

  for (const e of events) {
    const deltaMs = e.scheduledAt.getTime() - ts;
    const absMs = Math.abs(deltaMs);
    if (absMs > windowMs) continue;
    const imp = e.importance ?? 1;
    if (imp < 2) continue;
    if (!best || imp > best.sev || (imp === best.sev && absMs < best.absMs)) {
      best = { event: e, absMs, deltaMin: Math.round(deltaMs / 60_000), sev: imp };
    }
  }

  if (!best) return { eventCategory: 'none', eventTitle: null, eventDeltaMin: null };

  const impact = classifyEvent({
    title: best.event.title,
    currency: best.event.currency,
    importance: best.event.importance,
  });
  const titleLower = best.event.title.toLowerCase();

  let eventCategory: StudyEventCategory = 'other_high_impact';
  if (
    impact.category === 'cpi' ||
    impact.category === 'ppi' ||
    /\b(cpi|ppi|pce|inflation|verbraucherpreis)\b/i.test(titleLower)
  ) {
    eventCategory = 'inflation';
  } else if (
    impact.category === 'fomc' ||
    impact.category === 'fed_speak' ||
    impact.category === 'rate_decision' ||
    impact.category === 'ecb' ||
    impact.category === 'boe' ||
    impact.category === 'boj' ||
    /\b(fomc|fed|ecb|ezb|boe|boj|rate\s+decision|zins|powell|lagarde)\b/i.test(titleLower)
  ) {
    eventCategory = 'central_bank';
  } else if (
    impact.category === 'nfp' ||
    impact.category === 'unemployment' ||
    impact.category === 'jobless_claims' ||
    /\b(nfp|non-?farm|payroll|unemployment|jobless|arbeitsmarkt)\b/i.test(titleLower)
  ) {
    eventCategory = 'labor';
  } else if (
    impact.category === 'gdp' ||
    impact.category === 'pmi' ||
    impact.category === 'retail' ||
    impact.category === 'consumer_sentiment' ||
    /\b(gdp|bip|pmi|ism|retail\s+sales|einzelhandel)\b/i.test(titleLower)
  ) {
    eventCategory = 'growth_pmi';
  }

  return {
    eventCategory,
    eventTitle: best.event.title.slice(0, 120),
    eventDeltaMin: best.deltaMin,
  };
}

export type SignalStudyVariantOutcome = {
  variant: StudyVariantId;
  studyStatus: HindsightStatus;
  rMultiple: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitReason: 'tp' | 'sl' | 'be' | 'trail' | null;
  exitTs: Date | null;
  barsHeld: number | null;
};

function setupForVariant(signal: HindsightSignal, variant: StudyVariantId): { setup: EvaluatorSetup; tpWeights: number[]; trailPct?: number } {
  const baseRisk = Math.abs(signal.entry - signal.stopLoss);
  const stopLoss =
    variant === 'wide_sl' && baseRisk > 0
      ? signal.direction === 'long'
        ? signal.entry - baseRisk * 1.5
        : signal.entry + baseRisk * 1.5
      : signal.stopLoss;

  const tpWeights =
    variant === 'conservative_tp1'
      ? [1]
      : variant === 'runner_trail'
        ? [0.3, 0.3, 0.4]
        : [0.5, 0.3, 0.2];

  const takeProfits = variant === 'conservative_tp1' ? signal.takeProfits.slice(0, 1) : signal.takeProfits;
  const breakEvenAfterTp1 = variant === 'no_be' ? false : true;
  const trailPct = variant === 'runner_trail' ? (signal.trailPct ?? 2) : (signal.trailPct ?? undefined);

  const setup: EvaluatorSetup = {
    direction: signal.direction,
    setupType: signal.setupType,
    entry: signal.entry,
    stopLoss,
    takeProfits,
    tpWeights,
    breakEvenAfterTp1,
    score: 0,
    riskClass: 'medium',
    confluence: [],
    session: 'off',
    emaRegime: signal.direction === 'long' ? 'above' : 'below',
    marketPhase: signal.direction === 'long' ? 'bull' : 'bear',
    ...(trailPct ? { trailPct } : {}),
  };

  return { setup, tpWeights, trailPct };
}

/**
 * Pure: wertet EIN Signal look-ahead-frei über alle 5 Studien-Varianten auf echten Kerzen aus.
 * Gibt pro Variante Netto-R, MFE (R), MAE (R), Exit-Grund und Haltedauer zurück.
 */
export function evaluateSignalStudyVariants(
  signal: HindsightSignal,
  candles: Candle[],
  timeframeMs: number,
  venue = 'binance',
  customCosts?: CostModel,
): SignalStudyVariantOutcome[] {
  const created = signal.createdAt.getTime();
  let entryIdx = -1;
  for (let k = 0; k < candles.length; k++) {
    if (candles[k]!.ts.getTime() + timeframeMs <= created) entryIdx = k;
    else break;
  }

  const noData = (variant: StudyVariantId): SignalStudyVariantOutcome => ({
    variant,
    studyStatus: 'no_data',
    rMultiple: null,
    mfeR: null,
    maeR: null,
    exitReason: null,
    exitTs: null,
    barsHeld: null,
  });

  if (entryIdx < 0 || entryIdx >= candles.length - 1) {
    return STUDY_VARIANT_IDS.map(noData);
  }

  const window = candles.slice(entryIdx, entryIdx + 1 + HINDSIGHT_MAX_BARS);
  const costs = costModelForVenue(venue, customCosts);
  const barsPerYear = Math.max(1, Math.round((365 * 86_400_000) / timeframeMs));

  return STUDY_VARIANT_IDS.map((variant) => {
    const { setup, tpWeights, trailPct } = setupForVariant(signal, variant);
    const res = runBacktest(window, {
      evaluate: (_c, i) => (i === 0 ? [setup] : []),
      initialEquity: 10_000,
      riskPctPerTrade: 1,
      costModel: costs,
      barsPerYear,
      tpWeights,
      ...(trailPct ? { trailPct } : {}),
    });
    const trade = res.trades[0];
    if (!trade) return noData(variant);
    if (trade.exitReason === 'end-of-data') {
      return {
        variant,
        studyStatus: 'open',
        rMultiple: Math.round(trade.rMultiple * 1000) / 1000,
        mfeR: Math.round(trade.mfeR * 1000) / 1000,
        maeR: Math.round(trade.maeR * 1000) / 1000,
        exitReason: null,
        exitTs: null,
        barsHeld: trade.barsHeld,
      };
    }
    return {
      variant,
      studyStatus: 'closed',
      rMultiple: Math.round(trade.rMultiple * 1000) / 1000,
      mfeR: Math.round(trade.mfeR * 1000) / 1000,
      maeR: Math.round(trade.maeR * 1000) / 1000,
      exitReason: trade.exitReason,
      exitTs: trade.exitTs,
      barsHeld: trade.barsHeld,
    };
  });
}

export type StudyBucketStats = {
  key: string;
  total: number;
  closed: number;
  open: number;
  noData: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  sumR: number;
  profitFactor: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  lowSample: boolean;
};

export type StudyRowLike = {
  signalId: string;
  strategySlug: string;
  symbol: string;
  venue: string;
  timeframe: string;
  direction: string;
  setupType: string;
  signalStatus: string;
  usageGroup: SignalUsageGroup;
  variant: StudyVariantId;
  studyStatus: HindsightStatus;
  rMultiple: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitReason: string | null;
  barsHeld: number | null;
  session: string;
  marketPhase: string;
  emaRegime: string;
  score: number;
  eventCategory: StudyEventCategory;
  eventTitle: string | null;
  eventDeltaMin: number | null;
  signalCreatedAt: Date;
  exitTs: Date | null;
};

export const STUDY_LOW_SAMPLE_THRESHOLD = 10;

export function summarizeStudyBucket(key: string, rows: readonly StudyRowLike[]): StudyBucketStats {
  const closed = rows.filter((r) => r.studyStatus === 'closed' && r.rMultiple !== null);
  const rs = closed.map((r) => r.rMultiple!);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const sumR = Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100;
  const mfes = closed.map((r) => r.mfeR).filter((v): v is number => v !== null);
  const maes = closed.map((r) => r.maeR).filter((v): v is number => v !== null);
  return {
    key,
    total: rows.length,
    closed: closed.length,
    open: rows.filter((r) => r.studyStatus === 'open').length,
    noData: rows.filter((r) => r.studyStatus === 'no_data').length,
    wins: wins.length,
    losses: losses.length,
    winRate: rs.length > 0 ? Math.round((wins.length / rs.length) * 1000) / 1000 : null,
    expectancyR: rs.length > 0 ? Math.round((sumR / rs.length) * 1000) / 1000 : null,
    sumR,
    profitFactor: rs.length === 0 || grossLoss === 0 ? null : Math.round((grossWin / grossLoss) * 100) / 100,
    avgMfeR: mfes.length > 0 ? Math.round((mfes.reduce((a, b) => a + b, 0) / mfes.length) * 100) / 100 : null,
    avgMaeR: maes.length > 0 ? Math.round((maes.reduce((a, b) => a + b, 0) / maes.length) * 100) / 100 : null,
    lowSample: closed.length < STUDY_LOW_SAMPLE_THRESHOLD,
  };
}

export type StudyCurvePoint = { ts: string; cumR: number; r: number; symbol: string };

function buildCumCurve(rows: readonly StudyRowLike[]): StudyCurvePoint[] {
  const closed = rows
    .filter((r) => r.studyStatus === 'closed' && r.rMultiple !== null)
    .sort((a, b) => a.signalCreatedAt.getTime() - b.signalCreatedAt.getTime());
  let cum = 0;
  return closed.map((r) => {
    cum = Math.round((cum + r.rMultiple!) * 100) / 100;
    return {
      ts: r.signalCreatedAt.toISOString(),
      cumR: cum,
      r: r.rMultiple!,
      symbol: r.symbol,
    };
  });
}

function groupByKey(rows: readonly StudyRowLike[], getKey: (r: StudyRowLike) => string, order?: readonly string[]): StudyBucketStats[] {
  const map = new Map<string, StudyRowLike[]>();
  for (const r of rows) {
    const k = getKey(r);
    const list = map.get(k) ?? [];
    list.push(r);
    map.set(k, list);
  }
  const keys = order ? [...order.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !order.includes(k))] : [...map.keys()].sort();
  return keys.map((k) => summarizeStudyBucket(k, map.get(k)!));
}

export type SignalStudyAnalytics = {
  activeVariant: StudyVariantId;
  summary: StudyBucketStats;
  used: StudyBucketStats;
  missed: StudyBucketStats;
  usedCurve: StudyCurvePoint[];
  missedCurve: StudyCurvePoint[];
  allCurve: StudyCurvePoint[];
  byVariant: StudyBucketStats[];
  bySession: StudyBucketStats[];
  byEvent: StudyBucketStats[];
  bySymbol: StudyBucketStats[];
  byStrategy: StudyBucketStats[];
  byDirection: StudyBucketStats[];
  scatter: Array<{
    signalId: string;
    symbol: string;
    timeframe: string;
    direction: string;
    usageGroup: SignalUsageGroup;
    session: string;
    eventCategory: StudyEventCategory;
    mfeR: number;
    maeR: number;
    rMultiple: number;
  }>;
  recentItems: Array<{
    signalId: string;
    symbol: string;
    venue: string;
    timeframe: string;
    direction: string;
    strategySlug: string;
    usageGroup: SignalUsageGroup;
    signalStatus: string;
    studyStatus: HindsightStatus;
    rMultiple: number | null;
    mfeR: number | null;
    maeR: number | null;
    exitReason: string | null;
    barsHeld: number | null;
    session: string;
    eventCategory: StudyEventCategory;
    eventTitle: string | null;
    eventDeltaMin: number | null;
    score: number;
    signalCreatedAt: string;
  }>;
};

/**
 * Berechnet alle Labor-Statistiken & Grafik-Daten aus einem Satz Studien-Zeilen.
 * `allVariantRows` enthält bereits die nach Kontext (Symbol/Session/Event/Usage/Strategie)
 * gefilterten Zeilen über ALLE 5 Varianten, damit `byVariant` fair dieselben Signale vergleicht.
 */
export function buildSignalStudyAnalytics(
  allVariantRows: readonly StudyRowLike[],
  activeVariant: StudyVariantId = 'baseline',
): SignalStudyAnalytics {
  const selected = allVariantRows.filter((r) => r.variant === activeVariant);
  const usedRows = selected.filter((r) => r.usageGroup === 'used');
  const missedRows = selected.filter((r) => r.usageGroup === 'missed');

  const scatter = selected
    .filter((r) => r.studyStatus === 'closed' && r.rMultiple !== null && r.mfeR !== null && r.maeR !== null)
    .slice(0, 250)
    .map((r) => ({
      signalId: r.signalId,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      usageGroup: r.usageGroup,
      session: r.session,
      eventCategory: r.eventCategory,
      mfeR: r.mfeR!,
      maeR: r.maeR!,
      rMultiple: r.rMultiple!,
    }));

  const recentItems = [...selected]
    .sort((a, b) => b.signalCreatedAt.getTime() - a.signalCreatedAt.getTime())
    .slice(0, 80)
    .map((r) => ({
      signalId: r.signalId,
      symbol: r.symbol,
      venue: r.venue,
      timeframe: r.timeframe,
      direction: r.direction,
      strategySlug: r.strategySlug,
      usageGroup: r.usageGroup,
      signalStatus: r.signalStatus,
      studyStatus: r.studyStatus,
      rMultiple: r.rMultiple,
      mfeR: r.mfeR,
      maeR: r.maeR,
      exitReason: r.exitReason,
      barsHeld: r.barsHeld,
      session: r.session,
      eventCategory: r.eventCategory,
      eventTitle: r.eventTitle,
      eventDeltaMin: r.eventDeltaMin,
      score: r.score,
      signalCreatedAt: r.signalCreatedAt.toISOString(),
    }));

  return {
    activeVariant,
    summary: summarizeStudyBucket('all', selected),
    used: summarizeStudyBucket('used', usedRows),
    missed: summarizeStudyBucket('missed', missedRows),
    usedCurve: buildCumCurve(usedRows),
    missedCurve: buildCumCurve(missedRows),
    allCurve: buildCumCurve(selected),
    byVariant: groupByKey(allVariantRows, (r) => r.variant, STUDY_VARIANT_IDS),
    bySession: groupByKey(selected, (r) => r.session, ['asia', 'london', 'overlap', 'newyork', 'off']),
    byEvent: groupByKey(selected, (r) => r.eventCategory, STUDY_EVENT_CATEGORIES),
    bySymbol: groupByKey(selected, (r) => r.symbol),
    byStrategy: groupByKey(selected, (r) => r.strategySlug),
    byDirection: groupByKey(selected, (r) => r.direction, ['long', 'short']),
    scatter,
    recentItems,
  };
}

export type SignalStudyBatchResult = {
  signalsChecked: number;
  signalsEvaluated: number;
  rowsUpserted: number;
  skippedClosed: number;
};

/**
 * Autonomer Studien-Lauf (Worker alle 30 Min. + Sofort-Auslöser im Labor):
 * Liest alle genutzten (`filled`/`closed`/`confirmed`) und ungenutzten (`expired`/`rejected`)
 * Signale, rechnet fehlende oder noch offene Studien gegen echte Folge-Kerzen & Kalender-Events
 * über alle 5 Varianten nach und persistiert sie in `signal_studies`.
 */
export async function runSignalStudiesBatch(
  db: Db,
  opts: { limit?: number; forceReeval?: boolean } = {},
): Promise<SignalStudyBatchResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 300), 500);
  const sigRows = await db
    .select({
      id: signals.id,
      strategyId: signals.strategyId,
      strategySlug: strategies.slug,
      symbol: signals.symbol,
      venue: signals.venue,
      timeframe: signals.timeframe,
      direction: signals.direction,
      setupType: signals.setupType,
      entry: signals.entry,
      stopLoss: signals.stopLoss,
      takeProfits: signals.takeProfits,
      trailPct: signals.trailPct,
      score: signals.score,
      session: signals.session,
      marketPhase: signals.marketPhase,
      emaRegime: signals.emaRegime,
      status: signals.status,
      createdAt: signals.createdAt,
    })
    .from(signals)
    .innerJoin(strategies, eq(strategies.id, signals.strategyId))
    .where(inArray(signals.status, ['filled', 'closed', 'confirmed', 'expired', 'rejected']))
    .orderBy(desc(signals.createdAt))
    .limit(limit);

  if (sigRows.length === 0) {
    return { signalsChecked: 0, signalsEvaluated: 0, rowsUpserted: 0, skippedClosed: 0 };
  }

  // Bereits vollständig abgeschlossene Signale überspringen (außer forceReeval = true)
  const existing = await db
    .select({
      signalId: signalStudies.signalId,
      variant: signalStudies.variant,
      studyStatus: signalStudies.studyStatus,
      signalStatus: signalStudies.signalStatus,
    })
    .from(signalStudies)
    .where(inArray(signalStudies.signalId, sigRows.map((s) => s.id)));

  const existingBySig = new Map<string, typeof existing>();
  for (const e of existing) {
    const list = existingBySig.get(e.signalId) ?? [];
    list.push(e);
    existingBySig.set(e.signalId, list);
  }

  // Alle relevanten Kalender-Events im Gesamtzeitraum in EINER Abfrage laden
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const s of sigRows) {
    const t = s.createdAt.getTime();
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  const eventRows = await db
    .select({
      title: economicEvents.title,
      currency: economicEvents.currency,
      importance: economicEvents.importance,
      scheduledAt: economicEvents.scheduledAt,
    })
    .from(economicEvents)
    .where(
      and(
        gte(economicEvents.scheduledAt, new Date(minTs - 3 * 3_600_000)),
        lte(economicEvents.scheduledAt, new Date(maxTs + 3 * 3_600_000)),
      ),
    );

  let signalsEvaluated = 0;
  let rowsUpserted = 0;
  let skippedClosed = 0;
  const now = new Date();

  for (const s of sigRows) {
    const usageGroup = usageGroupOf(s.status);
    if (!usageGroup) continue;

    if (!opts.forceReeval) {
      const prev = existingBySig.get(s.id) ?? [];
      const allDone =
        prev.length >= STUDY_VARIANT_IDS.length &&
        prev.every((p) => p.studyStatus === 'closed' && p.signalStatus === s.status);
      if (allDone) {
        skippedClosed++;
        continue;
      }
    }

    const tfMs = (TIMEFRAME_MS as Record<string, number>)[s.timeframe];
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

    const candles = tfMs
      ? await loadSourceCandles(db, {
          venue: s.venue,
          symbol: s.symbol,
          timeframe: s.timeframe,
          since: new Date(s.createdAt.getTime() - 3 * tfMs),
          until: new Date(s.createdAt.getTime() + (HINDSIGHT_MAX_BARS + 2) * tfMs),
        })
      : [];

    const outcomes = tfMs
      ? evaluateSignalStudyVariants(sig, candles, tfMs, s.venue)
      : STUDY_VARIANT_IDS.map((variant) => ({
          variant,
          studyStatus: 'no_data' as const,
          rMultiple: null,
          mfeR: null,
          maeR: null,
          exitReason: null,
          exitTs: null,
          barsHeld: null,
        }));

    const eventCtx = classifySignalEventContext(s.createdAt, eventRows, 120);
    signalsEvaluated++;

    for (const o of outcomes) {
      await db
        .insert(signalStudies)
        .values({
          signalId: s.id,
          strategyId: s.strategyId,
          strategySlug: s.strategySlug,
          symbol: s.symbol,
          venue: s.venue,
          timeframe: s.timeframe,
          direction: s.direction,
          setupType: s.setupType,
          signalStatus: s.status,
          usageGroup,
          variant: o.variant,
          studyStatus: o.studyStatus,
          rMultiple: o.rMultiple === null ? null : String(o.rMultiple),
          mfeR: o.mfeR === null ? null : String(o.mfeR),
          maeR: o.maeR === null ? null : String(o.maeR),
          exitReason: o.exitReason,
          barsHeld: o.barsHeld,
          session: s.session,
          marketPhase: s.marketPhase,
          emaRegime: s.emaRegime,
          score: String(s.score),
          eventCategory: eventCtx.eventCategory,
          eventTitle: eventCtx.eventTitle,
          eventDeltaMin: eventCtx.eventDeltaMin,
          signalCreatedAt: s.createdAt,
          exitTs: o.exitTs,
          evaluatedAt: now,
        })
        .onConflictDoUpdate({
          target: [signalStudies.signalId, signalStudies.variant],
          set: {
            signalStatus: s.status,
            usageGroup,
            studyStatus: o.studyStatus,
            rMultiple: o.rMultiple === null ? null : String(o.rMultiple),
            mfeR: o.mfeR === null ? null : String(o.mfeR),
            maeR: o.maeR === null ? null : String(o.maeR),
            exitReason: o.exitReason,
            barsHeld: o.barsHeld,
            eventCategory: eventCtx.eventCategory,
            eventTitle: eventCtx.eventTitle,
            eventDeltaMin: eventCtx.eventDeltaMin,
            exitTs: o.exitTs,
            evaluatedAt: now,
          },
        });
      rowsUpserted++;
    }
  }

  return { signalsChecked: sigRows.length, signalsEvaluated, rowsUpserted, skippedClosed };
}
