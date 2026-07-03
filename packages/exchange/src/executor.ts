import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { evaluateRisk, noTradeWindowFor, type AdaptiveGate, type RiskVerdict } from '@gladiator/risk';
import type { TradingVenue } from './venue.js';

const { signals, orders, positions, executedTrades, tradingSettings, riskGates, auditLog, economicEvents } = schema;

/**
 * Order-Lifecycle (06_ §5): bestätigtes Signal → Risk-Gate (statisch + adaptiv)
 * → Entry-Order → Schutz-Orders (SL + TPs) → Position. Alles auditiert,
 * idempotent über clientOrderId (Doppel-Klick erzeugt KEINE zweite Order).
 * Paper-Modus: Fills gegen echte Live-Preise; Kostenmodell wie im Backtest.
 */

export const PAPER_START_EQUITY = 10_000;
/** Ausführungs-Schema wie im Backtest: TP1 50 %, TP2 30 %, TP3 20 % (decker S010). */
const TP_WEIGHTS = [0.5, 0.3, 0.2];
const TAKER_FEE = 0.0004;
const FUNDING_PER_8H = 0.0001;

export async function buildAccountState(db: Db, userId: string, now = new Date()) {
  const openPos = await db.select().from(positions).where(eq(positions.userId, userId));
  const closed = await db
    .select()
    .from(executedTrades)
    .where(and(eq(executedTrades.userId, userId), eq(executedTrades.mode, 'paper')))
    .orderBy(desc(executedTrades.createdAt))
    .limit(500);

  const equity = PAPER_START_EQUITY + closed.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const monthStart = new Date(now.getTime() - 30 * 86_400_000);
  const pnlSince = (since: Date) =>
    closed.filter((t) => t.exitTs !== null && t.exitTs >= since).reduce((a, t) => a + Number(t.netPnl ?? 0), 0);

  let consecutiveLosses = 0;
  let lastLossAt: Date | null = null;
  for (const t of closed) {
    if (Number(t.netPnl ?? 0) < 0) {
      if (consecutiveLosses === 0) lastLossAt = t.exitTs ?? t.createdAt;
      consecutiveLosses++;
    } else break;
  }

  const exposureBySymbolPct: Record<string, number> = {};
  for (const p of openPos) {
    const notional = Number(p.qty) * Number(p.entryPrice);
    exposureBySymbolPct[p.symbol] = (exposureBySymbolPct[p.symbol] ?? 0) + (equity > 0 ? (notional / equity) * 100 : 0);
  }

  return {
    equity,
    availableMargin: equity, // Paper: keine Fremd-Margin; konservativ = Equity
    openPositions: openPos.length,
    exposureBySymbolPct,
    dailyPnlPct: equity > 0 ? (pnlSince(dayStart) / PAPER_START_EQUITY) * 100 : 0,
    weeklyPnlPct: equity > 0 ? (pnlSince(weekStart) / PAPER_START_EQUITY) * 100 : 0,
    monthlyPnlPct: equity > 0 ? (pnlSince(monthStart) / PAPER_START_EQUITY) * 100 : 0,
    consecutiveLosses,
    lastLossAt,
    now,
  };
}

/** Lädt Patricks Trading-Limits (eine Wahrheit — auch die Agenten-Vorschau nutzt exakt diese). */
export async function loadRiskSettings(db: Db, userId: string) {
  const [settingsRow] = await db.select().from(tradingSettings).where(eq(tradingSettings.userId, userId)).limit(1);
  return {
    riskPctPerTrade: Number(settingsRow?.riskPctPerTrade ?? 1),
    maxLeverage: Number(settingsRow?.maxLeverage ?? 10),
    maxOpenPositions: settingsRow?.maxOpenPositions ?? 5,
    maxExposurePctPerAsset: Number(settingsRow?.maxExposurePctPerAsset ?? 20),
    dailyLossLimitPct: Number(settingsRow?.dailyLossLimitPct ?? 3),
    weeklyLossLimitPct: Number(settingsRow?.weeklyLossLimitPct ?? 7),
    monthlyLossLimitPct: 15,
    maxConsecutiveLosses: 5,
    pauseAfterLossStreakHours: 4,
    killSwitchActive: settingsRow?.killSwitchActive ?? false,
  };
}

/** Aktives No-Trade-Fenster aus ECHTEN Kalender-Events (High-Impact ± 30 min). */
export async function loadNoTradeWindow(db: Db, now = new Date()) {
  const events = await db
    .select({
      title: economicEvents.title,
      currency: economicEvents.currency,
      importance: economicEvents.importance,
      scheduledAt: economicEvents.scheduledAt,
    })
    .from(economicEvents)
    .where(and(gte(economicEvents.scheduledAt, new Date(now.getTime() - 2 * 3_600_000)), lte(economicEvents.scheduledAt, new Date(now.getTime() + 2 * 3_600_000))));
  return noTradeWindowFor(events, now);
}

export async function loadActiveGates(db: Db): Promise<AdaptiveGate[]> {
  const rows = await db.select().from(riskGates).where(eq(riskGates.isActive, true));
  return rows.map((g) => ({
    kind: 'block' as const,
    direction: (g.direction as 'long' | 'short' | null) ?? undefined,
    emaRegime: (g.emaRegime as 'above' | 'below' | null) ?? undefined,
    session: g.session ?? undefined,
    marketPhase: (g.marketPhase as 'bull' | 'bear' | null) ?? undefined,
    symbol: g.symbol ?? undefined,
    timeframe: g.timeframe ?? undefined,
    reason: g.reason,
    evidence: g.evidence as { trades: number; expectancyR: number; winRate: number },
  }));
}

export type ExecutionResult = {
  verdict: RiskVerdict;
  executed: boolean;
  positionId?: string;
  entryFill?: number;
  qty?: number;
  detail: string;
};

export async function executeConfirmedSignal(
  db: Db,
  venue: TradingVenue,
  opts: { signalId: string; userId: string; ip?: string | null },
): Promise<ExecutionResult> {
  const [signal] = await db.select().from(signals).where(eq(signals.id, opts.signalId)).limit(1);
  if (!signal) throw new Error('Signal nicht gefunden.');
  if (signal.status !== 'confirmed') throw new Error(`Signal ist ${signal.status}, nicht confirmed.`);

  const settings = await loadRiskSettings(db, opts.userId);

  const state = await buildAccountState(db, opts.userId);
  const gates = await loadActiveGates(db);
  const rules = await venue.marketRules(signal.symbol);

  const verdict = evaluateRisk(
    {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entry: Number(signal.entry),
      stopLoss: Number(signal.stopLoss),
      leverage: 1, // Paper-Phase: konservativ 1× (Hebel-Anwendung kommt mit VDB2-Promotion)
      session: signal.session,
      emaRegime: signal.emaRegime as 'above' | 'below',
      marketPhase: signal.marketPhase as 'bull' | 'bear',
    },
    settings,
    state,
    rules,
    gates,
    { noTrade: await loadNoTradeWindow(db) },
  );

  await db.insert(auditLog).values({
    actor: 'system',
    userId: opts.userId,
    action: verdict.allowed ? 'order.risk_check.passed' : 'order.risk_check.blocked',
    entityType: 'signal',
    entityId: signal.id,
    details: { reasons: verdict.reasons, checks: verdict.checks, sizing: verdict.sizing },
    ip: opts.ip ?? null,
  });

  if (!verdict.allowed || !verdict.sizing) {
    return { verdict, executed: false, detail: `Risk-Gate blockt: ${verdict.reasons.join(' | ')}` };
  }

  // ── Idempotenz: existiert die Entry-Order bereits, nicht erneut ausführen ──
  const clientOrderId = `gld-${signal.id.slice(0, 18)}-e`;
  const [existing] = await db.select().from(orders).where(eq(orders.clientOrderId, clientOrderId)).limit(1);
  if (existing) {
    return { verdict, executed: false, detail: 'Order existiert bereits (Idempotenz) — nichts erneut platziert.' };
  }

  // ── Entry (Market) ──
  const side = signal.direction === 'long' ? 'buy' : 'sell';
  const entryRes = await venue.placeOrder({
    clientOrderId,
    symbol: signal.symbol,
    side,
    type: 'market',
    qty: verdict.sizing.qty,
  });
  if (entryRes.status === 'rejected' || entryRes.fillPrice === undefined) {
    await db.insert(auditLog).values({
      actor: 'system', userId: opts.userId, action: 'order.entry.rejected',
      entityType: 'signal', entityId: signal.id, details: { entryRes }, ip: opts.ip ?? null,
    });
    return { verdict, executed: false, detail: 'Entry-Order abgelehnt.' };
  }

  await db.insert(orders).values({
    userId: opts.userId,
    signalId: signal.id,
    venue: venue.id,
    symbol: signal.symbol,
    clientOrderId,
    exchangeOrderId: entryRes.exchangeOrderId,
    type: 'market',
    side,
    qty: String(verdict.sizing.qty),
    price: String(entryRes.fillPrice),
    status: 'filled',
    mode: 'paper',
  });

  // ── Position ──
  const [position] = await db
    .insert(positions)
    .values({
      userId: opts.userId,
      venue: venue.id,
      symbol: signal.symbol,
      direction: signal.direction,
      qty: String(verdict.sizing.qty),
      entryPrice: String(entryRes.fillPrice),
      leverage: '1',
      mode: 'paper',
    })
    .returning();

  // ── Schutz-Orders: SL (voll) + TPs (gewichtet), mit Retry im Venue ──
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  const protection: { type: 'stop_market' | 'take_profit_market'; trigger: number; fraction: number; tag: string }[] = [
    { type: 'stop_market', trigger: Number(signal.stopLoss), fraction: 1, tag: 'sl' },
    ...signal.takeProfits.slice(0, 3).map((tp, i) => ({
      type: 'take_profit_market' as const,
      trigger: Number(tp),
      fraction: TP_WEIGHTS[i] ?? TP_WEIGHTS[TP_WEIGHTS.length - 1]!,
      tag: `tp${i + 1}`,
    })),
  ];

  for (const p of protection) {
    const pid = `gld-${signal.id.slice(0, 18)}-${p.tag}`;
    const res = await venue.placeOrder({
      clientOrderId: pid,
      symbol: signal.symbol,
      side: closeSide,
      type: p.type,
      qty: verdict.sizing.qty * p.fraction,
      triggerPrice: p.trigger,
      reduceOnly: true,
    });
    await db.insert(orders).values({
      userId: opts.userId,
      signalId: signal.id,
      venue: venue.id,
      symbol: signal.symbol,
      clientOrderId: pid,
      exchangeOrderId: res.exchangeOrderId,
      type: p.type,
      side: closeSide,
      qty: String(verdict.sizing.qty * p.fraction),
      price: String(p.trigger),
      reduceOnly: true,
      status: 'open',
      mode: 'paper',
    });
  }

  await db.update(signals).set({ status: 'filled', updatedAt: new Date() }).where(eq(signals.id, signal.id));
  await db.insert(auditLog).values({
    actor: 'system',
    userId: opts.userId,
    action: 'order.executed',
    entityType: 'position',
    entityId: position!.id,
    details: {
      signalId: signal.id, venue: venue.id, qty: verdict.sizing.qty,
      entryFill: entryRes.fillPrice, stopLoss: signal.stopLoss, takeProfits: signal.takeProfits,
    },
    ip: opts.ip ?? null,
  });

  return {
    verdict,
    executed: true,
    positionId: position!.id,
    entryFill: entryRes.fillPrice,
    qty: verdict.sizing.qty,
    detail: `Paper-Order ausgeführt @ ${entryRes.fillPrice} (${venue.id}).`,
  };
}

/**
 * PositionMonitor-Tick (06_ §5): prüft offene Paper-Positionen gegen den
 * ECHTEN Live-Preis, füllt Schutz-Orders (SL zuerst — konservativ),
 * setzt nach TP1 den Stop auf Break-Even, schreibt bei Voll-Schluss
 * executed_trades NETTO (Fees/Funding wie im Backtest-Kostenmodell).
 */
export async function monitorOpenPositions(db: Db, venue: TradingVenue): Promise<{ checked: number; fills: number }> {
  const { planFills } = await import('./lifecycle.js');
  const open = await db.select().from(positions).where(eq(positions.mode, 'paper'));
  let fills = 0;

  for (const pos of open) {
    // Fehler-Isolation: eine defekte Position (z. B. Preis nicht verfügbar)
    // darf die Überwachung der anderen NIE verhindern (06_ §7b).
    let price: number;
    try {
      price = await venue.markPrice(pos.symbol); // ECHTER Live-Preis
    } catch (err) {
      console.warn(`[position-monitor] Preis für ${pos.symbol} nicht verfügbar: ${String(err)}`);
      continue;
    }
    const prot = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, pos.userId),
          eq(orders.symbol, pos.symbol),
          eq(orders.venue, pos.venue),
          eq(orders.status, 'open'),
          inArray(orders.type, ['stop_market', 'take_profit_market']),
        ),
      );
    if (prot.length === 0) continue;

    const planned = planFills(
      pos.direction,
      prot.map((o) => ({
        id: o.id,
        type: o.type as 'stop_market' | 'take_profit_market',
        triggerPrice: Number(o.price),
        qtyFraction: Number(o.qty) / Number(pos.qty),
      })),
      price,
    );

    for (const fill of planned) {
      // Paper-Fill zum Trigger-Preis (konservativ; Live-Venue füllt selbst)
      await db.update(orders).set({ status: 'filled', updatedAt: new Date() }).where(eq(orders.id, fill.id));
      fills++;

      // decker S010: nach dem ersten TP-Fill Stop auf Break-Even (nur verschärfen)
      if (fill.type === 'take_profit_market') {
        const slRow = prot.find((o) => o.type === 'stop_market');
        const slNotAtBE =
          slRow &&
          (pos.direction === 'long'
            ? Number(slRow.price) < Number(pos.entryPrice)
            : Number(slRow.price) > Number(pos.entryPrice));
        if (slRow && slNotAtBE) {
          await db.update(orders).set({ price: pos.entryPrice, updatedAt: new Date() }).where(eq(orders.id, slRow.id));
          await db.insert(auditLog).values({
            actor: 'system',
            userId: pos.userId,
            action: 'position.stop_to_breakeven',
            entityType: 'position',
            entityId: pos.id,
            details: { newStop: pos.entryPrice },
          });
        }
      }

      if (fill.closesPosition) {
        await closePaperPosition(db, venue, pos.id, price, fill.type === 'stop_market' ? 'sl' : 'tp');
      }
    }
  }

  return { checked: open.length, fills };
}

async function closePaperPosition(
  db: Db,
  venue: TradingVenue,
  positionId: string,
  lastPrice: number,
  reason: 'sl' | 'tp' | 'manual',
): Promise<void> {
  const [pos] = await db.select().from(positions).where(eq(positions.id, positionId)).limit(1);
  if (!pos) return;

  // Gefüllte Exits dieses Symbols/Users aggregieren (gewichteter Exit-Preis)
  const exits = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.userId, pos.userId),
        eq(orders.symbol, pos.symbol),
        eq(orders.venue, pos.venue),
        eq(orders.reduceOnly, true),
        eq(orders.status, 'filled'),
      ),
    );

  const qty = Number(pos.qty);
  const entry = Number(pos.entryPrice);
  const sign = pos.direction === 'long' ? 1 : -1;
  let exitNotional = 0;
  let exitQty = 0;
  for (const e of exits) {
    exitNotional += Number(e.price) * Number(e.qty);
    exitQty += Number(e.qty);
  }
  if (exitQty < qty - 1e-9) {
    // Rest (z. B. Monitor-Schluss ohne Order-Zeile) zum letzten echten Preis
    exitNotional += lastPrice * (qty - exitQty);
    exitQty = qty;
  }
  const avgExit = exitNotional / exitQty;

  const grossPnl = (avgExit - entry) * qty * sign;
  const fees = (entry * qty + exitNotional) * TAKER_FEE;
  const hoursHeld = Math.max(0, (Date.now() - pos.openedAt.getTime()) / 3_600_000);
  const funding = entry * qty * FUNDING_PER_8H * (hoursHeld / 8);
  const netPnl = grossPnl - fees - funding;
  const riskAmount = Math.abs(entry - Number(exits.find((e) => e.type === 'stop_market')?.price ?? entry * 0.99)) * qty;

  await db.insert(executedTrades).values({
    userId: pos.userId,
    venue: pos.venue,
    symbol: pos.symbol,
    direction: pos.direction,
    entryTs: pos.openedAt,
    exitTs: new Date(),
    entryPrice: String(entry),
    exitPrice: String(avgExit),
    qty: String(qty),
    leverage: pos.leverage,
    grossPnl: String(grossPnl),
    makerTakerFee: String(fees),
    slippage: '0',
    fundingPaid: String(funding),
    netPnl: String(netPnl),
    rMultiple: riskAmount > 0 ? String(netPnl / riskAmount) : null,
    mode: 'paper',
  });

  // Verbleibende offene Schutz-Orders schließen
  await db
    .update(orders)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(
      and(
        eq(orders.userId, pos.userId),
        eq(orders.symbol, pos.symbol),
        eq(orders.venue, pos.venue),
        eq(orders.status, 'open'),
      ),
    );
  await db.delete(positions).where(eq(positions.id, positionId));
  await db.insert(auditLog).values({
    actor: 'system',
    userId: pos.userId,
    action: 'position.closed',
    entityType: 'position',
    entityId: positionId,
    details: { reason, avgExit, grossPnl, fees, funding, netPnl },
  });
}

/**
 * Absturz-Reconciliation (06_ §7c): Börse = Wahrheit. Für echte Venues werden
 * offene Orders/Positionen mit der DB abgeglichen; verwaiste DB-Positionen
 * ohne Schutz-Orders werden gemeldet. Paper: DB ist die Wahrheit → Check,
 * dass jede Position mindestens eine offene Schutz-Order hat (sonst Alarm-Log).
 */
export async function reconcile(db: Db, venue: TradingVenue): Promise<{ ok: boolean; findings: string[] }> {
  const findings: string[] = [];
  const open = await db.select().from(positions).where(eq(positions.venue, venue.id));

  for (const pos of open) {
    const prot = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.userId, pos.userId),
          eq(orders.symbol, pos.symbol),
          eq(orders.venue, pos.venue),
          eq(orders.status, 'open'),
          gte(orders.createdAt, pos.openedAt),
        ),
      );
    if ((prot[0]?.n ?? 0) === 0) {
      findings.push(`Position ${pos.symbol} (${pos.id}) ohne offene Schutz-Orders — UNGESCHÜTZT.`);
    }
  }

  if (venue.kind !== 'paper') {
    const exchangePositions = await venue.fetchPositions();
    for (const ep of exchangePositions) {
      const known = open.find((p) => p.symbol === ep.symbol && p.direction === ep.direction);
      if (!known) findings.push(`Börse meldet Position ${ep.symbol} ${ep.direction}, DB kennt sie nicht.`);
    }
    for (const p of open) {
      const onExchange = exchangePositions.find((ep) => ep.symbol === p.symbol && ep.direction === p.direction);
      if (!onExchange) findings.push(`DB-Position ${p.symbol} existiert auf der Börse nicht (mehr).`);
    }
  }

  if (findings.length > 0) {
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'reconciliation.findings',
      entityType: 'venue',
      entityId: venue.id,
      details: { findings },
    });
  }
  return { ok: findings.length === 0, findings };
}
