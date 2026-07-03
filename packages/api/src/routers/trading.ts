import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { buildAccountState, PAPER_START_EQUITY } from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { positions, orders, executedTrades, venueApprovals, auditLog } = schema;

/** Venues, für die eine Live-Freigabe überhaupt beantragbar ist. */
const APPROVABLE_VENUES = ['binance-testnet', 'hyperliquid-testnet'] as const;

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

  /** Venue-Liste (09_ §3.9): was ist konfiguriert, was aktiv — Zugänge legt nur Patrick an. */
  venues: protectedProcedure.query(({ ctx }) => {
    const active = ctx.venue?.id ?? 'none';
    return [
      { id: 'paper-internal', kind: 'paper' as const, configured: true, active: active === 'paper-internal' },
      {
        id: 'binance-testnet',
        kind: 'testnet' as const,
        configured: Boolean(process.env.BINANCE_TESTNET_KEY && process.env.BINANCE_TESTNET_SECRET),
        active: active === 'binance-testnet',
      },
      {
        id: 'hyperliquid-testnet',
        kind: 'testnet' as const,
        configured: Boolean(process.env.HYPERLIQUID_TESTNET_WALLET && process.env.HYPERLIQUID_TESTNET_AGENT_KEY),
        active: active === 'hyperliquid-testnet',
      },
    ];
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

  /**
   * Live-Freigaben pro Börse (11_ Phase 7 / 10_ §5) — NUR Patrick, Mensch im
   * Loop. WICHTIG: Eine Freigabe hier schaltet NICHTS automatisch live —
   * es existiert bewusst kein Live-Order-Pfad; sie ist die dokumentierte,
   * auditierte Voraussetzung dafür, dass ein künftiger Live-Adapter für
   * dieses Venue überhaupt gebaut/aktiviert werden darf.
   */
  approvals: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(venueApprovals).orderBy(desc(venueApprovals.approvedAt));
    return APPROVABLE_VENUES.map((venueId) => {
      const active = rows.find((r) => r.venueId === venueId && r.revokedAt === null);
      const last = rows.find((r) => r.venueId === venueId);
      return {
        venueId,
        approved: Boolean(active),
        approvedAt: active?.approvedAt ?? null,
        note: active?.note ?? null,
        lastRevokedAt: !active ? (last?.revokedAt ?? null) : null,
      };
    });
  }),

  approveVenue: protectedProcedure
    .input(
      z.object({
        venueId: z.enum(APPROVABLE_VENUES),
        /** Exakte Bestätigungsphrase — verhindert versehentliche Klicks. */
        confirmation: z.string(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const expected = `LIVE-FREIGABE ${input.venueId}`;
      if (input.confirmation !== expected) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Bestätigungsphrase falsch — exakt "${expected}" eingeben.`,
        });
      }
      const [existing] = await ctx.db
        .select()
        .from(venueApprovals)
        .where(and(eq(venueApprovals.venueId, input.venueId), isNull(venueApprovals.revokedAt)))
        .limit(1);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Für dieses Venue existiert bereits eine aktive Freigabe.' });
      }
      const [row] = await ctx.db
        .insert(venueApprovals)
        .values({ venueId: input.venueId, approvedBy: ctx.user.id, note: input.note ?? null })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'venue.live_approval.granted',
        entityType: 'venue_approval',
        entityId: row!.id,
        details: { venueId: input.venueId, note: input.note ?? null },
        ip: ctx.ip,
      });
      return row!;
    }),

  revokeVenue: protectedProcedure
    .input(z.object({ venueId: z.enum(APPROVABLE_VENUES) }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(venueApprovals)
        .where(and(eq(venueApprovals.venueId, input.venueId), isNull(venueApprovals.revokedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Keine aktive Freigabe für dieses Venue.' });
      const [row] = await ctx.db
        .update(venueApprovals)
        .set({ revokedAt: new Date(), revokedBy: ctx.user.id })
        .where(eq(venueApprovals.id, existing.id))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'venue.live_approval.revoked',
        entityType: 'venue_approval',
        entityId: existing.id,
        details: { venueId: input.venueId },
        ip: ctx.ip,
      });
      return row!;
    }),
});
