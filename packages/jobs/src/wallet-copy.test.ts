/**
 * Copy-Trading (Paper) gegen die ECHTE DB: beobachtete Solana-Wallet, Kette
 * (RPC), DexScreener und Jupiter injiziert. Erster Lauf merkt sich nur den
 * Verlauf; danach Kauf → Nachkauf mit festem Betrag, Verkauf → eigener
 * Bestand raus; nichts doppelt.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { fundPaperWallet, SOL_MINT, walletBalances } from '@gladiator/exchange';
import type pg from 'pg';
import { setSwapFetchForTests } from './swap-service.js';
import { runWalletCopy } from './wallet-copy.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WHALE = 'WhaLe11111111111111111111111111111111111111';

type Tx = { sig: string; side: 'buy' | 'sell' };
/** Kette der beobachteten Wallet, neueste zuerst. */
let chainTxs: Tx[] = [];

function parsedTx(t: Tx) {
  const tok = (amount: string) => [{ accountIndex: 1, mint: BONK, owner: WHALE, uiTokenAmount: { amount, decimals: 5 } }];
  return {
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: t.side === 'buy' ? [5_000_000_000, 1] : [1_000_000_000, 1],
      postBalances: t.side === 'buy' ? [4_000_000_000 - 5000, 1] : [2_000_000_000 - 5000, 1],
      preTokenBalances: tok(t.side === 'buy' ? '0' : '900000000'),
      postTokenBalances: tok(t.side === 'buy' ? '900000000' : '0'),
    },
    transaction: { message: { accountKeys: [{ pubkey: WHALE, signer: true }, { pubkey: 'Pool111111111111111111111111111111111111111' }] } },
  };
}

const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(addrs.map((a) => ({ chainId: 'solana', baseToken: { address: a, symbol: a === SOL_MINT ? 'SOL' : 'Bonk' }, priceUsd: a === SOL_MINT ? '150' : '0.00002', liquidity: { usd: 1e8 } })));
  }
  if (u.includes('jup.ag')) {
    const q = new URL(u).searchParams;
    const amount = BigInt(q.get('amount')!);
    const out = q.get('inputMint') === SOL_MINT ? amount * 750n : amount / 750n;
    return json({ inAmount: amount.toString(), outAmount: out.toString(), priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Raydium' } }] });
  }
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const rpc = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
  if (body.method === 'getSignaturesForAddress') {
    const until = (body.params[1] as { until?: string }).until;
    const idx = until ? chainTxs.findIndex((t) => t.sig === until) : chainTxs.length;
    return rpc(chainTxs.slice(0, idx === -1 ? chainTxs.length : idx).map((t) => ({ signature: t.sig, err: null })));
  }
  if (body.method === 'getTransaction') {
    const t = chainTxs.find((x) => x.sig === body.params[0]);
    return rpc(t ? parsedTx(t) : null);
  }
  if (body.method === 'getTokenSupply') return rpc({ value: { decimals: 5 } });
  if (body.method === 'getAccountInfo') {
    return rpc({ value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null } } } } });
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(!process.env.DATABASE_URL)('runWalletCopy (echte DB, Paper)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let walletId: string;
  let watchedId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const backdate = () => db.update(schema.watchedWallets).set({ lastCheckedAt: null }).where(eq(schema.watchedWallets.id, watchedId));
  const seen = () => db.select().from(schema.watchedWalletSwaps).where(eq(schema.watchedWalletSwaps.watchedId, watchedId));
  const bonk = async () => BigInt((await walletBalances(db, walletId)).find((b) => b.token === BONK)?.amountAtomic ?? '0');

  beforeAll(async () => {
    setSwapFetchForTests(fakeNet);
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `walletcopy-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [w] = await db
      .insert(schema.swapWallets)
      .values({ userId, chain: 'solana', label: 'Copy', address: `paper:${RUN}`, maxTradeUsd: '10000', maxSlippageBps: 500, maxPriceImpactPct: '5', minLiquidityUsd: '0', maxTokenTaxPct: '5' })
      .returning();
    walletId = w!.id;
    await fundPaperWallet(db, walletId, 'solana', '10', 150);
    const [ww] = await db
      .insert(schema.watchedWallets)
      .values({ userId, address: WHALE, label: 'Wal', copyMode: 'paper', copyWalletId: walletId, copyAmount: '0.5' })
      .returning();
    watchedId = ww!.id;
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('erster Lauf: Verlauf wird gespeichert, aber nicht kopiert', async () => {
    chainTxs = [{ sig: `old-${RUN}`, side: 'buy' }];
    const r = await runWalletCopy(db);
    expect(r.detected).toBeGreaterThanOrEqual(1);
    const rows = await seen();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ copyStatus: 'none', copyNote: 'vor Beobachtungsbeginn' });
    expect(await bonk()).toBe(0n);
  });

  it('nicht fällig → kein erneuter Abruf', async () => {
    chainTxs = [{ sig: `buy-${RUN}`, side: 'buy' }, ...chainTxs];
    await runWalletCopy(db);
    expect(await seen()).toHaveLength(1);
  });

  it('neuer Kauf → Nachkauf mit festem Betrag + Meldung; zweiter Lauf kopiert nicht doppelt', async () => {
    await backdate();
    await runWalletCopy(db);
    const buy = (await seen()).find((s) => s.signature === `buy-${RUN}`)!;
    expect(buy).toMatchObject({ side: 'buy', copyStatus: 'filled' });
    expect(buy.copyTradeId).not.toBeNull();
    // 0,5 SOL × 750 BONK-Atome je Lamport
    expect(await bonk()).toBe(500_000_000n * 750n);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.map((n) => n.title)).toContain('Copy-Trade ausgeführt: Kauf Bonk');

    await backdate();
    await runWalletCopy(db);
    expect(await bonk()).toBe(500_000_000n * 750n);
    expect((await db.select().from(schema.swapTrades).where(eq(schema.swapTrades.walletId, walletId))).filter((t) => t.side === 'buy')).toHaveLength(1);
  });

  it('Verkauf der beobachteten Wallet → eigener Bestand komplett verkauft', async () => {
    chainTxs = [{ sig: `sell-${RUN}`, side: 'sell' }, ...chainTxs];
    await backdate();
    await runWalletCopy(db);
    expect((await seen()).find((s) => s.signature === `sell-${RUN}`)).toMatchObject({ side: 'sell', copyStatus: 'filled' });
    expect(await bonk()).toBe(0n);
  });

  it('Verkauf ohne eigenen Bestand → übersprungen; Kopieren aus → nur beobachten', async () => {
    chainTxs = [{ sig: `sell2-${RUN}`, side: 'sell' }, ...chainTxs];
    await backdate();
    await runWalletCopy(db);
    expect((await seen()).find((s) => s.signature === `sell2-${RUN}`)).toMatchObject({ copyStatus: 'skipped', copyNote: 'kein eigener Bestand' });

    await db.update(schema.watchedWallets).set({ copyMode: 'off' }).where(eq(schema.watchedWallets.id, watchedId));
    chainTxs = [{ sig: `buy3-${RUN}`, side: 'buy' }, ...chainTxs];
    await backdate();
    await runWalletCopy(db);
    expect((await seen()).find((s) => s.signature === `buy3-${RUN}`)).toMatchObject({ copyStatus: 'none' });
    expect(await bonk()).toBe(0n);
  });

  it('RPC-Fehler → ehrlich als lastError gespeichert, Signatur bleibt', async () => {
    const before = (await db.select().from(schema.watchedWallets).where(eq(schema.watchedWallets.id, watchedId)))[0]!;
    setSwapFetchForTests((async () => new Response('down', { status: 503 })) as unknown as typeof fetch);
    await backdate();
    const r = await runWalletCopy(db);
    setSwapFetchForTests(fakeNet);
    expect(r.errors.join(' ')).toMatch(/HTTP 503/);
    const after = (await db.select().from(schema.watchedWallets).where(eq(schema.watchedWallets.id, watchedId)))[0]!;
    expect(after.lastError).toMatch(/HTTP 503/);
    expect(after.lastSignature).toBe(before.lastSignature);
  });

  it('Zeitbudget: höchstens eine Wallet, wenn das Budget erschöpft ist — der Rest bleibt fällig', async () => {
    const [extra] = await db.insert(schema.watchedWallets).values({ userId, address: 'Zweite1111111111111111111111111111111111111', label: 'Zweite' }).returning();
    await backdate();
    chainTxs = [];
    const r = await runWalletCopy(db, -1);
    expect(r.checked).toBe(1);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    // die vertagten kommen in den nächsten Takten dran (parallele Testdateien können eigene Wallets einreihen)
    const ownChecked = async () => (await db.select().from(schema.watchedWallets).where(eq(schema.watchedWallets.userId, userId))).every((x) => x.lastCheckedAt !== null);
    for (let i = 0; i < 10 && !(await ownChecked()); i++) expect((await runWalletCopy(db, -1)).checked).toBe(1);
    expect(await ownChecked()).toBe(true);
    await db.delete(schema.watchedWallets).where(eq(schema.watchedWallets.id, extra!.id));
  });
});
