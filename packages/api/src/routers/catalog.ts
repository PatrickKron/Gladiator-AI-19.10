import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { presetBySlug, STRATEGY_PRESETS } from '@gladiator/strategy-engine';
import { evaluateBacktestValidity, readHoldout, runLabBacktest, type ValidityVerdict } from '@gladiator/backtest';
import { ensureCandleHistory } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

const { strategies, strategyVersions, backtests, auditLog } = schema;

/**
 * Strategie-Katalog (Patricks Auftrag C): kuratierte Presets mit ECHTEN
 * Backtest-Nachweisen und One-Click-Aktivierung.
 *
 * Ehrlichkeits-Prinzip: Der Katalog zeigt NIE behauptete Performance.
 * - Nicht aktiviert + kein Backtest → „noch nicht geprüft".
 * - Aktivierung = registrieren (draft) → ECHTER Backtest (12 Monate echte
 *   DB-Kerzen, Netto-Kostenmodell) → Validitäts-Gate → erst bei BESTANDEN
 *   Paper-Status (dsl-scan erzeugt ab dann Signale; Mensch bestätigt weiter
 *   jede Order). Fällt das Gate, bleibt draft + ehrliche Gründe an die UI.
 * - Live existiert hier bewusst weiterhin nicht.
 */

const BACKTEST_MONTHS = 12;

type CatalogValidity = {
  hasBacktest: boolean;
  verdict: ValidityVerdict | null;
  backtest: {
    createdAt: Date;
    fromTs: Date;
    toTs: Date;
    tradeCount: number;
    netReturnPct: number | null;
    maxDrawdownPct: number | null;
    winRate: number | null;
    profitFactor: number | null;
    expectancy: number | null;
  } | null;
};

export const catalogRouter = router({
  /** Katalog: alle Presets + echter Prüf-Status (Backtest/Validität/Aktiv). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const out = [];
    for (const preset of STRATEGY_PRESETS) {
      const [strategy] = await ctx.db.select().from(strategies).where(eq(strategies.slug, preset.slug)).limit(1);
      let version: typeof strategyVersions.$inferSelect | undefined;
      let validity: CatalogValidity = { hasBacktest: false, verdict: null, backtest: null };
      if (strategy) {
        [version] = await ctx.db
          .select()
          .from(strategyVersions)
          .where(eq(strategyVersions.strategyId, strategy.id))
          .orderBy(desc(strategyVersions.version))
          .limit(1);
        if (version) validity = await loadCatalogValidity(ctx.db, version.id);
      }
      out.push({
        slug: preset.slug,
        slugKey: preset.slugKey,
        category: preset.category,
        symbol: preset.dsl.symbol,
        timeframe: preset.dsl.timeframe,
        direction: preset.dsl.direction,
        setupType: preset.dsl.setupType,
        riskPctPerTrade: preset.dsl.risk.riskPctPerTrade,
        maxLeverage: preset.dsl.risk.maxLeveragePerTrade,
        takeProfitRrs: preset.dsl.takeProfits.map((tp) => tp.rr),
        status: (version?.status ?? 'not_activated') as 'not_activated' | 'draft' | 'paper' | 'live' | 'retired',
        validity,
      });
    }
    return out;
  }),

  /**
   * One-Click-Aktivierung: registrieren → echter Backtest → Gate → Paper.
   * Gibt IMMER das echte Backtest-Ergebnis zurück — auch wenn das Gate fällt.
   */
  activate: protectedProcedure
    .input(z.object({ slug: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const preset = presetBySlug(input.slug);
      if (!preset) throw new TRPCError({ code: 'NOT_FOUND', message: 'Katalog-Strategie nicht gefunden.' });

      // 1) Strategie + Version sicherstellen (idempotent, kind 'dsl' wie Workshop)
      let [strategy] = await ctx.db.select().from(strategies).where(eq(strategies.slug, preset.slug)).limit(1);
      if (!strategy) {
        [strategy] = await ctx.db
          .insert(strategies)
          .values({ slug: preset.slug, name: preset.slug, kind: 'dsl', description: `Katalog-Preset (${preset.category})` })
          .returning();
      }
      let [version] = await ctx.db
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.strategyId, strategy!.id))
        .orderBy(desc(strategyVersions.version))
        .limit(1);
      if (!version) {
        [version] = await ctx.db
          .insert(strategyVersions)
          .values({ strategyId: strategy!.id, version: 1, params: preset.dsl, status: 'draft' })
          .returning();
      }
      if (version!.status === 'paper' || version!.status === 'live') {
        return { activated: true, alreadyActive: true, gateReasons: [] as string[], validity: await loadCatalogValidity(ctx.db, version!.id) };
      }

      // 2) ECHTER Backtest über die letzten 12 Monate echte Kerzen
      const to = new Date();
      const from = new Date(to.getTime() - BACKTEST_MONTHS * 30 * 86_400_000);
      // Fehlende echte Historie (z. B. 15m für Scalp-Presets) einmalig nachladen —
      // sonst scheitert der Backtest an „zu wenig Kerzen". Nur echte Börsendaten.
      let history: { before: number; after: number; backfilled: boolean };
      try {
        history = await ensureCandleHistory(ctx.db, { symbol: preset.dsl.symbol, timeframe: preset.dsl.timeframe, from, to });
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err instanceof Error ? err.message : String(err) });
      }

      let lab;
      try {
        lab = await runLabBacktest(ctx.db, {
          strategyId: strategy!.id,
          symbol: preset.dsl.symbol,
          timeframe: preset.dsl.timeframe,
          setupType: preset.dsl.setupType,
          from,
          to,
          riskPctPerTrade: preset.dsl.risk.riskPctPerTrade,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Echter Backtest nicht möglich: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // 3) Validitäts-Gate (netto) — nur BESTANDEN geht auf Paper
      const verdict = evaluateBacktestValidity(lab.result.metrics);
      if (verdict.passed) {
        await ctx.db
          .update(strategyVersions)
          .set({ status: 'paper', promotedBy: ctx.user.id, promotedAt: new Date() })
          .where(eq(strategyVersions.id, version!.id));
      }

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: verdict.passed ? 'catalog.strategy.activated' : 'catalog.strategy.gate_failed',
        entityType: 'strategy',
        entityId: strategy!.id,
        details: {
          slug: preset.slug,
          backtestId: lab.backtestId,
          candles: lab.candles,
          history,
          metrics: lab.result.metrics,
          verdict,
        },
        ip: ctx.ip,
      });

      return {
        activated: verdict.passed,
        alreadyActive: false,
        gateReasons: verdict.passed ? [] : verdict.reasons,
        validity: await loadCatalogValidity(ctx.db, version!.id),
      };
    }),

  /** Deaktivieren: Version zurück auf draft (dsl-scan erzeugt keine Signale mehr). */
  deactivate: protectedProcedure
    .input(z.object({ slug: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const preset = presetBySlug(input.slug);
      if (!preset) throw new TRPCError({ code: 'NOT_FOUND', message: 'Katalog-Strategie nicht gefunden.' });
      const [strategy] = await ctx.db.select().from(strategies).where(eq(strategies.slug, preset.slug)).limit(1);
      if (!strategy) throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategie ist nicht registriert.' });
      const [version] = await ctx.db
        .select()
        .from(strategyVersions)
        .where(and(eq(strategyVersions.strategyId, strategy.id), eq(strategyVersions.status, 'paper')))
        .orderBy(desc(strategyVersions.version))
        .limit(1);
      if (!version) return { deactivated: false };
      await ctx.db.update(strategyVersions).set({ status: 'draft' }).where(eq(strategyVersions.id, version.id));
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'catalog.strategy.deactivated',
        entityType: 'strategy',
        entityId: strategy.id,
        details: { slug: preset.slug },
        ip: ctx.ip,
      });
      return { deactivated: true };
    }),
});

/** Neuester fertiger Backtest einer Version + Gate-Urteil — reine DB-Wahrheit. */
async function loadCatalogValidity(db: Db, versionId: string): Promise<CatalogValidity> {
  const [bt] = await db
    .select()
    .from(backtests)
    .where(and(eq(backtests.strategyVersionId, versionId), eq(backtests.status, 'done')))
    .orderBy(desc(backtests.createdAt))
    .limit(1);
  if (!bt) return { hasBacktest: false, verdict: null, backtest: null };
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  const verdict = evaluateBacktestValidity({
    tradeCount: Number(bt.tradeCount),
    winRate: num(bt.winRate),
    profitFactor: num(bt.profitFactor),
    expectancy: num(bt.expectancy),
    maxDrawdownPct: Number(bt.maxDrawdown),
    sharpe: num(bt.sharpe),
    netReturnPct: num(bt.netReturn),
    holdout: readHoldout(bt.metrics),
  });
  return {
    hasBacktest: true,
    verdict,
    backtest: {
      createdAt: bt.createdAt,
      fromTs: bt.fromTs,
      toTs: bt.toTs,
      tradeCount: Number(bt.tradeCount),
      netReturnPct: num(bt.netReturn),
      maxDrawdownPct: num(bt.maxDrawdown),
      winRate: num(bt.winRate),
      profitFactor: num(bt.profitFactor),
      expectancy: num(bt.expectancy),
    },
  };
}
