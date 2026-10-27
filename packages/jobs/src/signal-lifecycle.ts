import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { leverageUpgradeSchema, reentrySchema } from '@gladiator/core';
import { loadRiskSettings } from '@gladiator/exchange';
import { getOhlcv, latestFreshClose } from '@gladiator/market-data';
import {
  AUTO_KILL_SCORE_THRESHOLD,
  assessOpenSignal,
  deriveLeverageUpgradePlan,
  deriveReentryPlan,
  evaluateLeverageUpgrade,
  evaluateReentry,
  rescoreSignal,
  riskClassOf,
  sessionOf,
  structureBrokenSince,
  type Candle,
  type ReentryPlan,
} from '@gladiator/strategy-engine';
import { emaTrendOf, HIGHER_TF } from './signal-scan.js';
import { ttlHoursFor, SIGNAL_TTL_HOURS } from './signal-expiry.js';
import { AGGREGATE_LOOKBACK_MS, prepareScanCandles, scanSourceTimeframe } from './scan-targets.js';

const { signals, positions, orders, auditLog } = schema;

/**
 * Signal-Lifecycle-Monitor (05_ §9 „Reentry- & Leverage-Upgrade-Engine"):
 * EIN zustandsbehafteter Job, der je Tick offene Signale/Positionen gegen
 * ECHTE Kerzen (DB) und den ECHTEN Preis prüft — je Kursquelle (A2): Binance = Live-Preis
 * (Venue), Yahoo/Twelve Data = Schluss der neuesten FRISCHEN Kerze (`latestFreshClose`), veraltet
 * ⇒ kein Preis, nichts wird bewertet (protokolliert); Kerzen mit Quelle, Börsen-4h aus 1h:
 *  1. Auto-Kill: 'new'-Signal mit gerissenem Stop / gegenläufigem
 *     Struktur-Bruch / auf < 6,5 gefallenem Score → 'expired' + Audit.
 *  2. Reentry: Position per SL/TP geschlossen, Plan erlaubt es, Preis im
 *     Pullback-Fenster → NEUES Signal (status 'new') zur Bestätigung.
 *  3. Leverage-Upgrade: offene Position, Bewegung ≥ Trigger + Stop sichert
 *     den Entry → sichtbarer Vorschlag in signals.leverage_upgrade + Audit.
 * Mensch im Loop: Hier wird NIE eine Order platziert und NIE ein Hebel
 * geändert. Jedes Ereignis einmalig (Dedupe über Status/parent/positionId),
 * vollständig auditiert.
 */

const ACTOR = 'signal-lifecycle';
const LOAD_LIMIT = 400;
const EMA_TREND_PERIOD = 200;
/** Längste Signal-Frist — ältere Schlüsse sind für einen Reentry ohnehin abgelaufen. */
const MAX_TTL_HOURS = Math.max(...Object.values(SIGNAL_TTL_HOURS));

export type SignalLifecycleOptions = {
  /** ECHTER Live-Preis für Binance-Symbole (Worker: venue.markPrice). */
  priceOf: (symbol: string) => Promise<number>;
  now?: Date;
  /**
   * Wirkungsbereich begrenzen — nötig, weil die Server-CI gegen die ECHTE DB
   * testet: Tests dürfen echte Signale/Positionen nie mit Fixture-Preisen bewerten.
   */
  scope?: { strategyIds?: string[]; userIds?: string[] };
};

export type SignalLifecycleResult = {
  checked: number;
  killed: number;
  reentries: number;
  upgrades: number;
  errors: string[];
};

export async function runSignalLifecycle(db: Db, opts: SignalLifecycleOptions): Promise<SignalLifecycleResult> {
  const now = opts.now ?? new Date();
  const result: SignalLifecycleResult = { checked: 0, killed: 0, reentries: 0, upgrades: 0, errors: [] };
  const ctx = new TickContext(db, opts.priceOf, now);

  // Fehler-Isolation je Teil: ein defekter Schritt blockiert die anderen nie.
  try {
    await autoKillPass(db, ctx, opts, now, result);
  } catch (err) {
    result.errors.push(`auto-kill: ${String(err)}`);
  }
  try {
    await reentryPass(db, ctx, opts, now, result);
  } catch (err) {
    result.errors.push(`reentry: ${String(err)}`);
  }
  try {
    await leverageUpgradePass(db, ctx, opts, now, result);
  } catch (err) {
    result.errors.push(`leverage-upgrade: ${String(err)}`);
  }
  return result;
}

/** Cache je Tick: jede Kerzenreihe / jeder Preis wird höchstens einmal geladen (je Quelle + Symbol). */
class TickContext {
  private candles = new Map<string, Candle[]>();
  private prices = new Map<string, number | null>();
  private trends = new Map<string, 'bull' | 'bear' | 'neutral' | undefined>();
  constructor(
    private db: Db,
    private priceOf: (symbol: string) => Promise<number>,
    private now: Date,
  ) {}

  async candlesFor(venue: string, symbol: string, timeframe: string): Promise<Candle[]> {
    const key = `${venue}|${symbol}|${timeframe}`;
    let c = this.candles.get(key);
    if (!c) {
      if (venue === 'binance') {
        c = await getOhlcv(this.db, { venue, symbol, timeframe, limit: LOAD_LIMIT });
      } else {
        // Börsen-Quellen: nur abgeschlossene Kerzen, 4h aus 1h — dieselbe Aufbereitung wie der Scan.
        const sourceTf = scanSourceTimeframe(venue, timeframe);
        const raw = await getOhlcv(this.db, {
          venue,
          symbol,
          timeframe: sourceTf,
          ...(sourceTf === timeframe ? { limit: LOAD_LIMIT + 1 } : { since: new Date(this.now.getTime() - AGGREGATE_LOOKBACK_MS), until: this.now }),
        });
        c = prepareScanCandles(venue, timeframe, raw, this.now).slice(-LOAD_LIMIT);
      }
      this.candles.set(key, c);
    }
    return c;
  }

  /** Preis je Quelle oder undefined (ehrlich: nicht verfügbar/veraltet → keine erfundene Zahl). */
  async priceFor(venue: string, symbol: string): Promise<number | undefined> {
    const key = `${venue}|${symbol}`;
    if (!this.prices.has(key)) {
      try {
        if (venue === 'binance') {
          const p = await this.priceOf(symbol);
          this.prices.set(key, Number.isFinite(p) && p > 0 ? p : null);
        } else {
          const best = await latestFreshClose(this.db, { venue, symbol, now: this.now });
          if (!best.ok) console.log(`[signal-lifecycle] ${venue}:${symbol} ohne frischen Schlusskurs (${best.reason}) — nicht bewertet.`);
          this.prices.set(key, best.ok && best.price > 0 ? best.price : null);
        }
      } catch {
        this.prices.set(key, null);
      }
    }
    return this.prices.get(key) ?? undefined;
  }

  /** Trend der nächsthöheren TF; undefined bei zu wenig Historie (dann gilt der Stand bei Erstellung). */
  async higherTrendFor(venue: string, symbol: string, timeframe: string): Promise<'bull' | 'bear' | 'neutral' | undefined> {
    const higher = (HIGHER_TF as Record<string, string | null>)[timeframe];
    if (!higher) return undefined;
    const key = `${venue}|${symbol}|${higher}`;
    if (!this.trends.has(key)) {
      const c = await this.candlesFor(venue, symbol, higher);
      this.trends.set(key, c.length >= EMA_TREND_PERIOD ? emaTrendOf(c, EMA_TREND_PERIOD) : undefined);
    }
    return this.trends.get(key);
  }
}

// ─── 1. Auto-Kill ──────────────────────────────────────────────────────────

async function autoKillPass(
  db: Db,
  ctx: TickContext,
  opts: SignalLifecycleOptions,
  now: Date,
  result: SignalLifecycleResult,
): Promise<void> {
  const strategyIds = opts.scope?.strategyIds;
  const open = await db
    .select()
    .from(signals)
    .where(and(eq(signals.status, 'new'), strategyIds ? inArray(signals.strategyId, strategyIds) : undefined))
    .orderBy(desc(signals.createdAt))
    .limit(500);

  for (const sig of open) {
    result.checked++;
    try {
      const candles = await ctx.candlesFor(sig.venue, sig.symbol, sig.timeframe);
      const price = await ctx.priceFor(sig.venue, sig.symbol);
      if (candles.length === 0 && price === undefined) continue; // keine echten Daten → keine Bewertung

      const takeProfits = sig.takeProfits.map(Number);
      const assessment = assessOpenSignal({
        direction: sig.direction,
        stopLoss: Number(sig.stopLoss),
        takeProfits,
        confluence: sig.confluence,
        candles,
        price,
        higherTfTrend: await ctx.higherTrendFor(sig.venue, sig.symbol, sig.timeframe),
        score: Number(sig.score),
        createdAt: sig.createdAt,
      });
      if (!assessment.kill) continue;

      // Nur 'new' → 'expired' (bestätigte Signale sind im Trade-Lifecycle); Dedupe über den Status.
      const updated = await db
        .update(signals)
        .set({ status: 'expired', updatedAt: now })
        .where(and(eq(signals.id, sig.id), eq(signals.status, 'new')))
        .returning({ id: signals.id });
      if (updated.length === 0) continue;

      await db.insert(auditLog).values({
        actor: ACTOR,
        action: 'signal.auto_killed',
        entityType: 'signal',
        entityId: sig.id,
        details: {
          reason: assessment.kill.reason,
          detail: assessment.kill.detail,
          score: Number(sig.score),
          rescored: assessment.score,
          threshold: AUTO_KILL_SCORE_THRESHOLD,
          price: price ?? null,
          stopLoss: Number(sig.stopLoss),
          at: now.toISOString(),
        },
      });
      result.killed++;
    } catch (err) {
      result.errors.push(`${sig.id}: ${String(err)}`);
    }
  }
}

// ─── 2. Reentry ────────────────────────────────────────────────────────────

type ClosedRow = { position_id: string; user_id: string | null; closed_at: string | Date; reason: 'sl' | 'tp'; signal_id: string };

async function reentryPass(
  db: Db,
  ctx: TickContext,
  opts: SignalLifecycleOptions,
  now: Date,
  result: SignalLifecycleResult,
): Promise<void> {
  const since = new Date(now.getTime() - MAX_TTL_HOURS * 3_600_000);
  const userIds = opts.scope?.userIds;
  // Schluss-Ereignis (position.closed, Grund sl/tp) ↔ Eröffnung (order.executed trägt die signalId).
  const closes = await db.execute(sql`
    SELECT c.entity_id AS position_id, c.user_id, c.ts AS closed_at,
           c.details->>'reason' AS reason, e.details->>'signalId' AS signal_id
    FROM audit_log c
    JOIN audit_log e ON e.action = 'order.executed' AND e.entity_id = c.entity_id
    WHERE c.action = 'position.closed'
      AND c.details->>'reason' IN ('sl', 'tp')
      AND c.ts >= ${since}
      ${userIds && userIds.length > 0 ? sql`AND c.user_id IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})` : sql``}
    ORDER BY c.ts DESC
    LIMIT 200
  `);

  for (const close of closes.rows as ClosedRow[]) {
    if (!close.signal_id) continue;
    try {
      const [sig] = await db.select().from(signals).where(eq(signals.id, close.signal_id)).limit(1);
      if (!sig) continue;
      if (opts.scope?.strategyIds && !opts.scope.strategyIds.includes(sig.strategyId)) continue;
      // Sub-Agenten führen eigene Einstiege aus — dort keine Reentry-Signale (nie Auto-Ausführung).
      if (sig.source === 'sub_agent' || sig.subAgentId) continue;
      const parsed = reentrySchema.safeParse(sig.reentry);
      if (!parsed.success || !parsed.data.enabled) continue;
      const closedAt = new Date(close.closed_at);
      if (now.getTime() - closedAt.getTime() > ttlHoursFor(sig.timeframe) * 3_600_000) continue;

      // Dedupe: je Ursprungs-Signal höchstens EIN Reentry-Kind.
      const dup = await db.execute(sql`SELECT 1 FROM signals WHERE reentry->>'parentSignalId' = ${sig.id} LIMIT 1`);
      if (dup.rows.length > 0) continue;
      // Auf dem Symbol läuft schon wieder eine Position → keine zweite Chance nötig.
      if (close.user_id) {
        const [openPos] = await db
          .select({ id: positions.id })
          .from(positions)
          .where(and(eq(positions.userId, close.user_id), eq(positions.symbol, sig.symbol)))
          .limit(1);
        if (openPos) continue;
      }

      const price = await ctx.priceFor(sig.venue, sig.symbol);
      if (price === undefined) continue;

      const stopLoss = Number(sig.stopLoss);
      const entry = Number(sig.entry);
      const takeProfits = sig.takeProfits.map(Number);
      const plan: ReentryPlan = {
        ...parsed.data,
        zoneLow: parsed.data.zoneLow ?? deriveReentryPlan({ direction: sig.direction, setupType: sig.setupType, entry, stopLoss }).zoneLow,
        zoneHigh: parsed.data.zoneHigh ?? deriveReentryPlan({ direction: sig.direction, setupType: sig.setupType, entry, stopLoss }).zoneHigh,
        maxReentries: parsed.data.maxReentries ?? 1,
        generation: parsed.data.generation ?? 0,
      };
      const candles = await ctx.candlesFor(sig.venue, sig.symbol, sig.timeframe);
      // Invalidierung ab dem Schluss: Der Stop-Ausstieg selbst ist das Exit-Ereignis;
      // ein WEITERER Bruch gegen das Setup danach verbietet die zweite Chance.
      const structureBroken = structureBrokenSince(candles, sig.direction, closedAt);
      const rescored = rescoreSignal({
        direction: sig.direction,
        stopLoss,
        takeProfits,
        confluence: sig.confluence,
        candles,
        price,
        higherTfTrend: await ctx.higherTrendFor(sig.venue, sig.symbol, sig.timeframe),
        structureBroken,
      });
      const decision = evaluateReentry({
        plan,
        direction: sig.direction,
        stopLoss,
        takeProfits,
        price,
        structureBroken,
        rescoredScore: rescored?.score ?? null,
      });
      if (!decision.trigger || !rescored) continue;

      const rootSignalId = plan.rootSignalId ?? sig.id;
      const confluence = [...rescored.confluence.filter((t) => t !== 'Reentry'), 'Reentry'];
      const [child] = await db
        .insert(signals)
        .values({
          source: sig.source,
          strategyId: sig.strategyId,
          strategyVersionId: sig.strategyVersionId,
          symbol: sig.symbol,
          venue: sig.venue,
          timeframe: sig.timeframe,
          assetClass: sig.assetClass,
          venueType: sig.venueType,
          direction: sig.direction,
          setupType: sig.setupType,
          entry: String(decision.entry),
          // Gleiche Invalidierung und Ziele — nur der Einstieg ist besser (Pullback).
          stopLoss: sig.stopLoss,
          takeProfits: sig.takeProfits,
          ...(sig.trailPct !== null ? { trailPct: sig.trailPct } : {}),
          leverageSuggested: sig.leverageSuggested,
          score: String(rescored.score),
          riskClass: riskClassOf(rescored.score),
          confluence,
          session: sessionOf(now),
          reentry: deriveReentryPlan(
            { direction: sig.direction, setupType: sig.setupType, entry: decision.entry, stopLoss },
            { generation: plan.generation + 1, parentSignalId: sig.id, rootSignalId },
          ),
          leverageUpgrade: deriveLeverageUpgradePlan(sig.setupType),
          emaRegime: sig.emaRegime,
          marketPhase: sig.marketPhase,
          status: 'new',
        })
        .returning({ id: signals.id });

      await db.insert(auditLog).values({
        actor: ACTOR,
        userId: close.user_id,
        action: 'signal.reentry_created',
        entityType: 'signal',
        entityId: child!.id,
        details: {
          parentSignalId: sig.id,
          rootSignalId,
          positionId: close.position_id,
          closeReason: close.reason,
          price,
          zone: { low: plan.zoneLow, high: plan.zoneHigh },
          score: rescored.score,
        },
      });
      result.reentries++;
    } catch (err) {
      result.errors.push(`reentry ${close.signal_id}: ${String(err)}`);
    }
  }
}

// ─── 3. Leverage-Upgrade ───────────────────────────────────────────────────

async function leverageUpgradePass(
  db: Db,
  ctx: TickContext,
  opts: SignalLifecycleOptions,
  now: Date,
  result: SignalLifecycleResult,
): Promise<void> {
  const userIds = opts.scope?.userIds;
  const open = await db
    .select()
    .from(positions)
    .where(and(eq(positions.mode, 'paper'), userIds ? inArray(positions.userId, userIds) : undefined));

  for (const pos of open) {
    try {
      const [opened] = await db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'order.executed'), eq(auditLog.entityId, pos.id)))
        .limit(1);
      const signalId = (opened?.details as { signalId?: string } | null)?.signalId;
      if (!signalId) continue;
      const [sig] = await db.select().from(signals).where(eq(signals.id, signalId)).limit(1);
      if (!sig) continue;
      if (opts.scope?.strategyIds && !opts.scope.strategyIds.includes(sig.strategyId)) continue;
      const parsed = leverageUpgradeSchema.safeParse(sig.leverageUpgrade);
      if (!parsed.success || parsed.data.multiplier === undefined) continue;
      // Dedupe: je Position genau EIN Vorschlag.
      if (parsed.data.suggestion?.positionId === pos.id) continue;

      const price = await ctx.priceFor(sig.venue, pos.symbol);
      if (price === undefined) continue;

      // Aktueller Stop DIESER Position (gleiche Konvention wie Monitor/Reconcile).
      const [stop] = await db
        .select({ price: orders.price })
        .from(orders)
        .where(
          and(
            eq(orders.userId, pos.userId),
            eq(orders.symbol, pos.symbol),
            eq(orders.venue, pos.venue),
            eq(orders.status, 'open'),
            eq(orders.type, 'stop_market'),
            gte(orders.createdAt, pos.openedAt),
          ),
        )
        .limit(1);

      const risk = await loadRiskSettings(db, pos.userId);
      const plan = { triggerPct: parsed.data.triggerPct, multiplier: parsed.data.multiplier, maxLeverage: parsed.data.maxLeverage };
      const up = evaluateLeverageUpgrade({
        plan,
        direction: pos.direction,
        entryPrice: Number(pos.entryPrice),
        price,
        currentLeverage: Number(pos.leverage),
        riskMaxLeverage: risk.maxLeverage,
        stopPrice: stop?.price != null ? Number(stop.price) : null,
      });
      if (!up) continue;

      const cap = Math.min(plan.maxLeverage, risk.maxLeverage);
      const suggestion = {
        ...up,
        reason:
          `+${up.movePct} % in Trendrichtung ≥ Trigger ${plan.triggerPct} %, Stop sichert den Entry — ` +
          `Vorschlag ${up.from}× → ${up.suggested}× (Deckel ${cap}×, Risk-Engine prüft beim Anwenden).`,
        at: now.toISOString(),
        positionId: pos.id,
        price,
      };
      await db
        .update(signals)
        .set({ leverageUpgrade: { ...parsed.data, suggestion }, updatedAt: now })
        .where(eq(signals.id, sig.id));
      await db.insert(auditLog).values({
        actor: ACTOR,
        userId: pos.userId,
        action: 'signal.leverage_upgrade_suggested',
        entityType: 'signal',
        entityId: sig.id,
        details: { ...suggestion, symbol: pos.symbol, cap, applied: false },
      });
      result.upgrades++;
    } catch (err) {
      result.errors.push(`leverage-upgrade ${pos.id}: ${String(err)}`);
    }
  }
}
