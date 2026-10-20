import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import {
  executePaperSwap,
  fetchSwapQuote,
  fetchTokenInfo,
  fetchTokenPrices,
  fromAtomic,
  fundPaperWallet,
  isNativeToken,
  isTokenAddress,
  SWAP_CHAIN_IDS,
  SWAP_CHAINS,
  toAtomic,
  walletBalances,
  type SwapChainId,
  type SwapQuote,
  type TokenInfo,
} from '@gladiator/exchange';
import { judgeSwap, SWAP_LIMIT_BOUNDS, SWAP_PROFILES, type SwapLimits, type SwapVerdict } from '@gladiator/risk';
import { protectedProcedure, router } from '../trpc.js';

const { swapWallets, swapTrades } = schema;

/**
 * Wallet-Trading / Spot-Swaps (Vision-Punkt 5, „wie Trojan, für alle Wallets").
 * Token-Adresse rein → echte Infos (DexScreener) → echtes Aggregator-Angebot
 * (Jupiter/KyberSwap) → Swap-Gate (`judgeSwap`) → Ausführung. Paper-Wallets
 * führen zum echten Angebot virtuell aus; Live-Ausführung folgt als eigener
 * Schritt (Schlüssel nur mit Betreiber-Freigabe `WALLET_KEYS_ENABLED=1`).
 */

/** Tests ersetzen das Netz (Aggregatoren/DexScreener); Produktion nutzt fetch. */
let fetchOverride: typeof fetch | null = null;
export function setSwapFetchForTests(f: typeof fetch | null): void {
  fetchOverride = f;
}
const net = (): typeof fetch => fetchOverride ?? fetch;

const INFO_TTL_MS = 15_000;
const infoCache = new Map<string, { at: number; info: TokenInfo }>();

async function tokenInfo(chain: SwapChainId, address: string): Promise<TokenInfo> {
  const key = `${chain}:${address}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS && !fetchOverride) return hit.info;
  const info = await fetchTokenInfo(chain, address, net());
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

/** Netzfehler ehrlich mit Quelle melden (Aggregator, DexScreener oder RPC nicht erreichbar). */
function netError(err: unknown): TRPCError {
  const detail = err instanceof Error ? err.message : String(err);
  return new TRPCError({ code: 'BAD_GATEWAY', message: `Markt-/Kettendaten nicht erreichbar (DexScreener, RPC bzw. Aggregator): ${detail}` });
}

const chainSchema = z.enum(SWAP_CHAIN_IDS);
const limitsSchema = z.object({
  maxTradeUsd: z.number().min(SWAP_LIMIT_BOUNDS.maxTradeUsd.min).max(SWAP_LIMIT_BOUNDS.maxTradeUsd.max),
  maxSlippageBps: z.number().int().min(SWAP_LIMIT_BOUNDS.maxSlippageBps.min).max(SWAP_LIMIT_BOUNDS.maxSlippageBps.max),
  maxPriceImpactPct: z.number().min(SWAP_LIMIT_BOUNDS.maxPriceImpactPct.min).max(SWAP_LIMIT_BOUNDS.maxPriceImpactPct.max),
  minLiquidityUsd: z.number().min(SWAP_LIMIT_BOUNDS.minLiquidityUsd.min).max(SWAP_LIMIT_BOUNDS.minLiquidityUsd.max),
});

type WalletRow = typeof swapWallets.$inferSelect;

function limitsOf(w: WalletRow): SwapLimits {
  return {
    maxTradeUsd: Number(w.maxTradeUsd),
    maxSlippageBps: w.maxSlippageBps,
    maxPriceImpactPct: Number(w.maxPriceImpactPct),
    minLiquidityUsd: Number(w.minLiquidityUsd),
  };
}

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
  })
  .refine((v) => (v.side === 'buy' ? v.amount !== undefined : v.percent !== undefined), {
    message: 'Kauf braucht einen Betrag, Verkauf einen Anteil in %.',
  });

type Prepared = {
  wallet: WalletRow;
  info: TokenInfo;
  nativePriceUsd: number;
  quote: SwapQuote;
  valueUsd: number;
  verdict: SwapVerdict;
};

async function prepareSwap(db: Db, userId: string, input: z.infer<typeof swapInput>): Promise<Prepared> {
  const wallet = await ownWallet(db, userId, input.walletId);
  const chain = wallet.chain as SwapChainId;
  const native = SWAP_CHAINS[chain].native;
  if (!isTokenAddress(chain, input.token)) throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[chain].name}-Token-Adresse.` });
  if (isNativeToken(chain, input.token)) throw new TRPCError({ code: 'BAD_REQUEST', message: `${native.symbol} gegen sich selbst tauschen geht nicht.` });

  let info: TokenInfo;
  let nativeInfo: TokenInfo;
  try {
    [info, nativeInfo] = await Promise.all([tokenInfo(chain, input.token), tokenInfo(chain, native.address)]);
  } catch (err) {
    throw netError(err);
  }
  const nativePriceUsd = nativeInfo.priceUsd ?? Number.NaN;
  if (!(nativePriceUsd > 0)) throw new TRPCError({ code: 'BAD_GATEWAY', message: `Kein ${native.symbol}-Preis verfügbar — Swap nicht bewertbar.` });
  const token = { address: info.address, symbol: info.symbol, decimals: info.decimals };

  let inAtomic: bigint;
  if (input.side === 'buy') {
    inAtomic = toAtomic(input.amount!, native.decimals);
  } else {
    const bal = (await walletBalances(db, wallet.id)).find((b) => b.token === input.token);
    const held = BigInt(bal?.amountAtomic ?? '0');
    if (held === 0n) throw new TRPCError({ code: 'BAD_REQUEST', message: `Kein ${info.symbol}-Bestand in dieser Wallet.` });
    // Prozent in Hundertstel, exakt in bigint
    inAtomic = (held * BigInt(Math.round(input.percent! * 100))) / 10_000n;
  }
  if (inAtomic <= 0n) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Betrag zu klein.' });

  const slippageBps = input.slippageBps ?? wallet.slippageBps;
  let quote: SwapQuote;
  try {
    quote = await fetchSwapQuote(
      {
        chain,
        inToken: input.side === 'buy' ? native : token,
        outToken: input.side === 'buy' ? token : native,
        inAtomic,
        slippageBps,
      },
      net(),
    );
  } catch (err) {
    throw netError(err);
  }
  const valueUsd = Number(input.side === 'buy' ? quote.inAmount : quote.outAmount) * nativePriceUsd;
  // Empfänger = eigene Wallet: Swaps werden nie mit fremdem Empfänger gebaut (Live-Schritt nutzt dieselbe Adresse)
  const verdict = judgeSwap(
    { owner: wallet.address, recipient: wallet.address, valueUsd, slippageBps, priceImpactPct: quote.priceImpactPct, liquidityUsd: info.liquidityUsd },
    limitsOf(wallet),
  );
  return { wallet, info, nativePriceUsd, quote, valueUsd, verdict };
}

function quoteView(p: Prepared) {
  const q = p.quote;
  return {
    token: p.info,
    side: q.inToken.address === p.info.address ? ('sell' as const) : ('buy' as const),
    inAmount: q.inAmount,
    inSymbol: q.inToken.symbol,
    outAmount: q.outAmount,
    outSymbol: q.outToken.symbol,
    minOut: fromAtomic(q.minOutAtomic, q.outToken.decimals),
    priceImpactPct: Number.isFinite(q.priceImpactPct) ? q.priceImpactPct : null,
    slippageBps: q.slippageBps,
    networkFeeNative: q.networkFeeNative,
    networkFeeUsd: q.networkFeeUsd ?? (q.networkFeeNative !== null ? Number(q.networkFeeNative) * p.nativePriceUsd : null),
    valueUsd: p.valueUsd,
    route: q.route,
    aggregator: q.aggregator,
    verdict: p.verdict,
  };
}

export const swapsRouter = router({
  /** Ketten, Profile, Grenzen und ob diese Instanz Wallet-Schlüssel überhaupt annimmt. */
  config: protectedProcedure.query(() => ({
    chains: SWAP_CHAIN_IDS.map((id) => {
      const c = SWAP_CHAINS[id];
      return { id, name: c.name, kind: c.kind, native: c.native, quickBuy: c.quickBuy, aggregator: c.aggregator, explorerTx: c.explorerTx };
    }),
    profiles: SWAP_PROFILES,
    bounds: SWAP_LIMIT_BOUNDS,
    liveKeysAllowed: process.env.WALLET_KEYS_ENABLED === '1',
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
        price = (await tokenInfo(input.chain, native.address)).priceUsd;
      } catch (err) {
        throw netError(err);
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
          slippageBps: Math.min(100, input.limits.maxSlippageBps),
        })
        .returning();
      await fundPaperWallet(ctx.db, w!.id, input.chain, input.startAmount, price);
      return walletView(w!);
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
          slippageBps: slippage,
        })
        .where(eq(swapWallets.id, w.id))
        .returning();
      return walletView(row!);
    }),

  archiveWallet: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    await ctx.db.update(swapWallets).set({ archivedAt: new Date() }).where(eq(swapWallets.id, w.id));
    return { ok: true };
  }),

  /** Token-Infos (Preis, Liquidität, MCap, 24 h) — Grundlage für die Kaufentscheidung. */
  token: protectedProcedure.input(z.object({ chain: chainSchema, address: z.string().min(32).max(64) })).query(async ({ input }) => {
    if (!isTokenAddress(input.chain, input.address)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Keine gültige ${SWAP_CHAINS[input.chain].name}-Token-Adresse.` });
    }
    try {
      return await tokenInfo(input.chain, input.address);
    } catch (err) {
      throw netError(err);
    }
  }),

  /** Bestände mit aktuellem Wert und unrealisierter PnL + letzte Swaps. */
  portfolio: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const chain = w.chain as SwapChainId;
    const balances = await walletBalances(ctx.db, w.id);
    let prices = new Map<string, number>();
    let pricesOk = true;
    try {
      prices = await fetchTokenPrices(chain, balances.map((b) => b.token), net());
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
      holdings,
      totalValueUsd: holdings.every((h) => h.valueUsd !== null) ? holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0) : null,
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
  quote: protectedProcedure.input(swapInput).query(async ({ ctx, input }) => quoteView(await prepareSwap(ctx.db, ctx.user.id, input))),

  /** Ausführen: Angebot neu holen, Gate prüfen, dann Paper-Fill (live folgt als eigener Schritt). */
  execute: protectedProcedure.input(swapInput).mutation(async ({ ctx, input }) => {
    const p = await prepareSwap(ctx.db, ctx.user.id, input);
    if (!p.verdict.allowed) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Swap-Gate: ${p.verdict.reasons.join(', ')}` });
    }
    if (p.wallet.mode !== 'paper') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Live-Swaps sind noch nicht freigeschaltet.' });
    }
    try {
      const trade = await executePaperSwap(ctx.db, { walletId: p.wallet.id, side: input.side, quote: p.quote, nativePriceUsd: p.nativePriceUsd });
      return { trade: { id: trade.id, realizedPnlUsd: trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd) }, quote: quoteView(p) };
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) });
    }
  }),
});
