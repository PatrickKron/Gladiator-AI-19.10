import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { fromAtomic, SWAP_CHAINS, toAtomic, type SwapChainId } from './chains.js';
import type { SwapQuote } from './quotes.js';

const { swapBalances, swapTrades } = schema;

/**
 * Paper-Swaps (Vision-Punkt 5): Ausführung zum ECHTEN Aggregator-Angebot
 * (Menge nach Pool-Gebühren und Preis-Einfluss), Netzwerkgebühr wird in nativer
 * Währung abgezogen — wie on-chain. Mengen exakt in kleinster Einheit (bigint),
 * Einstand nach Durchschnittskosten; Verkauf realisiert anteilig.
 */

export type BalanceRow = { token: string; symbol: string; decimals: number; amountAtomic: bigint; costUsd: number };

export type PaperSwapPlan = {
  /** neue Bestände (nur die geänderten Tokens) */
  balances: BalanceRow[];
  valueUsd: number;
  feeUsd: number;
  feeNativeAtomic: bigint;
  realizedPnlUsd: number | null;
};

/** Gebühr in nativer kleinster Einheit: Solana fix (Basisgebühr), EVM aus der USD-Schätzung der Route. */
export function networkFeeAtomic(quote: SwapQuote, nativePriceUsd: number): bigint {
  const native = SWAP_CHAINS[quote.chain].native;
  if (quote.networkFeeNative !== null) return toAtomic(quote.networkFeeNative, native.decimals);
  if (quote.networkFeeUsd !== null && nativePriceUsd > 0) {
    return toAtomic((quote.networkFeeUsd / nativePriceUsd).toFixed(native.decimals), native.decimals);
  }
  return 0n;
}

function toNumber(atomic: bigint, decimals: number): number {
  return Number(fromAtomic(atomic, decimals));
}

/**
 * Plant einen Paper-Swap. Wirft bei fehlendem Guthaben (inkl. Gebühr) — es wird
 * nie ins Minus gehandelt.
 * buy:  native → token,  sell: token → native.
 */
export function planPaperSwap(p: {
  side: 'buy' | 'sell';
  quote: SwapQuote;
  nativePriceUsd: number;
  /** aktuelle Bestände von in- und out-Token (fehlend = 0) */
  inBalance: BalanceRow | null;
  outBalance: BalanceRow | null;
}): PaperSwapPlan {
  const { quote, nativePriceUsd } = p;
  const native = SWAP_CHAINS[quote.chain].native;
  if (!(nativePriceUsd > 0)) throw new Error(`Kein ${native.symbol}-Preis — Swap nicht bewertbar.`);
  const inAtomic = BigInt(quote.inAtomic);
  const outAtomic = BigInt(quote.outAtomic);
  const fee = networkFeeAtomic(quote, nativePriceUsd);
  const feeUsd = toNumber(fee, native.decimals) * nativePriceUsd;

  const empty = (t: SwapQuote['inToken']): BalanceRow => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, amountAtomic: 0n, costUsd: 0 });
  const inBal = p.inBalance ?? empty(quote.inToken);
  const outBal = p.outBalance ?? empty(quote.outToken);

  if (p.side === 'buy') {
    // native raus: Betrag + Gebühr
    const need = inAtomic + fee;
    if (inBal.amountAtomic < need) {
      throw new Error(`Guthaben reicht nicht: ${fromAtomic(need, native.decimals)} ${native.symbol} nötig (inkl. Gebühr), ${fromAtomic(inBal.amountAtomic, native.decimals)} vorhanden.`);
    }
    const valueUsd = toNumber(inAtomic, native.decimals) * nativePriceUsd;
    const costShare = inBal.amountAtomic > 0n ? (inBal.costUsd * Number(need)) / Number(inBal.amountAtomic) : 0;
    return {
      balances: [
        { ...inBal, amountAtomic: inBal.amountAtomic - need, costUsd: Math.max(0, inBal.costUsd - costShare) },
        { ...outBal, amountAtomic: outBal.amountAtomic + outAtomic, costUsd: outBal.costUsd + valueUsd + feeUsd },
      ],
      valueUsd,
      feeUsd,
      feeNativeAtomic: fee,
      realizedPnlUsd: null,
    };
  }

  // sell: Token raus, native rein, Gebühr aus dem Erlös
  if (inBal.amountAtomic < inAtomic) {
    throw new Error(`Bestand reicht nicht: ${fromAtomic(inAtomic, inBal.decimals)} ${inBal.symbol} verkauft, ${fromAtomic(inBal.amountAtomic, inBal.decimals)} vorhanden.`);
  }
  if (outAtomic + outBal.amountAtomic < fee) throw new Error(`Zu wenig ${native.symbol} für die Netzwerkgebühr.`);
  const proceedsUsd = toNumber(outAtomic, native.decimals) * nativePriceUsd;
  const costPortion = inBal.amountAtomic > 0n ? (inBal.costUsd * Number(inAtomic)) / Number(inBal.amountAtomic) : 0;
  const netUsd = proceedsUsd - feeUsd;
  return {
    balances: [
      { ...inBal, amountAtomic: inBal.amountAtomic - inAtomic, costUsd: Math.max(0, inBal.costUsd - costPortion) },
      { ...outBal, amountAtomic: outBal.amountAtomic + outAtomic - fee, costUsd: outBal.costUsd + netUsd },
    ],
    valueUsd: proceedsUsd,
    feeUsd,
    feeNativeAtomic: fee,
    realizedPnlUsd: netUsd - costPortion,
  };
}

/** Führt einen geplanten Paper-Swap atomar aus (Bestände gesperrt, neu geprüft). */
export async function executePaperSwap(
  db: Db,
  p: { walletId: string; side: 'buy' | 'sell'; quote: SwapQuote; nativePriceUsd: number },
): Promise<typeof swapTrades.$inferSelect> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(swapBalances)
      .where(eq(swapBalances.walletId, p.walletId))
      .for('update');
    const find = (token: string): BalanceRow | null => {
      const r = rows.find((b) => b.token === token);
      return r ? { token: r.token, symbol: r.symbol, decimals: r.decimals, amountAtomic: BigInt(r.amountAtomic), costUsd: Number(r.costUsd) } : null;
    };
    const plan = planPaperSwap({
      side: p.side,
      quote: p.quote,
      nativePriceUsd: p.nativePriceUsd,
      inBalance: find(p.quote.inToken.address),
      outBalance: find(p.quote.outToken.address),
    });
    for (const b of plan.balances) {
      await tx
        .insert(swapBalances)
        .values({
          walletId: p.walletId,
          token: b.token,
          symbol: b.symbol,
          decimals: b.decimals,
          amountAtomic: b.amountAtomic.toString(),
          costUsd: b.costUsd.toFixed(8),
        })
        .onConflictDoUpdate({
          target: [swapBalances.walletId, swapBalances.token],
          set: { amountAtomic: b.amountAtomic.toString(), costUsd: b.costUsd.toFixed(8), updatedAt: sql`now()` },
        });
    }
    const [trade] = await tx
      .insert(swapTrades)
      .values({
        walletId: p.walletId,
        side: p.side,
        mode: 'paper',
        status: 'filled',
        aggregator: p.quote.aggregator,
        inToken: p.quote.inToken.address,
        inSymbol: p.quote.inToken.symbol,
        inAtomic: p.quote.inAtomic,
        inDecimals: p.quote.inToken.decimals,
        outToken: p.quote.outToken.address,
        outSymbol: p.quote.outToken.symbol,
        outAtomic: p.quote.outAtomic,
        outDecimals: p.quote.outToken.decimals,
        valueUsd: plan.valueUsd.toFixed(8),
        feeUsd: plan.feeUsd.toFixed(8),
        realizedPnlUsd: plan.realizedPnlUsd === null ? null : plan.realizedPnlUsd.toFixed(8),
        priceImpactPct: Number.isFinite(p.quote.priceImpactPct) ? p.quote.priceImpactPct.toFixed(6) : null,
        slippageBps: p.quote.slippageBps,
        route: p.quote.route,
      })
      .returning();
    return trade!;
  });
}

/** Paper-Wallet mit Startguthaben in nativer Währung aufladen (beim Anlegen). */
export async function fundPaperWallet(db: Db, walletId: string, chain: SwapChainId, amount: string, nativePriceUsd: number): Promise<void> {
  const native = SWAP_CHAINS[chain].native;
  const atomic = toAtomic(amount, native.decimals);
  const cost = (Number(amount) * nativePriceUsd).toFixed(8);
  await db
    .insert(swapBalances)
    .values({ walletId, token: native.address, symbol: native.symbol, decimals: native.decimals, amountAtomic: atomic.toString(), costUsd: cost })
    .onConflictDoUpdate({
      target: [swapBalances.walletId, swapBalances.token],
      set: { amountAtomic: sql`${swapBalances.amountAtomic} + ${atomic.toString()}`, costUsd: sql`${swapBalances.costUsd} + ${cost}`, updatedAt: sql`now()` },
    });
}

export async function walletBalances(db: Db, walletId: string) {
  return db.select().from(swapBalances).where(and(eq(swapBalances.walletId, walletId), sql`${swapBalances.amountAtomic} > 0`));
}

/**
 * Live-Wallets: Bestände von der Kette übernehmen (Menge), Einstand bleibt.
 * Neue Tokens (z. B. gerade gekauft) brauchen Symbol/Nachkommastellen.
 */
export async function setWalletAmounts(
  db: Db,
  walletId: string,
  amounts: { token: string; symbol: string; decimals: number; amountAtomic: bigint }[],
): Promise<void> {
  for (const a of amounts) {
    await db
      .insert(swapBalances)
      .values({ walletId, token: a.token, symbol: a.symbol, decimals: a.decimals, amountAtomic: a.amountAtomic.toString(), costUsd: '0' })
      .onConflictDoUpdate({ target: [swapBalances.walletId, swapBalances.token], set: { amountAtomic: a.amountAtomic.toString(), updatedAt: sql`now()` } });
  }
}

/**
 * Live-Swap verbuchen: Einstand/realisierte PnL wie beim Paper-Swap aus dem
 * ausgeführten Angebot, Mengen danach aus der Kette (`onchain`, falls gelesen).
 */
export async function recordLiveSwap(
  db: Db,
  p: {
    walletId: string;
    side: 'buy' | 'sell';
    quote: SwapQuote;
    nativePriceUsd: number;
    txHash: string | null;
    /** pending = gesendet, Ausgang unklar (Bestände bleiben, bis die Kette Klarheit gibt) */
    status: 'filled' | 'failed' | 'pending';
    error: string | null;
    onchain: Map<string, bigint> | null;
  },
): Promise<typeof swapTrades.$inferSelect> {
  return db.transaction(async (tx) => {
    let plan: PaperSwapPlan | null = null;
    if (p.status === 'filled') {
      const rows = await tx.select().from(swapBalances).where(eq(swapBalances.walletId, p.walletId)).for('update');
      const find = (token: string): BalanceRow | null => {
        const r = rows.find((b) => b.token === token);
        return r ? { token: r.token, symbol: r.symbol, decimals: r.decimals, amountAtomic: BigInt(r.amountAtomic), costUsd: Number(r.costUsd) } : null;
      };
      // Einstand rechnen; reicht der gespiegelte Bestand nicht (Kette war schneller), zählt die Kette
      const inBal = find(p.quote.inToken.address);
      const need = BigInt(p.quote.inAtomic) + (p.side === 'buy' ? networkFeeAtomic(p.quote, p.nativePriceUsd) : 0n);
      const padded = inBal && inBal.amountAtomic < need ? { ...inBal, amountAtomic: need } : inBal;
      plan = planPaperSwap({ side: p.side, quote: p.quote, nativePriceUsd: p.nativePriceUsd, inBalance: padded, outBalance: find(p.quote.outToken.address) });
      for (const b of plan.balances) {
        const chainAmount = p.onchain?.get(b.token);
        const amount = chainAmount ?? (b.amountAtomic < 0n ? 0n : b.amountAtomic);
        await tx
          .insert(swapBalances)
          .values({ walletId: p.walletId, token: b.token, symbol: b.symbol, decimals: b.decimals, amountAtomic: amount.toString(), costUsd: b.costUsd.toFixed(8) })
          .onConflictDoUpdate({
            target: [swapBalances.walletId, swapBalances.token],
            set: { amountAtomic: amount.toString(), costUsd: b.costUsd.toFixed(8), updatedAt: sql`now()` },
          });
      }
    }
    const [trade] = await tx
      .insert(swapTrades)
      .values({
        walletId: p.walletId,
        side: p.side,
        mode: 'live',
        status: p.status,
        aggregator: p.quote.aggregator,
        inToken: p.quote.inToken.address,
        inSymbol: p.quote.inToken.symbol,
        inAtomic: p.quote.inAtomic,
        inDecimals: p.quote.inToken.decimals,
        outToken: p.quote.outToken.address,
        outSymbol: p.quote.outToken.symbol,
        outAtomic: p.quote.outAtomic,
        outDecimals: p.quote.outToken.decimals,
        valueUsd: plan ? plan.valueUsd.toFixed(8) : null,
        feeUsd: plan ? plan.feeUsd.toFixed(8) : null,
        realizedPnlUsd: plan?.realizedPnlUsd == null ? null : plan.realizedPnlUsd.toFixed(8),
        priceImpactPct: Number.isFinite(p.quote.priceImpactPct) ? p.quote.priceImpactPct.toFixed(6) : null,
        slippageBps: p.quote.slippageBps,
        route: p.quote.route,
        txHash: p.txHash,
        error: p.error,
      })
      .returning();
    return trade!;
  });
}
