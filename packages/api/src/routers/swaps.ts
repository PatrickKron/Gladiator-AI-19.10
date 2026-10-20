import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import { notifySafe } from '@gladiator/jobs';
import {
  decryptSecret,
  encryptSecret,
  executeLiveSwap,
  executePaperSwap,
  fetchOnchainBalances,
  generateWalletKey,
  importWalletKey,
  recordLiveSwap,
  setWalletAmounts,
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

const { swapWallets, swapTrades, auditLog } = schema;

/** Betreiber-Schalter (Selbsthoster): ohne ihn nimmt die Instanz keine Wallet-Schlüssel an und führt nichts live aus. */
const liveKeysAllowed = (): boolean => process.env.WALLET_KEYS_ENABLED === '1';

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

/** Tests ersetzen die echte Ausführung (es wird nie etwas gesendet). */
type LiveExecutor = typeof executeLiveSwap;
let liveOverride: LiveExecutor | null = null;
export function setLiveSwapExecutorForTests(f: LiveExecutor | null): void {
  liveOverride = f;
}

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
    /** Live-Wallets: ausdrückliche Bestätigung genau dieses Swaps. */
    confirmLive: z.boolean().optional(),
  })
  .refine((v) => (v.side === 'buy' ? v.amount !== undefined : v.percent !== undefined), {
    message: 'Kauf braucht einen Betrag, Verkauf einen Anteil in %.',
  });

/** Live-Wallet: Mengen von der Kette übernehmen (native + bekannte Tokens + optional ein weiterer). */
async function syncLive(db: Db, w: WalletRow, extra?: { address: string; symbol: string; decimals: number }): Promise<void> {
  const chain = w.chain as SwapChainId;
  const native = SWAP_CHAINS[chain].native;
  const known = await walletBalances(db, w.id);
  const tokens = new Map<string, { symbol: string; decimals: number }>([[native.address, native]]);
  for (const b of known) tokens.set(b.token, { symbol: b.symbol, decimals: b.decimals });
  if (extra) tokens.set(extra.address, extra);
  const onchain = await fetchOnchainBalances(chain, w.address, [...tokens.keys()], net());
  await setWalletAmounts(
    db,
    w.id,
    [...tokens.entries()].map(([token, t]) => ({ token, symbol: t.symbol, decimals: t.decimals, amountAtomic: onchain.get(token) ?? 0n })),
  );
}

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

  if (wallet.mode === 'live') {
    try {
      await syncLive(db, wallet, token);
    } catch (err) {
      throw netError(err);
    }
  }

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

type Ctx = { db: Db; user: { id: string }; ip: string | null };

/**
 * Live-Ausführung: Betreiber-Schalter, Freigabe der Wallet, Bestätigung genau
 * dieses Swaps — dann Schlüssel entschlüsseln, Aggregator-Transaktion
 * signieren/senden, Ergebnis verbuchen, auditieren, benachrichtigen.
 */
async function executeLive(ctx: Ctx, p: Prepared, input: z.infer<typeof swapInput>) {
  const w = p.wallet;
  if (!liveKeysAllowed()) throw new TRPCError({ code: 'FORBIDDEN', message: 'Live-Wallets sind auf dieser Instanz abgeschaltet (WALLET_KEYS_ENABLED).' });
  if (!w.liveApprovedAt) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Diese Wallet ist noch nicht für Live-Swaps freigegeben.' });
  if (input.confirmLive !== true) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Live-Swap bitte ausdrücklich bestätigen.' });
  if (!w.encryptedKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Schlüssel gespeichert.' });

  const chain = w.chain as SwapChainId;
  const nativeBal = (await walletBalances(ctx.db, w.id)).find((b) => b.token === SWAP_CHAINS[chain].native.address);
  if (input.side === 'buy' && BigInt(nativeBal?.amountAtomic ?? '0') < BigInt(p.quote.inAtomic)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Guthaben reicht nicht: ${p.quote.inAmount} ${p.quote.inToken.symbol} nötig, ${fromAtomic(nativeBal?.amountAtomic ?? '0', SWAP_CHAINS[chain].native.decimals)} vorhanden (plus Netzwerkgebühr).` });
  }

  await ctx.db.insert(auditLog).values({
    actor: 'user',
    userId: ctx.user.id,
    action: 'swap.live_execute',
    entityType: 'swap_wallet',
    entityId: w.id,
    details: { chain, side: input.side, token: p.info.address, inAmount: p.quote.inAmount, inSymbol: p.quote.inToken.symbol, valueUsd: p.valueUsd, slippageBps: p.quote.slippageBps },
    ip: ctx.ip,
  });

  let result: Awaited<ReturnType<typeof executeLiveSwap>>;
  try {
    result = await (liveOverride ?? executeLiveSwap)({ quote: p.quote, address: w.address, secret: decryptSecret(w.encryptedKey) }, net());
  } catch (err) {
    // vor dem Senden abgebrochen (Route nicht baubar, Sicherheitsprüfung, Netz) — nichts on-chain
    const msg = err instanceof Error ? err.message : String(err);
    await recordLiveSwap(ctx.db, { walletId: w.id, side: input.side, quote: p.quote, nativePriceUsd: p.nativePriceUsd, txHash: null, status: 'failed', error: msg, onchain: null });
    throw new TRPCError({ code: 'BAD_GATEWAY', message: msg });
  }

  let onchain: Map<string, bigint> | null = null;
  if (result.status === 'filled') {
    onchain = await fetchOnchainBalances(chain, w.address, [p.quote.inToken.address, p.quote.outToken.address], net()).catch(() => null);
  }
  const trade = await recordLiveSwap(ctx.db, {
    walletId: w.id,
    side: input.side,
    quote: p.quote,
    nativePriceUsd: p.nativePriceUsd,
    txHash: result.txHash,
    status: result.status,
    error: result.error,
    onchain,
  });
  const verb = input.side === 'buy' ? 'Kauf' : 'Verkauf';
  await notifySafe(ctx.db, {
    userId: ctx.user.id,
    kind: 'system',
    severity: result.status === 'filled' ? 'info' : 'warn',
    title: result.status === 'filled' ? `${verb} ausgeführt: ${p.info.symbol}` : `${verb} fehlgeschlagen: ${p.info.symbol}`,
    body:
      result.status === 'filled'
        ? `${p.quote.inAmount} ${p.quote.inToken.symbol} → ${p.quote.outAmount} ${p.quote.outToken.symbol} (${w.label}, ${SWAP_CHAINS[chain].name})`
        : `${result.error ?? 'unbekannter Fehler'} (${w.label})`,
    link: '#/wallet',
  });
  if (result.status !== 'filled') throw new TRPCError({ code: 'BAD_GATEWAY', message: `${result.error ?? 'Swap fehlgeschlagen'} (Tx ${result.txHash})` });
  return {
    trade: { id: trade.id, realizedPnlUsd: trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd), txHash: result.txHash },
    quote: quoteView(p),
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
      return await tokenInfo(input.chain, input.address);
    } catch (err) {
      throw netError(err);
    }
  }),

  /** Bestände mit aktuellem Wert und unrealisierter PnL + letzte Swaps. */
  portfolio: protectedProcedure.input(z.object({ walletId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const w = await ownWallet(ctx.db, ctx.user.id, input.walletId);
    const chain = w.chain as SwapChainId;
    let chainOk: boolean | null = null;
    if (w.mode === 'live') {
      chainOk = await syncLive(ctx.db, w).then(
        () => true,
        () => false,
      );
    }
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
  quote: protectedProcedure.input(swapInput).query(async ({ ctx, input }) => quoteView(await prepareSwap(ctx.db, ctx.user.id, input))),

  /** Ausführen: Angebot neu holen, Gate prüfen, dann Paper-Fill (live folgt als eigener Schritt). */
  execute: protectedProcedure.input(swapInput).mutation(async ({ ctx, input }) => {
    const p = await prepareSwap(ctx.db, ctx.user.id, input);
    if (!p.verdict.allowed) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Swap-Gate: ${p.verdict.reasons.join(', ')}` });
    }
    if (p.wallet.mode === 'live') return executeLive(ctx, p, input);
    try {
      const trade = await executePaperSwap(ctx.db, { walletId: p.wallet.id, side: input.side, quote: p.quote, nativePriceUsd: p.nativePriceUsd });
      return { trade: { id: trade.id, realizedPnlUsd: trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd), txHash: null as string | null }, quote: quoteView(p) };
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) });
    }
  }),
});
