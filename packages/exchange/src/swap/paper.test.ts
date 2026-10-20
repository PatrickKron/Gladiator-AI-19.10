/**
 * Paper-Swaps: exakte Mengen, Gebühr in nativer Währung, Durchschnittskosten,
 * realisierte PnL beim Verkauf, nie ins Minus. DB-Teil gegen echte Postgres.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { SWAP_CHAINS } from './chains.js';
import { executePaperSwap, fundPaperWallet, planPaperSwap, walletBalances } from './paper.js';
import type { SwapQuote } from './quotes.js';

const SOL = SWAP_CHAINS.solana.native;
const BONK = { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk', decimals: 5 };

function quote(side: 'buy' | 'sell', inAtomic: bigint, outAtomic: bigint): SwapQuote {
  const [inToken, outToken] = side === 'buy' ? [SOL, BONK] : [BONK, SOL];
  return {
    chain: 'solana',
    aggregator: 'jupiter',
    inToken,
    outToken,
    inAtomic: inAtomic.toString(),
    outAtomic: outAtomic.toString(),
    minOutAtomic: outAtomic.toString(),
    inAmount: '',
    outAmount: '',
    slippageBps: 100,
    priceImpactPct: 0.2,
    networkFeeNative: '0.000005',
    networkFeeUsd: null,
    route: ['Raydium'],
    raw: null,
  };
}

describe('planPaperSwap', () => {
  const solBal = { token: SOL.address, symbol: SOL.symbol, decimals: SOL.decimals, amountAtomic: 10n * 10n ** 9n, costUsd: 1_500 }; // 10 SOL à 150

  it('Kauf: native inkl. Gebühr raus, Token rein, Einstand = Wert + Gebühr', () => {
    const plan = planPaperSwap({ side: 'buy', quote: quote('buy', 10n ** 9n, 5_000_000_000n), nativePriceUsd: 150, inBalance: solBal, outBalance: null });
    const [sol, bonk] = plan.balances;
    expect(sol!.amountAtomic).toBe(9n * 10n ** 9n - 5_000n);
    expect(bonk!.amountAtomic).toBe(5_000_000_000n);
    expect(plan.valueUsd).toBeCloseTo(150, 9);
    expect(plan.feeUsd).toBeCloseTo(0.00075, 9);
    expect(bonk!.costUsd).toBeCloseTo(150.00075, 9);
    expect(plan.realizedPnlUsd).toBeNull();
  });

  it('Verkauf der Hälfte: anteiliger Einstand, PnL netto nach Gebühr', () => {
    const bonkBal = { token: BONK.address, symbol: BONK.symbol, decimals: BONK.decimals, amountAtomic: 5_000_000_000n, costUsd: 150 };
    // Hälfte verkauft für 0,6 SOL à 150 = 90 USD; Einstand der Hälfte = 75
    const plan = planPaperSwap({ side: 'sell', quote: quote('sell', 2_500_000_000n, 600_000_000n), nativePriceUsd: 150, inBalance: bonkBal, outBalance: solBal });
    const [bonk, sol] = plan.balances;
    expect(bonk!.amountAtomic).toBe(2_500_000_000n);
    expect(bonk!.costUsd).toBeCloseTo(75, 9);
    expect(sol!.amountAtomic).toBe(10n * 10n ** 9n + 600_000_000n - 5_000n);
    expect(plan.realizedPnlUsd).toBeCloseTo(90 - 0.00075 - 75, 9);
  });

  it('nie ins Minus: Kauf über Guthaben (inkl. Gebühr) und Verkauf über Bestand werden verweigert', () => {
    expect(() => planPaperSwap({ side: 'buy', quote: quote('buy', 10n * 10n ** 9n, 1n), nativePriceUsd: 150, inBalance: solBal, outBalance: null })).toThrow(/inkl. Gebühr/);
    expect(() =>
      planPaperSwap({ side: 'sell', quote: quote('sell', 2n, 1n), nativePriceUsd: 150, inBalance: { token: BONK.address, symbol: BONK.symbol, decimals: BONK.decimals, amountAtomic: 1n, costUsd: 0 }, outBalance: solBal }),
    ).toThrow(/Bestand reicht nicht/);
  });

  it('ohne Preis der nativen Währung kein Swap (keine Schätzung)', () => {
    expect(() => planPaperSwap({ side: 'buy', quote: quote('buy', 1n, 1n), nativePriceUsd: Number.NaN, inBalance: solBal, outBalance: null })).toThrow(/Kein SOL-Preis/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('Paper-Swap (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let walletId: string;
  const RUN = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `swap-${RUN}@test.invalid` }).returning();
    const [w] = await db
      .insert(schema.swapWallets)
      .values({ userId: u!.id, chain: 'solana', label: 'Test', address: `paper-${RUN}`, maxTradeUsd: '1000', maxSlippageBps: 300, maxPriceImpactPct: '5', minLiquidityUsd: '0' })
      .returning();
    walletId = w!.id;
    await fundPaperWallet(db, walletId, 'solana', '10', 150);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email = ${`swap-${RUN}@test.invalid`}`);
    await pool.end();
  });

  it('Kauf und Teilverkauf landen exakt in Beständen und Historie', async () => {
    await executePaperSwap(db, { walletId, side: 'buy', quote: quote('buy', 10n ** 9n, 5_000_000_000n), nativePriceUsd: 150 });
    const sell = await executePaperSwap(db, { walletId, side: 'sell', quote: quote('sell', 2_500_000_000n, 600_000_000n), nativePriceUsd: 150 });
    expect(Number(sell.realizedPnlUsd)).toBeCloseTo(90 - 0.00075 - (150 + 0.00075) / 2, 6);

    const bal = await walletBalances(db, walletId);
    expect(bal.find((b) => b.token === BONK.address)!.amountAtomic).toBe('2500000000');
    expect(bal.find((b) => b.token === SOL.address)!.amountAtomic).toBe(String(9n * 10n ** 9n - 5_000n + 600_000_000n - 5_000n));
    const trades = await db.select().from(schema.swapTrades).where(eq(schema.swapTrades.walletId, walletId));
    expect(trades.map((t) => t.side).sort()).toEqual(['buy', 'sell']);
  });

  it('Verkauf über den Bestand → Fehler, nichts geändert', async () => {
    const before = await walletBalances(db, walletId);
    await expect(executePaperSwap(db, { walletId, side: 'sell', quote: quote('sell', 10n ** 12n, 1n), nativePriceUsd: 150 })).rejects.toThrow(/Bestand reicht nicht/);
    expect(await walletBalances(db, walletId)).toEqual(before);
  });
});
