/**
 * Vermögen: Swap-Wallets bewerten (echte DB, Netz injiziert). Fehlt ein Kurs,
 * ist die Wallet „nicht bewertbar“ (null) — nie geschätzt; Live-Wallets lesen
 * ihre Bestände von der Kette.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { fundPaperWallet, setWalletAmounts, SOL_MINT } from '@gladiator/exchange';
import type pg from 'pg';
import { setSwapFetchForTests, valueSwapWallets } from './swap-service.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let bonkPriced = true;
const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(
      addrs
        .filter((a) => a === SOL_MINT || bonkPriced)
        .map((a) => ({ chainId: 'solana', baseToken: { address: a }, priceUsd: a === SOL_MINT ? '150' : '0.00002', liquidity: { usd: 1e8 } })),
    );
  }
  const body = JSON.parse(String(init?.body)) as { method: string };
  if (body.method === 'getBalance') return json({ jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } }); // 2 SOL on-chain
  if (body.method === 'getTokenAccountsByOwner') return json({ jsonrpc: '2.0', id: 1, result: { value: [] } });
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(!process.env.DATABASE_URL)('valueSwapWallets (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    setSwapFetchForTests(fakeNet);
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `walletvalue-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const limits = { maxTradeUsd: '1000', maxSlippageBps: 100, maxPriceImpactPct: '3', minLiquidityUsd: '0', maxTokenTaxPct: '3' };
    const [paper] = await db.insert(schema.swapWallets).values({ userId, chain: 'solana', label: 'Paper', address: `paper:${RUN}`, ...limits }).returning();
    await fundPaperWallet(db, paper!.id, 'solana', '10', 150);
    await setWalletAmounts(db, paper!.id, [{ token: BONK, symbol: 'Bonk', decimals: 5, amountAtomic: 5_000_000_000n }]); // 50.000 BONK
    // Live-Wallet ohne Schlüssel (nur Lesen) — Bestand kommt von der Kette
    await db.insert(schema.swapWallets).values({ userId, chain: 'solana', label: 'Live', mode: 'live', address: '4PNvFd1e5cyWnTLsxYJiDafkALQKycVfMZ95PbHDKfcp', ...limits });
    // entfernte Wallets zählen nicht
    await db.insert(schema.swapWallets).values({ userId, chain: 'solana', label: 'Alt', address: `paper:alt-${RUN}`, archivedAt: new Date(), ...limits });
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Paper: native + Tokens zum echten Kurs; live: Bestand von der Kette; entfernte nicht', async () => {
    const v = await valueSwapWallets(db, userId);
    expect(v.map((w) => w.label).sort()).toEqual(['Live', 'Paper']);
    expect(v.find((w) => w.label === 'Paper')!.totalUsd).toBeCloseTo(10 * 150 + 50_000 * 0.00002, 6);
    expect(v.find((w) => w.label === 'Live')).toMatchObject({ mode: 'live', totalUsd: 300, error: null });
  });

  it('fehlender Kurs → Wallet nicht bewertbar (null), nie geschätzt', async () => {
    bonkPriced = false;
    const v = await valueSwapWallets(db, userId);
    expect(v.find((w) => w.label === 'Paper')).toMatchObject({ totalUsd: null });
    expect(v.find((w) => w.label === 'Paper')!.error).toMatch(/Kurs/);
    bonkPriced = true;
  });
});
