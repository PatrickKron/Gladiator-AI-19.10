import { TRPCError } from '@trpc/server';
import { and, desc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { runLabBacktest, runLabWalkForward } from '@gladiator/backtest';
import { SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { deriveAdaptiveGates } from '@gladiator/risk';
import { protectedProcedure, router } from '../trpc.js';

const { strategies, strategyVersions, backtests, auditLog, riskGates } = schema;

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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { runId, wf } = await runLabWalkForward(ctx.db, {
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

  /** Verlauf der Läufe (für Vergleich v2 vs v3 etc.). */
  runs: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: backtests.id,
          createdAt: backtests.createdAt,
          symbol: backtests.symbol,
          timeframe: backtests.timeframe,
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
