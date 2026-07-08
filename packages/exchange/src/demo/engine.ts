import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  DEMO_MAKER_FEE,
  DEMO_TAKER_FEE,
  addToPosition,
  availableBalance,
  checkTrigger,
  computeCloseNumbers,
  midPrice,
  restingLimitFill,
  roundToStep,
  simulateLimitPlacement,
  simulateMarketFill,
  type FillResult,
} from './fill-engine.js';
import type { DemoBookSource } from './book-source.js';

const { demoAccounts, demoOrders, demoPositions, demoTrades, auditLog } = schema;

/**
 * Demo-Trading-Engine (Session 5): schreibt AUSSCHLIESSLICH demo_*-Tabellen.
 * Dieses Modul importiert bewusst kein TradingVenue und kennt keinen
 * placeOrder-Pfad — der Demo-Modus kann bauartbedingt keine echten Orders
 * auslösen. Preise/Orderbücher sind IMMER echt (DemoBookSource); nur die
 * Ausführung ist simuliert (fill-engine.ts, deterministisch).
 */

type DemoAccount = typeof demoAccounts.$inferSelect;
type DemoPosition = typeof demoPositions.$inferSelect;
type DemoOrder = typeof demoOrders.$inferSelect;

const EPS = 1e-9;

export async function getOrCreateDemoAccount(db: Db, userId: string): Promise<DemoAccount> {
  const [existing] = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(demoAccounts).values({ userId }).onConflictDoNothing().returning();
  if (created) return created;
  const [raced] = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, userId)).limit(1);
  return raced!;
}

/** Offene (ganz oder teilweise ungefüllte) Demo-Orders eines Kontos. */
async function openOrders(db: Db, accountId: string): Promise<DemoOrder[]> {
  return db
    .select()
    .from(demoOrders)
    .where(and(eq(demoOrders.accountId, accountId), inArray(demoOrders.status, ['open', 'partially_filled'])));
}

/** Durch ruhende Entry-Orders gebundene Notional (Rest-Menge × Limit). */
function restingEntryNotional(orders: DemoOrder[]): number {
  return orders
    .filter((o) => !o.reduceOnly && o.type === 'limit' && o.limitPrice !== null)
    .reduce((a, o) => a + (Number(o.qty) - Number(o.filledQty)) * Number(o.limitPrice), 0);
}

function positionsNotional(positions: DemoPosition[]): number {
  return positions.reduce((a, p) => a + Number(p.qty) * Number(p.entryPrice), 0);
}

/**
 * Konto-Übersicht mit echten Mark-Preisen (Buch-Mid je Symbol; nicht
 * erreichbare Symbole ehrlich null — deren uPnL fehlt dann sichtbar).
 */
export async function demoAccountOverview(db: Db, source: DemoBookSource, userId: string) {
  const account = await getOrCreateDemoAccount(db, userId);
  const positions = await db.select().from(demoPositions).where(eq(demoPositions.accountId, account.id));
  const resting = await openOrders(db, account.id);

  const marks = new Map<string, number | null>();
  for (const symbol of new Set(positions.map((p) => p.symbol))) {
    try {
      marks.set(symbol, midPrice(await source.fetchBook(symbol)));
    } catch {
      marks.set(symbol, null);
    }
  }

  let unrealizedPnl = 0;
  let markMissing = false;
  for (const p of positions) {
    const mark = marks.get(p.symbol) ?? null;
    if (mark === null) {
      markMissing = true;
      continue;
    }
    const sign = p.direction === 'long' ? 1 : -1;
    unrealizedPnl += (mark - Number(p.entryPrice)) * Number(p.qty) * sign;
  }

  const balance = Number(account.balance);
  return {
    startBalance: Number(account.startBalance),
    balance,
    equity: balance + unrealizedPnl,
    unrealizedPnl,
    /** true = mind. ein Positions-Preis fehlt gerade → Equity unvollständig. */
    markIncomplete: markMissing,
    available: availableBalance(balance, positionsNotional(positions), restingEntryNotional(resting)),
    openPositions: positions.length,
    openOrders: resting.length,
    resetCount: account.resetCount,
    resetAt: account.resetAt?.toISOString() ?? null,
    feeRates: { maker: DEMO_MAKER_FEE, taker: DEMO_TAKER_FEE },
  };
}

export type PlaceDemoOrderInput = {
  symbol: string;
  direction: 'long' | 'short';
  type: 'market' | 'limit';
  qty: number;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
};

type Rejection = { ok: false; reason: string };

/**
 * Gemeinsame Validierung für Vorschau + Platzierung: Marktregeln (Lot/Tick/
 * Min-Notional), SL/TP-Plausibilität, verfügbares Guthaben.
 */
async function validateDemoOrder(
  db: Db,
  source: DemoBookSource,
  account: DemoAccount,
  input: PlaceDemoOrderInput,
): Promise<
  | Rejection
  | {
      ok: true;
      qty: number;
      limitPrice?: number;
      book: Awaited<ReturnType<DemoBookSource['fetchBook']>>;
      estNotional: number;
      available: number;
    }
> {
  let rules;
  try {
    rules = await source.marketRules(input.symbol);
  } catch {
    return { ok: false, reason: 'unknown_symbol' };
  }
  let book;
  try {
    book = await source.fetchBook(input.symbol);
  } catch {
    return { ok: false, reason: 'no_orderbook' };
  }

  const qty = roundToStep(input.qty, rules.lotSize);
  if (qty <= 0) return { ok: false, reason: 'qty_below_lot' };

  let limitPrice: number | undefined;
  if (input.type === 'limit') {
    if (input.limitPrice === undefined || input.limitPrice <= 0) return { ok: false, reason: 'limit_price_required' };
    limitPrice = roundToStep(input.limitPrice, rules.tickSize);
    if (limitPrice <= 0) return { ok: false, reason: 'limit_price_required' };
  }

  const mid = midPrice(book);
  const refPrice = limitPrice ?? mid;
  if (refPrice === null || refPrice === undefined) return { ok: false, reason: 'no_orderbook' };

  const estNotional = qty * refPrice;
  if (estNotional < rules.minNotional) return { ok: false, reason: 'below_min_notional' };

  // SL/TP-Plausibilität relativ zum Referenzpreis (long: SL darunter, TP darüber)
  const sign = input.direction === 'long' ? 1 : -1;
  if (input.stopLoss !== undefined && (refPrice - input.stopLoss) * sign <= 0) {
    return { ok: false, reason: 'invalid_stop' };
  }
  if (input.takeProfit !== undefined && (input.takeProfit - refPrice) * sign <= 0) {
    return { ok: false, reason: 'invalid_take_profit' };
  }

  const positions = await db.select().from(demoPositions).where(eq(demoPositions.accountId, account.id));
  const resting = await openOrders(db, account.id);
  const available = availableBalance(Number(account.balance), positionsNotional(positions), restingEntryNotional(resting));
  const feeRate = input.type === 'market' ? DEMO_TAKER_FEE : DEMO_MAKER_FEE;
  if (estNotional * (1 + feeRate) > available + EPS) return { ok: false, reason: 'insufficient_balance' };

  return { ok: true, qty, limitPrice, book, estNotional, available };
}

/** Kosten-Vorschau aus dem ECHTEN Buch — gleicher Validierungspfad wie die Order. */
export async function previewDemoOrder(db: Db, source: DemoBookSource, userId: string, input: PlaceDemoOrderInput) {
  const account = await getOrCreateDemoAccount(db, userId);
  const v = await validateDemoOrder(db, source, account, input);
  if (!v.ok) return { ok: false as const, reason: v.reason };

  const side: 'buy' | 'sell' = input.direction === 'long' ? 'buy' : 'sell';
  const mid = midPrice(v.book);
  const bestBid = v.book.bids[0]?.price ?? null;
  const bestAsk = v.book.asks[0]?.price ?? null;

  let est: FillResult | null;
  let restingQty = 0;
  if (input.type === 'market') {
    est = simulateMarketFill(v.book, side, v.qty);
  } else {
    const r = simulateLimitPlacement(v.book, side, v.qty, v.limitPrice!);
    est = r.fill;
    restingQty = r.restingQty;
  }

  return {
    ok: true as const,
    qty: v.qty,
    limitPrice: v.limitPrice ?? null,
    mid,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    estFillPrice: est?.avgPrice ?? null,
    estFilledQty: est?.filledQty ?? 0,
    estRestingQty: restingQty,
    estFee: est?.fee ?? 0,
    estFeeRole: est?.feeRole ?? (input.type === 'limit' ? ('maker' as const) : ('taker' as const)),
    estSlippage: est?.slippageVsMid ?? 0,
    estNotional: est?.notional ?? v.estNotional,
    available: v.available,
  };
}

/** Entry-Fill auf Konto + Position anwenden (Fee sofort, Entry volumengewichtet). */
async function applyEntryFill(
  db: Db,
  account: DemoAccount,
  input: { symbol: string; direction: 'long' | 'short'; stopLoss?: number; takeProfit?: number },
  fill: FillResult,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(demoPositions)
    .where(
      and(
        eq(demoPositions.accountId, account.id),
        eq(demoPositions.symbol, input.symbol),
        eq(demoPositions.direction, input.direction),
      ),
    )
    .limit(1);

  if (existing) {
    const merged = addToPosition(
      { qty: Number(existing.qty), entryPrice: Number(existing.entryPrice) },
      { qty: fill.filledQty, price: fill.avgPrice },
    );
    await db
      .update(demoPositions)
      .set({
        qty: String(merged.qty),
        entryPrice: String(merged.entryPrice),
        entryFee: String(Number(existing.entryFee) + fill.fee),
        entrySlippage: String(Number(existing.entrySlippage) + fill.slippageVsMid),
        stopLoss: input.stopLoss !== undefined ? String(input.stopLoss) : existing.stopLoss,
        takeProfit: input.takeProfit !== undefined ? String(input.takeProfit) : existing.takeProfit,
        updatedAt: new Date(),
      })
      .where(eq(demoPositions.id, existing.id));
  } else {
    await db.insert(demoPositions).values({
      userId: account.userId,
      accountId: account.id,
      symbol: input.symbol,
      direction: input.direction,
      qty: String(fill.filledQty),
      entryPrice: String(fill.avgPrice),
      entryFee: String(fill.fee),
      entrySlippage: String(fill.slippageVsMid),
      stopLoss: input.stopLoss !== undefined ? String(input.stopLoss) : null,
      takeProfit: input.takeProfit !== undefined ? String(input.takeProfit) : null,
    });
  }

  await db
    .update(demoAccounts)
    .set({ balance: String(Number(account.balance) - fill.fee) })
    .where(eq(demoAccounts.id, account.id));
  account.balance = String(Number(account.balance) - fill.fee);
}

export type PlaceDemoOrderResult =
  | { placed: false; reason: string }
  | {
      placed: true;
      orderId: string;
      status: 'filled' | 'open' | 'partially_filled';
      filledQty: number;
      avgFillPrice: number | null;
      fee: number;
      slippage: number;
      restingQty: number;
    };

export async function placeDemoOrder(
  db: Db,
  source: DemoBookSource,
  userId: string,
  input: PlaceDemoOrderInput,
): Promise<PlaceDemoOrderResult> {
  const account = await getOrCreateDemoAccount(db, userId);
  const v = await validateDemoOrder(db, source, account, input);
  if (!v.ok) return { placed: false, reason: v.reason };

  const side: 'buy' | 'sell' = input.direction === 'long' ? 'buy' : 'sell';

  if (input.type === 'market') {
    const fill = simulateMarketFill(v.book, side, v.qty);
    if (!fill) return { placed: false, reason: 'no_orderbook' };
    await applyEntryFill(db, account, input, fill);
    const partial = fill.filledQty < v.qty - EPS;
    const [row] = await db
      .insert(demoOrders)
      .values({
        userId,
        accountId: account.id,
        symbol: input.symbol,
        type: 'market',
        side,
        qty: String(v.qty),
        filledQty: String(fill.filledQty),
        avgFillPrice: String(fill.avgPrice),
        feePaid: String(fill.fee),
        slippagePaid: String(fill.slippageVsMid),
        status: 'filled',
        note: partial ? 'partial_book_depth' : null,
      })
      .returning();
    return {
      placed: true,
      orderId: row!.id,
      status: 'filled',
      filledQty: fill.filledQty,
      avgFillPrice: fill.avgPrice,
      fee: fill.fee,
      slippage: fill.slippageVsMid,
      restingQty: 0,
    };
  }

  // Limit: sofortiger Taker-Anteil (falls das Buch kreuzt) + ruhender Rest
  const r = simulateLimitPlacement(v.book, side, v.qty, v.limitPrice!);
  if (r.fill) await applyEntryFill(db, account, input, r.fill);
  const status: 'filled' | 'open' | 'partially_filled' =
    r.restingQty <= EPS ? 'filled' : r.fill ? 'partially_filled' : 'open';
  const [row] = await db
    .insert(demoOrders)
    .values({
      userId,
      accountId: account.id,
      symbol: input.symbol,
      type: 'limit',
      side,
      qty: String(v.qty),
      filledQty: String(r.fill?.filledQty ?? 0),
      limitPrice: String(v.limitPrice),
      avgFillPrice: r.fill ? String(r.fill.avgPrice) : null,
      feePaid: String(r.fill?.fee ?? 0),
      slippagePaid: String(r.fill?.slippageVsMid ?? 0),
      status,
      // SL/TP der ruhenden Order: beim späteren Fill an die Position anheften
      note:
        input.stopLoss !== undefined || input.takeProfit !== undefined
          ? JSON.stringify({ stopLoss: input.stopLoss ?? null, takeProfit: input.takeProfit ?? null })
          : null,
    })
    .returning();
  return {
    placed: true,
    orderId: row!.id,
    status,
    filledQty: r.fill?.filledQty ?? 0,
    avgFillPrice: r.fill?.avgPrice ?? null,
    fee: r.fill?.fee ?? 0,
    slippage: r.fill?.slippageVsMid ?? 0,
    restingQty: r.restingQty,
  };
}

export async function cancelDemoOrder(db: Db, userId: string, orderId: string): Promise<boolean> {
  const [row] = await db
    .update(demoOrders)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(
      and(
        eq(demoOrders.id, orderId),
        eq(demoOrders.userId, userId),
        inArray(demoOrders.status, ['open', 'partially_filled']),
      ),
    )
    .returning();
  return Boolean(row);
}

/** SL/TP einer offenen Position setzen/ändern/löschen (null = entfernen). */
export async function setDemoProtection(
  db: Db,
  source: DemoBookSource,
  userId: string,
  positionId: string,
  input: { stopLoss?: number | null; takeProfit?: number | null },
): Promise<{ ok: boolean; reason?: string }> {
  const [pos] = await db
    .select()
    .from(demoPositions)
    .where(and(eq(demoPositions.id, positionId), eq(demoPositions.userId, userId)))
    .limit(1);
  if (!pos) return { ok: false, reason: 'not_found' };

  let mark: number | null = null;
  try {
    mark = midPrice(await source.fetchBook(pos.symbol));
  } catch {
    return { ok: false, reason: 'no_orderbook' };
  }
  if (mark === null) return { ok: false, reason: 'no_orderbook' };

  const sign = pos.direction === 'long' ? 1 : -1;
  if (typeof input.stopLoss === 'number' && (mark - input.stopLoss) * sign <= 0) {
    return { ok: false, reason: 'invalid_stop' };
  }
  if (typeof input.takeProfit === 'number' && (input.takeProfit - mark) * sign <= 0) {
    return { ok: false, reason: 'invalid_take_profit' };
  }

  await db
    .update(demoPositions)
    .set({
      stopLoss: input.stopLoss === undefined ? pos.stopLoss : input.stopLoss === null ? null : String(input.stopLoss),
      takeProfit:
        input.takeProfit === undefined ? pos.takeProfit : input.takeProfit === null ? null : String(input.takeProfit),
      updatedAt: new Date(),
    })
    .where(eq(demoPositions.id, pos.id));
  return { ok: true };
}

/**
 * Position (teilweise) zum ECHTEN Buch schließen: Taker-Fill, Netto-Trade
 * schreiben (Fees anteilig, Funding über Haltezeit), Balance realisieren.
 */
export async function closeDemoPositionNow(
  db: Db,
  source: DemoBookSource,
  userId: string,
  positionId: string,
  opts: { qty?: number; reason?: 'sl' | 'tp' | 'manual' } = {},
): Promise<{ closed: boolean; reason?: string; exitPrice?: number; closedQty?: number; netPnl?: number }> {
  const [pos] = await db
    .select()
    .from(demoPositions)
    .where(and(eq(demoPositions.id, positionId), eq(demoPositions.userId, userId)))
    .limit(1);
  if (!pos) return { closed: false, reason: 'not_found' };

  let book;
  try {
    book = await source.fetchBook(pos.symbol);
  } catch {
    return { closed: false, reason: 'no_orderbook' };
  }

  const posQty = Number(pos.qty);
  const requested = Math.min(opts.qty ?? posQty, posQty);
  if (requested <= 0) return { closed: false, reason: 'qty_below_lot' };

  const closeSide: 'buy' | 'sell' = pos.direction === 'long' ? 'sell' : 'buy';
  const fill = simulateMarketFill(book, closeSide, requested);
  if (!fill) return { closed: false, reason: 'no_orderbook' };

  const fraction = fill.filledQty / posQty;
  const entryFeeShare = Number(pos.entryFee) * fraction;
  const entrySlippageShare = Number(pos.entrySlippage) * fraction;
  const hoursHeld = Math.max(0, (Date.now() - pos.openedAt.getTime()) / 3_600_000);
  const n = computeCloseNumbers({
    direction: pos.direction,
    qty: fill.filledQty,
    entryPrice: Number(pos.entryPrice),
    exitPrice: fill.avgPrice,
    entryFee: entryFeeShare,
    exitFee: fill.fee,
    hoursHeld,
  });

  // R-Multiple nur, wenn ein Stop gesetzt war (ehrlich: sonst kein definiertes Risiko)
  const riskPerUnit = pos.stopLoss !== null ? Math.abs(Number(pos.entryPrice) - Number(pos.stopLoss)) : null;
  const riskAmount = riskPerUnit !== null ? riskPerUnit * fill.filledQty : null;

  await db.insert(demoTrades).values({
    userId,
    accountId: pos.accountId,
    symbol: pos.symbol,
    direction: pos.direction,
    entryTs: pos.openedAt,
    exitTs: new Date(),
    entryPrice: pos.entryPrice,
    exitPrice: String(fill.avgPrice),
    qty: String(fill.filledQty),
    grossPnl: String(n.grossPnl),
    fees: String(entryFeeShare + fill.fee),
    slippage: String(entrySlippageShare + fill.slippageVsMid),
    fundingPaid: String(n.funding),
    netPnl: String(n.netPnl),
    rMultiple: riskAmount !== null && riskAmount > 0 ? String(n.netPnl / riskAmount) : null,
    reason: opts.reason ?? 'manual',
  });

  // Balance realisieren: Entry-Fee wurde bereits beim Entry abgezogen
  const [account] = await db.select().from(demoAccounts).where(eq(demoAccounts.id, pos.accountId)).limit(1);
  await db
    .update(demoAccounts)
    .set({ balance: String(Number(account!.balance) + n.grossPnl - fill.fee - n.funding) })
    .where(eq(demoAccounts.id, pos.accountId));

  const remaining = posQty - fill.filledQty;
  if (remaining <= EPS) {
    await db.delete(demoPositions).where(eq(demoPositions.id, pos.id));
  } else {
    await db
      .update(demoPositions)
      .set({
        qty: String(remaining),
        entryFee: String(Number(pos.entryFee) - entryFeeShare),
        entrySlippage: String(Number(pos.entrySlippage) - entrySlippageShare),
        updatedAt: new Date(),
      })
      .where(eq(demoPositions.id, pos.id));
  }

  return { closed: true, exitPrice: fill.avgPrice, closedQty: fill.filledQty, netPnl: n.netPnl };
}

/** Demo zurücksetzen: alle Demo-Daten des Users löschen, Startguthaben neu, auditiert. */
export async function resetDemoAccount(db: Db, userId: string, ip?: string | null): Promise<DemoAccount> {
  const account = await getOrCreateDemoAccount(db, userId);
  await db.delete(demoOrders).where(eq(demoOrders.accountId, account.id));
  await db.delete(demoPositions).where(eq(demoPositions.accountId, account.id));
  await db.delete(demoTrades).where(eq(demoTrades.accountId, account.id));
  const [row] = await db
    .update(demoAccounts)
    .set({ balance: account.startBalance, resetCount: account.resetCount + 1, resetAt: new Date() })
    .where(eq(demoAccounts.id, account.id))
    .returning();
  await db.insert(auditLog).values({
    actor: 'user',
    userId,
    action: 'demo.account.reset',
    entityType: 'demo_account',
    entityId: account.id,
    details: { resetCount: account.resetCount + 1 },
    ip: ip ?? null,
  });
  return row!;
}

/**
 * Monitor-Tick (läuft im Worker, minütlich): ruhende Limit-Orders gegen die
 * echte Buchtiefe füllen (Maker, partiell) und SL/TP offener Positionen
 * prüfen (SL vor TP — konservativ, Haus-Konvention). Fehler je Symbol
 * isoliert: ein nicht erreichbares Buch blockiert die anderen nie.
 */
export async function monitorDemoTick(
  db: Db,
  source: DemoBookSource,
  /** accountId: Tests scopen auf ihr eigenes Konto — die CI läuft gegen die echte DB. */
  opts: { accountId?: string } = {},
): Promise<{ checkedOrders: number; orderFills: number; triggeredCloses: number }> {
  const orderWhere = and(inArray(demoOrders.status, ['open', 'partially_filled']), eq(demoOrders.type, 'limit'));
  const resting = await db
    .select()
    .from(demoOrders)
    .where(opts.accountId ? and(orderWhere, eq(demoOrders.accountId, opts.accountId)) : orderWhere);
  const allPositions = opts.accountId
    ? await db.select().from(demoPositions).where(eq(demoPositions.accountId, opts.accountId))
    : await db.select().from(demoPositions);
  const protectedPositions = allPositions.filter((p) => p.stopLoss !== null || p.takeProfit !== null);

  if (resting.length === 0 && protectedPositions.length === 0) {
    return { checkedOrders: 0, orderFills: 0, triggeredCloses: 0 };
  }

  const symbols = new Set<string>([...resting.map((o) => o.symbol), ...protectedPositions.map((p) => p.symbol)]);
  const books = new Map<string, Awaited<ReturnType<DemoBookSource['fetchBook']>>>();
  for (const symbol of symbols) {
    try {
      books.set(symbol, await source.fetchBook(symbol));
    } catch (err) {
      console.warn(`[demo-monitor] Orderbuch für ${symbol} nicht verfügbar: ${String(err)}`);
    }
  }

  let orderFills = 0;
  for (const order of resting) {
    const book = books.get(order.symbol);
    if (!book || order.limitPrice === null) continue;
    const remaining = Number(order.qty) - Number(order.filledQty);
    if (remaining <= EPS) continue;
    const fill = restingLimitFill(book, order.side, remaining, Number(order.limitPrice));
    if (!fill) continue;

    const [account] = await db.select().from(demoAccounts).where(eq(demoAccounts.id, order.accountId)).limit(1);
    if (!account) continue;

    // SL/TP-Wunsch aus der Order (note-JSON) an die Position weiterreichen
    let protection: { stopLoss?: number; takeProfit?: number } = {};
    if (order.note) {
      try {
        const parsed = JSON.parse(order.note) as { stopLoss?: number | null; takeProfit?: number | null };
        protection = {
          stopLoss: parsed.stopLoss ?? undefined,
          takeProfit: parsed.takeProfit ?? undefined,
        };
      } catch {
        // note ist kein JSON (z. B. Hinweistext) — dann gibt es keinen SL/TP-Wunsch
      }
    }

    const direction: 'long' | 'short' = order.side === 'buy' ? 'long' : 'short';
    await applyEntryFill(db, account, { symbol: order.symbol, direction, ...protection }, fill);

    const newFilled = Number(order.filledQty) + fill.filledQty;
    const prevNotional = Number(order.filledQty) * Number(order.avgFillPrice ?? 0);
    const newAvg = (prevNotional + fill.notional) / newFilled;
    const done = newFilled >= Number(order.qty) - EPS;
    await db
      .update(demoOrders)
      .set({
        filledQty: String(newFilled),
        avgFillPrice: String(newAvg),
        feePaid: String(Number(order.feePaid) + fill.fee),
        slippagePaid: String(Number(order.slippagePaid) + fill.slippageVsMid),
        status: done ? 'filled' : 'partially_filled',
        updatedAt: new Date(),
      })
      .where(eq(demoOrders.id, order.id));
    orderFills++;
  }

  let triggeredCloses = 0;
  for (const pos of protectedPositions) {
    const book = books.get(pos.symbol);
    if (!book) continue;
    // Konservativ wie planFills: greift der Stop, zählt NUR der Stop.
    if (pos.stopLoss !== null && checkTrigger(pos.direction, 'stop', Number(pos.stopLoss), book)) {
      const r = await closeDemoPositionNow(db, source, pos.userId, pos.id, { reason: 'sl' });
      if (r.closed) triggeredCloses++;
      continue;
    }
    if (pos.takeProfit !== null && checkTrigger(pos.direction, 'takeProfit', Number(pos.takeProfit), book)) {
      const r = await closeDemoPositionNow(db, source, pos.userId, pos.id, { reason: 'tp' });
      if (r.closed) triggeredCloses++;
    }
  }

  return { checkedOrders: resting.length, orderFills, triggeredCloses };
}
