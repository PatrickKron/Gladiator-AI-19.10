import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { buildAccountState, PAPER_START_EQUITY } from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { positions, orders, executedTrades } = schema;

/** Trading-Seite (09_ §3.9): Konto, offene Positionen, Schutz-Orders, Historie — alles echt. */
export const tradingRouter = router({
  account: protectedProcedure.query(async ({ ctx }) => {
    const state = await buildAccountState(ctx.db, ctx.user.id);
    const venueStatus = ctx.venue ? await ctx.venue.validate() : { ok: false, detail: 'Kein Venue aktiv.' };
    return {
      mode: 'paper' as const,
      startEquity: PAPER_START_EQUITY,
      equity: state.equity,
      dailyPnlPct: state.dailyPnlPct,
      weeklyPnlPct: state.weeklyPnlPct,
      openPositions: state.openPositions,
      consecutiveLosses: state.consecutiveLosses,
      venue: { id: ctx.venue?.id ?? 'none', kind: ctx.venue?.kind ?? 'none', ...venueStatus },
    };
  }),

  positions: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(positions)
      .where(eq(positions.userId, ctx.user.id))
      .orderBy(desc(positions.openedAt));

    // Unrealisierter PnL gegen den ECHTEN Live-Preis (kein Cache-Fake)
    const out = [];
    for (const p of rows) {
      let mark: number | null = null;
      try {
        mark = ctx.venue ? await ctx.venue.markPrice(p.symbol) : null;
      } catch {
        mark = null; // ehrlich: Preis gerade nicht verfügbar
      }
      const entry = Number(p.entryPrice);
      const qty = Number(p.qty);
      const sign = p.direction === 'long' ? 1 : -1;
      out.push({
        id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        qty,
        entryPrice: entry,
        openedAt: p.openedAt.toISOString(),
        markPrice: mark,
        unrealizedPnl: mark === null ? null : (mark - entry) * qty * sign,
      });
    }
    return out;
  }),

  protectionOrders: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: orders.id,
        symbol: orders.symbol,
        type: orders.type,
        side: orders.side,
        qty: orders.qty,
        price: orders.price,
        status: orders.status,
        clientOrderId: orders.clientOrderId,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.userId, ctx.user.id), eq(orders.status, 'open'), inArray(orders.type, ['stop_market', 'take_profit_market'])))
      .orderBy(desc(orders.createdAt))
      .limit(50);
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(executedTrades)
        .where(eq(executedTrades.userId, ctx.user.id))
        .orderBy(desc(executedTrades.createdAt))
        .limit(input.limit);
    }),
});
