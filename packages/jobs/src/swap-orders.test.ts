/**
 * Limit-Orders + Auto-Sell (Vision-Punkt 5e): reine Auslöse-Logik und der
 * Worker-Lauf gegen die ECHTE DB (Paper-Wallet). Netz (DexScreener, RPC,
 * Jupiter) injiziert; der Kurs wird pro Lauf gesetzt.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { fundPaperWallet, SOL_MINT, walletBalances } from '@gladiator/exchange';
import type pg from 'pg';
import { dcaAfterRun, evaluateSwapOrder, failStuckSwapOrders, runDcaOrders, runSwapOrders, stoppableOrders, validateNewOrder } from './swap-orders.js';
import { setSwapFetchForTests } from './swap-service.js';

describe('evaluateSwapOrder', () => {
  it('Take-Profit ab Ziel, Stop-Loss und Limit-Kauf ab Unterschreiten', () => {
    expect(evaluateSwapOrder({ kind: 'take_profit', triggerPriceUsd: 2, trailPct: null, peakPriceUsd: null }, 1.99).trigger).toBe(false);
    expect(evaluateSwapOrder({ kind: 'take_profit', triggerPriceUsd: 2, trailPct: null, peakPriceUsd: null }, 2).trigger).toBe(true);
    expect(evaluateSwapOrder({ kind: 'stop_loss', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, 1.01).trigger).toBe(false);
    expect(evaluateSwapOrder({ kind: 'stop_loss', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, 0.5).trigger).toBe(true);
    expect(evaluateSwapOrder({ kind: 'limit_buy', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, 0.9).trigger).toBe(true);
  });

  it('Trailing: Höchstkurs zieht nach, Auslösung erst beim Abstand vom Hoch', () => {
    let s = { kind: 'trailing_stop' as const, triggerPriceUsd: null, trailPct: 10, peakPriceUsd: null as number | null };
    let r = evaluateSwapOrder(s, 100);
    expect(r).toEqual({ trigger: false, peakPriceUsd: 100 });
    s = { ...s, peakPriceUsd: r.peakPriceUsd };
    r = evaluateSwapOrder(s, 150);
    expect(r).toEqual({ trigger: false, peakPriceUsd: 150 });
    s = { ...s, peakPriceUsd: r.peakPriceUsd };
    expect(evaluateSwapOrder(s, 136).trigger).toBe(false);
    expect(evaluateSwapOrder(s, 135).trigger).toBe(true);
  });

  it('ohne gültigen Preis nie auslösen', () => {
    expect(evaluateSwapOrder({ kind: 'stop_loss', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, Number.NaN).trigger).toBe(false);
    expect(evaluateSwapOrder({ kind: 'stop_loss', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, 0).trigger).toBe(false);
  });
});

describe('dcaAfterRun', () => {
  it('zählt hoch, nächster Termin ab jetzt, fertig nach dem letzten Kauf', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(dcaAfterRun({ runsDone: 0, runsTotal: 3, intervalMinutes: 60 }, now)).toEqual({ runsDone: 1, done: false, nextRunAt: new Date('2026-10-20T13:00:00Z') });
    expect(dcaAfterRun({ runsDone: 2, runsTotal: 3, intervalMinutes: 60 }, now).done).toBe(true);
  });

  it('DCA ist nie preisgesteuert und braucht keine Preisprüfung beim Anlegen', () => {
    expect(evaluateSwapOrder({ kind: 'dca', triggerPriceUsd: null, trailPct: null, peakPriceUsd: null }, 1).trigger).toBe(false);
    expect(validateNewOrder({ kind: 'dca', triggerPriceUsd: null, trailPct: null, peakPriceUsd: null }, 1)).toBeNull();
  });
});

describe('validateNewOrder', () => {
  it('lehnt Orders ab, die sofort auslösen würden', () => {
    expect(validateNewOrder({ kind: 'take_profit', triggerPriceUsd: 0.9, trailPct: null, peakPriceUsd: null }, 1)).toMatch(/über dem aktuellen/);
    expect(validateNewOrder({ kind: 'stop_loss', triggerPriceUsd: 1.1, trailPct: null, peakPriceUsd: null }, 1)).toMatch(/unter dem aktuellen/);
    expect(validateNewOrder({ kind: 'limit_buy', triggerPriceUsd: 1, trailPct: null, peakPriceUsd: null }, 1)).toMatch(/unter dem aktuellen/);
    expect(validateNewOrder({ kind: 'trailing_stop', triggerPriceUsd: null, trailPct: 0.1, peakPriceUsd: null }, 1)).toMatch(/0,5 bis 90/);
    expect(validateNewOrder({ kind: 'take_profit', triggerPriceUsd: 1.5, trailPct: null, peakPriceUsd: null }, 1)).toBeNull();
  });
});

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let bonkUsd = 0.00002;
/** Wird während des Angebotsabrufs ausgeführt (Wettlauf nachstellen). */
let duringQuote: (() => Promise<void>) | null = null;
const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('jup.ag') && duringQuote) {
    const f = duringQuote;
    duringQuote = null;
    await f();
  }
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(addrs.map((a) => ({ chainId: 'solana', baseToken: { address: a, symbol: a === SOL_MINT ? 'SOL' : 'Bonk' }, priceUsd: String(a === SOL_MINT ? 150 : bonkUsd), liquidity: { usd: 1e8 } })));
  }
  if (u.includes('jup.ag')) {
    const q = new URL(u).searchParams;
    const amount = BigInt(q.get('amount')!);
    // Kurs folgt bonkUsd: BONK-Atome je Lamport = (150 / bonkUsd) / 1e4
    const perLamport = 150 / bonkUsd / 10_000;
    const out = q.get('inputMint') === SOL_MINT ? BigInt(Math.floor(Number(amount) * perLamport)) : BigInt(Math.floor(Number(amount) / perLamport));
    return json({ inAmount: amount.toString(), outAmount: out.toString(), priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Raydium' } }] });
  }
  const body = JSON.parse(String(init?.body)) as { method: string };
  if (body.method === 'getTokenSupply') return json({ jsonrpc: '2.0', id: 1, result: { value: { decimals: 5 } } });
  if (body.method === 'getAccountInfo') {
    return json({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null } } } } } });
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(!process.env.DATABASE_URL)('runSwapOrders (echte DB, Paper)', () => {
  let db: Db;
  let pool: pg.Pool;
  let walletId: string;
  let userId: string;
  const RUN = `${process.pid}-${Date.now()}`;

  async function addOrder(values: Partial<typeof schema.swapOrders.$inferInsert> & { kind: typeof schema.swapOrders.$inferInsert.kind }) {
    const [o] = await db.insert(schema.swapOrders).values({ walletId, token: BONK, symbol: 'Bonk', ...values }).returning();
    return o!;
  }
  const status = async (id: string) => (await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, id)))[0]!;

  beforeAll(async () => {
    setSwapFetchForTests(fakeNet);
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `swaporders-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [w] = await db
      .insert(schema.swapWallets)
      .values({ userId, chain: 'solana', label: 'Orders', address: `paper:${RUN}`, maxTradeUsd: '10000', maxSlippageBps: 500, maxPriceImpactPct: '5', minLiquidityUsd: '0', maxTokenTaxPct: '5' })
      .returning();
    walletId = w!.id;
    await fundPaperWallet(db, walletId, 'solana', '10', 150);
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Limit-Kauf löst erst unter dem Zielpreis aus und kauft zum echten Angebot', async () => {
    const o = await addOrder({ kind: 'limit_buy', triggerPriceUsd: '0.000015', buyAmount: '1' });
    bonkUsd = 0.000018;
    expect((await runSwapOrders(db)).triggered).toBe(0);
    expect((await status(o.id)).status).toBe('open');
    bonkUsd = 0.000015;
    const r = await runSwapOrders(db);
    expect(r).toMatchObject({ triggered: 1, filled: 1, failed: 0 });
    const done = await status(o.id);
    expect(done.status).toBe('filled');
    expect(done.tradeId).not.toBeNull();
    const bonk = (await walletBalances(db, walletId)).find((b) => b.token === BONK)!;
    expect(BigInt(bonk.amountAtomic)).toBeGreaterThan(0n);
  });

  it('Take-Profit + Stop-Loss (je 100 %): TP feuert, SL wird danach als gegenstandslos storniert (OCO)', async () => {
    const tp = await addOrder({ kind: 'take_profit', triggerPriceUsd: '0.00002', sellPercent: '100' });
    const sl = await addOrder({ kind: 'stop_loss', triggerPriceUsd: '0.00001', sellPercent: '100' });
    bonkUsd = 0.000021;
    const r = await runSwapOrders(db);
    expect(r).toMatchObject({ triggered: 1, filled: 1 });
    expect((await status(tp.id)).status).toBe('filled');
    expect(await status(sl.id)).toMatchObject({ status: 'cancelled', error: 'Bestand verkauft' });
    const trades = await db.select().from(schema.swapTrades).where(eq(schema.swapTrades.walletId, walletId));
    const sell = trades.find((t) => t.side === 'sell')!;
    expect(Number(sell.realizedPnlUsd)).toBeGreaterThan(0); // bei 0,000015 gekauft, bei 0,000021 verkauft
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.map((n) => n.title)).toContain('Take-Profit ausgeführt: Bonk');
  });

  it('Verkauf ohne Bestand → fehlgeschlagen mit Grund + Meldung, nie doppelt ausgeführt', async () => {
    const o = await addOrder({ kind: 'trailing_stop', trailPct: '10', sellPercent: '50', peakPriceUsd: '0.00003' });
    bonkUsd = 0.00002;
    const r = await runSwapOrders(db);
    expect(r).toMatchObject({ triggered: 1, failed: 1 });
    expect((await status(o.id)).error).toMatch(/Kein Bonk-Bestand/);
    expect((await runSwapOrders(db)).triggered).toBe(0);
  });

  it('hängende Ausführung (Absturz) wird nach 10 min als fehlgeschlagen markiert', async () => {
    const o = await addOrder({ kind: 'stop_loss', triggerPriceUsd: '0.000001', sellPercent: '100' });
    await db.execute(sql`UPDATE swap_orders SET status = 'executing', triggered_at = now() - interval '11 minutes' WHERE id = ${o.id}`);
    expect(await failStuckSwapOrders(db)).toBeGreaterThanOrEqual(1);
    expect((await status(o.id)).status).toBe('failed');
  });

  it('DCA: kauft je Termin genau einmal, überspringt über der Preisgrenze, endet nach dem letzten Termin', async () => {
    const t0 = new Date(Date.now() + 365 * 86_400_000); // weit in der Zukunft: unabhängig von anderen Läufen
    const o = await addOrder({ kind: 'dca', buyAmount: '0.5', intervalMinutes: 60, runsTotal: 3, nextRunAt: t0, maxPriceUsd: '0.00003' });
    const own = async () => (await db.select().from(schema.swapTrades).where(eq(schema.swapTrades.walletId, walletId))).filter((t) => t.side === 'buy').length;
    const before = await own();
    bonkUsd = 0.00002;

    // noch nicht fällig
    await runDcaOrders(db, new Date(t0.getTime() - 60_000));
    expect((await status(o.id)).runsDone).toBe(0);

    // Termin 1: Kauf
    await runDcaOrders(db, t0);
    let s1 = await status(o.id);
    expect(s1).toMatchObject({ status: 'open', runsDone: 1, error: null });
    expect(s1.nextRunAt!.getTime()).toBe(t0.getTime() + 3_600_000);
    expect(await own()).toBe(before + 1);
    // derselbe Zeitpunkt nochmal → nichts (nie doppelt)
    await runDcaOrders(db, t0);
    expect(await own()).toBe(before + 1);

    // Termin 2: Kurs über der Grenze → übersprungen, zählt aber
    bonkUsd = 0.00004;
    const t1 = new Date(t0.getTime() + 3_600_000);
    await runDcaOrders(db, t1);
    s1 = await status(o.id);
    expect(s1.runsDone).toBe(2);
    expect(s1.error).toMatch(/übersprungen.*Preisgrenze/);
    expect(await own()).toBe(before + 1);

    // Termin 3: wieder günstig → Kauf, DCA fertig
    bonkUsd = 0.00002;
    await runDcaOrders(db, new Date(t1.getTime() + 3_600_000));
    expect(await status(o.id)).toMatchObject({ status: 'filled', runsDone: 3, error: null });
    expect(await own()).toBe(before + 2);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['DCA-Kauf 1/3: Bonk', 'DCA-Kauf 3/3: Bonk']));
  });

  it('DCA erscheint nie im preisgesteuerten Lauf', async () => {
    const o = await addOrder({ kind: 'dca', buyAmount: '0.1', intervalMinutes: 60, runsTotal: 2, nextRunAt: new Date(Date.now() + 400 * 86_400_000) });
    await runSwapOrders(db);
    expect(await status(o.id)).toMatchObject({ status: 'open', runsDone: 0 });
    await db.update(schema.swapOrders).set({ status: 'cancelled' }).where(eq(schema.swapOrders.id, o.id));
  });

  it('DCA wird nie wiederbelebt: während des Kaufs gestoppt → bleibt gestoppt, Zähler stimmt', async () => {
    const t0 = new Date(Date.now() + 500 * 86_400_000);
    const o = await addOrder({ kind: 'dca', buyAmount: '0.1', intervalMinutes: 60, runsTotal: 5, nextRunAt: t0 });
    bonkUsd = 0.00002;
    // Freigabe zurückziehen, während die DCA gerade kauft (status executing)
    duringQuote = async () => {
      await db.update(schema.swapOrders).set({ status: 'cancelled', closedAt: new Date(), error: 'Live-Freigabe zurückgezogen' }).where(stoppableOrders(walletId));
    };
    await runDcaOrders(db, t0);
    expect(await status(o.id)).toMatchObject({ status: 'cancelled', runsDone: 1, error: 'Live-Freigabe zurückgezogen' });
    // nächster Termin: nichts passiert mehr
    await runDcaOrders(db, new Date(t0.getTime() + 3_600_000));
    expect((await status(o.id)).runsDone).toBe(1);
  });

  it('Take-Profit verkauft alles → laufende DCA auf denselben Token bleibt bestehen (nur Verkaufs-Orders storniert)', async () => {
    const t0 = new Date(Date.now() + 600 * 86_400_000);
    const dca = await addOrder({ kind: 'dca', buyAmount: '0.1', intervalMinutes: 60, runsTotal: 3, nextRunAt: t0 });
    bonkUsd = 0.00002;
    await runDcaOrders(db, t0); // Bestand aufbauen
    const sl = await addOrder({ kind: 'stop_loss', triggerPriceUsd: '0.000001', sellPercent: '100' });
    await addOrder({ kind: 'take_profit', triggerPriceUsd: '0.000025', sellPercent: '100' });
    bonkUsd = 0.00003;
    expect((await runSwapOrders(db)).filled).toBeGreaterThanOrEqual(1);
    expect(await status(sl.id)).toMatchObject({ status: 'cancelled', error: 'Bestand verkauft' });
    expect(await status(dca.id)).toMatchObject({ status: 'open', runsDone: 1 });
    await db.update(schema.swapOrders).set({ status: 'cancelled' }).where(eq(schema.swapOrders.id, dca.id));
  });
});
