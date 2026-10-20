/**
 * Wallet-Trading (Vision-Punkt 5) gegen die ECHTE DB: Paper-Wallet anlegen,
 * Angebot + Swap-Gate, Kauf, Teilverkauf, Grenzen, Nutzer-Scoping. Das Netz
 * (DexScreener, Solana-RPC, Jupiter) ist hier injiziert — die echten Antworten
 * prüft packages/exchange/src/swap/swap.test.ts live.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { SOL_MINT } from '@gladiator/exchange';
import type pg from 'pg';
import { appRouter } from './index.js';
import { setSwapFetchForTests } from './swaps.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL_USD = 150;
const BONK_USD = 0.00002; // 1 SOL = 7.500.000 BONK

/** Simuliert DexScreener, Solana-RPC und Jupiter mit festen, plausiblen Kursen. */
const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(
      addrs.map((a) => ({
        chainId: 'solana',
        dexId: 'raydium',
        baseToken: { address: a, symbol: a === SOL_MINT ? 'SOL' : 'Bonk', name: a === SOL_MINT ? 'Wrapped SOL' : 'Bonk' },
        priceUsd: String(a === SOL_MINT ? SOL_USD : BONK_USD),
        liquidity: { usd: a === SOL_MINT ? 50_000_000 : 40_000 },
      })),
    );
  }
  if (u.includes('jup.ag')) {
    const q = new URL(u).searchParams;
    const amount = BigInt(q.get('amount')!);
    // 0,3 % Pool-Gebühr; BONK hat 5, SOL 9 Nachkommastellen
    const out =
      q.get('inputMint') === SOL_MINT
        ? (amount * 7_500_000n * 100_000n * 997n) / (10n ** 9n * 1_000n)
        : (amount * 10n ** 9n * 997n) / (7_500_000n * 100_000n * 1_000n);
    return json({ inAmount: amount.toString(), outAmount: out.toString(), priceImpactPct: '0.004', routePlan: [{ swapInfo: { label: 'Raydium' } }] });
  }
  if (init?.method === 'POST') return json({ jsonrpc: '2.0', id: 1, result: { value: { decimals: 5 } } }); // getTokenSupply
  return new Response('unbekannt', { status: 404 });
}) as unknown as typeof fetch;

const STANDARD = { maxTradeUsd: 1_000, maxSlippageBps: 100, maxPriceImpactPct: 3, minLiquidityUsd: 10_000 };

describe.skipIf(!hasDb)('Wallet-Trading: Paper-Swaps über das Swap-Gate', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let b: ReturnType<typeof createCaller>;
  let walletId: string;

  beforeAll(async () => {
    setSwapFetchForTests(fakeNet);
    ({ db, pool } = createDb());
    const ra = await register(db, { email: `swap-a-${RUN}@test.invalid`, password: 'sehr-sicheres-passwort-123', name: 'A' });
    const rb = await register(db, { email: `swap-b-${RUN}@test.invalid`, password: 'sehr-sicheres-passwort-123', name: 'B' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    b = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${rb.accessToken}` }));
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    const emails = [`swap-a-${RUN}@test.invalid`, `swap-b-${RUN}@test.invalid`];
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${emails[0]}, ${emails[1]}))`);
    await db.execute(sql`DELETE FROM users WHERE email IN (${emails[0]}, ${emails[1]})`);
    await pool.end();
  });

  it('config: Ketten + Profile; Wallet-Schlüssel ohne Betreiber-Freigabe nicht erlaubt', async () => {
    const cfg = await a.swaps.config();
    expect(cfg.chains.map((c) => c.id)).toEqual(['solana', 'ethereum', 'base', 'arbitrum', 'bsc']);
    expect(cfg.liveKeysAllowed).toBe(false);
  });

  it('Paper-Wallet: Startguthaben zum echten Preis bewertet', async () => {
    const w = await a.swaps.createPaperWallet({ chain: 'solana', label: 'Memes', startAmount: '10', limits: STANDARD });
    walletId = w.id;
    expect(w).toMatchObject({ mode: 'paper', address: null, slippageBps: 100 });
    const pf = await a.swaps.portfolio({ walletId });
    expect(pf.holdings).toEqual([expect.objectContaining({ symbol: 'SOL', amount: '10', valueUsd: 1_500, native: true })]);
  });

  it('Angebot: echte Mengen + Urteil, ändert nichts', async () => {
    const q = await a.swaps.quote({ walletId, side: 'buy', token: BONK, amount: '1' });
    expect(q).toMatchObject({ inAmount: '1', inSymbol: 'SOL', outSymbol: 'Bonk', valueUsd: 150, route: ['Raydium'] });
    expect(Number(q.outAmount)).toBeCloseTo(7_477_500, 0);
    expect(q.priceImpactPct).toBeCloseTo(0.4, 6);
    expect(q.verdict).toEqual({ allowed: true, reasons: [] });
    expect((await a.swaps.portfolio({ walletId })).trades).toHaveLength(0);
  });

  it('Kauf und Verkauf der Hälfte: Bestände, realisierte PnL, Historie', async () => {
    await a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '1' });
    const sell = await a.swaps.execute({ walletId, side: 'sell', token: BONK, percent: 50 });
    // Einstand der Hälfte ≈ 75 USD, Erlös ≈ 74,55 USD (2× 0,3 % Pool-Gebühr) → kleiner Verlust
    expect(sell.trade.realizedPnlUsd).toBeLessThan(0);
    expect(sell.trade.realizedPnlUsd).toBeGreaterThan(-1);

    const pf = await a.swaps.portfolio({ walletId });
    const bonk = pf.holdings.find((h) => h.symbol === 'Bonk')!;
    expect(Number(bonk.amount)).toBeCloseTo(3_738_750, 0);
    expect(pf.trades.map((t) => t.side)).toEqual(['sell', 'buy']);
    expect(pf.trades[1]).toMatchObject({ inSymbol: 'SOL', inAmount: '1', outSymbol: 'Bonk' });
  });

  it('Swap-Gate greift: Betrag über dem Limit und zu wenig Liquidität', async () => {
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '7' })).rejects.toThrow(/trade_above_limit/);
    await a.swaps.updateWallet({ walletId, limits: { ...STANDARD, minLiquidityUsd: 1_000_000 } });
    const q = await a.swaps.quote({ walletId, side: 'buy', token: BONK, amount: '0.1' });
    expect(q.verdict.reasons).toEqual(['liquidity_below_limit']);
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1' })).rejects.toThrow(/liquidity_below_limit/);
  });

  it('Standard-Slippage darf die eigene Obergrenze nicht überschreiten', async () => {
    await expect(a.swaps.updateWallet({ walletId, slippageBps: 500 })).rejects.toThrow(/Obergrenze/);
  });

  it('fremde Wallets sind unsichtbar', async () => {
    expect(await b.swaps.wallets()).toEqual([]);
    await expect(b.swaps.portfolio({ walletId })).rejects.toThrow(/nicht gefunden/);
    await expect(b.swaps.execute({ walletId, side: 'sell', token: BONK, percent: 100 })).rejects.toThrow(/nicht gefunden/);
  });

  it('ungültige Adresse oder Gegenwährung wird abgelehnt', async () => {
    await expect(a.swaps.quote({ walletId, side: 'buy', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1' })).rejects.toThrow(/gültige Solana/);
    await expect(a.swaps.quote({ walletId, side: 'buy', token: SOL_MINT, amount: '1' })).rejects.toThrow(/selbst/);
  });
});
