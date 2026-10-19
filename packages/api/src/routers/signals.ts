import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  buildAccountState,
  executeConfirmedSignal,
  loadActiveGates,
  loadRiskContext,
  loadRiskSettings,
} from '@gladiator/exchange';
import { evaluateRisk } from '@gladiator/risk';
import { formatEmergencyAlert, sendTelegram } from '@gladiator/jobs';
import { getEurUsdRate } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

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

export const signalsRouter = router({
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
        .limit(input.limit);

      // Favoriten (Stern-System): Symbole des Users → Filter/Priorität
      const favRows = await ctx.db
        .select({ pair: assets.tradingPair })
        .from(assetFavorites)
        .innerJoin(assets, eq(assets.id, assetFavorites.assetId))
        .where(eq(assetFavorites.userId, ctx.user.id));
      const favSymbols = new Set(
        favRows
          .map((f) => f.pair?.toUpperCase().replaceAll('/', ''))
          .filter((x): x is string => Boolean(x))
          .map((x) => (x.endsWith('USDT') ? x.slice(0, -4) + '/USDT' : x.endsWith('USDC') ? x.slice(0, -4) + '/USDC' : x)),
      );
      let filtered = rows.map((r) => ({ ...r, isFavorite: favSymbols.has(r.symbol) }));
      if (input.favoritesOnly) filtered = filtered.filter((r) => r.isFavorite);
      // Favoriten zuerst, dann Zeit
      filtered.sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.createdAt.getTime() - a.createdAt.getTime());
      const rowsOut = filtered;

      // Schwarm-Urteile (Phase 5) in EINEM Batch dazuladen — transparent auf der Karte.
      if (rowsOut.length === 0) return rowsOut.map((r) => ({ ...r, reviews: [] as SignalReviewDto[] }));
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
      return rowsOut.map((r) => ({ ...r, reviews: bySignal.get(r.id) ?? [] }));
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
      const state = await buildAccountState(ctx.db, ctx.user.id);
      const rules = await ctx.venue.marketRules(signal.symbol);
      const gates = await loadActiveGates(ctx.db);
      const verdict = evaluateRisk(
        {
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entry: Number(signal.entry),
          stopLoss: Number(signal.stopLoss),
          leverage: 1,
          session: signal.session,
          emaRegime: signal.emaRegime as 'above' | 'below',
          marketPhase: signal.marketPhase as 'bull' | 'bear',
        },
        settings,
        state,
        rules,
        gates,
        await loadRiskContext(ctx.db),
      );
      const eurUsd = await getEurUsdRate();
      const suggestedNotionalUsd = verdict.sizing?.notional ?? null;
      return {
        // Strategie-Vorschlag (Referenz fürs Ticket)
        suggested: {
          notionalUsd: suggestedNotionalUsd,
          notionalEur: suggestedNotionalUsd !== null && eurUsd ? suggestedNotionalUsd / eurUsd : null,
          leverage: Number(signal.leverageSuggested ?? 1) || 1,
          stopLoss: Number(signal.stopLoss),
          takeProfits: signal.takeProfits.map((tp) => Number(tp)),
          entry: Number(signal.entry),
          riskAmountUsd: verdict.sizing?.riskAmount ?? null,
        },
        // Grenzen für die Schieberegler
        limits: {
          maxLeverage: settings.maxLeverage,
          maxNotionalUsd: Math.min(
            state.availableMargin * settings.maxLeverage,
            state.equity * (settings.maxExposurePctPerAsset / 100),
          ),
          minNotionalUsd: rules.minNotional,
          equityUsd: state.equity,
        },
        /** Echter EUR/USD-Kurs; null = Quelle nicht erreichbar (UI zeigt USD). */
        eurUsdRate: eurUsd,
        gateReasons: verdict.allowed ? [] : verdict.reasons,
      };
    }),

  /** Bestätigen (Mensch im Loop): Risk-Gate → Paper-Order. Nur aus Status 'new'.
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
        void sendTelegram(formatEmergencyAlert(updated.symbol, execution.detail, execution.emergency.closed));
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
