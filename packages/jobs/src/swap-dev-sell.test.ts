/**
 * Dev-Verkauf-Schutz gegen die ECHTE DB (Paper, Base): Transfers der
 * Ersteller-Wallet kommen als Transfer-Logs von der (injizierten) Kette. Nur
 * Transfers an Pools des Tokens/Router zählen als Verkauf (Lock/Umbuchung nicht);
 * unter der Schwelle → nichts; Kette nicht lesbar → nichts entscheiden (Cursor
 * bleibt); ab der Schwelle → eigener Bestand wird über denselben Swap-Pfad verkauft.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { ERC20_TRANSFER_TOPIC, fundPaperWallet, padTopic, SWAP_CHAINS, walletBalances } from '@gladiator/exchange';
import type pg from 'pg';
import { devSoldAtomic, evaluateDevSell, runSwapOrders, validateNewOrder } from './swap-orders.js';
import { setSwapFetchForTests } from './swap-service.js';

const MEME = '0x6666666666666666666666666666666666666666';
const DEV = '0x8888888888888888888888888888888888888888';
const ROUTER = '0x7777777777777777777777777777777777777777';
const WETH = SWAP_CHAINS.base.wrappedNative;
const E18 = 10n ** 18n;
const POOL = '0x9999999999999999999999999999999999999999';
const LOCK = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Kette: Spitze + Transfers der Ersteller-Wallet; down = Knoten antwortet nicht */
let head = 1000;
let devTransfers: { block: number; to: string; amount: bigint }[] = [];
/** Blöcke, in denen der Ersteller LP-Token geprägt bekam (Liquidität hinzugefügt) */
let lpMintBlocks: number[] = [];
let down = false;

const net = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener') && u.includes('/token-pairs/v1/')) {
    return json([{ chainId: 'base', dexId: 'uniswap', labels: ['v2'], pairAddress: POOL, baseToken: { address: MEME }, liquidity: { usd: 1e7, base: 1e9, quote: 300 } }]);
  }
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
    return json({ code: 0, data: { routeSummary: { amountIn: amountIn.toString(), amountOut: out.toString(), amountInUsd: String(usd), amountOutUsd: String(usd * 0.997), gasUsd: '0.01', route: [[{ exchange: 'uniswap-v2' }]] }, routerAddress: ROUTER } });
  }
  if (u.includes('gopluslabs')) return new Response('nicht erreichbar', { status: 503 });
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const rpc = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  if (down && (body.method === 'eth_getLogs' || body.method === 'eth_blockNumber')) return new Response('überlastet', { status: 503 });
  switch (body.method) {
    case 'eth_blockNumber':
      return rpc(`0x${head.toString(16)}`);
    case 'eth_getLogs': {
      const f = body.params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] };
      const [lo, hi] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
      if (f.address.toLowerCase() !== MEME || f.topics[1] !== padTopic(DEV)) return rpc([]);
      return rpc(
        devTransfers
          .filter((t) => t.block >= lo && t.block <= hi)
          .map((t) => ({ address: MEME, topics: [ERC20_TRANSFER_TOPIC, padTopic(DEV), padTopic(t.to)], data: word(t.amount), transactionHash: `0x${t.block}`, blockNumber: `0x${t.block.toString(16)}` })),
      );
    }
    case 'eth_getTransactionReceipt': {
      // Beleg: bei Liquidität zusätzlich LP-Token-Prägung (0x0 → Ersteller) in derselben Tx
      const block = Number(String(body.params[0]).slice(2));
      const mint = { address: POOL, topics: [ERC20_TRANSFER_TOPIC, padTopic('0x0000000000000000000000000000000000000000'), padTopic(DEV)], data: word(1n) };
      return rpc({ logs: lpMintBlocks.includes(block) ? [mint] : [] });
    }
    case 'eth_call':
      return rpc(word(18n)); // decimals()
    case 'eth_getBalance':
      return rpc('0x0');
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe('evaluateDevSell (rein)', () => {
  it('löst ab dem verkauften Anteil aus, ganzzahlig ohne Rundungsfehler', () => {
    expect(evaluateDevSell(1000n * E18, 200n * E18, 50)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 500n * E18 - 1n, 50)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 500n * E18, 50)).toBe(true);
    // 100 % = erst wenn der Ersteller alles verkauft hat
    expect(evaluateDevSell(1000n * E18, 1000n * E18 - 1n, 100)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 1000n * E18, 100)).toBe(true);
    // ohne Ausgangsbestand oder ohne Verkauf nie
    expect(evaluateDevSell(0n, 5n, 50)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 0n, 10)).toBe(false);
  });

  it('nur Transfers an Pools/Router zählen als Verkauf (Lock, Burn, Umbuchung nicht)', () => {
    const sinks = new Set([POOL]);
    expect(devSoldAtomic([{ to: POOL.toUpperCase().replace('0X', '0x'), amount: 7n }, { to: LOCK, amount: 100n }, { to: '0x000000000000000000000000000000000000dead', amount: 50n }], sinks)).toBe(7n);
    expect(devSoldAtomic([], sinks)).toBe(0n);
  });

  it('Plausibilität: Abgabe 10 bis 100 %', () => {
    expect(validateNewOrder({ kind: 'dev_sell', triggerPriceUsd: null, trailPct: 5, peakPriceUsd: null }, 1)).toMatch(/10 bis 100/);
    expect(validateNewOrder({ kind: 'dev_sell', triggerPriceUsd: null, trailPct: 100, peakPriceUsd: null }, 1)).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('Dev-Verkauf-Schutz (echte DB, Paper, Base)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let walletId: string;
  const RUN = `${process.pid}-${Date.now()}-dev`;
  const meme = async () => BigInt((await walletBalances(db, walletId)).find((b) => b.token.toLowerCase() === MEME)?.amountAtomic ?? '0');
  const status = async (id: string) => (await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, id)))[0]!.status;

  beforeAll(async () => {
    setSwapFetchForTests(net);
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `devsell-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [w] = await db
      .insert(schema.swapWallets)
      .values({ userId, chain: 'base', label: 'Base Dev', address: `paper:${RUN}`, maxTradeUsd: '10000', maxSlippageBps: 500, maxPriceImpactPct: '5', minLiquidityUsd: '0', maxTokenTaxPct: '5' })
      .returning();
    walletId = w!.id;
    await fundPaperWallet(db, walletId, 'base', '1', 3000);
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Lock und Liquidität zählen nicht, Verkauf unter der Schwelle → nichts; Kette nicht lesbar → nichts; ab der Schwelle → Bestand verkauft', async () => {
    // Bestand aufbauen: Limit-Kauf über dem Kurs löst sofort aus
    const [buy] = await db.insert(schema.swapOrders).values({ walletId, token: MEME, symbol: 'MEME', kind: 'limit_buy', triggerPriceUsd: '1', buyAmount: '0.1' }).returning();
    await runSwapOrders(db);
    expect(await status(buy!.id)).toBe('filled');
    expect(await meme()).toBe(600n * E18);

    const [dev] = await db
      .insert(schema.swapOrders)
      .values({ walletId, token: MEME, symbol: 'MEME', kind: 'dev_sell', trailPct: '50', sellPercent: '100', watchAddress: DEV, watchBalance: (1000n * E18).toString(), watchBlock: String(head - 3), watchSold: '0' })
      .returning();
    const row = async () => (await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, dev!.id)))[0]!;
    // 60 % in einen Lock (kein Verkauf) + 10 % an den Pool → 10 % verkauft, unter der Schwelle
    head += 10;
    devTransfers = [
      { block: head - 8, to: LOCK, amount: 600n * E18 },
      { block: head - 7, to: POOL, amount: 100n * E18 },
      // Liquidität hinzugefügt (LP-Token geprägt) → kein Verkauf
      { block: head - 6, to: POOL, amount: 300n * E18 },
    ];
    lpMintBlocks = [head - 6];
    await runSwapOrders(db);
    expect(await row()).toMatchObject({ status: 'open', watchSold: (100n * E18).toString(), watchBlock: String(head - 3) });
    // Knoten antwortet nicht → nie raten, Cursor bleibt
    head += 10;
    devTransfers.push({ block: head - 5, to: POOL, amount: 450n * E18 });
    down = true;
    const r = await runSwapOrders(db);
    expect(r.errors.some((e) => e.startsWith('Dev-Verkäufe MEME'))).toBe(true);
    expect(await row()).toMatchObject({ status: 'open', watchSold: (100n * E18).toString(), watchBlock: String(head - 13) });
    // wieder erreichbar: 450 dazu → 55 % verkauft → eigener Bestand raus
    down = false;
    await runSwapOrders(db);
    expect(await status(dev!.id)).toBe('filled');
    expect((await row()).watchSold).toBe((550n * E18).toString());
    expect(await meme()).toBe(0n);
    // Altbestand ohne Startblock: wird ab jetzt beobachtet (Startblock gesetzt), nicht still liegen gelassen
    const [old] = await db
      .insert(schema.swapOrders)
      .values({ walletId, token: MEME, symbol: 'MEME', kind: 'dev_sell', trailPct: '50', sellPercent: '100', watchAddress: DEV, watchBalance: (1000n * E18).toString() })
      .returning();
    await runSwapOrders(db);
    expect((await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, old!.id)))[0]).toMatchObject({ status: 'open', watchBlock: String(head - 3), watchSold: '0' });
    const notes = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, userId)));
    expect(notes.map((n) => n.title)).toContain('Dev-Verkauf-Schutz ausgeführt: MEME');
  });
});
