import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import {
  cachedTokenInfo,
  cachedTokenSafety,
  executePreparedSwap,
  limitsOf,
  liveKeysAllowed,
  netError,
  prepareSwap,
  quoteView,
  swapNet,
  SwapError,
  syncLiveBalances,
  validateNewOrder,
  type SwapWalletRow,
} from '@gladiator/jobs';
import {
  encryptSecret,
  generateWalletKey,
  importWalletKey,
  fetchTokenCandles,
  fetchTokenDiscovery,
  DISCOVERY_KINDS,
  type DiscoveredToken,
  fetchTokenPrices,
  TOKEN_CHART_TIMEFRAMES,
  type TokenCandle,
  fromAtomic,
  fundPaperWallet,
  isNativeToken,
  isTokenAddress,
  SWAP_CHAIN_IDS,
  SWAP_CHAINS,
  walletBalances,
  type SwapChainId,
} from '@gladiator/exchange';
import { SWAP_LIMIT_BOUNDS, SWAP_PROFILES } from '@gladiator/risk';
import { protectedProcedure, router } from '../trpc.js';

const MAX_WATCHED = 25;

const copyInput = z.object({
  copyMode: z.enum(['off', 'paper']),
  copyWalletId: z.string().uuid().nullable(),
  /** Betrag je Kopie in nativer Währung (SOL, ETH, BNB) */
  copyAmount: z.string().regex(/^\d+(\.\d+)?$/).refine((v) => Number(v) > 0 && Number(v) <= 1000, 'Betrag: über 0 bis 1000.').nullable(),
});

/** Copy-Ziel prüfen: nur eigene, aktive PAPER-Wallets derselben Kette (echtes Copy-Trading gibt es nicht). */
async function checkCopyTarget(db: Db, userId: string, chain: SwapChainId, input: z.infer<typeof copyInput>): Promise<void> {
  if (input.copyMode === 'off') return;
  if (!input.copyWalletId || !input.copyAmount) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Zum Kopieren Ziel-Wallet und Betrag wählen.' });
  const w = await ownWallet(db, userId, input.copyWalletId);
  if (w.chain !== chain || w.mode !== 'paper') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Kopiert wird nur in eine ${SWAP_CHAINS[chain].name}-Paper-Wallet.` });
  }
}

const { swapWallets, swapTrades, swapOrders, auditLog, watchedWallets, watchedWalletSwaps } = schema;

/**
 * Wallet-Trading / Spot-Swaps (Vision-Punkt 5, „wie Trojan, für alle Wallets").
 * Die Swap-Logik (Angebot, Sicherheitscheck, Gate, Paper/Live) liegt im
 * Swap-Dienst von @gladiator/jobs — derselbe Pfad wie für ausgelöste Orders.
 */

export { setSwapFetchForTests, setLiveSwapExecutorForTests } from '@gladiator/jobs';

const CANDLE_TTL_MS = 60_000;
const candleCache = new Map<string, { at: number; candles: TokenCandle[] }>();
const discoveryCache = new Map<string, { at: number; tokens: DiscoveredToken[] }>();

/** SwapError des Dienstes → tRPC-Fehler (gleicher Code, gleiche Meldung). */
function asTrpc(err: unknown): never {
  if (err instanceof SwapError) throw new TRPCError({ code: err.code, message: err.message });
  throw err;
}

const chainSchema = z.enum(SWAP_CHAIN_IDS);
const limitsSchema = z.object({
  maxTradeUsd: z.number().min(SWAP_LIMIT_BOUNDS.maxTradeUsd.min).max(SWAP_LIMIT_BOUNDS.maxTradeUsd.max),
  maxSlippageBps: z.number().int().min(SWAP_LIMIT_BOUNDS.maxSlippageBps.min).max(SWAP_LIMIT_BOUNDS.maxSlippageBps.max),
  maxPriceImpactPct: z.number().min(SWAP_LIMIT_BOUNDS.maxPriceImpactPct.min).max(SWAP_LIMIT_BOUNDS.maxPriceImpactPct.max),
  minLiquidityUsd: z.number().min(SWAP_LIMIT_BOUNDS.minLiquidityUsd.min).max(SWAP_LIMIT_BOUNDS.minLiquidityUsd.max),
  maxTokenTaxPct: z.number().min(SWAP_LIMIT_BOUNDS.maxTokenTaxPct.min).max(SWAP_LIMIT_BOUNDS.maxTokenTaxPct.max),
});

type WalletRow = SwapWalletRow;

function walletView(w: WalletRow) {
  return {
    id: w.id,
    chain: w.chain as SwapChainId,
    label: w.label,
    mode: w.mode,
    address: w.mode === 'live' ? w.address : null,
    liveApproved: w.liveApprovedAt !== null,
    slippageBps: w.slippageBps,
    limits: limitsOf(w),
    createdAt: w.createdAt.toISOString(),
  };
}

async function ownWallet(db: Db, userId: string, walletId: string): Promise<WalletRow> {
  const [w] = await db
    .select()
    .from(swapWallets)
    .where(and(eq(swapWallets.id, walletId), eq(swapWallets.userId, userId), isNull(swapWallets.archivedAt)));
  if (!w) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet nicht gefunden.' });
  return w;
}

const swapInput = z
  .object({
    walletId: z.string().uuid(),
    side: z.enum(['buy', 'sell']),
    token: z.string().min(32).max(64),
    /** Kauf: Betrag in nativer Währung (Dezimal-String) */
    amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    /** Verkauf: Anteil des Bestands in % */
    percent: z.number().min(0.01).max(100).optional(),
    slippageBps: z.number().int().min(1).max(5_000).optional(),
    /** Live-Wallets: ausdrückliche Bestätigung genau dieses Swaps. */
    confirmLive: z.boolean().optional(),
  })
  .refine((v) => (v.side === 'buy' ? v.amount !== undefined : v.percent !== undefined), {
    message: 'Kauf braucht einen Betrag, Verkauf einen Anteil in %.',
  });

export const swapsRouter = router({
  /** Ketten, Profile, Grenzen und ob diese Instanz Wallet-Schlüssel überhaupt annimmt. */
  config: protectedProcedure.query(() => ({
    chains: SWAP_CHAIN_IDS.map((id) => {
      const c = SWAP_CHAINS[id];
      return { id, name: c.name, kind: c.kind, native: c.native, quickBuy: c.quickBuy, aggregator: c.aggregator, explorerTx: c.explorerTx };
    }),
    profiles: SWAP_PROFILES,
    bounds: SWAP_LIMIT_BOUNDS,
    liveKeysAllowed: liveKeysAllowed(),
  })),

  wallets: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(swapWallets)
      .where(and(eq(swapWallets.userId, ctx.user.id), isNull(swapWallets.archivedAt)))
      .orderBy(swapWallets.createdAt);
    return rows.map(walletView);
  }),

  /** Paper-Wallet mit Startguthaben in nativer Währung (bewertet zum echten Preis). */
  createPaperWallet: protectedProcedure
    .input(
      z.object({
        chain: chainSchema,
        label: z.string().trim().min(1).max(40),
        startAmount: z.string().regex(/^\d+(\.\d+)?$/),
        limits: limitsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const native = SWAP_CHAINS[input.chain].native;
      if (!(Number(input.startAmount) > 0)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Startguthaben muss größer als 0 sein.' });
      let price: number | null;
      try {
        price = (await cachedTokenInfo(input.chain, native.address)).priceUsd;
      } catch (err) {
        throw asTrpc(netError(err));
      }
      if (!price) throw new TRPCError({ code: 'BAD_GATEWAY', message: `Kein ${native.symbol}-Preis verfügbar.` });
      const [w] = await ctx.db
        .insert(swapWallets)
        .values({
          userId: ctx.user.id,
          chain: input.chain,
          label: input.label,
          mode: 'paper',
          address: `paper:${randomUUID()}`,
          maxTradeUsd: String(input.limits.maxTradeUsd),
          maxSlippageBps: input.limits.maxSlippageBps,
          maxPriceImpactPct: String(input.limits.maxPriceImpactPct),
          minLiquidityUsd: String(input.limits.minLiquidityUsd),
          maxTokenTaxPct: String(input.limits.maxTokenTaxPct),
          slippageBps: Math.min(100, input.limits.maxSlippageBps),
        })
        .returning();
      await fundPaperWallet(ctx.db, w!.id, input.chain, input.startAmount, price);
      return walletView(w!);
    }),

  /**
   * Eigene Trading-Wallet (live) — nur wenn der Betreiber es erlaubt.
   * `generate`: neue Wallet, Schlüssel wird GENAU EINMAL zurückgegeben (sichern!);
   * `import`: vorhandene, eigens fürs Trading angelegte Wallet. Gespeichert wird
   * der Schlüssel nur verschlüsselt (Vault, AES-256-GCM). Live erst nach Freigabe.
   */
  createLiveWallet: protectedProcedure
    .input(
      z.object({
        chain: chainSchema,
        label: z.string().trim().min(1).max(40),
        source: z.enum(['generate', 'import']),
        secret: z.string().min(32).max(1_000).optional(),
        limits: limitsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!liveKeysAllowed()) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Diese Instanz nimmt keine Wallet-Schlüssel an (Betreiber: WALLET_KEYS_ENABLED=1, nur beim Selbsthosten).' });
      }
      const kind = SWAP_CHAINS[input.chain].kind;
      let key: { address: string; secret: string };
      try {
        key = input.source === 'generate' ? generateWalletKey(kind) : importWalletKey(kind, input.secret ?? '');
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) });
      }
      const dup = await ctx.db
        .select({ id: swapWallets.id })
        .from(swapWallets)
        .where(and(eq(swapWallets.userId, ctx.user.id), eq(swapWallets.chain, input.chain), eq(swapWallets.address, key.address), isNull(swapWallets.archivedAt)));
      if (dup.length > 0) throw new TRPCError({ code: 'CONFLICT', message: 'Diese Wallet ist bereits verbunden.' });
      const [w] = await ctx.db
        .insert(swapWallets)
        .values({
          userId: ctx.user.id,
          chain: input.chain,
          label: input.label,
          mode: 'live',
          address: key.address,
          encryptedKey: encryptSecret(key.secret),
          maxTradeUsd: String(input.limits.maxTradeUsd),
          maxSlippageBps: input.limits.maxSlippageBps,
          maxPriceImpactPct: String(input.limits.maxPriceImpactPct),
          minLiquidityUsd: String(input.limits.minLiquidityUsd),
          maxTokenTaxPct: String(input.limits.maxTokenTaxPct),
          slippageBps: Math.min(100, input.limits.maxSlippageBps),
        })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'swap.live_wallet_create',
        entityType: 'swap_wallet',
        entityId: w!.id,
        details: { chain: input.chain, address: key.address, source: input.source },
        ip: ctx.ip,
      });
      return { wallet: walletView(w!), secretOnce: input.source === 'generate' ? key.secret : null };
    }),

  /** Live-Freigabe je Wallet (Mensch im Loop): Bestätigungswort muss exakt stimmen. */
  approveLive: protectedProcedure
    .input(z.object({ walletId: z.string().uuid(), confirm: z.literal('FREIGEBEN') }))
    .mutation(async ({ ctx, input }) => {
      const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
      if (w.mode !== 'live') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nur eigene Wallets (live) brauchen eine Freigabe.' });
      if (!liveKeysAllowed()) throw new TRPCError({ code: 'FORBIDDEN', message: 'Live-Wallets sind auf dieser Instanz abgeschaltet.' });
      const [row] = await ctx.db.update(swapWallets).set({ liveApprovedAt: new Date() }).where(eq(swapWallets.id, w.id)).returning();
      await ctx.db.insert(auditLog).values({ actor: 'user', userId: ctx.user.id, action: 'swap.live_approve', entityType: 'swap_wallet', entityId: w.id, details: { chain: w.chain, address: w.address }, ip: ctx.ip });
      return walletView(row!);
    }),

  revokeLive: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const [row] = await ctx.db.update(swapWallets).set({ liveApprovedAt: null }).where(eq(swapWallets.id, w.id)).returning();
    // ohne Freigabe darf nichts mehr automatisch live ausgeführt werden
    await ctx.db.update(swapOrders).set({ status: 'cancelled', closedAt: new Date(), error: 'Live-Freigabe zurückgezogen' }).where(and(eq(swapOrders.walletId, w.id), eq(swapOrders.status, 'open')));
    await ctx.db.insert(auditLog).values({ actor: 'user', userId: ctx.user.id, action: 'swap.live_revoke', entityType: 'swap_wallet', entityId: w.id, details: { chain: w.chain }, ip: ctx.ip });
    return walletView(row!);
  }),

  updateWallet: protectedProcedure
    .input(
      z.object({
        walletId: z.string().uuid(),
        label: z.string().trim().min(1).max(40).optional(),
        limits: limitsSchema.optional(),
        slippageBps: z.number().int().min(1).max(5_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
      const limits = input.limits ?? limitsOf(w);
      const slippage = input.slippageBps ?? w.slippageBps;
      if (slippage > limits.maxSlippageBps) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Standard-Slippage liegt über der eigenen Obergrenze.' });
      }
      const [row] = await ctx.db
        .update(swapWallets)
        .set({
          label: input.label ?? w.label,
          maxTradeUsd: String(limits.maxTradeUsd),
          maxSlippageBps: limits.maxSlippageBps,
          maxPriceImpactPct: String(limits.maxPriceImpactPct),
          minLiquidityUsd: String(limits.minLiquidityUsd),
          maxTokenTaxPct: String(limits.maxTokenTaxPct),
          slippageBps: slippage,
        })
        .where(eq(swapWallets.id, w.id))
        .returning();
      return walletView(row!);
    }),

  /** Entfernen: bei eigenen Wallets wird der gespeicherte Schlüssel gelöscht (Guthaben bleibt in der Wallet, Zugriff über die eigene Wallet-App). */
  archiveWallet: protectedProcedure
    .input(z.object({ walletId: z.string().uuid(), confirmKeyBackedUp: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
      if (w.mode === 'live' && !input.confirmKeyBackedUp) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Erst bestätigen, dass der Schlüssel gesichert ist — er wird beim Entfernen gelöscht.' });
      }
      await ctx.db.update(swapWallets).set({ archivedAt: new Date(), encryptedKey: null, liveApprovedAt: null }).where(eq(swapWallets.id, w.id));
      await ctx.db.update(swapOrders).set({ status: 'cancelled', closedAt: new Date(), error: 'Wallet entfernt' }).where(and(eq(swapOrders.walletId, w.id), eq(swapOrders.status, 'open')));
      if (w.mode === 'live') {
        await ctx.db.insert(auditLog).values({ actor: 'user', userId: ctx.user.id, action: 'swap.live_wallet_remove', entityType: 'swap_wallet', entityId: w.id, details: { chain: w.chain }, ip: ctx.ip });
      }
      return { ok: true };
    }),

  /** Token-Infos (Preis, Liquidität, MCap, 24 h) — Grundlage für die Kaufentscheidung. */
  token: protectedProcedure.input(z.object({ chain: chainSchema, address: z.string().min(32).max(64) })).query(async ({ input }) => {
    if (!isTokenAddress(input.chain, input.address)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[input.chain].name}-Token-Adresse.` });
    }
    try {
      return await cachedTokenInfo(input.chain, input.address);
    } catch (err) {
      throw asTrpc(netError(err));
    }
  }),

  /** Token-Sicherheitscheck (Mint/Freeze/Honeypot/Steuer) — eigene Abfrage, damit die Token-Infos nicht warten. */
  safety: protectedProcedure.input(z.object({ chain: chainSchema, address: z.string().min(32).max(64) })).query(async ({ input }) => {
    if (!isTokenAddress(input.chain, input.address)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[input.chain].name}-Token-Adresse.` });
    }
    return cachedTokenSafety(input.chain, input.address);
  }),

  /** Bestände mit aktuellem Wert und unrealisierter PnL + letzte Swaps. */
  portfolio: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const chain = w.chain as SwapChainId;
    let chainOk: boolean | null = null;
    if (w.mode === 'live') {
      chainOk = await syncLiveBalances(ctx.db, w).then(
        () => true,
        () => false,
      );
    }
    const balances = await walletBalances(ctx.db, w.id);
    let prices = new Map<string, number>();
    let pricesOk = true;
    try {
      prices = await fetchTokenPrices(chain, balances.map((b) => b.token), swapNet());
    } catch {
      pricesOk = false;
    }
    const holdings = balances.map((b) => {
      const amount = fromAtomic(b.amountAtomic, b.decimals);
      const price = prices.get(b.token) ?? null;
      const valueUsd = price === null ? null : Number(amount) * price;
      const costUsd = Number(b.costUsd);
      return {
        token: b.token,
        symbol: b.symbol,
        native: isNativeToken(chain, b.token),
        amount,
        priceUsd: price,
        valueUsd,
        costUsd,
        pnlUsd: valueUsd === null || isNativeToken(chain, b.token) ? null : valueUsd - costUsd,
      };
    });
    const trades = await ctx.db.select().from(swapTrades).where(eq(swapTrades.walletId, w.id)).orderBy(desc(swapTrades.createdAt)).limit(50);
    const realized = trades.reduce((s, t) => s + Number(t.realizedPnlUsd ?? 0), 0);
    return {
      wallet: walletView(w),
      pricesOk,
      /** live: Bestände frisch von der Kette gelesen? (null = Paper) */
      chainOk,
      holdings,
      // ohne frische Kettendaten (live) oder ohne Kurse keine Summe — nie eine erfundene 0
      totalValueUsd: chainOk !== false && holdings.every((h) => h.valueUsd !== null) ? holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0) : null,
      realizedPnlUsd: realized,
      trades: trades.map((t) => ({
        id: t.id,
        side: t.side,
        mode: t.mode,
        status: t.status,
        inSymbol: t.inSymbol,
        inAmount: fromAtomic(t.inAtomic, t.inDecimals),
        outSymbol: t.outSymbol,
        outAmount: fromAtomic(t.outAtomic, t.outDecimals),
        valueUsd: t.valueUsd === null ? null : Number(t.valueUsd),
        feeUsd: t.feeUsd === null ? null : Number(t.feeUsd),
        realizedPnlUsd: t.realizedPnlUsd === null ? null : Number(t.realizedPnlUsd),
        route: t.route,
        txHash: t.txHash,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }),

  /** Echtes Angebot + Urteil des Swap-Gates (ändert nichts). */
  quote: protectedProcedure.input(swapInput).query(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    return quoteView(await prepareSwap(ctx.db, w, input).catch(asTrpc));
  }),

  /** Ausführen: Angebot neu holen, Gate prüfen, dann Paper-Fill bzw. live (Schalter + Freigabe + Bestätigung). */
  execute: protectedProcedure.input(swapInput).mutation(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const p = await prepareSwap(ctx.db, w, input).catch(asTrpc);
    const r = await executePreparedSwap(ctx.db, p, input.side, {
      userId: ctx.user.id,
      ip: ctx.ip,
      actor: 'user',
      confirmedLive: input.confirmLive === true,
    }).catch(asTrpc);
    return { trade: { id: r.tradeId, realizedPnlUsd: r.realizedPnlUsd, txHash: r.txHash }, quote: quoteView(p) };
  }),

  /** Limit-Orders + Auto-Sell einer Wallet: offene zuerst, dann die letzten erledigten. */
  orders: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const rows = await ctx.db.select().from(swapOrders).where(eq(swapOrders.walletId, w.id)).orderBy(desc(swapOrders.createdAt)).limit(100);
    const rank = (s: string) => (s === 'open' || s === 'executing' ? 0 : 1);
    return rows
      .sort((a, b) => rank(a.status) - rank(b.status))
      .slice(0, 50)
      .map((o) => ({
        id: o.id,
        token: o.token,
        symbol: o.symbol,
        kind: o.kind,
        triggerPriceUsd: o.triggerPriceUsd === null ? null : Number(o.triggerPriceUsd),
        trailPct: o.trailPct === null ? null : Number(o.trailPct),
        peakPriceUsd: o.peakPriceUsd === null ? null : Number(o.peakPriceUsd),
        sellPercent: o.sellPercent === null ? null : Number(o.sellPercent),
        buyAmount: o.buyAmount,
        intervalMinutes: o.intervalMinutes,
        runsTotal: o.runsTotal,
        runsDone: o.runsDone,
        nextRunAt: o.nextRunAt?.toISOString() ?? null,
        maxPriceUsd: o.maxPriceUsd === null ? null : Number(o.maxPriceUsd),
        status: o.status,
        error: o.error,
        createdAt: o.createdAt.toISOString(),
        closedAt: o.closedAt?.toISOString() ?? null,
      }));
  }),

  /**
   * Order anlegen. Plausibel gegen den aktuellen Preis (nichts, was sofort
   * auslöst); Verkäufe nur mit Bestand; live nur mit Freigabe der Wallet und
   * ausdrücklicher Bestätigung — die gilt dann für das spätere Auslösen.
   */
  createOrder: protectedProcedure
    .input(
      z.object({
        walletId: z.string().uuid(),
        token: z.string().min(32).max(64),
        kind: z.enum(['take_profit', 'stop_loss', 'trailing_stop', 'limit_buy', 'dca']),
        /** DCA: Abstand (5 min bis 30 Tage), Anzahl Käufe, optionale Preisgrenze */
        intervalMinutes: z.number().int().min(5).max(43_200).optional(),
        runsTotal: z.number().int().min(2).max(500).optional(),
        maxPriceUsd: z.number().positive().optional(),
        triggerPriceUsd: z.number().positive().optional(),
        trailPct: z.number().min(0.5).max(90).optional(),
        sellPercent: z.number().min(1).max(100).optional(),
        buyAmount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        slippageBps: z.number().int().min(1).max(5_000).optional(),
        confirmLive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
      const chain = w.chain as SwapChainId;
      if (!isTokenAddress(chain, input.token) || isNativeToken(chain, input.token)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[chain].name}-Token-Adresse.` });
      }
      if (input.slippageBps !== undefined && input.slippageBps > w.maxSlippageBps) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Slippage liegt über der Obergrenze dieser Wallet.' });
      }
      if (w.mode === 'live') {
        if (!liveKeysAllowed() || !w.liveApprovedAt) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Diese Wallet ist nicht für Live-Swaps freigegeben.' });
        if (input.confirmLive !== true) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Live-Order bitte ausdrücklich bestätigen — sie wird später automatisch ausgeführt.' });
      }
      const dca = input.kind === 'dca';
      const buy = input.kind === 'limit_buy' || dca;
      if (buy && !(input.buyAmount && Number(input.buyAmount) > 0)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Kauf-Order braucht einen Betrag.' });
      if (dca && (input.intervalMinutes === undefined || input.runsTotal === undefined)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'DCA braucht Abstand und Anzahl der Käufe.' });
      }
      const info = await cachedTokenInfo(chain, input.token).catch((err: unknown) => asTrpc(netError(err)));
      if (info.priceUsd === null) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Kein aktueller Kurs — Order nicht prüfbar.' });
      if (!buy) {
        if (w.mode === 'live') await syncLiveBalances(ctx.db, w, { address: info.address, symbol: info.symbol, decimals: info.decimals }).catch((err: unknown) => asTrpc(netError(err)));
        const held = (await walletBalances(ctx.db, w.id)).find((b) => b.token === input.token);
        if (!held || BigInt(held.amountAtomic) === 0n) throw new TRPCError({ code: 'BAD_REQUEST', message: `Kein ${info.symbol}-Bestand in dieser Wallet.` });
      }
      const state = { kind: input.kind, triggerPriceUsd: input.triggerPriceUsd ?? null, trailPct: input.trailPct ?? null, peakPriceUsd: null };
      const problem = validateNewOrder(state, info.priceUsd);
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });
      const [o] = await ctx.db
        .insert(swapOrders)
        .values({
          walletId: w.id,
          token: input.token,
          symbol: info.symbol,
          kind: input.kind,
          triggerPriceUsd: input.kind === 'trailing_stop' || dca ? null : String(input.triggerPriceUsd),
          trailPct: input.kind === 'trailing_stop' ? String(input.trailPct) : null,
          peakPriceUsd: input.kind === 'trailing_stop' ? String(info.priceUsd) : null,
          sellPercent: buy ? null : String(input.sellPercent ?? 100),
          buyAmount: buy ? input.buyAmount! : null,
          slippageBps: input.slippageBps ?? null,
          // DCA: erster Kauf im nächsten Worker-Takt
          intervalMinutes: dca ? input.intervalMinutes! : null,
          runsTotal: dca ? input.runsTotal! : null,
          nextRunAt: dca ? new Date() : null,
          maxPriceUsd: dca && input.maxPriceUsd !== undefined ? String(input.maxPriceUsd) : null,
          confirmedLive: w.mode === 'live' && input.confirmLive === true,
        })
        .returning();
      if (w.mode === 'live') {
        await ctx.db.insert(auditLog).values({ actor: 'user', userId: ctx.user.id, action: 'swap.live_order_create', entityType: 'swap_order', entityId: o!.id, details: { chain, kind: input.kind, token: input.token, triggerPriceUsd: input.triggerPriceUsd ?? null, trailPct: input.trailPct ?? null, sellPercent: input.sellPercent ?? null, buyAmount: input.buyAmount ?? null, intervalMinutes: input.intervalMinutes ?? null, runsTotal: input.runsTotal ?? null, maxPriceUsd: input.maxPriceUsd ?? null }, ip: ctx.ip });
      }
      return { id: o!.id };
    }),

  cancelOrder: protectedProcedure.input(z.object({ orderId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [o] = await ctx.db.select().from(swapOrders).where(eq(swapOrders.id, input.orderId));
    if (!o) throw new TRPCError({ code: 'NOT_FOUND', message: 'Order nicht gefunden.' });
    await ownWallet(ctx.db, ctx.user.id, o.walletId);
    const rows = await ctx.db
      .update(swapOrders)
      .set({ status: 'cancelled', closedAt: new Date(), error: null })
      .where(and(eq(swapOrders.id, o.id), inArray(swapOrders.status, ['open'])))
      .returning({ id: swapOrders.id });
    if (rows.length === 0) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Order ist nicht mehr offen.' });
    return { ok: true };
  }),

  /** Echte Kerzen des Token-Pools (GeckoTerminal) für den Chart im Ticket; 60 s gecacht (freies Abruf-Limit). */
  candles: protectedProcedure
    .input(z.object({ chain: chainSchema, pool: z.string().min(32).max(90), tf: z.enum(TOKEN_CHART_TIMEFRAMES) }))
    .query(async ({ input }) => {
      const key = `${input.chain}:${input.pool}:${input.tf}`;
      const hit = candleCache.get(key);
      if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.candles;
      try {
        const candles = await fetchTokenCandles(input.chain, input.pool, input.tf, swapNet());
        candleCache.set(key, { at: Date.now(), candles });
        return candles;
      } catch (err) {
        return asTrpc(netError(err));
      }
    }),

  /** Token entdecken: Trend-Pools / neue Pools je Kette (GeckoTerminal), 60 s gecacht. Kein Kaufsignal — Check + Gate im Ticket. */
  discover: protectedProcedure.input(z.object({ chain: chainSchema, kind: z.enum(DISCOVERY_KINDS) })).query(async ({ input }) => {
    const key = `${input.chain}:${input.kind}`;
    const hit = discoveryCache.get(key);
    if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.tokens;
    try {
      const tokens = await fetchTokenDiscovery(input.chain, input.kind, swapNet());
      discoveryCache.set(key, { at: Date.now(), tokens });
      return tokens;
    } catch (err) {
      return asTrpc(netError(err));
    }
  }),

  /** Beobachtete Wallets (Copy-Trading, Solana). */
  watched: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(watchedWallets).where(eq(watchedWallets.userId, ctx.user.id)).orderBy(desc(watchedWallets.createdAt));
    if (rows.length === 0) return [];
    // Copy-Statistik aus den echten Paper-Trades der Kopien (über copy_trade_id verknüpft)
    const stats = await ctx.db
      .select({
        watchedId: watchedWalletSwaps.watchedId,
        buys: sql<number>`count(*) FILTER (WHERE ${swapTrades.side} = 'buy')::int`,
        sells: sql<number>`count(*) FILTER (WHERE ${swapTrades.side} = 'sell')::int`,
        wins: sql<number>`count(*) FILTER (WHERE ${swapTrades.side} = 'sell' AND ${swapTrades.realizedPnlUsd} > 0)::int`,
        investedUsd: sql<string | null>`sum(${swapTrades.valueUsd}) FILTER (WHERE ${swapTrades.side} = 'buy')`,
        realizedPnlUsd: sql<string | null>`sum(${swapTrades.realizedPnlUsd}) FILTER (WHERE ${swapTrades.side} = 'sell')`,
      })
      .from(watchedWalletSwaps)
      .innerJoin(swapTrades, eq(swapTrades.id, watchedWalletSwaps.copyTradeId))
      .where(inArray(watchedWalletSwaps.watchedId, rows.map((r) => r.id)))
      .groupBy(watchedWalletSwaps.watchedId);
    const byId = new Map(stats.map((x) => [x.watchedId, x]));
    return rows.map((r) => {
      const x = byId.get(r.id);
      return {
        ...r,
        copyStats: {
          buys: x?.buys ?? 0,
          sells: x?.sells ?? 0,
          wins: x?.wins ?? 0,
          investedUsd: x?.investedUsd == null ? 0 : Number(x.investedUsd),
          realizedPnlUsd: x?.realizedPnlUsd == null ? 0 : Number(x.realizedPnlUsd),
        },
      };
    });
  }),

  addWatched: protectedProcedure
    .input(z.object({ chain: chainSchema.default('solana'), address: z.string().trim(), label: z.string().trim().min(1).max(40) }).merge(copyInput))
    .mutation(async ({ ctx, input }) => {
      const evm = SWAP_CHAINS[input.chain].kind === 'evm';
      if (!isTokenAddress(input.chain, input.address)) throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[input.chain].name}-Adresse.` });
      // EVM-Adressen einheitlich klein (Groß-/Kleinschreibung ist nur Prüfsumme)
      const address = evm ? input.address.toLowerCase() : input.address;
      await checkCopyTarget(ctx.db, ctx.user.id, input.chain, input);
      const existing = await ctx.db
        .select({ id: watchedWallets.id, chain: watchedWallets.chain, address: watchedWallets.address })
        .from(watchedWallets)
        .where(eq(watchedWallets.userId, ctx.user.id));
      if (existing.some((e) => e.chain === input.chain && e.address === address)) throw new TRPCError({ code: 'CONFLICT', message: 'Diese Wallet wird schon beobachtet.' });
      if (existing.length >= MAX_WATCHED) throw new TRPCError({ code: 'BAD_REQUEST', message: `Höchstens ${MAX_WATCHED} beobachtete Wallets.` });
      const [row] = await ctx.db
        .insert(watchedWallets)
        .values({
          userId: ctx.user.id,
          chain: input.chain,
          address,
          label: input.label,
          copyMode: input.copyMode,
          copyWalletId: input.copyMode === 'paper' ? input.copyWalletId : null,
          copyAmount: input.copyMode === 'paper' ? input.copyAmount : null,
        })
        .returning();
      return row!;
    }),

  updateWatched: protectedProcedure
    .input(z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(40) }).merge(copyInput))
    .mutation(async ({ ctx, input }) => {
      const [cur] = await ctx.db
        .select({ chain: watchedWallets.chain })
        .from(watchedWallets)
        .where(and(eq(watchedWallets.id, input.id), eq(watchedWallets.userId, ctx.user.id)));
      if (!cur) throw new TRPCError({ code: 'NOT_FOUND', message: 'Beobachtete Wallet nicht gefunden.' });
      await checkCopyTarget(ctx.db, ctx.user.id, cur.chain as SwapChainId, input);
      const rows = await ctx.db
        .update(watchedWallets)
        .set({
          label: input.label,
          copyMode: input.copyMode,
          copyWalletId: input.copyMode === 'paper' ? input.copyWalletId : null,
          copyAmount: input.copyMode === 'paper' ? input.copyAmount : null,
        })
        .where(and(eq(watchedWallets.id, input.id), eq(watchedWallets.userId, ctx.user.id)))
        .returning();
      if (rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Beobachtete Wallet nicht gefunden.' });
      return rows[0]!;
    }),

  removeWatched: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const rows = await ctx.db
      .delete(watchedWallets)
      .where(and(eq(watchedWallets.id, input.id), eq(watchedWallets.userId, ctx.user.id)))
      .returning({ id: watchedWallets.id });
    if (rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Beobachtete Wallet nicht gefunden.' });
    return { ok: true };
  }),

  /** Erkannte Swaps einer beobachteten Wallet (neueste zuerst) mit Symbol, Menge und Kopie-Ergebnis. */
  watchedActivity: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [w] = await ctx.db
      .select({ id: watchedWallets.id, chain: watchedWallets.chain })
      .from(watchedWallets)
      .where(and(eq(watchedWallets.id, input.id), eq(watchedWallets.userId, ctx.user.id)));
    if (!w) throw new TRPCError({ code: 'NOT_FOUND', message: 'Beobachtete Wallet nicht gefunden.' });
    const chain = w.chain as SwapChainId;
    const rows = await ctx.db
      .select()
      .from(watchedWalletSwaps)
      .where(eq(watchedWalletSwaps.watchedId, w.id))
      .orderBy(desc(watchedWalletSwaps.txTime), desc(watchedWalletSwaps.createdAt))
      .limit(30);
    const symbols = new Map<string, string>();
    await Promise.all(
      [...new Set(rows.map((r) => r.token))].map(async (t) => {
        try {
          symbols.set(t, (await cachedTokenInfo(chain, t)).symbol);
        } catch {
          // Symbol unbekannt → Adresse gekürzt anzeigen (nie geraten)
        }
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      signature: r.signature,
      side: r.side,
      token: r.token,
      symbol: symbols.get(r.token) ?? null,
      amount: fromAtomic(r.tokenAtomic, r.tokenDecimals),
      native: r.nativeAtomic === null ? null : fromAtomic(r.nativeAtomic, SWAP_CHAINS[chain].native.decimals),
      counterToken: r.counterToken,
      txTime: r.txTime,
      copyStatus: r.copyStatus,
      copyNote: r.copyNote,
    }));
  }),
});
