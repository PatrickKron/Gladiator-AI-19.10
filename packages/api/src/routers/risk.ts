import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { protectedProcedure, router } from '../trpc.js';

const { riskGates, auditLog } = schema;

/**
 * Adaptive Risk-Gates: einsehen und einzeln (de)aktivieren — Mensch im Loop.
 * Gates entstehen NUR über die Labor-Kalibrierung mit Evidenz; hier wird
 * nichts erfunden und nichts gelockert.
 */
export const riskRouter = router({
  gates: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(riskGates).orderBy(desc(riskGates.createdAt)).limit(100);
  }),

  toggleGate: protectedProcedure
    .input(z.object({ id: z.string().uuid(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(riskGates)
        .set({
          isActive: input.active,
          updatedAt: new Date(),
          disabledAt: input.active ? null : new Date(),
          disabledBy: input.active ? null : ctx.user.id,
        })
        .where(eq(riskGates.id, input.id))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gate nicht gefunden.' });
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: input.active ? 'risk.gate.enable' : 'risk.gate.disable',
        entityType: 'risk_gate',
        entityId: updated.id,
        details: { reason: updated.reason },
        ip: ctx.ip,
      });
      return updated;
    }),
});
