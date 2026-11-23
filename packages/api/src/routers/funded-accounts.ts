import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  evaluateFundedAccount,
  FUNDED_PHASES,
  FUNDED_PROVIDER_PRESETS,
  FUNDED_STATUSES,
  fundedAccountCreateSchema,
} from '@gladiator/risk';
import { fetchConnectionBalances } from '@gladiator/exchange';
import { valueBalancesUsd } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

const { fundedAccounts, exchangeConnections, auditLog } = schema;

/**
 * Fremdgeldkonten (Welle 22): Prop-Firm- & Drittkapital-Konten (FTMO, Topstep,
 * Apex, FundedNext, The5ers, CCXT-Subaccounts oder eigene Anbieter).
 * Strikt getrennt von Eigengeld, keine Auszahlungen/Transfers, jede Änderung auditiert.
 */

function toDto(row: typeof fundedAccounts.$inferSelect) {
  const startBalance = Number(row.startBalance);
  const currentEquity = Number(row.currentEquity);
  const highWaterMark = Number(row.highWaterMark);
  const dailyStartEquity = Number(row.dailyStartEquity);
  const dailyLossLimitPct = Number(row.dailyLossLimitPct);
  const maxTotalDrawdownPct = Number(row.maxTotalDrawdownPct);
  const profitTargetPct = row.profitTargetPct === null ? null : Number(row.profitTargetPct);
  const payoutSplitPct = Number(row.payoutSplitPct);
  const evaluation = evaluateFundedAccount({
    startBalance,
    currentEquity,
    highWaterMark,
    dailyStartEquity,
    dailyLossLimitPct,
    maxTotalDrawdownPct,
    profitTargetPct,
    trailingDrawdown: row.trailingDrawdown,
  });
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    phase: row.phase,
    currency: row.currency as 'USD' | 'EUR',
    startBalance,
    currentEquity,
    highWaterMark,
    dailyStartEquity,
    dailyLossLimitPct,
    maxTotalDrawdownPct,
    profitTargetPct,
    payoutSplitPct,
    trailingDrawdown: row.trailingDrawdown,
    exchangeConnectionId: row.exchangeConnectionId,
    notes: row.notes,
    status: row.status,
    evaluation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const fundedAccountsRouter = router({
  /** Anbieter-Vorlagen (FTMO, Topstep, Apex, FundedNext, The5ers, CCXT-Subaccount, Custom). */
  presets: protectedProcedure.query(() => FUNDED_PROVIDER_PRESETS),

  /** Alle Fremdgeldkonten des Nutzers inkl. deterministischer Regel-Auswertung. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(fundedAccounts)
      .where(eq(fundedAccounts.userId, ctx.user.id))
      .orderBy(desc(fundedAccounts.createdAt));
    return rows.map(toDto);
  }),

  /** Neues Fremdgeldkonto anlegen (optional verknüpft mit einer bestehenden CCXT-API-Verbindung). */
  create: protectedProcedure.input(fundedAccountCreateSchema).mutation(async ({ ctx, input }) => {
    if (input.exchangeConnectionId) {
      const [conn] = await ctx.db
        .select({ id: exchangeConnections.id })
        .from(exchangeConnections)
        .where(and(eq(exchangeConnections.id, input.exchangeConnectionId), eq(exchangeConnections.userId, ctx.user.id)))
        .limit(1);
      if (!conn) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Verknüpfte Börsen-Verbindung nicht gefunden.' });
      }
    }

    const eqVal = input.currentEquity ?? input.startBalance;
    const hwm = Math.max(input.startBalance, eqVal);

    const [created] = await ctx.db
      .insert(fundedAccounts)
      .values({
        userId: ctx.user.id,
        name: input.name,
        provider: input.provider,
        phase: input.phase,
        currency: input.currency,
        startBalance: String(input.startBalance),
        currentEquity: String(eqVal),
        highWaterMark: String(hwm),
        dailyStartEquity: String(eqVal),
        dailyLossLimitPct: String(input.dailyLossLimitPct),
        maxTotalDrawdownPct: String(input.maxTotalDrawdownPct),
        profitTargetPct: input.profitTargetPct != null ? String(input.profitTargetPct) : null,
        payoutSplitPct: String(input.payoutSplitPct),
        trailingDrawdown: input.trailingDrawdown,
        exchangeConnectionId: input.exchangeConnectionId ?? null,
        notes: input.notes?.trim() || null,
        status: 'active',
      })
      .returning();

    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'funded_account.created',
      entityType: 'funded_account',
      entityId: created!.id,
      details: {
        name: input.name,
        provider: input.provider,
        phase: input.phase,
        startBalance: input.startBalance,
        exchangeConnectionId: input.exchangeConnectionId ?? null,
      },
      ip: ctx.ip,
    });

    return toDto(created!);
  }),

  /** Aktuelles Guthaben, Tagesstart, Phase, Status oder Notizen eines Fremdgeldkontos aktualisieren. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        currentEquity: z.number().nonnegative().max(100_000_000).optional(),
        resetDailyStart: z.boolean().optional(),
        phase: z.enum(FUNDED_PHASES).optional(),
        status: z.enum(FUNDED_STATUSES).optional(),
        notes: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(fundedAccounts)
        .where(and(eq(fundedAccounts.id, input.id), eq(fundedAccounts.userId, ctx.user.id)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fremdgeldkonto nicht gefunden.' });

      const nextEquity = input.currentEquity ?? Number(existing.currentEquity);
      const nextHwm = Math.max(Number(existing.highWaterMark), nextEquity);
      const nextDailyStart = input.resetDailyStart ? nextEquity : Number(existing.dailyStartEquity);

      const [updated] = await ctx.db
        .update(fundedAccounts)
        .set({
          currentEquity: String(nextEquity),
          highWaterMark: String(nextHwm),
          dailyStartEquity: String(nextDailyStart),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(fundedAccounts.id, existing.id))
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'funded_account.updated',
        entityType: 'funded_account',
        entityId: existing.id,
        details: { currentEquity: nextEquity, highWaterMark: nextHwm, phase: updated!.phase, status: updated!.status },
        ip: ctx.ip,
      });

      return toDto(updated!);
    }),

  /** Synchronisiert das aktuelle Guthaben direkt aus der verknüpften CCXT-Börsen-API (echte Salden). */
  syncFromExchange: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(fundedAccounts)
        .where(and(eq(fundedAccounts.id, input.id), eq(fundedAccounts.userId, ctx.user.id)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fremdgeldkonto nicht gefunden.' });
      if (!existing.exchangeConnectionId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Dieses Fremdgeldkonto ist mit keiner Börsen-API verknüpft — Guthaben manuell aktualisieren oder CCXT-Verbindung hinterlegen.',
        });
      }

      const balances = await fetchConnectionBalances(ctx.db, ctx.user.id, existing.exchangeConnectionId);
      const amounts: Record<string, number> = {};
      for (const b of balances) amounts[b.currency] = b.total;
      const valued = await valueBalancesUsd(amounts);
      const nextEquity = Math.round(valued.totalUsd * 100) / 100;
      const nextHwm = Math.max(Number(existing.highWaterMark), nextEquity);

      const [updated] = await ctx.db
        .update(fundedAccounts)
        .set({
          currentEquity: String(nextEquity),
          highWaterMark: String(nextHwm),
          updatedAt: new Date(),
        })
        .where(eq(fundedAccounts.id, existing.id))
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'funded_account.synced',
        entityType: 'funded_account',
        entityId: existing.id,
        details: { totalUsd: nextEquity, assetsCount: balances.length },
        ip: ctx.ip,
      });

      return toDto(updated!);
    }),

  /** Fremdgeldkonto entfernen. */
  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(fundedAccounts)
        .where(and(eq(fundedAccounts.id, input.id), eq(fundedAccounts.userId, ctx.user.id)))
        .returning();
      if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fremdgeldkonto nicht gefunden.' });
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'funded_account.deleted',
        entityType: 'funded_account',
        entityId: deleted.id,
        details: { name: deleted.name, provider: deleted.provider },
        ip: ctx.ip,
      });
      return { ok: true };
    }),
});
