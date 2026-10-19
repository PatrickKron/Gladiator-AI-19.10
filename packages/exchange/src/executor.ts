import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { evaluateRisk, noTradeWindowFor, type AdaptiveGate, type RiskVerdict } from '@gladiator/risk';
import type { TradingVenue, VenueOrderResult } from './venue.js';
import { trailStep } from '@gladiator/strategy-engine';

const { signals, orders, positions, executedTrades, tradingSettings, riskGates, auditLog, economicEvents, macroSeries } = schema;

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

/** Risk-Kontext: No-Trade-Fenster + aktueller VIX (SAFE-003) aus echten Daten. */
export async function loadRiskContext(db: Db, now = new Date()) {
  const noTrade = await loadNoTradeWindow(db, now);
  // Jüngster VIX-Punkt (< 5 Tage alt, sonst ehrlich null — SAFE-003 braucht frische Daten)
  const [vixRow] = await db
    .select({ ts: macroSeries.ts, value: macroSeries.value })
    .from(macroSeries)
    .where(eq(macroSeries.seriesId, 'VIX'))
    .orderBy(desc(macroSeries.ts))
    .limit(1);
  const vix = vixRow && now.getTime() - vixRow.ts.getTime() < 5 * 86_400_000 ? Number(vixRow.value) : null;
  return { noTrade, vix };
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
  /**
   * Notfall: Stop-Loss ließ sich nicht platzieren → Glattstellung versucht.
   * closed=false heißt: Position ist UNGESCHÜTZT offen (Kill-Switch ist an) —
   * der Aufrufer muss sofort alarmieren (Telegram).
   */
  emergency?: { closed: boolean; reason: string; exitPrice?: number };
};

export async function executeConfirmedSignal(
  db: Db,
  venue: TradingVenue,
  opts: {
    signalId: string;
    userId: string;
    ip?: string | null;
    /**
     * Optionaler Risk-Kontext-Override. Produktion lässt das weg → echter
     * Kontext (No-Trade-Fenster aus dem Live-Kalender, aktueller VIX). Nur
     * Integrationstests injizieren hier einen deterministischen Kontext, damit
     * ein zufällig aktives Kalender-Fenster den Lifecycle-Test nicht kippt.
     */
    riskContext?: Awaited<ReturnType<typeof loadRiskContext>>;
    /**
     * Optionaler Positionsgröße-Override (Risiko % je Trade) — genutzt von
     * Sub-Agenten mit eigenem Risk-Budget. Die HARTEN Grenzen (Leverage,
     * Exposure, Verlustlimits, Kill-Switch) bleiben die globalen Risk-Settings;
     * nur die Sizing-Größe je Trade wird ersetzt (Gate bleibt maßgeblich).
     */
    riskPctOverride?: number;
    /**
     * User-Anpassungen VOR der Ausführung (Patricks „ich bekomme es trotzdem
     * vorgeschlagen wie die Strategie ausgemacht war"-Fix): Betrag, Hebel,
     * Stop-Loss und Take-Profits dürfen den Strategie-Vorschlag ersetzen.
     * Der Vorschlag bleibt in Signal + Audit als Referenz erhalten. ALLE
     * harten Risk-Gates gelten unverändert auch für die angepassten Werte.
     */
    overrides?: {
      /** Gewünschter Positionswert in USD (UI rechnet € mit echtem Kurs um). */
      notionalUsd?: number;
      /** 1× … maxLeverage (Cap aus den Risk-Settings, Gate blockt darüber). */
      leverage?: number;
      stopLoss?: number;
      takeProfits?: number[];
    };
  },
): Promise<ExecutionResult> {
  const [signal] = await db.select().from(signals).where(eq(signals.id, opts.signalId)).limit(1);
  if (!signal) throw new Error('Signal nicht gefunden.');
  if (signal.status !== 'confirmed') throw new Error(`Signal ist ${signal.status}, nicht confirmed.`);

  const settings = await loadRiskSettings(db, opts.userId);
  if (opts.riskPctOverride !== undefined && opts.riskPctOverride > 0) {
    settings.riskPctPerTrade = opts.riskPctOverride;
  }

  const state = await buildAccountState(db, opts.userId);
  const gates = await loadActiveGates(db);
  const rules = await venue.marketRules(signal.symbol);

  // User-Anpassungen (Betrag/Hebel/SL/TP) — Strategie-Vorschlag bleibt Referenz.
  const effectiveStopLoss = opts.overrides?.stopLoss ?? Number(signal.stopLoss);
  const effectiveTakeProfits =
    opts.overrides?.takeProfits && opts.overrides.takeProfits.length > 0
      ? opts.overrides.takeProfits.slice(0, 3)
      : signal.takeProfits.map((tp) => Number(tp));
  // Ohne Override bleibt es bei konservativ 1× (Paper-Phase, Hebel-Anwendung mit VDB2-Promotion).
  const effectiveLeverage = opts.overrides?.leverage ?? 1;

  const verdict = evaluateRisk(
    {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entry: Number(signal.entry),
      stopLoss: effectiveStopLoss,
      leverage: effectiveLeverage,
      session: signal.session,
      emaRegime: signal.emaRegime as 'above' | 'below',
      marketPhase: signal.marketPhase as 'bull' | 'bear',
      requestedNotional: opts.overrides?.notionalUsd,
    },
    settings,
    state,
    rules,
    gates,
    opts.riskContext ?? (await loadRiskContext(db)),
  );

  await db.insert(auditLog).values({
    actor: 'system',
    userId: opts.userId,
    action: verdict.allowed ? 'order.risk_check.passed' : 'order.risk_check.blocked',
    entityType: 'signal',
    entityId: signal.id,
    details: {
      reasons: verdict.reasons,
      checks: verdict.checks,
      sizing: verdict.sizing,
      // Transparenz: Was hat der User angepasst, was war der Strategie-Vorschlag?
      ...(opts.overrides
        ? {
            overrides: opts.overrides,
            suggested: { stopLoss: signal.stopLoss, takeProfits: signal.takeProfits, leverage: 1 },
          }
        : {}),
    },
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

  // ── Eine Position je Symbol (positions_unique_idx): VOR der Entry-Order
  // prüfen — sonst würde die Order platziert und erst das Positions-Insert
  // scheitern (verwaiste Order ohne Position). ──
  const [openPos] = await db
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.userId, opts.userId),
        eq(positions.venue, venue.id),
        eq(positions.symbol, signal.symbol),
        eq(positions.mode, 'paper'),
      ),
    )
    .limit(1);
  if (openPos) {
    return { verdict, executed: false, detail: `Auf ${signal.symbol} ist bereits eine Position offen — erst schließen, dann neu einsteigen.` };
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
      // Herkunft aus einem Sub-Agenten mitführen (echte Performance je Agent).
      subAgentId: signal.subAgentId,
      venue: venue.id,
      symbol: signal.symbol,
      direction: signal.direction,
      qty: String(verdict.sizing.qty),
      entryPrice: String(entryRes.fillPrice),
      leverage: String(effectiveLeverage),
      // Trailing-Stop aus der Strategie (DSL trailingStop) übernehmen — der Monitor
      // zieht ihn mit derselben trailStep-Funktion nach wie der Backtest (Start: Fill).
      ...(signal.trailPct !== null ? { trailPct: signal.trailPct, trailPeak: String(entryRes.fillPrice) } : {}),
      mode: 'paper',
    })
    .returning();

  // ── Schutz-Orders: SL (voll) + TPs (gewichtet), mit Retry im Venue ──
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  const protection: { type: 'stop_market' | 'take_profit_market'; trigger: number; fraction: number; tag: string }[] = [
    { type: 'stop_market', trigger: effectiveStopLoss, fraction: 1, tag: 'sl' },
    ...effectiveTakeProfits.slice(0, 3).map((tp, i) => ({
      type: 'take_profit_market' as const,
      trigger: tp,
      fraction: TP_WEIGHTS[i] ?? TP_WEIGHTS[TP_WEIGHTS.length - 1]!,
      tag: `tp${i + 1}`,
    })),
  ];

  for (const p of protection) {
    const pid = `gld-${signal.id.slice(0, 18)}-${p.tag}`;
    let res: VenueOrderResult | null = null;
    let failure: string | null = null;
    try {
      res = await venue.placeOrder({
        clientOrderId: pid,
        symbol: signal.symbol,
        side: closeSide,
        type: p.type,
        qty: verdict.sizing.qty * p.fraction,
        triggerPrice: p.trigger,
        reduceOnly: true,
      });
      if (res.status === 'rejected') failure = 'von der Börse abgelehnt';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure !== null) {
      await db.insert(auditLog).values({
        actor: 'system', userId: opts.userId, action: 'order.protection.failed',
        entityType: 'position', entityId: position!.id,
        details: { tag: p.tag, trigger: p.trigger, error: failure, venue: venue.id }, ip: opts.ip ?? null,
      });
      // Ohne Stop NIE offen lassen (06_ §5): sofort glattstellen. Ein fehlender TP ist kein Notfall.
      if (p.type === 'stop_market') {
        const emergency = await emergencyClose(db, venue, position!.id, opts.userId, failure, opts.ip ?? null);
        await db.update(signals).set({ status: 'filled', updatedAt: new Date() }).where(eq(signals.id, signal.id));
        return {
          verdict,
          executed: false,
          positionId: position!.id,
          entryFill: entryRes.fillPrice,
          qty: verdict.sizing.qty,
          emergency,
          detail: emergency.closed
            ? `Stop-Loss ließ sich nicht setzen (${failure}) — Position sofort glattgestellt @ ${emergency.exitPrice}, Kill-Switch aktiv.`
            : `ACHTUNG: Stop-Loss ließ sich nicht setzen UND der Notfall-Schluss scheiterte (${emergency.reason}) — Position ist UNGESCHÜTZT offen. Kill-Switch aktiv, sofort an der Börse prüfen!`,
        };
      }
      continue;
    }

    await db.insert(orders).values({
      userId: opts.userId,
      signalId: signal.id,
      venue: venue.id,
      symbol: signal.symbol,
      clientOrderId: pid,
      exchangeOrderId: res!.exchangeOrderId,
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
      entryFill: entryRes.fillPrice, stopLoss: effectiveStopLoss, takeProfits: effectiveTakeProfits,
      leverage: effectiveLeverage,
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
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
    // Nur Schutz-Orders DIESER Position (erstellt ab Eröffnung — gleiche
    // Konvention wie reconcile), nie Reste früherer Trades auf dem Symbol.
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
          gte(orders.createdAt, pos.openedAt),
        ),
      );
    if (prot.length === 0) continue;

    // Trailing-Stop: Stop vor der Fill-Prüfung nachziehen (nur verschärfen).
    if (pos.trailPct !== null) {
      const slIdx = prot.findIndex((o) => o.type === 'stop_market');
      const moved = await applyTrailing(db, venue, pos, prot[slIdx], price);
      if (slIdx >= 0 && moved) prot[slIdx] = moved;
    }

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
        // Der Stop deckt nur noch die RESTMENGE ab — sonst würde er beim
        // Auslösen mehr schließen, als offen ist (Exit-Menge > Positionsgröße).
        const tpQty = Number(prot.find((o) => o.id === fill.id)?.qty ?? 0);
        if (slRow && tpQty > 0) {
          const remaining = Math.max(0, Number(slRow.qty) - tpQty);
          slRow.qty = String(remaining);
          await db.update(orders).set({ qty: String(remaining), updatedAt: new Date() }).where(eq(orders.id, slRow.id));
        }
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

/**
 * Notfall-Glattstellung (Stop nicht platzierbar): reduceOnly-Market für die
 * ganze Position, Schutz-Reste storniert, Netto-Abrechnung, Kill-Switch AN.
 * Scheitert auch das, bleibt die Position sichtbar offen und wird als
 * UNGESCHÜTZT gemeldet — nie still verschluckt.
 */
async function emergencyClose(
  db: Db,
  venue: TradingVenue,
  positionId: string,
  userId: string,
  cause: string,
  ip: string | null,
): Promise<{ closed: boolean; reason: string; exitPrice?: number }> {
  await db
    .insert(tradingSettings)
    .values({ userId, killSwitchActive: true })
    .onConflictDoUpdate({ target: tradingSettings.userId, set: { killSwitchActive: true } });

  const r = await closePositionManually(db, venue, userId, positionId, ip);
  const closed = r.closed;
  await db.insert(auditLog).values({
    actor: 'system',
    userId,
    action: 'position.emergency_close',
    entityType: 'position',
    entityId: positionId,
    details: { cause, closed, exitPrice: r.exitPrice ?? null, reason: r.reason ?? null, killSwitch: true },
    ip,
  });
  return closed ? { closed, reason: cause, exitPrice: r.exitPrice } : { closed, reason: r.reason ?? 'unbekannt' };
}

async function closePaperPosition(
  db: Db,
  venue: TradingVenue,
  positionId: string,
  lastPrice: number,
  reason: 'sl' | 'tp' | 'manual' | 'agent',
): Promise<{ netPnl: number } | null> {
  const [pos] = await db.select().from(positions).where(eq(positions.id, positionId)).limit(1);
  if (!pos) return null;

  // Gefüllte Exits DIESER Position aggregieren (gewichteter Exit-Preis) —
  // nur Orders ab Eröffnung, sonst zählen Fills früherer Trades mit.
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
        gte(orders.createdAt, pos.openedAt),
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
    subAgentId: pos.subAgentId,
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

  // Verbleibende offene Schutz-Orders dieser Position schließen
  await db
    .update(orders)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(
      and(
        eq(orders.userId, pos.userId),
        eq(orders.symbol, pos.symbol),
        eq(orders.venue, pos.venue),
        eq(orders.status, 'open'),
        gte(orders.createdAt, pos.openedAt),
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
  return { netPnl };
}

/**
 * Sofort-Schluss einer offenen Paper-Position zum ECHTEN Live-Preis — für
 * agenten-verwaltete Ausstiege (Zeit-/Event-Exit eines Sub-Agenten), die die
 * statischen TP/SL-Schutz-Orders nicht abdecken. Nutzt exakt denselben
 * Netto-Kostenpfad wie ein regulärer Schluss (Gebühren/Funding) — kein Sonderweg.
 */
export async function closePositionNow(
  db: Db,
  venue: TradingVenue,
  positionId: string,
  reason: 'agent' | 'manual' = 'agent',
): Promise<{ closed: boolean; exitPrice?: number }> {
  const [pos] = await db.select().from(positions).where(eq(positions.id, positionId)).limit(1);
  if (!pos) return { closed: false };
  let price: number;
  try {
    price = await venue.markPrice(pos.symbol); // ECHTER Live-Preis
  } catch (err) {
    console.warn(`[close-now] Preis für ${pos.symbol} nicht verfügbar: ${String(err)}`);
    return { closed: false };
  }
  await closePaperPosition(db, venue, positionId, price, reason);
  return { closed: true, exitPrice: price };
}

/** Orders, die zu DIESER Position gehören (ab Eröffnung — gleiche Konvention wie reconcile). */
function positionOrders(pos: typeof positions.$inferSelect) {
  return and(
    eq(orders.userId, pos.userId),
    eq(orders.symbol, pos.symbol),
    eq(orders.venue, pos.venue),
    gte(orders.createdAt, pos.openedAt),
  );
}

/** Kurze, börsentaugliche clientOrderId (Binance: max. 36 Zeichen). */
function manualOrderId(prefix: 'm' | 'r', id: string): string {
  return `gld-${prefix}-${id.slice(0, 18)}-${Date.now().toString(36)}`;
}

type OrderRow = typeof orders.$inferSelect;
type PositionRow = typeof positions.$inferSelect;

/**
 * Schutz-Order ersetzen (neuer Preis und/oder neue Menge): NEUE Order zuerst
 * an der Venue, dann Storno der alten — die Position ist dabei nie
 * ungeschützt. Menge ≤ 0 → nur stornieren. Gemeinsamer Pfad für SL/TP
 * ändern, Teilschließen und den Trailing-Stop.
 */
async function replaceProtectionOrder(
  db: Db,
  venue: TradingVenue,
  pos: PositionRow,
  row: OrderRow,
  change: { price?: number; qty?: number },
): Promise<{ ok: boolean; row?: OrderRow }> {
  const price = change.price ?? Number(row.price);
  const qty = change.qty ?? Number(row.qty);
  let replacement: OrderRow | undefined;
  if (qty > 1e-12) {
    const clientOrderId = manualOrderId('r', row.id);
    const res = await venue.placeOrder({
      clientOrderId,
      symbol: pos.symbol,
      side: row.side,
      type: row.type as 'stop_market' | 'take_profit_market',
      qty,
      triggerPrice: price,
      reduceOnly: true,
    });
    if (res.status === 'rejected') return { ok: false };
    [replacement] = await db
      .insert(orders)
      .values({
        userId: pos.userId,
        signalId: row.signalId,
        venue: pos.venue,
        symbol: pos.symbol,
        clientOrderId,
        exchangeOrderId: res.exchangeOrderId,
        type: row.type,
        side: row.side,
        qty: String(qty),
        price: String(price),
        reduceOnly: true,
        status: 'open',
        mode: 'paper',
      })
      .returning();
  }
  if (row.exchangeOrderId) {
    try {
      await venue.cancelOrder(pos.symbol, row.exchangeOrderId);
    } catch (err) {
      console.warn(`[protection] Storno ${row.clientOrderId} fehlgeschlagen: ${String(err)}`);
    }
  }
  await db.update(orders).set({ status: 'canceled', updatedAt: new Date() }).where(eq(orders.id, row.id));
  return { ok: true, row: replacement };
}

/**
 * Trailing-Stop eines Ticks anwenden (Monitor + direkt beim Aktivieren):
 * Peak fortschreiben, Stop nur verschärfen. Liefert die (ggf. ersetzte)
 * SL-Order zurück, damit der Aufrufer mit dem aktuellen Stand weiterrechnet.
 */
async function applyTrailing(
  db: Db,
  venue: TradingVenue,
  pos: PositionRow,
  sl: OrderRow | undefined,
  price: number,
): Promise<OrderRow | undefined> {
  if (pos.trailPct === null || !sl) return sl;
  const step = trailStep({
    direction: pos.direction,
    pct: Number(pos.trailPct),
    peak: pos.trailPeak === null ? null : Number(pos.trailPeak),
    price,
    currentStop: Number(sl.price),
  });
  if (step.peak !== null && String(step.peak) !== pos.trailPeak) {
    await db.update(positions).set({ trailPeak: String(step.peak), updatedAt: new Date() }).where(eq(positions.id, pos.id));
    pos.trailPeak = String(step.peak);
  }
  if (step.stop === null) return sl;
  const r = await replaceProtectionOrder(db, venue, pos, sl, { price: step.stop });
  return r.ok ? r.row : sl;
}

export type ManualCloseResult = {
  closed: boolean;
  /** Teilschluss: Position bleibt mit Restmenge offen. */
  partial?: boolean;
  reason?: 'not_found' | 'no_price' | 'rejected' | 'invalid_qty';
  exitPrice?: number;
  closedQty?: number;
  remainingQty?: number;
  netPnl?: number;
};

/**
 * Manueller (Teil-)Schluss einer Agenten-Konto-Position (Mensch im Loop).
 * Anders als closePositionNow läuft der Ausstieg über eine ECHTE
 * reduceOnly-Market-Order an der aktiven Venue (Paper: Fill zum Live-Preis;
 * Testnet: echte Order) — sonst bliebe die Position an einer Testnet-Börse
 * offen. Ohne `qty` (oder qty ≥ Rest) wird alles geschlossen; offene
 * Schutz-Orders werden auch an der Venue storniert. Bei einem Teilschluss
 * (= manuelle Gewinnmitnahme) decken Stop und TPs danach genau die Restmenge
 * (TPs proportional, ihr Verhältnis bleibt). Realisiert wird — wie bei
 * TP-Fills — mit dem Vollschluss über denselben Netto-Pfad.
 */
export async function closePositionManually(
  db: Db,
  venue: TradingVenue,
  userId: string,
  positionId: string,
  ip: string | null = null,
  opts: { qty?: number } = {},
): Promise<ManualCloseResult> {
  const [pos] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.id, positionId), eq(positions.userId, userId)))
    .limit(1);
  if (!pos) return { closed: false, reason: 'not_found' };
  if (opts.qty !== undefined && !(opts.qty > 0)) return { closed: false, reason: 'invalid_qty' };

  const own = await db.select().from(orders).where(positionOrders(pos));
  const exited = own.filter((o) => o.reduceOnly && o.status === 'filled').reduce((n, o) => n + Number(o.qty), 0);
  const remaining = Math.max(0, Number(pos.qty) - exited);
  // Rest so klein, dass er nicht mehr handelbar wäre → als Vollschluss behandeln.
  const full = opts.qty === undefined || opts.qty >= remaining - remaining * 1e-9;
  const closeQty = full ? remaining : opts.qty!;
  const side = pos.direction === 'long' ? 'sell' : 'buy';

  let exitPrice: number;
  if (closeQty > 1e-12) {
    const clientOrderId = manualOrderId('m', pos.id);
    let res: VenueOrderResult;
    try {
      res = await venue.placeOrder({ clientOrderId, symbol: pos.symbol, side, type: 'market', qty: closeQty, reduceOnly: true });
    } catch (err) {
      console.warn(`[close-manual] ${pos.symbol}: ${String(err)}`);
      return { closed: false, reason: 'no_price' };
    }
    if (res.status === 'rejected' || res.fillPrice === undefined) return { closed: false, reason: 'rejected' };
    exitPrice = res.fillPrice;
    await db.insert(orders).values({
      userId: pos.userId,
      venue: pos.venue,
      symbol: pos.symbol,
      clientOrderId,
      exchangeOrderId: res.exchangeOrderId,
      type: 'market',
      side,
      qty: String(closeQty),
      price: String(exitPrice),
      reduceOnly: true,
      status: 'filled',
      mode: 'paper',
    });
  } else {
    try {
      exitPrice = await venue.markPrice(pos.symbol);
    } catch {
      return { closed: false, reason: 'no_price' };
    }
  }

  const openProt = own.filter((o) => o.status === 'open' && (o.type === 'stop_market' || o.type === 'take_profit_market'));

  if (!full) {
    // Schutz-Orders auf die Restmenge zuschneiden: Stop = Rest, TPs proportional.
    const rest = remaining - closeQty;
    for (const sl of openProt.filter((o) => o.type === 'stop_market')) {
      await replaceProtectionOrder(db, venue, pos, sl, { qty: rest });
    }
    const tps = openProt.filter((o) => o.type === 'take_profit_market');
    const tpSum = tps.reduce((n, o) => n + Number(o.qty), 0);
    if (tpSum > rest + 1e-12) {
      const factor = rest / tpSum;
      for (const tp of tps) await replaceProtectionOrder(db, venue, pos, tp, { qty: Number(tp.qty) * factor });
    }
    await db.insert(auditLog).values({
      actor: 'user',
      userId,
      action: 'position.close.partial',
      entityType: 'position',
      entityId: pos.id,
      details: { symbol: pos.symbol, exitPrice, closedQty: closeQty, remainingQty: rest },
      ip,
    });
    return { closed: false, partial: true, exitPrice, closedQty: closeQty, remainingQty: rest };
  }

  // Schutz-Orders auch an der Venue entfernen (Paper: No-op); die DB-Stornierung macht closePaperPosition.
  for (const o of openProt.filter((x) => x.exchangeOrderId)) {
    try {
      await venue.cancelOrder(pos.symbol, o.exchangeOrderId!);
    } catch (err) {
      console.warn(`[close-manual] Storno ${o.clientOrderId} fehlgeschlagen: ${String(err)}`);
    }
  }

  const booked = await closePaperPosition(db, venue, pos.id, exitPrice, 'manual');
  await db.insert(auditLog).values({
    actor: 'user',
    userId,
    action: 'position.close.manual',
    entityType: 'position',
    entityId: pos.id,
    details: { symbol: pos.symbol, exitPrice, closedQty: closeQty, netPnl: booked?.netPnl ?? null },
    ip,
  });
  return { closed: true, exitPrice, closedQty: closeQty, remainingQty: 0, netPnl: booked?.netPnl };
}

export type ProtectionUpdate = {
  stopLoss?: number;
  takeProfits?: { orderId: string; price: number }[];
  /** Stop weiter vom Preis weg = mehr Risiko → nur mit ausdrücklicher Bestätigung. */
  confirmWiden?: boolean;
  /** Trailing-Stop-Abstand in % (0,1–50); null = ausschalten. */
  trailPct?: number | null;
};

export type ProtectionResult = {
  ok: boolean;
  reason?:
    | 'not_found'
    | 'no_price'
    | 'no_stop'
    | 'order_not_found'
    | 'invalid_stop'
    | 'invalid_take_profit'
    | 'invalid_trail'
    | 'widen_requires_confirm'
    | 'rejected';
};

/**
 * SL/TP einer Agenten-Konto-Position ändern und den Trailing-Stop schalten.
 * Gleiche Seitenregeln wie das Demo-Konto (Stop unter/über dem Live-Preis);
 * einen Stop zu WEITEN erhöht das Risiko über das, was das Risk-Gate
 * freigegeben hat → nur mit confirmWiden (Mensch im Loop, Audit). Der
 * Trailing-Stop verschärft nur (startet beim aktuellen Kurs).
 */
export async function updateProtection(
  db: Db,
  venue: TradingVenue,
  userId: string,
  positionId: string,
  input: ProtectionUpdate,
  ip: string | null = null,
): Promise<ProtectionResult> {
  const [pos] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.id, positionId), eq(positions.userId, userId)))
    .limit(1);
  if (!pos) return { ok: false, reason: 'not_found' };

  let mark: number;
  try {
    mark = await venue.markPrice(pos.symbol);
  } catch {
    return { ok: false, reason: 'no_price' };
  }
  const sign = pos.direction === 'long' ? 1 : -1;
  const open = await db
    .select()
    .from(orders)
    .where(and(positionOrders(pos), eq(orders.status, 'open'), inArray(orders.type, ['stop_market', 'take_profit_market'])));

  // ── Erst ALLES prüfen, dann ändern (keine halben Änderungen) ──
  const changes: { row: OrderRow; price: number }[] = [];
  let widened = false;
  let sl = open.find((o) => o.type === 'stop_market');
  if (input.stopLoss !== undefined) {
    if ((mark - input.stopLoss) * sign <= 0) return { ok: false, reason: 'invalid_stop' };
    if (!sl) return { ok: false, reason: 'no_stop' };
    widened = (Number(sl.price) - input.stopLoss) * sign > 0;
    if (widened && !input.confirmWiden) return { ok: false, reason: 'widen_requires_confirm' };
    if (Number(sl.price) !== input.stopLoss) changes.push({ row: sl, price: input.stopLoss });
  }
  for (const tp of input.takeProfits ?? []) {
    const row = open.find((o) => o.id === tp.orderId && o.type === 'take_profit_market');
    if (!row) return { ok: false, reason: 'order_not_found' };
    if ((tp.price - mark) * sign <= 0) return { ok: false, reason: 'invalid_take_profit' };
    if (Number(row.price) !== tp.price) changes.push({ row, price: tp.price });
  }
  if (input.trailPct !== undefined && input.trailPct !== null) {
    if (!(input.trailPct >= 0.1 && input.trailPct <= 50)) return { ok: false, reason: 'invalid_trail' };
    if (!sl) return { ok: false, reason: 'no_stop' };
  }

  const applied: { type: string; from: number; to: number }[] = [];
  for (const { row, price } of changes) {
    const r = await replaceProtectionOrder(db, venue, pos, row, { price });
    if (!r.ok) return { ok: false, reason: 'rejected' };
    if (row.type === 'stop_market') sl = r.row;
    applied.push({ type: row.type, from: Number(row.price), to: price });
  }

  let trail: { from: number | null; to: number | null } | null = null;
  if (input.trailPct !== undefined) {
    const before = pos.trailPct === null ? null : Number(pos.trailPct);
    pos.trailPct = input.trailPct === null ? null : String(input.trailPct);
    pos.trailPeak = input.trailPct === null ? null : String(mark); // Start beim aktuellen Kurs
    await db
      .update(positions)
      .set({ trailPct: pos.trailPct, trailPeak: pos.trailPeak, updatedAt: new Date() })
      .where(eq(positions.id, pos.id));
    // Sofort einmal anwenden: ist der Trailing-Stop schon enger, zieht er jetzt nach.
    const beforeStop = sl ? Number(sl.price) : null;
    sl = await applyTrailing(db, venue, pos, sl, mark);
    if (sl && beforeStop !== null && Number(sl.price) !== beforeStop) applied.push({ type: 'stop_market', from: beforeStop, to: Number(sl.price) });
    trail = { from: before, to: input.trailPct };
  }

  if (applied.length > 0 || trail) {
    const slChange = applied.find((a) => a.type === 'stop_market');
    await db.insert(auditLog).values({
      actor: 'user',
      userId,
      action: 'position.protection.updated',
      entityType: 'position',
      entityId: pos.id,
      details: {
        symbol: pos.symbol,
        markPrice: mark,
        ...(slChange ? { stopLoss: { from: slChange.from, to: slChange.to, widened } } : {}),
        takeProfits: applied.filter((a) => a.type === 'take_profit_market').map(({ from, to }) => ({ from, to })),
        ...(trail ? { trailPct: trail } : {}),
      },
      ip,
    });
  }
  return { ok: true };
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
