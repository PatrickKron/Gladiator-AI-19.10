import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { BARS_PER_YEAR, TIMEFRAME_MS, type SupportedTimeframe } from '@gladiator/market-data';
import {
  evaluateDslAt,
  evaluateSmcCoreAt,
  parseInstructionDsl,
  SMC_CORE_DEFAULTS,
  type InstructionDsl,
  type SmcCoreParams,
} from '@gladiator/strategy-engine';
import {
  DEFAULT_COSTS,
  diffParams,
  dslGrid,
  loadLabMarketData,
  paramsKey,
  readProposalState,
  runOptimizationStudy,
  smcCoreGrid,
  summarizeMetrics,
  WF_WARMUP_BARS,
  type Evaluator,
  type OptimizationProposalResults,
  type OptimizationStudy,
  type StudyMarket,
} from '@gladiator/backtest';
import { BASE_SYMBOLS } from './universe.js';

const { strategies, strategyVersions, optimizations, auditLog } = schema;

/**
 * Nacht-Optimierung → VORSCHLAG (08_ §4/§5). Wöchentlich (So 03:00 UTC, vor dem
 * Morning-Briefing um 03:30, das offene Vorschläge nennt):
 *  1. je Strategie die neueste Paper-Version (DSL) bzw. SMC Core laden,
 *  2. kleines Grid (SMC: Swing-Bars × EMA-Nähe; DSL: Stop × TP-RR + Trailing),
 *  3. Walk-Forward auf ECHTEN Kerzen (Datenqualität, historisches Funding,
 *     netto) — Kandidat vs. aktuelle Version auf DENSELBEN OOS-Fenstern,
 *  4. nur bei klarem Vorsprung (judgeOptimization) eine Zeile in
 *     `optimizations` + Audit. Die laufende Version bleibt UNVERÄNDERT —
 *     übernehmen (→ neue draft-Version) und promoten entscheidet Patrick.
 */

/** In-Sample-Fenster in Bars. */
export const OPT_IS_BARS = 1000;
/** Out-of-Sample-Fenster in Bars. */
export const OPT_OOS_BARS = 250;
/** Höchstens so viele jüngste Kerzen je Markt laden (≤ 5 OOS-Fenster → Laufzeit beschränkt). */
export const OPT_MAX_BARS = OPT_IS_BARS + 5 * OPT_OOS_BARS;
/** Mindestens so viele echte Kerzen (≥ 3 OOS-Fenster), sonst wird der Markt übersprungen. */
export const OPT_MIN_BARS = OPT_IS_BARS + 3 * OPT_OOS_BARS;
/** Höchstens so viele Strategie-Versionen je Lauf. */
export const OPT_MAX_TARGETS = 10;
/** SMC Core: Märkte der Basis-Universe auf 4h, Setup swing (Labor-Standard) — gepoolt bewertet. */
export const SMC_OPT_TIMEFRAME: SupportedTimeframe = '4h';
const SMC_OPT_SETUP = 'swing' as const;

export type OptimizationRunOptions = {
  now?: Date;
  /** Nur diese Strategien (Tests, manuelle Läufe). Ohne Angabe: alle Paper-Strategien + SMC Core. */
  strategyIds?: string[];
  /** SMC-Core-Märkte (Default: Basis-Symbole). */
  smcSymbols?: string[];
};

export type OptimizationRunSummary = {
  evaluated: number;
  proposals: { strategy: string; baseVersion: number; optimizationId: string }[];
  /** Ehrlich begründet, warum kein Vorschlag entstand (zu wenig Daten, nicht klar besser …). */
  skipped: { target: string; reason: string }[];
  errors: string[];
};

type Target = {
  strategyId: string;
  slug: string;
  versionId: string;
  version: number;
  kind: 'smc' | 'dsl';
  params: unknown;
};

async function loadTargets(db: Db, opts: OptimizationRunOptions): Promise<Target[]> {
  const rows = await db
    .select({
      strategyId: strategies.id,
      slug: strategies.slug,
      kind: strategies.kind,
      versionId: strategyVersions.id,
      version: strategyVersions.version,
      params: strategyVersions.params,
    })
    .from(strategies)
    .innerJoin(strategyVersions, eq(strategyVersions.strategyId, strategies.id))
    .where(
      and(
        eq(strategies.isActive, true),
        eq(strategyVersions.status, 'paper'),
        opts.strategyIds ? inArray(strategies.id, opts.strategyIds) : undefined,
      ),
    )
    .orderBy(desc(strategyVersions.version));

  // Je Strategie nur die NEUESTE Paper-Version (wie dsl-scan); SMC Core = slug smc-core.
  const latest = new Map<string, Target>();
  for (const r of rows) {
    if (latest.has(r.strategyId)) continue;
    const kind = r.kind === 'dsl' ? 'dsl' : r.slug === 'smc-core' ? 'smc' : null;
    if (!kind) continue; // Pine-Strategien rechnet TradingView — hier nicht optimierbar
    latest.set(r.strategyId, { ...r, kind });
  }
  return [...latest.values()].slice(0, OPT_MAX_TARGETS);
}

/** Echte Kerzen + Funding je Markt; zu wenig/zu lückenhafte Daten → ehrlich übersprungen. */
async function loadMarkets(
  db: Db,
  markets: { symbol: string; timeframe: SupportedTimeframe }[],
  setupType: 'scalp' | 'swing' | 'position',
  now: Date,
  skipped: OptimizationRunSummary['skipped'],
  label: string,
): Promise<{ study: StudyMarket[]; meta: { key: string; fundingSource: 'historical' | 'model'; dataWarnings: string[] }[] }> {
  const study: StudyMarket[] = [];
  const meta: { key: string; fundingSource: 'historical' | 'model'; dataWarnings: string[] }[] = [];
  for (const m of markets) {
    const key = `${m.symbol} ${m.timeframe}`;
    const tfMs = TIMEFRAME_MS[m.timeframe];
    try {
      const data = await loadLabMarketData(db, {
        symbol: m.symbol,
        timeframe: m.timeframe,
        from: new Date(now.getTime() - OPT_MAX_BARS * tfMs),
        to: now,
        minCandles: OPT_MIN_BARS,
        minCandlesMessage: (n) => `nur ${n} echte Kerzen (≥ ${OPT_MIN_BARS} nötig für 3 OOS-Fenster)`,
      });
      study.push({
        key,
        candles: data.candles,
        base: {
          initialEquity: 10_000,
          riskPctPerTrade: 1,
          costModel: DEFAULT_COSTS,
          barsPerYear: BARS_PER_YEAR[m.timeframe]!,
          tpWeights: [0.5, 0.3, 0.2],
          setupType,
          ...(data.fundingSeries ? { fundingSeries: data.fundingSeries } : {}),
        },
      });
      meta.push({ key, fundingSource: data.fundingSource, dataWarnings: data.dataQuality.warnings });
    } catch (err) {
      skipped.push({ target: `${label} · ${key}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { study, meta };
}

/** Eventloop atmen lassen (BullMQ-Lock-Erneuerung) zwischen CPU-lastigen Studien. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function runStrategyOptimization(db: Db, opts: OptimizationRunOptions = {}): Promise<OptimizationRunSummary> {
  const now = opts.now ?? new Date();
  const summary: OptimizationRunSummary = { evaluated: 0, proposals: [], skipped: [], errors: [] };
  const targets = await loadTargets(db, opts);

  for (const target of targets) {
    const label = `${target.slug} v${target.version}`;
    try {
      let markets: Awaited<ReturnType<typeof loadMarkets>>;
      let study: OptimizationStudy<unknown>;
      let currentParams: unknown;

      if (target.kind === 'smc') {
        const current: SmcCoreParams = { ...SMC_CORE_DEFAULTS, ...(target.params as Partial<SmcCoreParams>) };
        currentParams = current;
        const symbols = opts.smcSymbols ?? BASE_SYMBOLS;
        markets = await loadMarkets(db, symbols.map((symbol) => ({ symbol, timeframe: SMC_OPT_TIMEFRAME })), SMC_OPT_SETUP, now, summary.skipped, label);
        if (markets.study.length === 0) continue;
        await breathe();
        study = runOptimizationStudy<SmcCoreParams>(markets.study, {
          current,
          grid: smcCoreGrid(current),
          makeEvaluator: (p): Evaluator => (cs, i) => evaluateSmcCoreAt(cs, i, p, { higherTfTrend: 'neutral' }),
          isBars: OPT_IS_BARS,
          oosBars: OPT_OOS_BARS,
          warmupBars: WF_WARMUP_BARS,
        }) as OptimizationStudy<unknown>;
      } else {
        const parsed = parseInstructionDsl(target.params);
        if (!parsed.ok) {
          summary.skipped.push({ target: label, reason: `DSL ungültig (${parsed.errors.join('; ')})` });
          continue;
        }
        const current = parsed.dsl;
        currentParams = current;
        markets = await loadMarkets(
          db,
          [{ symbol: current.symbol, timeframe: current.timeframe }],
          current.setupType,
          now,
          summary.skipped,
          label,
        );
        if (markets.study.length === 0) continue;
        await breathe();
        study = runOptimizationStudy<InstructionDsl>(markets.study, {
          current,
          grid: dslGrid(current),
          makeEvaluator: (d): Evaluator => (cs, i) => {
            const setup = evaluateDslAt(cs, i, d);
            return setup ? [setup] : [];
          },
          isBars: OPT_IS_BARS,
          oosBars: OPT_OOS_BARS,
          warmupBars: WF_WARMUP_BARS,
        }) as OptimizationStudy<unknown>;
      }
      summary.evaluated++;

      if (!study.verdict.passed || !study.proposal) {
        summary.skipped.push({ target: label, reason: `kein klarer Vorsprung: ${study.verdict.reasons.join(' · ')}` });
        continue;
      }

      const id = await persistProposal(db, target, currentParams, study, markets.meta, now);
      if (id) summary.proposals.push({ strategy: target.slug, baseVersion: target.version, optimizationId: id });
      else summary.skipped.push({ target: label, reason: 'identischer Vorschlag ist bereits offen' });
    } catch (err) {
      summary.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await breathe();
  }
  return summary;
}

/**
 * Vorschlag speichern (status 'done', Review-Status 'open' im results-JSON).
 * Ältere offene Vorschläge derselben Basis-Version werden 'superseded'; ein
 * identischer offener Vorschlag wird nicht doppelt angelegt (→ null).
 */
async function persistProposal(
  db: Db,
  target: Target,
  currentParams: unknown,
  study: OptimizationStudy<unknown>,
  marketMeta: { key: string; fundingSource: 'historical' | 'model'; dataWarnings: string[] }[],
  now: Date,
): Promise<string | null> {
  const proposal = study.proposal!;
  const open = await db
    .select({ id: optimizations.id, bestParams: optimizations.bestParams, results: optimizations.results, baseVersionId: optimizations.baseVersionId })
    .from(optimizations)
    .where(and(eq(optimizations.strategyId, target.strategyId), eq(optimizations.status, 'done')));
  const stillOpen = open.filter((o) => readProposalState(o.results) === 'open');
  if (stillOpen.some((o) => o.baseVersionId === target.versionId && paramsKey(o.bestParams) === paramsKey(proposal.params))) {
    return null;
  }
  for (const o of stillOpen.filter((x) => x.baseVersionId === target.versionId)) {
    const r = o.results as OptimizationProposalResults;
    await db
      .update(optimizations)
      .set({ results: { ...r, review: { state: 'superseded', at: now.toISOString(), reason: 'neuerer Vorschlag' } } })
      .where(eq(optimizations.id, o.id));
  }

  const results: OptimizationProposalResults = {
    kind: target.kind,
    strategySlug: target.slug,
    baseVersion: target.version,
    review: { state: 'open', at: null },
    window: {
      from: new Date(now.getTime() - OPT_MAX_BARS * (target.kind === 'smc' ? TIMEFRAME_MS[SMC_OPT_TIMEFRAME] : TIMEFRAME_MS[(currentParams as InstructionDsl).timeframe])).toISOString(),
      to: now.toISOString(),
      oosFrom: study.oosFrom?.toISOString() ?? null,
      oosTo: study.oosTo?.toISOString() ?? null,
      windows: study.windows,
      isBars: OPT_IS_BARS,
      oosBars: OPT_OOS_BARS,
    },
    before: summarizeMetrics(study.baseline),
    after: summarizeMetrics(study.candidate),
    holdout: study.holdout
      ? {
          fromTs: study.holdout.fromTs.toISOString(),
          tradeCount: study.holdout.tradeCount,
          expectancy: study.holdout.expectancy,
          profitFactor: study.holdout.profitFactor,
        }
      : null,
    wins: proposal.wins,
    checks: study.verdict.checks,
    changes: diffParams(currentParams, proposal.params),
    markets: study.markets.map((m) => {
      const meta = marketMeta.find((x) => x.key === m.key);
      return {
        key: m.key,
        windows: m.windows,
        before: summarizeMetrics(m.baselineOos),
        after: summarizeMetrics(m.candidateOos),
        fundingSource: meta?.fundingSource ?? 'model',
        dataWarnings: meta?.dataWarnings ?? [],
      };
    }),
  };

  const [row] = await db
    .insert(optimizations)
    .values({
      strategyId: target.strategyId,
      baseVersionId: target.versionId,
      method: 'walk-forward-grid',
      paramSpace: {
        gridSize: study.gridSize,
        isBars: OPT_IS_BARS,
        oosBars: OPT_OOS_BARS,
        warmupBars: WF_WARMUP_BARS,
        markets: study.markets.map((m) => m.key),
        costModel: DEFAULT_COSTS,
        grid: study.grid,
      },
      results,
      bestParams: proposal.params,
      bestScore: study.candidate.expectancy === null ? null : String(study.candidate.expectancy),
      status: 'done',
      finishedAt: new Date(),
    })
    .returning({ id: optimizations.id });

  await db.insert(auditLog).values({
    actor: 'optimizer',
    action: 'strategy.optimization.proposed',
    entityType: 'optimization',
    entityId: row!.id,
    details: {
      strategy: target.slug,
      baseVersion: target.version,
      changes: results.changes,
      oosExpectancy: { before: results.before.expectancy, after: results.after.expectancy },
      oosProfitFactor: { before: results.before.profitFactor, after: results.after.profitFactor },
      oosTrades: { before: results.before.tradeCount, after: results.after.tradeCount },
    },
  });
  return row!.id;
}

export type OpenProposal = {
  id: string;
  strategy: string;
  baseVersion: number;
  expectancyBefore: number | null;
  expectancyAfter: number | null;
  changes: number;
};

/** Offene Vorschläge (Briefing/Badge) — jüngste zuerst. */
export async function openOptimizationProposals(db: Db, limit = 10): Promise<OpenProposal[]> {
  const rows = await db
    .select({ id: optimizations.id, slug: strategies.slug, results: optimizations.results })
    .from(optimizations)
    .innerJoin(strategies, eq(strategies.id, optimizations.strategyId))
    .where(and(eq(optimizations.status, 'done'), sql`${optimizations.results}->'review'->>'state' = 'open'`))
    .orderBy(desc(optimizations.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const res = r.results as OptimizationProposalResults;
    return {
      id: r.id,
      strategy: r.slug,
      baseVersion: res.baseVersion,
      expectancyBefore: res.before?.expectancy ?? null,
      expectancyAfter: res.after?.expectancy ?? null,
      changes: res.changes?.length ?? 0,
    };
  });
}
