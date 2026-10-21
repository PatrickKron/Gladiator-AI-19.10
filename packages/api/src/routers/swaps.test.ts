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
const RUG = 'RugPu11Token1111111111111111111111111111111';
const SOL_USD = 150;
const BONK_USD = 0.00002; // 1 SOL = 7.500.000 BONK

/** Simuliert DexScreener, Solana-RPC und Jupiter mit festen, plausiblen Kursen. */
const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('data-api.ecb.europa.eu')) {
    // EZB-Antwort (Aufbau wie csvdata) mit einem Testkurs für die letzten Tage
    const days = [0, 1, 2, 3].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
    return new Response(['KEY,FREQ,TIME_PERIOD,OBS_VALUE', ...days.map((d) => `EXR.D.USD.EUR.SP00.A,D,${d},1.25`)].join('\n'));
  }
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
  if (init?.method === 'POST') {
    const rpc = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    if (rpc.method === 'getAccountInfo') {
      // RUG = Token-2022 mit permanentem Delegierten (kann Tokens jederzeit abziehen)
      const rug = rpc.params[0] === RUG;
      return json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          value: {
            owner: rug ? 'TokenzQdBNbLqP5VEhdkAS6EHFLp88EzTEbtKFFuh6' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            data: { parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, extensions: rug ? [{ extension: 'permanentDelegate', state: { delegate: 'Evil' } }] : [] } } },
          },
        },
      });
    }
    return json({ jsonrpc: '2.0', id: 1, result: { value: { decimals: 5 } } }); // getTokenSupply
  }
  return new Response('unbekannt', { status: 404 });
}) as unknown as typeof fetch;

const STANDARD = { maxTradeUsd: 1_000, maxSlippageBps: 100, maxPriceImpactPct: 3, minLiquidityUsd: 10_000, maxTokenTaxPct: 3 };

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

  it('Steuer-Export: ausgeführte Swaps als CSV (Paper-Hinweis), Jahresfilter', async () => {
    const csv = await a.swaps.exportTrades({ format: 'csv' });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^# Hinweis: Paper-Swaps sind simuliert/);
    const rows = lines.slice(2).filter((l) => l.includes(';Solana;'));
    expect(rows.some((l) => l.includes(';Kauf;1;SOL;'))).toBe(true);
    // EUR zum (Test-)EZB-Kurs: 1 SOL × 150 $ / 1,25 = 120 €
    expect(lines[0]).toMatch(/EZB-Referenzkurs des Tages/);
    expect(rows.find((l) => l.includes(';Kauf;1;SOL;'))).toMatch(/;1\.25;120\.0000;/);
    expect(rows.some((l) => l.includes(';Verkauf;'))).toBe(true);
    // anderes Jahr → nur Kopf
    expect((await a.swaps.exportTrades({ format: 'csv', year: 2001 })).trim().split('\n')).toHaveLength(2);
  });

  it('Swap-Gate greift: Betrag über dem Limit und zu wenig Liquidität', async () => {
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '7' })).rejects.toThrow(/trade_above_limit/);
    await a.swaps.updateWallet({ walletId, limits: { ...STANDARD, minLiquidityUsd: 1_000_000 } });
    const q = await a.swaps.quote({ walletId, side: 'buy', token: BONK, amount: '0.1' });
    expect(q.verdict.reasons).toEqual(['liquidity_below_limit']);
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1' })).rejects.toThrow(/liquidity_below_limit/);
  });

  it('Sicherheitscheck: Token mit permanentem Delegierten wird nicht gekauft; sauberer Token zeigt den Check', async () => {
    const ok = await a.swaps.quote({ walletId, side: 'buy', token: BONK, amount: '0.1' });
    expect(ok.safety).toMatchObject({ checked: true, source: 'chain', severe: [] });
    await a.swaps.updateWallet({ walletId, limits: STANDARD });
    const rug = await a.swaps.quote({ walletId, side: 'buy', token: RUG, amount: '0.1' });
    expect(rug.safety?.severe).toEqual(['permanent_delegate']);
    expect(rug.verdict.reasons).toContain('token_unsafe');
    expect(await a.swaps.safety({ chain: 'solana', address: RUG })).toMatchObject({ severe: ['permanent_delegate'] });
  });

  it('Standard-Slippage darf die eigene Obergrenze nicht überschreiten', async () => {
    await expect(a.swaps.updateWallet({ walletId, slippageBps: 500 })).rejects.toThrow(/Obergrenze/);
  });

  it('Orders: Plausibilität, Anlegen, Liste, Stornieren; fremde Orders unantastbar', async () => {
    // BONK kostet hier 0,00002 $
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'take_profit', triggerPriceUsd: 0.00001, sellPercent: 50 })).rejects.toThrow(/über dem aktuellen/);
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'stop_loss', triggerPriceUsd: 0.00003, sellPercent: 50 })).rejects.toThrow(/unter dem aktuellen/);
    await expect(a.swaps.createOrder({ walletId, token: RUG, kind: 'stop_loss', triggerPriceUsd: 0.00001 })).rejects.toThrow(/Kein .*-Bestand/);
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'limit_buy', triggerPriceUsd: 0.00001 })).rejects.toThrow(/Betrag/);
    const tp = await a.swaps.createOrder({ walletId, token: BONK, kind: 'take_profit', triggerPriceUsd: 0.00004, sellPercent: 50 });
    await a.swaps.createOrder({ walletId, token: BONK, kind: 'trailing_stop', trailPct: 15 });
    // Rug-Schutz: Ausgangsstand = aktuelle Pool-Liquidität (hier 40.000 $), Abfall 10–90 %
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'rug_guard', trailPct: 5 })).rejects.toThrow(/10 bis 90/);
    await a.swaps.createOrder({ walletId, token: BONK, kind: 'rug_guard', trailPct: 50 });
    const list = await a.swaps.orders({ walletId });
    expect(list.find((o) => o.kind === 'rug_guard')).toMatchObject({ trailPct: 50, peakLiquidityUsd: 40_000, triggerPriceUsd: null, sellPercent: 100 });
    expect(list.map((o) => o.kind).sort()).toEqual(['rug_guard', 'take_profit', 'trailing_stop']);
    expect(list.find((o) => o.kind === 'trailing_stop')).toMatchObject({ peakPriceUsd: 0.00002, sellPercent: 100, status: 'open' });
    await expect(b.swaps.cancelOrder({ orderId: tp.id })).rejects.toThrow(/nicht gefunden/);
    await a.swaps.cancelOrder({ orderId: tp.id });
    await expect(a.swaps.cancelOrder({ orderId: tp.id })).rejects.toThrow(/nicht mehr offen/);
  });

  it('Auto-TP/SL beim Kauf: Orders relativ zum tatsächlichen Kaufkurs (inkl. Pool-Gebühr)', async () => {
    const r = await a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.5', autoOrders: { takeProfitPct: 50, stopLossPct: 20, sellPercent: 100 } });
    const entry = r.quote.valueUsd / Number(r.quote.outAmount);
    expect(entry).toBeGreaterThan(BONK_USD); // Gebühr macht den Einstieg etwas teurer
    expect(r.autoOrders.map((o) => o.kind)).toEqual(['take_profit', 'stop_loss']);
    expect(r.autoOrders.every((o) => o.orderId !== null && o.error === null)).toBe(true);
    expect(r.autoOrders[0]!.triggerPriceUsd).toBeCloseTo(entry * 1.5, 12);
    expect(r.autoOrders[1]!.triggerPriceUsd).toBeCloseTo(entry * 0.8, 12);
    const listed = (await a.swaps.orders({ walletId })).filter((o) => r.autoOrders.some((x) => x.orderId === o.id));
    expect(listed.map((o) => [o.kind, o.sellPercent, o.status]).sort()).toEqual([
      ['stop_loss', 100, 'open'],
      ['take_profit', 100, 'open'],
    ]);
    for (const o of listed) await a.swaps.cancelOrder({ orderId: o.id });
    // ohne autoOrders: keine Orders
    expect((await a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1' })).autoOrders).toEqual([]);
  });

  it('DCA: braucht Betrag, Abstand und Anzahl; erster Kauf sofort fällig', async () => {
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'dca', intervalMinutes: 60, runsTotal: 5 })).rejects.toThrow(/Betrag/);
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'dca', buyAmount: '0.1' })).rejects.toThrow(/Abstand und Anzahl/);
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'dca', buyAmount: '0.1', intervalMinutes: 1, runsTotal: 5 })).rejects.toThrow();
    const before = Date.now();
    const o = await a.swaps.createOrder({ walletId, token: BONK, kind: 'dca', buyAmount: '0.1', intervalMinutes: 240, runsTotal: 6, maxPriceUsd: 0.00003 });
    const row = (await a.swaps.orders({ walletId })).find((x) => x.id === o.id)!;
    expect(row).toMatchObject({ kind: 'dca', buyAmount: '0.1', intervalMinutes: 240, runsTotal: 6, runsDone: 0, maxPriceUsd: 0.00003, triggerPriceUsd: null, sellPercent: null, status: 'open' });
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThanOrEqual(before - 1000);
    await a.swaps.cancelOrder({ orderId: o.id });
  });

  it('Positionen über alle Wallets: nur Tokens (kein natives SOL), Wert + PnL aus echten Kursen; fremde unsichtbar', async () => {
    const r = await a.swaps.positions();
    const bonk = r.positions.filter((p) => p.symbol === 'Bonk');
    expect(bonk.length).toBeGreaterThan(0);
    expect(r.positions.some((p) => p.token === SOL_MINT)).toBe(false);
    for (const p of bonk) {
      expect(p.priceUsd).toBe(BONK_USD);
      expect(p.valueUsd).toBeCloseTo(Number(p.amount) * BONK_USD, 8);
      expect(p.pnlUsd).toBeCloseTo(p.valueUsd! - p.costUsd, 8);
    }
    expect(r.totalValueUsd).toBeCloseTo(r.positions.reduce((s, p) => s + p.valueUsd!, 0), 8);
    expect(r.problems).toEqual([]);
    expect((await b.swaps.positions()).positions).toEqual([]);
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
