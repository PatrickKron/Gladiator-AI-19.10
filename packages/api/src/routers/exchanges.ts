import { TRPCError } from '@trpc/server';
import ccxt from 'ccxt';
import { and, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  connectExchange,
  connectWallet,
  ensureLiveModeStillValid,
  fetchConnectionBalances,
  listConnections,
  listSupportedExchanges,
  loadPreferredExchanges,
  loadRiskSettings,
  loadRoutingConnections,
  pickConnectionForSymbol,
  refreshConnectionMarkets,
  revokeConnection,
  setConnectionMode,
  walletExchanges,
} from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog, venueApprovals } = schema;

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

  /** Börsen mit Wallet-Login (Hyperliquid & Co.) — per öffentlicher Adresse nur lesend anschließbar. */
  walletSupported: protectedProcedure.query(() => walletExchanges()),

  list: protectedProcedure.query(({ ctx }) => listConnections(ctx.db, ctx.user.id)),

  /** Aus Patricks eigenen Chat-Nachrichten erkannte Börsen (Vorschlag, nie Auto-Aktion). */
  preferred: protectedProcedure.query(async ({ ctx }) =>
    (await loadPreferredExchanges(ctx.db, ctx.user.id)).map((p) => ({ ...p, lastMentionedAt: p.lastMentionedAt.toISOString() })),
  ),

  /** Wallet anschließen: nur die ÖFFENTLICHE Adresse, nie ein Private Key — immer read_only. */
  connectWallet: protectedProcedure
    .input(
      z.object({
        exchangeId: z.string().min(2).max(40),
        walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Ungültige Wallet-Adresse.'),
        label: z.string().max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let dto;
      try {
        dto = await connectWallet(ctx.db, { userId: ctx.user.id, ...input });
      } catch (err) {
        throw asBadRequest(err);
      }
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'exchange.connect_wallet',
        entityType: 'exchange_connection',
        entityId: dto.id,
        details: { exchangeId: dto.exchangeId, mode: dto.mode, address: dto.keyMasked },
        ip: ctx.ip,
      });
      return dto;
    }),

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
      if (input.mode === 'read_only') {
        await ensureLiveModeStillValid(ctx.db, ctx.user.id, `exchange_read_only:${input.connectionId}`, ctx.ip);
      }
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
      await ensureLiveModeStillValid(ctx.db, ctx.user.id, `exchange_disconnected:${input.connectionId}`, ctx.ip);
      return { ok: true };
    }),

  /** Order-Router-Vorschau: welche verbundene Börse führt dieses Asset aus, und ist sie live freigegeben? */
  routePreview: protectedProcedure
    .input(z.object({ symbol: z.string().min(3).max(30) }))
    .query(async ({ ctx, input }) => {
      const connections = await loadRoutingConnections(ctx.db, ctx.user.id);
      const picked = pickConnectionForSymbol(connections, input.symbol);
      if (!picked) return null;
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const approvals = await ctx.db
        .select({ id: venueApprovals.id })
        .from(venueApprovals)
        .where(
          and(
            isNull(venueApprovals.revokedAt),
            inArray(venueApprovals.venueId, [picked.exchangeId, `live:${picked.id}`]),
          ),
        )
        .limit(1);
      return {
        connectionId: picked.id,
        exchangeId: picked.exchangeId,
        approved: approvals.length > 0,
        tradingMode: settings.mode,
      };
    }),

  /** Misst echte Round-Trip-Latenz (ms) zu jeder verbundenen Börse (öffentlicher Ping, isoliert je Börse). */
  pingAll: protectedProcedure.query(async ({ ctx }) => {
    const conns = await listConnections(ctx.db, ctx.user.id);
    const active = conns.filter((c) => c.status === 'active');
    const results = await Promise.all(
      active.map(async (c) => {
        const Ctor = (ccxt as unknown as Record<string, new (opts: object) => {
          fetchTime?: () => Promise<number>;
          fetchStatus?: () => Promise<unknown>;
          loadMarkets: () => Promise<unknown>;
        }>)[c.exchangeId];
        if (!Ctor) return { connectionId: c.id, exchangeId: c.exchangeId, ok: false, latencyMs: null as number | null, error: 'unbekannt' };
        const ex = new Ctor({ enableRateLimit: true, timeout: 6_000 });
        const t0 = performance.now();
        try {
          if (typeof ex.fetchTime === 'function') await ex.fetchTime();
          else if (typeof ex.fetchStatus === 'function') await ex.fetchStatus();
          else await ex.loadMarkets();
          return { connectionId: c.id, exchangeId: c.exchangeId, ok: true, latencyMs: Math.max(1, Math.round(performance.now() - t0)), error: null as string | null };
        } catch (err) {
          return {
            connectionId: c.id,
            exchangeId: c.exchangeId,
            ok: false,
            latencyMs: null as number | null,
            error: err instanceof Error ? err.message.slice(0, 120) : String(err),
          };
        }
      }),
    );
    return results;
  }),
});
