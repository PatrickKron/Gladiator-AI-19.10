/**
 * Copy-Trading (Paper) gegen die ECHTE DB: beobachtete Solana-Wallet, Kette
 * (RPC), DexScreener und Jupiter injiziert. Erster Lauf merkt sich nur den
 * Verlauf; danach Kauf → Nachkauf mit festem Betrag, Verkauf → eigener
 * Bestand raus; nichts doppelt.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { ERC20_TRANSFER_TOPIC, fundPaperWallet, padTopic, SOL_MINT, SWAP_CHAINS, walletBalances, WETH_WITHDRAWAL_TOPIC } from '@gladiator/exchange';
import type pg from 'pg';
import { setSwapFetchForTests } from './swap-service.js';
import { copySellPercent, runWalletCopy } from './wallet-copy.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('copySellPercent', () => {
  it('Teilverkauf → derselbe Anteil; unbekannt oder fast alles → ganz raus', () => {
    expect(copySellPercent(25)).toBe(25);
    expect(copySellPercent(33.3333)).toBe(33.33);
    expect(copySellPercent(0.2)).toBe(1);
    expect(copySellPercent(96)).toBe(100);
    expect(copySellPercent(null)).toBe(100);
    expect(copySellPercent(undefined)).toBe(100);
  });
});
const WHALE = 'WhaLe11111111111111111111111111111111111111';

type Tx = { sig: string; side: 'buy' | 'sell'; owner?: string };
/** Kette der beobachteten Wallet, neueste zuerst. */
let chainTxs: Tx[] = [];

function parsedTx(t: Tx) {
  const who = t.owner ?? WHALE;
  const tok = (amount: string) => [{ accountIndex: 1, mint: BONK, owner: who, uiTokenAmount: { amount, decimals: 5 } }];
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
    transaction: { message: { accountKeys: [{ pubkey: who, signer: true }, { pubkey: 'Pool111111111111111111111111111111111111111' }] } },
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
    const mine = chainTxs.filter((t) => (t.owner ?? WHALE) === body.params[0]);
    const idx = until ? mine.findIndex((t) => t.sig === until) : mine.length;
    return rpc(mine.slice(0, idx === -1 ? mine.length : idx).map((t) => ({ signature: t.sig, err: null })));
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

  it('leere Wallet: Cursor "" nach dem ersten Lauf → ihr erster echter Kauf wird kopiert', async () => {
    const saved = chainTxs;
    chainTxs = [];
    const [fresh] = await db
      .insert(schema.watchedWallets)
      .values({ userId, address: 'Frisch111111111111111111111111111111111111', label: 'Frisch', copyMode: 'paper', copyWalletId: walletId, copyAmount: '0.1' })
      .returning();
    await runWalletCopy(db);
    const row = async () => (await db.select().from(schema.watchedWallets).where(eq(schema.watchedWallets.id, fresh!.id)))[0]!;
    expect((await row()).lastSignature).toBe('');
    chainTxs = [{ sig: `fresh-${RUN}`, side: 'buy', owner: 'Frisch111111111111111111111111111111111111' }];
    await db.update(schema.watchedWallets).set({ lastCheckedAt: null }).where(eq(schema.watchedWallets.id, fresh!.id));
    await runWalletCopy(db);
    const swaps = await db.select().from(schema.watchedWalletSwaps).where(eq(schema.watchedWalletSwaps.watchedId, fresh!.id));
    expect(swaps).toEqual([expect.objectContaining({ signature: `fresh-${RUN}`, copyStatus: 'filled' })]);
    await db.delete(schema.watchedWallets).where(eq(schema.watchedWallets.id, fresh!.id));
    chainTxs = saved;
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

/* ---------- EVM (Base): Transfer-Logs statt Signaturen ---------- */

const EVM_WHALE = '0x5555555555555555555555555555555555555555';
const MEME = '0x6666666666666666666666666666666666666666';
const ROUTER = '0x7777777777777777777777777777777777777777';
const WETH = SWAP_CHAINS.base.wrappedNative;
type EvmTxSpec = { hash: string; block: number; side: 'buy' | 'sell' };
let evmBlock = 30_000_000;
let evmTxs: EvmTxSpec[] = [];

const evmNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(addrs.map((a) => ({ chainId: 'base', baseToken: { address: a, symbol: a.toLowerCase() === WETH.toLowerCase() ? 'WETH' : 'MEME' }, priceUsd: a.toLowerCase() === WETH.toLowerCase() ? '3000' : '0.5', liquidity: { usd: 1e7 } })));
  }
  if (u.includes('kyberswap')) {
    const q = new URL(u).searchParams;
    const amountIn = BigInt(q.get('amountIn')!);
    const buy = q.get('tokenOut')!.toLowerCase() === MEME;
    // 1 ETH = 6000 MEME (beide 18 Nachkommastellen)
    const out = buy ? amountIn * 6000n : amountIn / 6000n;
    const usd = buy ? (Number(amountIn) / 1e18) * 3000 : (Number(amountIn) / 1e18) * 0.5;
    return json({ code: 0, data: { routeSummary: { amountIn: amountIn.toString(), amountOut: out.toString(), amountInUsd: String(usd), amountOutUsd: String(usd * 0.997), gasUsd: '0.01', route: [[{ exchange: 'uniswap-v3' }]] }, routerAddress: ROUTER } });
  }
  if (u.includes('gopluslabs')) return new Response('nicht erreichbar', { status: 503 });
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const rpc = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
  const hex = (n: number | bigint) => `0x${n.toString(16)}`;
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  switch (body.method) {
    case 'eth_blockNumber':
      return rpc(hex(evmBlock));
    case 'eth_getLogs': {
      const f = body.params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
      const [lo, hi] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
      const outgoing = f.topics[1] !== null && f.topics[1] !== undefined;
      const logs = evmTxs
        .filter((t) => t.block >= lo && t.block <= hi && (outgoing ? t.side === 'sell' : t.side === 'buy'))
        .map((t) => ({
          address: MEME,
          topics: [ERC20_TRANSFER_TOPIC, padTopic(t.side === 'buy' ? ROUTER : EVM_WHALE), padTopic(t.side === 'buy' ? EVM_WHALE : ROUTER)],
          data: word(900n * 10n ** 18n),
          transactionHash: t.hash,
          blockNumber: hex(t.block),
          logIndex: '0x0',
        }));
      return rpc(logs);
    }
    case 'eth_getTransactionByHash': {
      const t = evmTxs.find((x) => x.hash === body.params[0]);
      return rpc(t ? { from: EVM_WHALE, to: ROUTER, value: t.side === 'buy' ? hex(10n ** 17n) : '0x0' } : null);
    }
    case 'eth_getTransactionReceipt': {
      // Verkauf: Router packt WETH aus und zahlt ETH an die Wallet (Erlös-Nachweis)
      const t = evmTxs.find((x) => x.hash === body.params[0]);
      return rpc({ logs: t?.side === 'sell' ? [{ address: WETH, topics: [WETH_WITHDRAWAL_TOPIC, padTopic(ROUTER)], data: word(15n * 10n ** 16n) }] : [] });
    }
    case 'eth_getBlockByNumber':
      return rpc({ timestamp: hex(1_700_000_000) });
    case 'eth_call':
      return rpc(word(18n)); // decimals()
    case 'eth_getBalance':
      return rpc('0x0');
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(!process.env.DATABASE_URL)('runWalletCopy EVM (echte DB, Paper, Base)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let walletId: string;
  let watchedId: string;
  const RUN = `${process.pid}-${Date.now()}-evm`;
  const backdate = () => db.update(schema.watchedWallets).set({ lastCheckedAt: null }).where(eq(schema.watchedWallets.id, watchedId));
  const seen = () => db.select().from(schema.watchedWalletSwaps).where(eq(schema.watchedWalletSwaps.watchedId, watchedId));
  const meme = async () => BigInt((await walletBalances(db, walletId)).find((b) => b.token.toLowerCase() === MEME)?.amountAtomic ?? '0');

  beforeAll(async () => {
    setSwapFetchForTests(evmNet);
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `walletcopy-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [w] = await db
      .insert(schema.swapWallets)
      .values({ userId, chain: 'base', label: 'Base Copy', address: `paper:${RUN}`, maxTradeUsd: '10000', maxSlippageBps: 500, maxPriceImpactPct: '5', minLiquidityUsd: '0', maxTokenTaxPct: '5' })
      .returning();
    walletId = w!.id;
    await fundPaperWallet(db, walletId, 'base', '1', 3000);
    const [ww] = await db
      .insert(schema.watchedWallets)
      .values({ userId, chain: 'base', address: EVM_WHALE, label: 'Base-Wal', copyMode: 'paper', copyWalletId: walletId, copyAmount: '0.05' })
      .returning();
    watchedId = ww!.id;
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('erster Lauf: letzte Blöcke als Verlauf, Cursor = aktueller Block, nichts kopiert', async () => {
    evmTxs = [{ hash: `0xold${RUN}`, block: evmBlock - 10, side: 'buy' }];
    // Cursor = Spitze − 3 Bestätigungen
    await runWalletCopy(db);
    const rows = await seen();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ side: 'buy', token: MEME, copyStatus: 'none', copyNote: 'vor Beobachtungsbeginn', nativeAtomic: (10n ** 17n).toString() });
    const w = (await db.select().from(schema.watchedWallets).where(eq(schema.watchedWallets.id, watchedId)))[0]!;
    expect(w.lastSignature).toBe(String(evmBlock - 3));
    expect(await meme()).toBe(0n);
  });

  it('neuer Kauf in neuem Block → Nachkauf 0,05 ETH; Verkauf → Bestand raus; nichts doppelt', async () => {
    evmBlock += 5;
    evmTxs.push({ hash: `0xbuy${RUN}`, block: evmBlock - 3, side: 'buy' }); // gerade bestätigt
    await backdate();
    await runWalletCopy(db);
    expect((await seen()).find((s) => s.signature === `0xbuy${RUN}`)).toMatchObject({ copyStatus: 'filled' });
    expect(await meme()).toBe(5n * 10n ** 16n * 6000n);

    // derselbe Block nochmal → Cursor verhindert Doppel-Kopie
    await backdate();
    await runWalletCopy(db);
    expect(await meme()).toBe(5n * 10n ** 16n * 6000n);

    evmBlock += 3;
    evmTxs.push({ hash: `0xsell${RUN}`, block: evmBlock - 3, side: 'sell' });
    await backdate();
    await runWalletCopy(db);
    expect((await seen()).find((s) => s.signature === `0xsell${RUN}`)).toMatchObject({ side: 'sell', copyStatus: 'filled', nativeAtomic: (15n * 10n ** 16n).toString() });
    expect(await meme()).toBe(0n);
  });
});
