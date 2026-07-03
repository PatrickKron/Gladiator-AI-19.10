import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { executeConfirmedSignal } from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { signals, strategies, auditLog } = schema;

/**
 * Signal-Feed + Mensch-im-Loop-Entscheidung.
 * Seit Phase 4b führt „Bestätigen" den vollen Lifecycle aus:
 * Risk-Gate (statisch + adaptiv) → Paper-Order gegen echte Live-Preise
 * → Schutz-Orders → Position. Blockt das Gate, bleibt das Signal 'new'
 * und die Gründe gehen an die UI. Jeder Schritt ist auditiert.
 */
export const signalsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        status: z.array(z.enum(['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed'])).default(['new']),
        limit: z.number().int().min(1).max(200).default(50),
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
          strategySlug: strategies.slug,
        })
        .from(signals)
        .innerJoin(strategies, eq(strategies.id, signals.strategyId))
        .where(inArray(signals.status, input.status))
        .orderBy(desc(signals.createdAt))
        .limit(input.limit);
      return rows;
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
