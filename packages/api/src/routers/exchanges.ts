import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  connectExchange,
  fetchConnectionBalances,
  listConnections,
  listSupportedExchanges,
  loadRoutingConnections,
  pickConnectionForSymbol,
  refreshConnectionMarkets,
  revokeConnection,
  setConnectionMode,
} from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog } = schema;

/**
 * Universelle Börsen-Anbindung (System → „Börse verbinden"):
 * jede CCXT-Börse (100+) per API-Key + Secret, Vault-verschlüsselt, Read-Only
 * oder Trading-Modus. Verbindung wird beim Anlegen GEGEN DIE ECHTE BÖRSE
 * bewiesen. Echte Live-Orders gibt es weiterhin bewusst NICHT — der
 * Order-Router zeigt nur ehrlich, welche verbundene Börse ein Asset
 * ausführen WÜRDE (Live-Pfad erst nach ausdrücklicher Freigabe).
 */

const credentialsInput = z.object({
  apiKey: z.string().min(8, 'API-Key zu kurz.'),
  secret: z.string().min(8, 'API-Secret zu kurz.'),
  password: z.string().optional(),
  uid: z.string().optional(),
});

function asBadRequest(err: unknown): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) });
}

export const exchangesRouter = router({
  /** Alle unterstützten CCXT-Börsen für das Dropdown. */
  supported: protectedProcedure.query(() => listSupportedExchanges()),

  list: protectedProcedure.query(({ ctx }) => listConnections(ctx.db, ctx.user.id)),

  connect: protectedProcedure
    .input(
      z.object({
        exchangeId: z.string().min(2).max(40),
        label: z.string().max(80).optional(),
        mode: z.enum(['read_only', 'trading']).default('read_only'),
        credentials: credentialsInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let dto;
      try {
        dto = await connectExchange(ctx.db, { userId: ctx.user.id, ...input });
      } catch (err) {
        throw asBadRequest(err);
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'exchange.connect',
        entityType: 'exchange_connection',
        entityId: dto.id,
        details: { exchangeId: dto.exchangeId, mode: dto.mode, keyMasked: dto.keyMasked },
        ip: ctx.ip,
      });
      return dto;
    }),

  balances: protectedProcedure
    .input(z.object({ connectionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        return await fetchConnectionBalances(ctx.db, ctx.user.id, input.connectionId);
      } catch (err) {
        throw asBadRequest(err);
      }
    }),

  refreshMarkets: protectedProcedure
    .input(z.object({ connectionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await refreshConnectionMarkets(ctx.db, ctx.user.id, input.connectionId);
      } catch (err) {
        throw asBadRequest(err);
      }
    }),

  setMode: protectedProcedure
    .input(z.object({ connectionId: z.string().uuid(), mode: z.enum(['read_only', 'trading']) }))
    .mutation(async ({ ctx, input }) => {
      let dto;
      try {
        dto = await setConnectionMode(ctx.db, ctx.user.id, input.connectionId, input.mode);
      } catch (err) {
        throw asBadRequest(err);
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'exchange.set_mode',
        entityType: 'exchange_connection',
        entityId: input.connectionId,
        details: { mode: input.mode },
        ip: ctx.ip,
      });
      return dto;
    }),

  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await revokeConnection(ctx.db, ctx.user.id, input.connectionId);
      } catch (err) {
        throw asBadRequest(err);
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'exchange.disconnect',
        entityType: 'exchange_connection',
        entityId: input.connectionId,
        details: {},
        ip: ctx.ip,
      });
      return { ok: true };
    }),

  /** Order-Router-Vorschau: welche verbundene Börse würde dieses Asset ausführen? */
  routePreview: protectedProcedure
    .input(z.object({ symbol: z.string().min(3).max(30) }))
    .query(async ({ ctx, input }) => {
      const connections = await loadRoutingConnections(ctx.db, ctx.user.id);
      const picked = pickConnectionForSymbol(connections, input.symbol);
      return picked
        ? { connectionId: picked.id, exchangeId: picked.exchangeId }
        : null;
    }),
});
