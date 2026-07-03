import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { executeConfirmedSignal } from '@gladiator/exchange';
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

  /** Bestätigen (Mensch im Loop): Risk-Gate → Paper-Order. Nur aus Status 'new'. */
  confirm: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.venue) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Trading-Venue aktiv — Ausführung nicht möglich.' });
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
        details: { symbol: updated.symbol, timeframe: updated.timeframe, direction: updated.direction },
        ip: ctx.ip,
      });

      const execution = await executeConfirmedSignal(ctx.db, ctx.venue, {
        signalId: updated.id,
        userId: ctx.user.id,
        ip: ctx.ip,
      });

      if (!execution.executed) {
        // Gate hat geblockt → Signal bleibt handlungsfähig ('new'), Gründe an die UI
        await ctx.db
          .update(signals)
          .set({ status: 'new', updatedAt: new Date() })
          .where(eq(signals.id, updated.id));
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
