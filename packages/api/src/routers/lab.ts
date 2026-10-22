import { TRPCError } from '@trpc/server';
import { and, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { readProposalState, runLabBacktest, runLabWalkForward, type OptimizationProposalResults, runMonteCarlo } from '@gladiator/backtest';
import { parseInstructionDsl } from '@gladiator/strategy-engine';
import { SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { deriveAdaptiveGates } from '@gladiator/risk';
import { protectedProcedure, router } from '../trpc.js';

const { strategies, strategyVersions, backtests, auditLog, riskGates, optimizations } = schema;

const timeframeSchema = z.enum(SUPPORTED_TIMEFRAMES);
const setupSchema = z.enum(['scalp', 'swing', 'position']);

const paramsSchema = z
  .object({
    swingLeftBars: z.number().int().min(2).max(30),
    swingRightBars: z.number().int().min(2).max(30),
    emaTrendPeriod: z.number().int().min(20).max(400),
    emaPullbackPeriod: z.number().int().min(5).max(200),
    rsiPeriod: z.number().int().min(2).max(50),
    rsiLongMin: z.number().min(0).max(100),
    rsiLongMax: z.number().min(0).max(100),
    rsiShortMin: z.number().min(0).max(100),
    rsiShortMax: z.number().min(0).max(100),
    volumeMaPeriod: z.number().int().min(2).max(100),
    atrPeriod: z.number().int().min(2).max(50),
    retestWindowBars: z.number().int().min(2).max(60),
    emaProximityPct: z.number().min(0.1).max(10),
    rsiLookbackBars: z.number().int().min(1).max(20),
    // Experiment-Flags (Phase 1b): Sweep/Discount als Zusatz-Confluence — nur im Labor messbar, Standard aus
    sweepConfluence: z.boolean(),
    discountConfluence: z.boolean(),
    sweepWindowBars: z.number().int().min(2).max(100),
  })
  .partial();

const costSchema = z.object({
  takerFeeRate: z.number().min(0).max(0.01),
  makerFeeRate: z.number().min(0).max(0.01),
  slippageBps: z.number().min(0).max(100),
  fundingRatePer8h: z.number().min(-0.01).max(0.01),
});

/** Equity-Kurve fürs UI auf max. N Punkte eindampfen (verlustfrei genug für die Anzeige). */
function downsample<T>(points: T[], maxPoints = 400): T[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

export const labRouter = router({
  /** Strategie + Versionen (für Auswahl & Vergleich). */
  versions: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: strategyVersions.id,
        version: strategyVersions.version,
        params: strategyVersions.params,
        status: strategyVersions.status,
        createdAt: strategyVersions.createdAt,
        slug: strategies.slug,
      })
      .from(strategyVersions)
      .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
      .where(eq(strategies.slug, 'smc-core'))
      .orderBy(desc(strategyVersions.version));
    return rows;
  }),

  /** Parameter-Experiment als neue Version speichern (Status draft — Promotion nur durch dich). */
  saveVersion: protectedProcedure
    .input(z.object({ params: paramsSchema }))
    .mutation(async ({ ctx, input }) => {
      const [s] = await ctx.db.select().from(strategies).where(eq(strategies.slug, 'smc-core')).limit(1);
      if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: 'smc-core nicht registriert.' });
      const [maxRow] = await ctx.db
        .select({ maxV: max(strategyVersions.version) })
        .from(strategyVersions)
        .where(eq(strategyVersions.strategyId, s.id));
      const nextVersion = (maxRow?.maxV ?? 0) + 1;
      const [row] = await ctx.db
        .insert(strategyVersions)
        .values({ strategyId: s.id, version: nextVersion, params: input.params, status: 'draft' })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.version.create',
        entityType: 'strategy_version',
        entityId: row!.id,
        details: { version: nextVersion, params: input.params },
        ip: ctx.ip,
      });
      return row!;
    }),

  /** Backtest ausführen (netto, persistiert) — Kern des Labors. */
  runBacktest: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3), // Universum waechst mit Favoriten — Kerzen-Check schuetzt
        timeframe: timeframeSchema,
        setupType: setupSchema,
        from: z.string().datetime(),
        to: z.string().datetime(),
        params: paramsSchema.optional(),
        versionId: z.string().uuid().optional(),
        strategyId: z.string().uuid().optional(), // registrierte DSL-Strategie backtesten
        riskPctPerTrade: z.number().min(0.1).max(5).default(1),
        costModel: costSchema.optional(),
        /** Trailing-Stop in % (optional; DSL-Strategien mit eigenem trailingStop behalten ihren Wert). */
        trailPct: z.number().min(0.1).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const out = await runLabBacktest(ctx.db, {
          ...input,
          from: new Date(input.from),
          to: new Date(input.to),
        });
        return {
          backtestId: out.backtestId,
          candles: out.candles,
          params: out.params,
          costModel: out.costModel,
          metrics: out.result.metrics,
          equityCurve: downsample(out.result.equityCurve).map((p) => ({
            ts: p.ts.toISOString(),
            equity: Math.round(p.equity * 100) / 100,
          })),
          /** Alle R-Multiples (netto) in Original-Reihenfolge — Grundlage der Monte-Carlo-Simulation. */
          rMultiples: out.result.trades.map((t) => Math.round(t.rMultiple * 10_000) / 10_000),
          trades: out.result.trades.slice(-200).map((t) => ({
            entryTs: t.entryTs.toISOString(),
            exitTs: t.exitTs.toISOString(),
            direction: t.direction,
            entry: t.entry,
            stopLoss: t.stopLoss,
            takeProfits: t.takeProfits,
            exitPrice: t.exitPrice,
            netPnl: Math.round(t.netPnl * 100) / 100,
            rMultiple: Math.round(t.rMultiple * 100) / 100,
            mfeR: Math.round(t.mfeR * 100) / 100,
            maeR: Math.round(t.maeR * 100) / 100,
            fees: Math.round(t.fees * 100) / 100,
            funding: Math.round(t.funding * 100) / 100,
            exitReason: t.exitReason,
            score: t.score,
            session: t.session,
          })),
          raps: {
            grid: out.raps.grid,
            best: out.raps.best,
            explanation: out.raps.explanation,
            clusterKey: out.raps.clusterKey,
            isLowSampleSize: out.raps.isLowSampleSize,
            tradeCount: out.raps.tradeCount,
          },
          analysis: out.analysis,
          turningPoints: out.turningPoints,
          // Ehrlichkeit: Funding-Herkunft + Datenqualitäts-Warnungen (08_ §3a/§3b)
          fundingSource: out.fundingSource,
          dataQuality: {
            gaps: out.dataQuality.gaps,
            expectedBars: out.dataQuality.expectedBars,
            zeroVolumeBars: out.dataQuality.zeroVolumeBars,
            spikes: out.dataQuality.spikes,
            ok: out.dataQuality.ok,
            warnings: out.dataQuality.warnings,
          },
        };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Backtest fehlgeschlagen.' });
      }
    }),

  /** Walk-Forward (08_ §4): IS-Grid-Optimierung → OOS-Validierung, persistiert. */
  runWalkForward: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3),
        timeframe: timeframeSchema,
        setupType: setupSchema,
        from: z.string().datetime(),
        to: z.string().datetime(),
        isBars: z.number().int().min(200).max(20_000),
        oosBars: z.number().int().min(50).max(10_000),
        grid: z.array(paramsSchema).min(1).max(27),
        riskPctPerTrade: z.number().min(0.1).max(5).default(1),
        /** Trailing-Stop in % (optional) — wie beim Backtest. */
        trailPct: z.number().min(0.1).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { runId, wf, fundingSource, dataQuality } = await runLabWalkForward(ctx.db, {
          ...input,
          from: new Date(input.from),
          to: new Date(input.to),
        });
        return {
          runId,
          combinedOos: wf.combinedOos,
          windows: wf.windows.map((w) => ({
            isStart: w.isStart,
            oosStart: w.oosStart,
            oosEnd: w.oosEnd,
            bestParams: w.bestParams,
            isNetPnl: Math.round(w.isMetrics.netPnl * 100) / 100,
            isTrades: w.isMetrics.tradeCount,
            oosNetPnl: Math.round(w.oosMetrics.netPnl * 100) / 100,
            oosTrades: w.oosMetrics.tradeCount,
          })),
          // Parität zum Backtest: Funding-Herkunft + Datenqualitäts-Warnungen (08_ §3a/§3b)
          trailPct: input.trailPct ?? null,
          fundingSource,
          dataQuality: {
            gaps: dataQuality.gaps,
            expectedBars: dataQuality.expectedBars,
            zeroVolumeBars: dataQuality.zeroVolumeBars,
            spikes: dataQuality.spikes,
            ok: dataQuality.ok,
            warnings: dataQuality.warnings,
          },
        };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Walk-Forward fehlgeschlagen.' });
      }
    }),

  /**
   * Selbst-Kalibrierung: Backtest → Rundum-Analyse → restriktive Gates ableiten
   * und persistieren (ersetzt vorherige Labor-Gates für diesen Scope). Auditiert.
   * Gates können nur VERSCHÄRFEN; jedes ist einzeln deaktivierbar (risk.toggleGate).
   */
  calibrateRisk: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3),
        timeframe: timeframeSchema,
        setupType: setupSchema,
        from: z.string().datetime(),
        to: z.string().datetime(),
        params: paramsSchema.optional(),
        minSample: z.number().int().min(10).max(500).default(30),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const out = await runLabBacktest(ctx.db, {
          symbol: input.symbol,
          timeframe: input.timeframe,
          setupType: input.setupType,
          from: new Date(input.from),
          to: new Date(input.to),
          params: input.params,
        });
        const gates = deriveAdaptiveGates(out.analysis, {
          minSample: input.minSample,
          symbol: input.symbol,
          timeframe: input.timeframe,
        });

        // Alte Labor-Gates für diesen Scope ersetzen (Historie bleibt im Audit-Log)
        await ctx.db
          .delete(riskGates)
          .where(and(eq(riskGates.symbol, input.symbol), eq(riskGates.timeframe, input.timeframe), eq(riskGates.source, 'lab-calibration')));

        for (const g of gates) {
          await ctx.db.insert(riskGates).values({
            kind: g.kind,
            direction: g.direction ?? null,
            emaRegime: g.emaRegime ?? null,
            session: (g.session as 'asia' | 'london' | 'overlap' | 'newyork' | 'off' | undefined) ?? null,
            marketPhase: g.marketPhase ?? null,
            symbol: g.symbol ?? null,
            timeframe: g.timeframe ?? null,
            evidence: { ...g.evidence, backtestId: out.backtestId, trades: g.evidence.trades },
            reason: g.reason,
            source: 'lab-calibration',
          });
        }

        await ctx.db.insert(auditLog).values({
          actor: 'user',
          userId: ctx.user.id,
          action: 'risk.calibrate',
          entityType: 'risk_gate',
          entityId: out.backtestId,
          details: { scope: `${input.symbol} ${input.timeframe}`, gatesDerived: gates.length, trades: out.result.metrics.tradeCount },
          ip: ctx.ip,
        });

        return { backtestId: out.backtestId, trades: out.result.metrics.tradeCount, gates, analysis: out.analysis };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Kalibrierung fehlgeschlagen.' });
      }
    }),

  /**
   * Optimierungs-Vorschläge der Nacht-Optimierung (08_ §5). Nur lesen —
   * Vorher/Nachher (kombiniert OOS, netto), Prüfungen, geänderte Parameter.
   */
  proposals: protectedProcedure
    .input(z.object({ state: z.enum(['open', 'all']).default('open'), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: optimizations.id,
          createdAt: optimizations.createdAt,
          strategyId: optimizations.strategyId,
          baseVersionId: optimizations.baseVersionId,
          method: optimizations.method,
          bestParams: optimizations.bestParams,
          results: optimizations.results,
          slug: strategies.slug,
          name: strategies.name,
          kind: strategies.kind,
        })
        .from(optimizations)
        .innerJoin(strategies, eq(strategies.id, optimizations.strategyId))
        .where(
          and(
            eq(optimizations.status, 'done'),
            input.state === 'open' ? sql`${optimizations.results}->'review'->>'state' = 'open'` : undefined,
          ),
        )
        .orderBy(desc(optimizations.createdAt))
        .limit(input.limit);
      return rows.map((r) => {
        const results = r.results as OptimizationProposalResults;
        return { ...r, results, baseVersion: results.baseVersion, state: readProposalState(r.results) };
      });
    }),

  /**
   * Vorschlag übernehmen → NEUE Strategie-Version als draft mit den
   * vorgeschlagenen Parametern. Scharf geschaltet wird NICHTS: die Version
   * muss wie jede andere backtestet und über das Validitäts-Gate promotet werden.
   */
  acceptProposal: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx.select().from(optimizations).where(eq(optimizations.id, input.id)).for('update').limit(1);
        if (!row || row.status !== 'done') throw new TRPCError({ code: 'NOT_FOUND', message: 'Vorschlag nicht gefunden.' });
        const state = readProposalState(row.results);
        if (state !== 'open') {
          throw new TRPCError({ code: 'CONFLICT', message: `Vorschlag ist bereits ${state === 'accepted' ? 'übernommen' : state === 'rejected' ? 'verworfen' : 'durch einen neueren ersetzt'}.` });
        }
        const [strategy] = await tx.select().from(strategies).where(eq(strategies.id, row.strategyId)).limit(1);
        if (!strategy) throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategie nicht gefunden.' });

        // Parameter vor dem Anlegen erneut validieren (nie ungeprüft übernehmen)
        if (strategy.kind === 'dsl') {
          const parsed = parseInstructionDsl(row.bestParams);
          if (!parsed.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: `Vorgeschlagene DSL ungültig: ${parsed.errors.join('; ')}` });
        } else if (strategy.slug === 'smc-core') {
          const parsed = paramsSchema.safeParse(row.bestParams);
          if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Vorgeschlagene SMC-Parameter ungültig.' });
        } else {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Strategie-Art ${strategy.kind} ist nicht optimierbar.` });
        }

        const [maxRow] = await tx
          .select({ maxV: max(strategyVersions.version) })
          .from(strategyVersions)
          .where(eq(strategyVersions.strategyId, strategy.id));
        const nextVersion = (maxRow?.maxV ?? 0) + 1;
        const [version] = await tx
          .insert(strategyVersions)
          .values({ strategyId: strategy.id, version: nextVersion, params: row.bestParams as object, status: 'draft' })
          .returning();

        const results = row.results as OptimizationProposalResults;
        await tx
          .update(optimizations)
          .set({
            results: {
              ...results,
              review: { state: 'accepted', at: new Date().toISOString(), newVersionId: version!.id, newVersion: nextVersion },
            },
          })
          .where(eq(optimizations.id, row.id));
        await tx.insert(auditLog).values([
          {
            actor: 'user',
            userId: ctx.user.id,
            action: 'strategy.optimization.accepted',
            entityType: 'optimization',
            entityId: row.id,
            details: { strategy: strategy.slug, baseVersion: results.baseVersion, newVersion: nextVersion, changes: results.changes },
            ip: ctx.ip,
          },
          {
            actor: 'user',
            userId: ctx.user.id,
            action: 'strategy.version.create',
            entityType: 'strategy_version',
            entityId: version!.id,
            details: { version: nextVersion, source: 'optimization', optimizationId: row.id },
            ip: ctx.ip,
          },
        ]);
        return { versionId: version!.id, version: nextVersion, strategyId: strategy.id, slug: strategy.slug };
      });
    }),

  /** Vorschlag verwerfen (auditiert) — bleibt in der Historie sichtbar. */
  rejectProposal: protectedProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx.select().from(optimizations).where(eq(optimizations.id, input.id)).for('update').limit(1);
        if (!row || row.status !== 'done') throw new TRPCError({ code: 'NOT_FOUND', message: 'Vorschlag nicht gefunden.' });
        if (readProposalState(row.results) !== 'open') throw new TRPCError({ code: 'CONFLICT', message: 'Vorschlag ist bereits abgeschlossen.' });
        const results = row.results as OptimizationProposalResults;
        await tx
          .update(optimizations)
          .set({ results: { ...results, review: { state: 'rejected', at: new Date().toISOString(), ...(input.reason ? { reason: input.reason } : {}) } } })
          .where(eq(optimizations.id, row.id));
        await tx.insert(auditLog).values({
          actor: 'user',
          userId: ctx.user.id,
          action: 'strategy.optimization.rejected',
          entityType: 'optimization',
          entityId: row.id,
          details: { strategy: results.strategySlug, baseVersion: results.baseVersion, reason: input.reason ?? null },
          ip: ctx.ip,
        });
        return { ok: true as const };
      });
    }),

  /** Verlauf der Läufe (für Vergleich v2 vs v3 etc.). */
  /**
   * Monte-Carlo über die Trade-Reihenfolge (Repo-Masterliste, Phase 4): rein,
   * deterministisch über den Seed; nur die beobachteten Trades werden neu
   * angeordnet — nichts erfunden.
   */
  monteCarlo: protectedProcedure
    .input(
      z.object({
        rMultiples: z.array(z.number().finite()).min(1).max(10_000),
        startEquity: z.number().positive().max(1e9).default(10_000),
        riskPct: z.number().min(0.1).max(5).default(1),
        runs: z.number().int().min(100).max(5000).default(1000),
        seed: z.number().int().min(0).max(2_147_483_647).default(42),
        mode: z.enum(['shuffle', 'bootstrap']).default('shuffle'),
      }),
    )
    .mutation(({ input }) => runMonteCarlo(input)),

  runs: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: backtests.id,
          createdAt: backtests.createdAt,
          symbol: backtests.symbol,
          timeframe: backtests.timeframe,
          fromTs: backtests.fromTs,
          toTs: backtests.toTs,
          config: backtests.config,
          sharpe: backtests.sharpe,
          maxDrawdown: backtests.maxDrawdown,
          winRate: backtests.winRate,
          profitFactor: backtests.profitFactor,
          expectancy: backtests.expectancy,
          netReturn: backtests.netReturn,
          tradeCount: backtests.tradeCount,
          versionId: backtests.strategyVersionId,
          version: strategyVersions.version,
        })
        .from(backtests)
        .innerJoin(strategyVersions, eq(strategyVersions.id, backtests.strategyVersionId))
        .where(and(eq(backtests.status, 'done')))
        .orderBy(desc(backtests.createdAt))
        .limit(input.limit);
      return rows;
    }),
});
