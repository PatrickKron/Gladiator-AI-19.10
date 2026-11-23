import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  buildAccountState,
  executeConfirmedSignal,
  isCandleCloseSource,
  resolveLiveVenueForSymbol,
  signalExecutionBlock,
  venueForSource,
  loadActiveGates,
  loadRiskContext,
  loadRiskSettings,
  type TradingVenue,
} from '@gladiator/exchange';
import { applyAdaptiveHedgeSizing, evaluateAssetHedging, evaluateRisk, exposureFit, safeCappedNotional } from '@gladiator/risk';
import { leverageUpgradeSchema, reentrySchema } from '@gladiator/core';
import { formatEmergencyAlert, notifySafe, reviewNewSignals, runDslScan, runSignalScan, telegramHtmlToText } from '@gladiator/jobs';
import { getEurUsdRate, getMacroSnapshot } from '@gladiator/market-data';
import { evaluateExpiredSignals, getOptimalParams, MIN_TRADES_PER_CLUSTER, type OptimalParams } from '@gladiator/backtest';
import { buildClusterKey } from '@gladiator/strategy-engine';
import { protectedProcedure, router } from '../trpc.js';
import { assetSource } from '../market/asset-source.js';

const { signals, signalReviews, strategies, auditLog, assetFavorites, assets } = schema;

/**
 * Signal-Feed + Mensch-im-Loop-Entscheidung.
 * Seit Phase 4b führt „Bestätigen" den vollen Lifecycle aus:
 * Risk-Gate (statisch + adaptiv) → Paper-Order gegen echte Live-Preise
 * → Schutz-Orders → Position. Blockt das Gate, bleibt das Signal 'new'
 * und die Gründe gehen an die UI. Jeder Schritt ist auditiert.
 */
type SignalReviewDto = {
  agent: string;
  vote: 'confirm' | 'reject' | 'caution';
  confidence: number;
  reason: string;
  refs: unknown;
};

/** Auto-Kill-Ereignis (05_ §9) für die Karte: Grund + Score vorher/nachher. */
type AutoKillDto = { reason: string; score: number | null; rescored: number | null; at: string };

/** Venue für die Kursquelle des Signals; fehlt die Schlusskurs-Weiche ⇒ ehrlicher Vorbedingungsfehler. */
function executionVenueOrThrow(venue: TradingVenue, source: string): TradingVenue {
  try {
    return venueForSource(venue, source);
  } catch (err) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
}

export const signalsRouter = router({
  /** Echte Anzahl offener Signale (`status = 'new'`) — ungekürzt durch Listen-Limits. */
  openCount: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(signals)
      .where(eq(signals.status, 'new'));
    return { count: Number(row?.count ?? 0) };
  }),

  /**
   * Sofortiger Signal-Scan (Welle 19): prüft alle aktivierten Strategien (SMC Core +
   * alle für Signale aktivierten DSL-/Katalog-Strategien) gegen echte Live-Kerzen und
   * lässt neue Signale direkt vom Schwarm & Risk-Gate bewerten.
   */
  scanNow: protectedProcedure.mutation(async ({ ctx }) => {
    const smc = await runSignalScan(ctx.db);
    const dsl = await runDslScan(ctx.db);
    const totalInserted = smc.inserted + dsl.inserted;
    let reviewed = 0;
    if (ctx.venue && totalInserted > 0) {
      const rev = await reviewNewSignals(ctx.db, ctx.venue);
      reviewed = rev.reviewed;
    }
    return {
      smcInserted: smc.inserted,
      dslInserted: dsl.inserted,
      totalInserted,
      expired: smc.expired,
      reviewed,
      scannedSmc: smc.scanned.length,
      scannedDsl: dsl.scanned.length,
      errors: dsl.errors.slice(0, 5),
    };
  }),

  /**
   * „Was wäre passiert": abgelaufene Signale mit derselben Backtest-Engine auf
   * den echten Kerzen danach nachgerechnet (netto, hypothetisch gekennzeichnet).
   */
  hindsight: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(200) }).default({ limit: 200 }))
    .query(async ({ ctx, input }) => {
      const res = await evaluateExpiredSignals(ctx.db, { limit: input.limit });
      return {
        summary: res.summary,
        items: res.items.map((i) => ({
          ...i,
          createdAt: i.createdAt.toISOString(),
          exitTs: i.exitTs ? i.exitTs.toISOString() : null,
        })),
      };
    }),

  list: protectedProcedure
    .input(
      z.object({
        status: z.array(z.enum(['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed'])).default(['new']),
        limit: z.number().int().min(1).max(200).default(50),
        symbol: z.string().optional(),
        timeframe: z.enum(['15m', '1h', '4h', '1d']).optional(),
        setupType: z.enum(['scalp', 'swing', 'position']).optional(),
        direction: z.enum(['long', 'short']).optional(),
        source: z.enum(['engine', 'pine', 'instruction', 'manual']).optional(),
        favoritesOnly: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: signals.id,
          createdAt: signals.createdAt,
          symbol: signals.symbol,
          venue: signals.venue,
          timeframe: signals.timeframe,
          direction: signals.direction,
          setupType: signals.setupType,
          entry: signals.entry,
          stopLoss: signals.stopLoss,
          takeProfits: signals.takeProfits,
          score: signals.score,
          riskClass: signals.riskClass,
          confluence: signals.confluence,
          session: signals.session,
          status: signals.status,
          source: signals.source,
          strategySlug: strategies.slug,
          reentryRaw: signals.reentry,
          leverageUpgradeRaw: signals.leverageUpgrade,
        })
        .from(signals)
        .innerJoin(strategies, eq(strategies.id, signals.strategyId))
        .where(
          and(
            inArray(signals.status, input.status),
            input.symbol ? eq(signals.symbol, input.symbol) : undefined,
            input.timeframe ? eq(signals.timeframe, input.timeframe) : undefined,
            input.setupType ? eq(signals.setupType, input.setupType) : undefined,
            input.direction ? eq(signals.direction, input.direction) : undefined,
            input.source ? eq(signals.source, input.source) : undefined,
          ),
        )
        .orderBy(desc(signals.createdAt))
        .limit(input.favoritesOnly ? Math.max(input.limit * 5, 500) : input.limit);

      // Favoriten (Stern-System) mit Kursquelle (A2): Krypto-Paare, Aktien, ETF, Forex, Rohstoffe —
      // dieselbe Quellen-Auflösung wie product.favoriteSymbols; Katalog-Asset ohne Quelle per Symbol.
      const favRows = await ctx.db
        .select({
          ticker: assets.ticker,
          assetType: assets.assetType,
          tradingPair: assets.tradingPair,
          candleVenue: assets.candleVenue,
          dataSymbol: assets.dataSymbol,
        })
        .from(assetFavorites)
        .innerJoin(assets, eq(assets.id, assetFavorites.assetId))
        .where(eq(assetFavorites.userId, ctx.user.id));
      const favSources = favRows.map(assetSource);
      const isFavoriteSignal = (r: { symbol: string; venue: string }) =>
        favSources.some((f) => f.symbol === r.symbol && (f.venue === null || f.venue === r.venue));
      // 05_ §9: Pläne/Vorschläge aus den jsonb-Spalten — validiert über das EINE Schema (@gladiator/core).
      let filtered = rows.map(({ reentryRaw, leverageUpgradeRaw, ...r }) => {
        const re = reentrySchema.safeParse(reentryRaw);
        const lu = leverageUpgradeSchema.safeParse(leverageUpgradeRaw);
        return {
          ...r,
          reentry: re.success ? re.data : null,
          leverageUpgrade: lu.success ? lu.data : null,
          isFavorite: isFavoriteSignal(r),
        };
      });
      if (input.favoritesOnly) filtered = filtered.filter((r) => r.isFavorite).slice(0, input.limit);
      // Favoriten zuerst, dann Zeit
      filtered.sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.createdAt.getTime() - a.createdAt.getTime());
      const rowsOut = filtered;

      // Schwarm-Urteile (Phase 5) in EINEM Batch dazuladen — transparent auf der Karte.
      if (rowsOut.length === 0) {
        return rowsOut.map((r) => ({ ...r, reviews: [] as SignalReviewDto[], autoKill: null as AutoKillDto | null }));
      }
      // Auto-Kill-Grund (05_ §9) aus dem Audit-Log — eine Batch-Abfrage, nur entwertete Signale.
      const expiredIds = rowsOut.filter((r) => r.status === 'expired').map((r) => r.id);
      const killRows =
        expiredIds.length === 0
          ? []
          : await ctx.db
            .select({ entityId: auditLog.entityId, ts: auditLog.ts, details: auditLog.details })
            .from(auditLog)
            .where(and(eq(auditLog.action, 'signal.auto_killed'), inArray(auditLog.entityId, expiredIds)));
      const killBySignal = new Map<string, AutoKillDto>();
      for (const k of killRows) {
        const d = (k.details ?? {}) as { reason?: string; score?: number; rescored?: number | null };
        if (!k.entityId || !d.reason) continue;
        killBySignal.set(k.entityId, {
          reason: d.reason,
          score: typeof d.score === 'number' ? d.score : null,
          rescored: typeof d.rescored === 'number' ? d.rescored : null,
          at: k.ts.toISOString(),
        });
      }
      const reviewRows = await ctx.db
        .select({
          signalId: signalReviews.signalId,
          agent: signalReviews.agent,
          vote: signalReviews.vote,
          confidence: signalReviews.confidence,
          reason: signalReviews.reason,
          refs: signalReviews.refs,
        })
        .from(signalReviews)
        .where(
          inArray(
            signalReviews.signalId,
            rowsOut.map((r) => r.id),
          ),
        );
      const bySignal = new Map<string, SignalReviewDto[]>();
      for (const r of reviewRows) {
        const list = bySignal.get(r.signalId) ?? [];
        list.push({ agent: r.agent, vote: r.vote, confidence: Number(r.confidence), reason: r.reason, refs: r.refs });
        bySignal.set(r.signalId, list);
      }
      return rowsOut.map((r) => ({ ...r, reviews: bySignal.get(r.id) ?? [], autoKill: killBySignal.get(r.id) ?? null }));
    }),

  /**
   * Ausführungs-Vorschau: Was schlägt die Strategie vor (Betrag/Hebel/SL/TP),
   * was sind die harten Grenzen, wie ist der echte EUR-Kurs? Grundlage für
   * das anpassbare Signal-Ticket — der Vorschlag bleibt sichtbare Referenz.
   */
  executionPreview: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.venue) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Trading-Venue aktiv.' });
      }
      const [signal] = await ctx.db.select().from(signals).where(eq(signals.id, input.id)).limit(1);
      if (!signal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Signal nicht gefunden.' });

      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const wantLive = ctx.venue.kind === 'live' || settings.mode === 'live';
      const venueBlock = signalExecutionBlock(signal.venue, wantLive ? 'live' : ctx.venue.kind);
      if (venueBlock) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: venueBlock });

      let execVenue: TradingVenue = executionVenueOrThrow(ctx.venue, signal.venue);
      let liveEquityUsd: number | null = null;
      let liveBlockReason: string | null = null;
      let liveSourceName = signal.venue;
      if (wantLive && !isCandleCloseSource(signal.venue)) {
        if (ctx.venue.kind === 'live') {
          execVenue = ctx.venue;
          liveSourceName = ctx.venue.id;
        } else {
          const resolved = await resolveLiveVenueForSymbol(ctx.db, ctx.user.id, signal.symbol);
          if (resolved.ok) {
            execVenue = resolved.venue;
            liveSourceName = resolved.connection.exchangeId;
            liveEquityUsd = await resolved.venue.equityUsd().catch(() => null);
          } else {
            liveBlockReason = resolved.detail;
          }
        }
      }

      const state = await buildAccountState(ctx.db, ctx.user.id, new Date(), {
        mode: wantLive ? 'live' : 'paper',
        liveEquityUsd,
      });
      const rules = await execVenue.marketRules(signal.symbol);
      const gates = await loadActiveGates(ctx.db);
      const suggestedLev = Math.max(1, Math.min(settings.maxLeverage, Number(signal.leverageSuggested ?? 1) || 1));
      const existingExpPct = state.exposureBySymbolPct[signal.symbol] ?? 0;
      const riskContext = await loadRiskContext(ctx.db);
      const macroSnap = await getMacroSnapshot(ctx.db).catch(() => null);
      const totalExposureUsd = Object.values(state.exposureBySymbolPct).reduce(
        (sum, pct) => sum + (state.equity * pct) / 100,
        0,
      );
      const assetHedge = evaluateAssetHedging(settings.hedgingConfig, signal.symbol, {
        drawdownPct: Math.max(0, -state.monthlyPnlPct),
        vix: riskContext.vix ?? macroSnap?.vix?.value ?? null,
        grsLabel: macroSnap?.grs?.label ?? null,
        netExposureUsd: totalExposureUsd,
      });

      const autoCap = safeCappedNotional({
        equity: state.equity,
        availableMargin: state.availableMargin,
        leverage: suggestedLev,
        riskPct: settings.riskPctPerTrade,
        entry: Number(signal.entry),
        stopLoss: Number(signal.stopLoss),
        maxExposurePct: settings.maxExposurePctPerAsset,
        existingExposurePct: existingExpPct,
        minNotional: rules.minNotional,
      });
      const hedgeSizing = applyAdaptiveHedgeSizing(autoCap.notional, rules.minNotional, assetHedge);
      const previewRequestedNotional =
        hedgeSizing.scaled && hedgeSizing.notionalUsd !== null
          ? hedgeSizing.notionalUsd
          : autoCap.capped && autoCap.notional !== null
            ? autoCap.notional
            : undefined;
      const verdict = evaluateRisk(
        {
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entry: Number(signal.entry),
          stopLoss: Number(signal.stopLoss),
          leverage: suggestedLev,
          session: signal.session,
          emaRegime: signal.emaRegime as 'above' | 'below',
          marketPhase: signal.marketPhase as 'bull' | 'bear',
          ...(previewRequestedNotional !== undefined ? { requestedNotional: previewRequestedNotional } : {}),
        },
        settings,
        state,
        rules,
        gates,
        riskContext,
      );
      const eurUsd = await getEurUsdRate();
      const suggestedNotionalUsd = verdict.sizing?.notional ?? hedgeSizing.notionalUsd ?? autoCap.notional ?? null;

      // Vorschlag aus Erfahrung (13_ §7): VDB2-Cluster des Signals, gedeckelt
      // durch die Risk-Settings. Nur Vorschlag — angewendet wird nichts
      // automatisch, das Risk-Gate prüft beim Ausführen erneut.
      let experience: OptimalParams | { available: false; reason: 'error'; tradeCount: 0; minTrades: number };
      try {
        const [strategy] = await ctx.db
          .select({ slug: strategies.slug })
          .from(strategies)
          .where(eq(strategies.id, signal.strategyId))
          .limit(1);
        const clusterKey = buildClusterKey({
          strategy: strategy?.slug ?? '',
          symbol: signal.symbol,
          setupType: signal.setupType,
          timeframe: signal.timeframe,
          session: signal.session,
          emaRegime: signal.emaRegime === 'above' || signal.emaRegime === 'below' ? signal.emaRegime : null,
          marketPhase: signal.marketPhase === 'bull' || signal.marketPhase === 'bear' ? signal.marketPhase : null,
        });
        experience = strategy
          ? await getOptimalParams(ctx.db, clusterKey, { maxLeverage: settings.maxLeverage, riskPctPerTrade: settings.riskPctPerTrade })
          : { available: false, reason: 'no_data', tradeCount: 0, minTrades: MIN_TRADES_PER_CLUSTER };
      } catch (err) {
        console.warn(`[executionPreview] Erfahrungs-Vorschlag nicht ladbar: ${String(err)}`);
        experience = { available: false, reason: 'error', tradeCount: 0, minTrades: MIN_TRADES_PER_CLUSTER };
      }
      const gateReasons = [
        ...(liveBlockReason ? [liveBlockReason] : []),
        ...(verdict.allowed ? [] : verdict.reasons),
      ];
      return {
        /** A2: Yahoo/Twelve Data füllen zum letzten echten Kerzenschluss (Paper); im Live-Modus über CCXT-Router. */
        execution: {
          mode: isCandleCloseSource(signal.venue)
            ? ('candle_close' as const)
            : wantLive
              ? ('live' as const)
              : ('venue' as const),
          source: wantLive ? liveSourceName : signal.venue,
        },
        // Strategie-Vorschlag (Referenz fürs Ticket — bei engen Stops konservativ auf Exposure/Margin gedeckelt)
        suggested: {
          notionalUsd: suggestedNotionalUsd,
          notionalEur: suggestedNotionalUsd !== null && eurUsd ? suggestedNotionalUsd / eurUsd : null,
          leverage: suggestedLev,
          stopLoss: Number(signal.stopLoss),
          takeProfits: signal.takeProfits.map((tp) => Number(tp)),
          entry: Number(signal.entry),
          riskAmountUsd: verdict.sizing?.riskAmount ?? null,
          autoCapped: autoCap.capped,
          effectiveRiskPct: autoCap.effectiveRiskPct,
        },
        // Grenzen für die Schieberegler
        limits: {
          maxLeverage: settings.maxLeverage,
          maxNotionalUsd: Math.max(
            0,
            Math.min(
              state.availableMargin * settings.maxLeverage,
              state.equity * (Math.max(0, settings.maxExposurePctPerAsset - existingExpPct) / 100),
            ),
          ),
          minNotionalUsd: rules.minNotional,
          equityUsd: state.equity,
        },
        /** Echter EUR/USD-Kurs; null = Quelle nicht erreichbar (UI zeigt USD). */
        eurUsdRate: eurUsd,
        gateReasons,
        /**
         * Erklärung, falls Risiko% und Exposure-Limit kollidieren (enger Stop):
         * Rechnung + größter erlaubter Betrag. Ändert nichts, nur Hinweis.
         */
        exposureFit: {
          riskPct: settings.riskPctPerTrade,
          limitPct: settings.maxExposurePctPerAsset,
          ...exposureFit({
            equity: state.equity,
            riskPct: settings.riskPctPerTrade,
            entry: Number(signal.entry),
            stopLoss: Number(signal.stopLoss),
            maxExposurePct: settings.maxExposurePctPerAsset,
            existingExposurePct: state.exposureBySymbolPct[signal.symbol] ?? 0,
          }),
        },
        /** Optionaler Vorschlag aus echten Trades (Labor + Paper); null-Fall mit Grund. */
        experience,
        /** Adaptives Asset-Hedging (Welle 20): Live-Status der diesem Asset zugeordneten Hedging-Strategie. */
        hedging: {
          strategyName: assetHedge.strategyName,
          mode: assetHedge.mode,
          state: assetHedge.evaluation.state,
          hedgeSymbol: assetHedge.hedgeSymbol,
          recommendedHedgePct: assetHedge.evaluation.recommendedHedgePct,
          recommendedHedgeUsd: assetHedge.evaluation.recommendedHedgeUsd,
          exposureScaleFactor: assetHedge.evaluation.exposureScaleFactor,
          scaled: hedgeSizing.scaled,
          triggeredBy: assetHedge.evaluation.triggeredBy,
          summary: assetHedge.evaluation.summary,
        },
      };
    }),

  /** Bestätigen (Mensch im Loop): Risk-Gate → Paper- oder Live-Order. Nur aus Status 'new'.
   *  Optional mit User-Anpassungen (Betrag in €, Hebel, SL, TP) — der
   *  Strategie-Vorschlag bleibt als Referenz in Signal + Audit erhalten. */
  confirm: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        overrides: z
          .object({
            amountEur: z.number().positive().max(100_000_000).optional(),
            leverage: z.number().min(1).max(200).optional(),
            stopLoss: z.number().positive().optional(),
            takeProfits: z.array(z.number().positive()).max(3).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.venue) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Trading-Venue aktiv — Ausführung nicht möglich.' });
      }
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const wantLive = ctx.venue.kind === 'live' || settings.mode === 'live';
      // Kursquelle vor jeder Statusänderung prüfen (A2: Yahoo/Twelve Data = Paper-Schlusskurs, nie live).
      const [target] = await ctx.db.select({ venue: signals.venue }).from(signals).where(eq(signals.id, input.id)).limit(1);
      const venueBlock = target ? signalExecutionBlock(target.venue, wantLive ? 'live' : ctx.venue.kind) : null;
      if (venueBlock) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: venueBlock });
      if (target && !wantLive) executionVenueOrThrow(ctx.venue, target.venue);

      // €-Betrag mit ECHTEM Kurs nach USD umrechnen — kein Kurs, kein Trade in €.
      let notionalUsd: number | undefined;
      let eurUsdRateUsed: number | null = null;
      if (input.overrides?.amountEur !== undefined) {
        eurUsdRateUsed = await getEurUsdRate();
        if (eurUsdRateUsed === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'EUR/USD-Kurs gerade nicht verfügbar — bitte kurz erneut versuchen (es wird nie ein Kurs erfunden).',
          });
        }
        notionalUsd = input.overrides.amountEur * eurUsdRateUsed;
      }

      const [updated] = await ctx.db
        .update(signals)
        .set({ status: 'confirmed', updatedAt: new Date() })
        .where(and(eq(signals.id, input.id), eq(signals.status, 'new')))
        .returning();
      if (!updated) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Signal ist nicht mehr im Status "new".' });
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'signal.confirm',
        entityType: 'signal',
        entityId: updated.id,
        details: {
          symbol: updated.symbol,
          timeframe: updated.timeframe,
          direction: updated.direction,
          ...(input.overrides ? { overrides: input.overrides, eurUsdRateUsed } : {}),
        },
        ip: ctx.ip,
      });

      const hasOverrides =
        notionalUsd !== undefined ||
        input.overrides?.leverage !== undefined ||
        input.overrides?.stopLoss !== undefined ||
        (input.overrides?.takeProfits?.length ?? 0) > 0;

      // Wirft die Ausführung (Netzfehler bei Marktregeln, DB-Konflikt …), darf
      // das Signal NICHT in 'confirmed' hängen bleiben — dort wäre es weder
      // erneut bestätig- noch ablehnbar. Zurück auf 'new', Fehler an die UI.
      const resetToNew = () =>
        ctx.db
          .update(signals)
          .set({ status: 'new', updatedAt: new Date() })
          .where(and(eq(signals.id, updated.id), eq(signals.status, 'confirmed')));

      let execution: Awaited<ReturnType<typeof executeConfirmedSignal>>;
      try {
        execution = await executeConfirmedSignal(ctx.db, ctx.venue, {
          signalId: updated.id,
          userId: ctx.user.id,
          ip: ctx.ip,
          ...(hasOverrides
            ? {
              overrides: {
                ...(notionalUsd !== undefined ? { notionalUsd } : {}),
                ...(input.overrides?.leverage !== undefined ? { leverage: input.overrides.leverage } : {}),
                ...(input.overrides?.stopLoss !== undefined ? { stopLoss: input.overrides.stopLoss } : {}),
                ...(input.overrides?.takeProfits?.length ? { takeProfits: input.overrides.takeProfits } : {}),
              },
            }
            : {}),
        });
      } catch (err) {
        await resetToNew();
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Ausführung fehlgeschlagen — Signal bleibt offen: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (execution.emergency) {
        // Notfall: Stop nicht platzierbar → Executor hat glattgestellt (oder meldet UNGESCHÜTZT).
        const emergencyHtml = formatEmergencyAlert(updated.symbol, execution.detail, execution.emergency.closed);
        void notifySafe(ctx.db, {
          userId: ctx.user.id,
          kind: 'emergency',
          severity: 'critical',
          title: `Notfall ${updated.symbol}`,
          body: telegramHtmlToText(emergencyHtml),
          link: '#/traden?tab=positionen',
          telegramHtml: emergencyHtml,
        });
      } else if (!execution.executed) {
        // Gate hat geblockt → Signal bleibt handlungsfähig ('new'), Gründe an die UI
        await resetToNew();
      }

      return {
        signal: updated,
        executed: execution.executed,
        detail: execution.detail,
        riskReasons: execution.verdict.reasons,
        entryFill: execution.entryFill,
        qty: execution.qty,
      };
    }),

  /** Ablehnen (Mensch im Loop). Nur aus Status 'new'. */
  reject: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(signals)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(and(eq(signals.id, input.id), eq(signals.status, 'new')))
        .returning();
      if (!updated) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Signal ist nicht mehr im Status "new".' });
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'signal.reject',
        entityType: 'signal',
        entityId: updated.id,
        details: { symbol: updated.symbol, timeframe: updated.timeframe, direction: updated.direction },
        ip: ctx.ip,
      });
      return updated;
    }),
});
