/**
 * Eigene Trading-Wallet (Vision-Punkt 5c) gegen die ECHTE DB: Betreiber-Schalter,
 * Schlüssel nur verschlüsselt + einmalig sichtbar, Freigabe je Wallet,
 * Bestätigung je Swap, Verbuchung + Audit + Benachrichtigung, Entfernen löscht
 * den Schlüssel. Netz (DexScreener, RPC, Jupiter) injiziert; die Ausführung ist
 * durch einen Test-Executor ersetzt — es wird nie etwas gesendet.
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { decryptSecret, importWalletKey, SOL_MINT } from '@gladiator/exchange';
import type pg from 'pg';
import { appRouter } from './index.js';
import { setLiveSwapExecutorForTests, setSwapFetchForTests } from './swaps.js';
import { executePreparedSwap, prepareSwap, resolvePendingSwaps } from '@gladiator/jobs';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `swaplive-${RUN}@test.invalid`;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const LIMITS = { maxTradeUsd: 1_000, maxSlippageBps: 300, maxPriceImpactPct: 5, minLiquidityUsd: 0, maxTokenTaxPct: 5 };

/** Kette: 3 SOL Guthaben; nach dem Kauf hält die Wallet BONK. */
let chainBonk = 0n;
let chainLamports = 3_000_000_000n;
/** manipuliertes Angebot: Aggregator behauptet 10 % des fairen Ergebnisses bei „0,1 % Preis-Einfluss“ */
let rugQuote = false;
/** Antwort der Kette auf getSignatureStatuses (Klärung „Ausgang unklar“) */
let sigStatus: unknown = null;
const fakeNet = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (u.includes('dexscreener')) {
    const addrs = u.split('/').pop()!.split(',');
    return json(addrs.map((a) => ({ chainId: 'solana', baseToken: { address: a, symbol: a === SOL_MINT ? 'SOL' : 'Bonk' }, priceUsd: a === SOL_MINT ? '150' : '0.00002', liquidity: { usd: 1e7 } })));
  }
  if (u.includes('jup.ag')) {
    const q = new URL(u).searchParams;
    const amount = BigInt(q.get('amount')!);
    // 1 Lamport = 750 BONK-Atome (0,00002 $ bei 150 $/SOL), in beide Richtungen
    const fair = q.get('inputMint') === SOL_MINT ? amount * 750n : amount / 750n;
    const out = rugQuote ? fair / 10n : fair;
    return json({ inAmount: amount.toString(), outAmount: out.toString(), priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Raydium' } }] });
  }
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const ok = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
  if (body.method === 'getTokenSupply') return ok({ value: { decimals: 5 } });
  if (body.method === 'getAccountInfo') {
    return ok({ value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null } } } } });
  }
  if (body.method === 'getBalance') return ok({ value: Number(chainLamports) });
  if (body.method === 'getSignatureStatuses') return ok({ value: [sigStatus] });
  if (body.method === 'getTokenAccountsByOwner') {
    return ok({ value: chainBonk > 0n ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: chainBonk.toString() } } } } } }] : [] });
  }
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(!hasDb)('Eigene Trading-Wallet (live)', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let userId: string;
  let walletId: string;
  let secretOnce: string;
  const executed: { address: string; secret: string; inAtomic: string }[] = [];
  let nextStatus: 'filled' | 'failed' | 'pending' = 'filled';
  let liveOrderId = '';
  const savedFlag = process.env.WALLET_KEYS_ENABLED;
  const savedKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    setSwapFetchForTests(fakeNet);
    setLiveSwapExecutorForTests(async (p) => {
      executed.push({ address: p.address, secret: p.secret, inAtomic: p.quote.inAtomic });
      if (nextStatus === 'filled') {
        chainLamports -= BigInt(p.quote.inAtomic) + 5_000n;
        chainBonk += BigInt(p.quote.outAtomic);
        return { txHash: `tx-${executed.length}`, status: 'filled', error: null, approvalTx: null };
      }
      if (nextStatus === 'pending') return { txHash: `tx-${executed.length}`, status: 'pending', error: 'Gesendet, Ausgang unklar — bitte NICHT erneut ausführen; Status im Explorer prüfen.', approvalTx: null };
      return { txHash: `tx-${executed.length}`, status: 'failed', error: 'On-chain fehlgeschlagen: Slippage', approvalTx: null };
    });
    ({ db, pool } = createDb());
    const r = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'L' });
    userId = r.user.id;
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${r.accessToken}`, ip: '127.0.0.1' }));
  });

  afterAll(async () => {
    setSwapFetchForTests(null);
    setLiveSwapExecutorForTests(null);
    if (savedFlag === undefined) delete process.env.WALLET_KEYS_ENABLED;
    else process.env.WALLET_KEYS_ENABLED = savedFlag;
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${EMAIL}`);
    await pool.end();
  });

  it('ohne Betreiber-Schalter: keine Schlüssel-Annahme', async () => {
    delete process.env.WALLET_KEYS_ENABLED;
    await expect(a.swaps.createLiveWallet({ chain: 'solana', label: 'X', source: 'generate', limits: LIMITS })).rejects.toThrow(/WALLET_KEYS_ENABLED/);
  });

  it('neue Wallet: Schlüssel genau einmal sichtbar, gespeichert nur verschlüsselt, Audit ohne Schlüssel', async () => {
    process.env.WALLET_KEYS_ENABLED = '1';
    const r = await a.swaps.createLiveWallet({ chain: 'solana', label: 'Trojan', source: 'generate', limits: LIMITS });
    walletId = r.wallet.id;
    secretOnce = r.secretOnce!;
    expect(r.wallet).toMatchObject({ mode: 'live', liveApproved: false });
    expect(importWalletKey('solana', secretOnce).address).toBe(r.wallet.address);

    const [row] = await db.select().from(schema.swapWallets).where(eq(schema.swapWallets.id, walletId));
    expect(row!.encryptedKey).not.toContain(secretOnce);
    expect(decryptSecret(row!.encryptedKey!)).toBe(secretOnce);
    expect(JSON.stringify(await a.swaps.wallets())).not.toContain(secretOnce);

    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.action, 'swap.live_wallet_create')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toContain(secretOnce);
  });

  it('Import: kaputter Schlüssel abgelehnt, dieselbe Wallet nicht doppelt', async () => {
    await expect(a.swaps.createLiveWallet({ chain: 'solana', label: 'Y', source: 'import', secret: 'x'.repeat(40), limits: LIMITS })).rejects.toThrow();
    await expect(a.swaps.createLiveWallet({ chain: 'solana', label: 'Y', source: 'import', secret: secretOnce, limits: LIMITS })).rejects.toThrow(/bereits verbunden/);
  });

  it('Bestände kommen von der Kette', async () => {
    const pf = await a.swaps.portfolio({ walletId });
    expect(pf.chainOk).toBe(true);
    expect(pf.holdings.find((h) => h.native)).toMatchObject({ symbol: 'SOL', amount: '3' });
  });

  it('ohne Freigabe kein Live-Swap; falsches Bestätigungswort zählt nicht', async () => {
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '1', confirmLive: true })).rejects.toThrow(/nicht für Live-Swaps freigegeben/);
    // @ts-expect-error — nur das exakte Wort ist erlaubt
    await expect(a.swaps.approveLive({ walletId, confirm: 'ja' })).rejects.toThrow();
    expect(executed).toHaveLength(0);
  });

  it('nach Freigabe: ohne Bestätigung dieses Swaps nichts; mit Bestätigung ausgeführt + verbucht + gemeldet', async () => {
    expect((await a.swaps.approveLive({ walletId, confirm: 'FREIGEBEN' })).liveApproved).toBe(true);
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '1' })).rejects.toThrow(/ausdrücklich bestätigen/);
    expect(executed).toHaveLength(0);

    const r = await a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '1', confirmLive: true });
    expect(r.trade.txHash).toBe('tx-1');
    expect(executed[0]).toMatchObject({ secret: secretOnce, inAtomic: '1000000000' });

    const pf = await a.swaps.portfolio({ walletId });
    expect(pf.trades[0]).toMatchObject({ mode: 'live', status: 'filled', txHash: 'tx-1', side: 'buy' });
    expect(pf.holdings.find((h) => h.symbol === 'Bonk')?.amount).toBe(String(750_000_000_000n / 100_000n));
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.some((n) => n.title === 'Kauf ausgeführt: Bonk')).toBe(true);
  });

  it('Live-Order: nur mit ausdrücklicher Bestätigung; Freigabe zurückziehen storniert offene Orders', async () => {
    await expect(a.swaps.createOrder({ walletId, token: BONK, kind: 'take_profit', triggerPriceUsd: 0.0001, sellPercent: 50 })).rejects.toThrow(/ausdrücklich bestätigen/);
    const o = await a.swaps.createOrder({ walletId, token: BONK, kind: 'take_profit', triggerPriceUsd: 0.0001, sellPercent: 50, confirmLive: true });
    const [row] = await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, o.id));
    expect(row!.confirmedLive).toBe(true);
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.action, 'swap.live_order_create')));
    expect(audit).toHaveLength(1);
    liveOrderId = o.id;
  });

  it('manipuliertes Angebot (viel zu wenig heraus, Aggregator meldet kaum Preis-Einfluss) → unabhängig erkannt, nichts gesendet', async () => {
    rugQuote = true;
    try {
      await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '1', confirmLive: true })).rejects.toThrow(/price_impact_above_limit|Preis-Einfluss/);
      expect(executed).toHaveLength(1);
    } finally {
      rugQuote = false;
    }
  });

  it('mehr als das Guthaben → abgelehnt, bevor etwas gebaut wird', async () => {
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '5', confirmLive: true })).rejects.toThrow(/Guthaben reicht nicht/);
    expect(executed).toHaveLength(1);
  });

  it('on-chain fehlgeschlagen → als failed verbucht, Meldung, Fehler an die Oberfläche', async () => {
    nextStatus = 'failed';
    await expect(a.swaps.execute({ walletId, side: 'sell', token: BONK, percent: 50, confirmLive: true })).rejects.toThrow(/Slippage/);
    const pf = await a.swaps.portfolio({ walletId });
    expect(pf.trades[0]).toMatchObject({ status: 'failed', txHash: 'tx-2' });
    nextStatus = 'filled';
  });

  it('Wettlauf: Freigabe zwischen Angebot und Signatur entzogen bzw. Order gestoppt → nichts gesendet', async () => {
    const [stale] = await db.select().from(schema.swapWallets).where(eq(schema.swapWallets.id, walletId));
    const sent = executed.length;
    const p = await prepareSwap(db, stale!, { side: 'buy', token: BONK, amount: '0.1' });
    // Order (noch „open“, nicht „executing“) → als gestoppt behandelt
    await expect(executePreparedSwap(db, p, 'buy', { userId, ip: null, actor: 'system', confirmedLive: true, orderId: liveOrderId })).rejects.toThrow(/gestoppt/);
    // Freigabe inzwischen entzogen, der mitgegebene Wallet-Datensatz ist aber noch alt
    await db.update(schema.swapWallets).set({ liveApprovedAt: null }).where(eq(schema.swapWallets.id, walletId));
    await expect(executePreparedSwap(db, p, 'buy', { userId, ip: null, actor: 'user', confirmedLive: true })).rejects.toThrow(/nicht für Live-Swaps freigegeben/);
    expect(executed.length).toBe(sent);
    await db.update(schema.swapWallets).set({ liveApprovedAt: stale!.liveApprovedAt }).where(eq(schema.swapWallets.id, walletId));
  });

  it('Order aus einer FRÜHEREN Live-Freigabe (zurückgezogen + neu erteilt) läuft nie', async () => {
    const [w] = await db.select().from(schema.swapWallets).where(eq(schema.swapWallets.id, walletId));
    const [old] = await db
      .insert(schema.swapOrders)
      .values({ walletId, token: BONK, symbol: 'Bonk', kind: 'take_profit', triggerPriceUsd: '0.0001', sellPercent: '50', confirmedLive: true, status: 'executing', createdAt: new Date(w!.liveApprovedAt!.getTime() - 60_000) })
      .returning();
    const sent = executed.length;
    const p = await prepareSwap(db, w!, { side: 'sell', token: BONK, percent: 10 });
    await expect(executePreparedSwap(db, p, 'sell', { userId, ip: null, actor: 'system', confirmedLive: true, orderId: old!.id })).rejects.toThrow(/früheren Live-Freigabe/);
    expect(executed.length).toBe(sent);
    await db.update(schema.swapOrders).set({ status: 'cancelled' }).where(eq(schema.swapOrders.id, old!.id));
  });

  it('gesendet, Ausgang unklar → als „pending“ mit Tx verbucht, deutliche Warnung (nicht erneut kaufen)', async () => {
    nextStatus = 'pending';
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1', confirmLive: true })).rejects.toThrow(/NICHT erneut/);
    nextStatus = 'filled';
    const pf = await a.swaps.portfolio({ walletId });
    expect(pf.trades[0]).toMatchObject({ status: 'pending' });
    expect(pf.trades[0]!.txHash).toMatch(/^tx-/);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.some((n) => /Ausgang unklar/.test(n.title))).toBe(true);
  });

  it('„Ausgang unklar“ wird gegen die Kette geklärt: gelandet → verbucht wie ausgeführt; nie gelandet → fehlgeschlagen; ohne Aussage bleibt es offen', async () => {
    const pendingTrade = async () => (await a.swaps.portfolio({ walletId })).trades.find((t) => t.status === 'pending');
    const tx = (await pendingTrade())!;
    const bonkBefore = chainBonk;
    // Kette weiß noch nichts → bleibt offen (nie raten)
    sigStatus = null;
    expect(await resolvePendingSwaps(db, { walletId })).toMatchObject({ checked: 1, filled: 0, failed: 0 });
    expect((await pendingTrade())?.id).toBe(tx.id);

    // Swap ist doch gelandet: Kette zeigt die neuen Bestände
    chainLamports -= 100_000_000n + 5_000n;
    chainBonk += 75_000_000_000n;
    sigStatus = { confirmationStatus: 'finalized', err: null };
    expect(await resolvePendingSwaps(db, { walletId })).toMatchObject({ filled: 1 });
    const pf = await a.swaps.portfolio({ walletId });
    const resolved = pf.trades.find((t) => t.id === tx.id)!;
    expect(resolved).toMatchObject({ status: 'filled' });
    expect(Number(resolved.valueUsd)).toBeCloseTo(15, 6); // 0,1 SOL × 150 $
    expect(Number(pf.holdings.find((h) => h.symbol === 'Bonk')?.amount)).toBeCloseTo(Number(bonkBefore + 75_000_000_000n) / 1e5, 5);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    expect(notes.some((n) => n.title === 'Kauf doch ausgeführt: Bonk')).toBe(true);
    // zweiter Lauf ändert nichts mehr
    expect(await resolvePendingSwaps(db, { walletId })).toMatchObject({ checked: 0 });

    // neuer unklarer Swap, der nie in einen Block kam
    nextStatus = 'pending';
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1', confirmLive: true })).rejects.toThrow(/NICHT erneut/);
    nextStatus = 'filled';
    sigStatus = null;
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await resolvePendingSwaps(db, { walletId, now: later })).toMatchObject({ failed: 1 });
    expect((await a.swaps.portfolio({ walletId })).trades[0]).toMatchObject({ status: 'failed' });
    expect(chainBonk).toBe(bonkBefore + 75_000_000_000n);
  });

  it('Freigabe zurückziehen sperrt sofort (Preisalarme bleiben); Entfernen löscht den Schlüssel erst nach Bestätigung', async () => {
    const alarm = await a.swaps.createOrder({ walletId, token: BONK, kind: 'alert_above', triggerPriceUsd: 0.0001 });
    await a.swaps.revokeLive({ walletId });
    const [order] = await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, liveOrderId));
    expect(order).toMatchObject({ status: 'cancelled', error: 'Live-Freigabe zurückgezogen' });
    const [alarmRow] = await db.select().from(schema.swapOrders).where(eq(schema.swapOrders.id, alarm.id));
    expect(alarmRow!.status).toBe('open');
    await expect(a.swaps.execute({ walletId, side: 'buy', token: BONK, amount: '0.1', confirmLive: true })).rejects.toThrow(/nicht für Live-Swaps freigegeben/);
    await expect(a.swaps.archiveWallet({ walletId })).rejects.toThrow(/Schlüssel gesichert/);
    await a.swaps.archiveWallet({ walletId, confirmKeyBackedUp: true });
    const [row] = await db.select().from(schema.swapWallets).where(eq(schema.swapWallets.id, walletId));
    expect(row).toMatchObject({ encryptedKey: null, liveApprovedAt: null });
    expect(row!.archivedAt).not.toBeNull();
  });
});
