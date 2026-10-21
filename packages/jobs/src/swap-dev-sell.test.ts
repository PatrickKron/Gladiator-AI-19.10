/**
 * Dev-Verkauf-Schutz gegen die ECHTE DB (Paper, Base): Bestand der
 * Ersteller-Wallet kommt per `balanceOf` von der (injizierten) Kette. Gibt der
 * Ersteller unter der Schwelle ab → nichts; Kette nicht lesbar → nichts
 * entscheiden; ab der Schwelle → eigener Bestand wird über denselben Swap-Pfad
 * verkauft.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { fundPaperWallet, SWAP_CHAINS, walletBalances } from '@gladiator/exchange';
import type pg from 'pg';
import { evaluateDevSell, runSwapOrders, validateNewOrder } from './swap-orders.js';
import { setSwapFetchForTests } from './swap-service.js';

const MEME = '0x6666666666666666666666666666666666666666';
const DEV = '0x8888888888888888888888888888888888888888';
const ROUTER = '0x7777777777777777777777777777777777777777';
const WETH = SWAP_CHAINS.base.wrappedNative;
const E18 = 10n ** 18n;
/** Bestand der Ersteller-Wallet (kleinste Einheit); null = Knoten antwortet nicht */
let devBalance: bigint | null = 1000n * E18;

const net = (async (url: string, init?: RequestInit) => {
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
    return json({ code: 0, data: { routeSummary: { amountIn: amountIn.toString(), amountOut: out.toString(), amountInUsd: String(usd), amountOutUsd: String(usd * 0.997), gasUsd: '0.01', route: [[{ exchange: 'uniswap-v2' }]] }, routerAddress: ROUTER } });
  }
  if (u.includes('gopluslabs')) return new Response('nicht erreichbar', { status: 503 });
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const rpc = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  switch (body.method) {
    case 'eth_call': {
      const call = body.params[0] as { to: string; data: string };
      // balanceOf(Ersteller) = 0x70a08231 + Adresse
      if (call.data.startsWith('0x70a08231') && call.data.endsWith(DEV.slice(2))) {
        if (devBalance === null) return new Response('überlastet', { status: 503 });
        return rpc(word(devBalance));
      }
      return rpc(word(18n)); // decimals()
    }
    case 'eth_getBalance':
      return rpc('0x0');
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe('evaluateDevSell (rein)', () => {
  it('löst ab der Abgabe-Schwelle aus, ganzzahlig ohne Rundungsfehler', () => {
    expect(evaluateDevSell(1000n * E18, 800n * E18, 50)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 500n * E18 + 1n, 50)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 500n * E18, 50)).toBe(true);
    // 100 % = erst wenn der Ersteller alles abgegeben hat
    expect(evaluateDevSell(1000n * E18, 1n, 100)).toBe(false);
    expect(evaluateDevSell(1000n * E18, 0n, 100)).toBe(true);
    // ohne Ausgangsbestand nie
    expect(evaluateDevSell(0n, 0n, 50)).toBe(false);
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

  it('Abgabe unter der Schwelle → nichts; Kette nicht lesbar → nichts; ab der Schwelle → Bestand verkauft', async () => {
    // Bestand aufbauen: Limit-Kauf über dem Kurs löst sofort aus
    const [buy] = await db.insert(schema.swapOrders).values({ walletId, token: MEME, symbol: 'MEME', kind: 'limit_buy', triggerPriceUsd: '1', buyAmount: '0.1' }).returning();
    await runSwapOrders(db);
    expect(await status(buy!.id)).toBe('filled');
    expect(await meme()).toBe(600n * E18);

    const [dev] = await db
      .insert(schema.swapOrders)
      .values({ walletId, token: MEME, symbol: 'MEME', kind: 'dev_sell', trailPct: '50', sellPercent: '100', watchAddress: DEV, watchBalance: (1000n * E18).toString() })
      .returning();
    // Ersteller gibt 20 % ab → unter der Schwelle
    devBalance = 800n * E18;
    await runSwapOrders(db);
    expect(await status(dev!.id)).toBe('open');
    // Knoten antwortet nicht → nie raten
    devBalance = null;
    const r = await runSwapOrders(db);
    expect(r.errors.some((e) => e.startsWith('Dev-Bestand MEME'))).toBe(true);
    expect(await status(dev!.id)).toBe('open');
    // Ersteller hat 60 % abgegeben → eigener Bestand raus
    devBalance = 400n * E18;
    await runSwapOrders(db);
    expect(await status(dev!.id)).toBe('filled');
    expect(await meme()).toBe(0n);
    const notes = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, userId)));
    expect(notes.map((n) => n.title)).toContain('Dev-Verkauf-Schutz ausgeführt: MEME');
  });
});
