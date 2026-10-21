/**
 * Beobachtete Wallets / Copy-Trading (Vision-Punkt 5) über die API gegen die
 * ECHTE DB: Adress-Prüfung, Copy-Ziel nur eigene Solana-Paper-Wallet,
 * Nutzer-Scoping, Aktivität. Den Kopier-Lauf prüft jobs/wallet-copy.test.ts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
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
const WHALE = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const LIMITS = { maxTradeUsd: 1_000, maxSlippageBps: 100, maxPriceImpactPct: 3, minLiquidityUsd: 0, maxTokenTaxPct: 3 };
/** Netz injiziert: Preise (DexScreener) + Nachkommastellen (RPC). */
let geckoCalls = 0;
const fakeNet = (async (url: string) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('geckoterminal')) {
    geckoCalls++;
    const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    return json({
      data: [{ attributes: { address: 'PoolBonk', base_token_price_usd: '0.00002', reserve_in_usd: '500000' }, relationships: { base_token: { data: { id: `solana_${bonk}` } } } }],
      included: [{ id: `solana_${bonk}`, type: 'token', attributes: { address: bonk, symbol: 'Bonk', name: 'Bonk' } }],
    });
  }
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(addrs.map((a) => ({ chainId: u.includes('/base/') ? 'base' : 'solana', baseToken: { address: a, symbol: 'Bonk' }, priceUsd: '0.00002', liquidity: { usd: 1e6 } })));
  }
  return json({ jsonrpc: '2.0', id: 1, result: { value: { decimals: 5 } } });
}) as unknown as typeof fetch;
const off = { copyMode: 'off' as const, copyWalletId: null, copyAmount: null };

describe.skipIf(!hasDb)('Beobachtete Wallets (API)', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let b: ReturnType<typeof createCaller>;
  const emails = [`watch-a-${RUN}@test.invalid`, `watch-b-${RUN}@test.invalid`];

  beforeAll(async () => {
    setSwapFetchForTests(fakeNet);
    ({ db, pool } = createDb());
    const ra = await register(db, { email: emails[0]!, password: 'sehr-sicheres-passwort-123', name: 'A' });
    const rb = await register(db, { email: emails[1]!, password: 'sehr-sicheres-passwort-123', name: 'B' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    b = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${rb.accessToken}` }));
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${emails[0]}, ${emails[1]}))`);
    await db.execute(sql`DELETE FROM users WHERE email IN (${emails[0]}, ${emails[1]})`);
    await pool.end();
  });

  it('Adresse wird geprüft; doppelt beobachten geht nicht', async () => {
    await expect(a.swaps.addWatched({ address: '0xabc', label: 'X', ...off })).rejects.toThrow(/Solana-Adresse/);
    const w = await a.swaps.addWatched({ address: WHALE, label: 'Wal', ...off });
    expect(w).toMatchObject({ address: WHALE, chain: 'solana', copyMode: 'off', lastSignature: null });
    await expect(a.swaps.addWatched({ address: WHALE, label: 'Nochmal', ...off })).rejects.toThrow(/schon beobachtet/);
    expect((await a.swaps.watched()).map((x) => x.address)).toEqual([WHALE]);
  });

  it('Copy-Ziel: nur eigene Solana-Paper-Wallet mit Betrag', async () => {
    const [w] = await a.swaps.watched();
    const solPaper = await a.swaps.createPaperWallet({ chain: 'solana', label: 'Copy', startAmount: '5', limits: LIMITS });
    const basePaper = await a.swaps.createPaperWallet({ chain: 'base', label: 'Base', startAmount: '1', limits: LIMITS });
    const foreign = await b.swaps.createPaperWallet({ chain: 'solana', label: 'B', startAmount: '1', limits: LIMITS });

    await expect(a.swaps.updateWatched({ id: w!.id, label: 'Wal', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: null })).rejects.toThrow(/Betrag/);
    await expect(a.swaps.updateWatched({ id: w!.id, label: 'Wal', copyMode: 'paper', copyWalletId: basePaper.id, copyAmount: '0.1' })).rejects.toThrow(/Solana-Paper-Wallet/);
    await expect(a.swaps.updateWatched({ id: w!.id, label: 'Wal', copyMode: 'paper', copyWalletId: foreign.id, copyAmount: '0.1' })).rejects.toThrow(/nicht gefunden/);
    await expect(a.swaps.updateWatched({ id: w!.id, label: 'Wal', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: '0' })).rejects.toThrow();

    const u = await a.swaps.updateWatched({ id: w!.id, label: 'Wal 2', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: '0.25' });
    expect(u).toMatchObject({ label: 'Wal 2', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: '0.25' });
    // Kopieren aus → Ziel und Betrag werden geleert
    expect(await a.swaps.updateWatched({ id: w!.id, label: 'Wal 2', copyMode: 'off', copyWalletId: solPaper.id, copyAmount: '0.25' })).toMatchObject({
      copyMode: 'off',
      copyWalletId: null,
      copyAmount: null,
    });
  });

  it('EVM-Kette: Adresse je Kette geprüft und klein gespeichert; Copy-Ziel muss auf derselben Kette liegen', async () => {
    const EVM = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    await expect(a.swaps.addWatched({ chain: 'base', address: WHALE, label: 'X', ...off })).rejects.toThrow(/Base-Adresse/);
    const basePaper = await a.swaps.createPaperWallet({ chain: 'base', label: 'Base Copy', startAmount: '1', limits: LIMITS });
    const solPaper = (await a.swaps.wallets()).find((w) => w.chain === 'solana')!;
    await expect(a.swaps.addWatched({ chain: 'base', address: EVM, label: 'Base-Wal', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: '0.01' })).rejects.toThrow(/Base-Paper-Wallet/);
    const w = await a.swaps.addWatched({ chain: 'base', address: EVM, label: 'Base-Wal', copyMode: 'paper', copyWalletId: basePaper.id, copyAmount: '0.01' });
    expect(w).toMatchObject({ chain: 'base', address: EVM.toLowerCase(), copyMode: 'paper', copyWalletId: basePaper.id });
    await expect(a.swaps.addWatched({ chain: 'base', address: EVM.toLowerCase(), label: 'Nochmal', ...off })).rejects.toThrow(/schon beobachtet/);
    await expect(a.swaps.updateWatched({ id: w.id, label: 'Base-Wal', copyMode: 'paper', copyWalletId: solPaper.id, copyAmount: '0.01' })).rejects.toThrow(/Base-Paper-Wallet/);
    await a.swaps.removeWatched({ id: w.id });
  });

  it('Aktivität: Mengen exakt, nur eigene Wallets sichtbar', async () => {
    const [w] = await a.swaps.watched();
    await db.insert(schema.watchedWalletSwaps).values({
      watchedId: w!.id,
      signature: `sig-${RUN}`,
      side: 'buy',
      token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      tokenAtomic: '123456789',
      tokenDecimals: 5,
      nativeAtomic: '1500000000',
      txTime: new Date(),
      copyStatus: 'filled',
      copyNote: '0.25 SOL → 1234 Bonk',
    });
    const act = await a.swaps.watchedActivity({ id: w!.id });
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ side: 'buy', symbol: 'Bonk', amount: '1234.56789', native: '1.5', copyStatus: 'filled' });

    expect(await b.swaps.watched()).toEqual([]);
    await expect(b.swaps.watchedActivity({ id: w!.id })).rejects.toThrow(/nicht gefunden/);
    await expect(b.swaps.removeWatched({ id: w!.id })).rejects.toThrow(/nicht gefunden/);
    await expect(b.swaps.updateWatched({ id: w!.id, label: 'Hack', ...off })).rejects.toThrow(/nicht gefunden/);

    await a.swaps.removeWatched({ id: w!.id });
    expect(await a.swaps.watched()).toEqual([]);
  });

  it('Copy-Statistik: aus den verknüpften Paper-Trades (Käufe, Verkäufe, Treffer, investiert, realisiert)', async () => {
    const paper = (await a.swaps.wallets()).find((w) => w.chain === 'solana' && w.mode === 'paper')!;
    const w = await a.swaps.addWatched({ address: WHALE, label: 'Stats', copyMode: 'paper', copyWalletId: paper.id, copyAmount: '0.1' });
    expect((await a.swaps.watched()).find((x) => x.id === w.id)!.copyStats).toEqual({ buys: 0, sells: 0, wins: 0, investedUsd: 0, realizedPnlUsd: 0 });
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const trade = async (side: 'buy' | 'sell', valueUsd: string, pnl: string | null) => {
      const [t] = await db
        .insert(schema.swapTrades)
        .values({ walletId: paper.id, side, mode: 'paper', status: 'filled', aggregator: 'jupiter', inToken: 'x', inSymbol: 'X', inAtomic: '1', inDecimals: 9, outToken: 'y', outSymbol: 'Y', outAtomic: '1', outDecimals: 5, valueUsd, realizedPnlUsd: pnl, slippageBps: 100 })
        .returning();
      return t!.id;
    };
    const link = async (sig: string, side: 'buy' | 'sell', tradeId: string | null, status: 'filled' | 'skipped') =>
      db.insert(schema.watchedWalletSwaps).values({ watchedId: w.id, signature: `${sig}-${RUN}`, side, token: BONK, tokenAtomic: '1', tokenDecimals: 5, copyStatus: status, copyTradeId: tradeId });
    await link('b1', 'buy', await trade('buy', '15', null), 'filled');
    await link('b2', 'buy', await trade('buy', '15', null), 'filled');
    await link('s1', 'sell', await trade('sell', '20', '5'), 'filled');
    await link('s2', 'sell', await trade('sell', '12', '-3'), 'filled');
    await link('s3', 'sell', null, 'skipped'); // übersprungen → zählt nicht
    expect((await a.swaps.watched()).find((x) => x.id === w.id)!.copyStats).toEqual({ buys: 2, sells: 2, wins: 1, investedUsd: 30, realizedPnlUsd: 2 });
    await a.swaps.removeWatched({ id: w.id });
  });

  it('Token entdecken: echte Felder durchgereicht, 60 s gecacht', async () => {
    const r = await a.swaps.discover({ chain: 'solana', kind: 'trending' });
    expect(r).toEqual([expect.objectContaining({ symbol: 'Bonk', pool: 'PoolBonk', priceUsd: 0.00002, liquidityUsd: 500000, volume24hUsd: null })]);
    const before = geckoCalls;
    await b.swaps.discover({ chain: 'solana', kind: 'trending' });
    expect(geckoCalls).toBe(before);
  });
});
