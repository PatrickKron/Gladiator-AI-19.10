import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getMacroSnapshot, getOhlcv, latestNews, upcomingEvents } from '@gladiator/market-data';
import { getDerivativesSnapshot } from '@gladiator/market-data';
import {
  evaluateSubAgentEntry,
  evaluateSubAgentExit,
  parseSubAgentSpec,
  priceSnapshotFromCandles,
  riskClassOf,
  sessionOf,
  ema,
  type SubAgentSnapshot,
  type SubAgentSpec,
} from '@gladiator/strategy-engine';
import { closePositionNow, executeConfirmedSignal, PAPER_START_EQUITY, type TradingVenue } from '@gladiator/exchange';
import { CostGuard, envAnthropicProvider } from '@gladiator/agents';
import { runAnalysisGate } from './sub-agent-llm.js';
import { formatEmergencyAlert } from './telegram.js';
import { notifySafe, telegramHtmlToText } from './notify.js';

const { subAgents, subAgentRuns, signals, positions, executedTrades, strategies, auditLog } = schema;

/**
 * Kosten-Wächter für den optionalen LLM-Analyse-Layer (In-Memory je Worker-Prozess,
 * UTC-Tag). Tagesbudget aus LLM_DAILY_BUDGET_USD (Default 5 USD). Erschöpft → der
 * Analyse-Schritt scheitert kontrolliert und der Trade wird konservativ übersprungen.
 */
const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

/**
 * Agent-Runner (Trading-Agenten-Werkstatt): wertet aktive Sub-Agenten periodisch
 * gegen ECHTE Feeds aus. Ablauf je Agent:
 *   1. Sicherheits-Throttle: Tagesverlust-Limit → Agent pausiert sich selbst.
 *   2. Ausstiege: agenten-verwaltete Zeit-/Event-Exits schließen offene Positionen.
 *   3. Einstiege: erfüllte Regeln erzeugen ein kanonisches Signal (source 'sub_agent'),
 *      das im Paper-Modus autonom durch das HARTE Risk-Gate ausgeführt wird; im
 *      Live-Modus bleibt es 'new' (Mensch im Loop bestätigt).
 * Alles wird in `sub_agent_runs` protokolliert — keine Blackbox.
 */

const LOAD_LIMIT = 260; // genug Historie für Dip-Lookback + 24h-Fenster
const BARS_PER_24H: Record<'15m' | '1h' | '4h' | '1d', number> = { '15m': 96, '1h': 24, '4h': 6, '1d': 1 };
const EMA_TREND = 200;

export type SubAgentRunSummary = {
  agentsEvaluated: number;
  signalsCreated: number;
  positionsClosed: number;
  paused: number;
  errors: string[];
};

// ── Reine Helfer (unit-getestet) ───────────────────────────────────────────

/** Setzt die getrennt gespeicherten Spalten wieder zu einem Spec-Objekt zusammen. */
export function reassembleSubAgentSpec(row: {
  config: unknown;
  dataSources: unknown;
  entryRules: unknown;
  exitRules: unknown;
  riskParams: unknown;
}): unknown {
  const config = (row.config ?? {}) as Record<string, unknown>;
  return {
    ...config,
    dataSources: row.dataSources,
    entryRules: row.entryRules,
    exitRules: row.exitRules,
    riskParams: row.riskParams,
  };
}

/** true, wenn der heutige Netto-Verlust des Agenten die Schwelle (in %) überschreitet. */
export function dailyLossBreached(todayNetPnl: number, maxDailyLossPct: number, startEquity: number): boolean {
  if (todayNetPnl >= 0) return false;
  const lossPct = (Math.abs(todayNetPnl) / startEquity) * 100;
  return lossPct >= maxDailyLossPct;
}

/** true, wenn seit dem letzten Einstieg für dieses Symbol weniger als cooldownMinutes vergangen sind. */
export function symbolOnCooldown(lastEntryAt: Date | null, now: Date, cooldownMinutes: number): boolean {
  if (cooldownMinutes <= 0 || lastEntryAt === null) return false;
  const minutes = (now.getTime() - lastEntryAt.getTime()) / 60_000;
  return minutes < cooldownMinutes;
}

/** Minuten bis zum nächsten High-Impact-Event (importance 3) in der Zukunft; null = keins. */
export function minutesToNextHighImpact(
  events: { importance: number | null; scheduledAt: Date }[],
  now: Date,
): number | null {
  let best: number | null = null;
  for (const e of events) {
    if ((e.importance ?? 0) < 3) continue;
    const min = (e.scheduledAt.getTime() - now.getTime()) / 60_000;
    if (min < 0) continue;
    if (best === null || min < best) best = min;
  }
  return best;
}

/** News-Zeilen in {title, ageMin} umrechnen. */
export function newsToItems(rows: { title: string; publishedAt: Date }[], now: Date): { title: string; ageMin: number }[] {
  return rows.map((r) => ({ title: r.title, ageMin: Math.max(0, (now.getTime() - r.publishedAt.getTime()) / 60_000) }));
}

/** 20-Punkte-Änderung einer Makro-Serie in % (aufsteigend sortiert erwartet). */
export function dxyChangePct20d(series: { ts: Date; value: number }[]): number | null {
  if (series.length < 21) return null;
  const cur = series[series.length - 1]!.value;
  const ref = series[series.length - 21]!.value;
  if (ref === 0) return null;
  return ((cur - ref) / ref) * 100;
}

/** Baut den Daten-Snapshot für ein Symbol aus echten Feed-Daten (rein, look-ahead-frei). */
export function buildSubAgentSnapshot(input: {
  symbol: string;
  candles: { ts: Date; high: number; close: number }[];
  dipLookback: number;
  changeLookback: number;
  macro: { vix: number | null; grsLabel: 'risk-on' | 'neutral' | 'risk-off' | null; dxyChangePct20d: number | null };
  fundingRate: number | null;
  events: { importance: number | null; scheduledAt: Date }[];
  news: { title: string; publishedAt: Date }[];
  now: Date;
}): SubAgentSnapshot {
  const i = input.candles.length - 1;
  const price = priceSnapshotFromCandles(
    input.candles.map((c) => ({ ts: c.ts, open: c.close, high: c.high, low: c.close, close: c.close, volume: 0 })),
    i,
    { dipLookback: input.dipLookback, changeLookback: input.changeLookback },
  );
  return {
    symbol: input.symbol,
    price: price.price,
    changePct24h: price.changePct24h,
    recentHigh: price.recentHigh,
    vix: input.macro.vix,
    grsLabel: input.macro.grsLabel,
    dxyChangePct20d: input.macro.dxyChangePct20d,
    fundingRate: input.fundingRate,
    minutesToNextHighImpact: minutesToNextHighImpact(input.events, input.now),
    recentNews: newsToItems(input.news, input.now),
    now: input.now,
  };
}

// ── Persistenz-Helfer ──────────────────────────────────────────────────────

/** Registriert (idempotent) die Sammel-Strategie, unter der Sub-Agent-Signale laufen. */
export async function ensureSubAgentStrategy(db: Db): Promise<string> {
  const [created] = await db
    .insert(strategies)
    .values({
      slug: 'sub-agent-runner',
      name: 'Trading-Agenten-Werkstatt',
      kind: 'builtin',
      description: 'Sammel-Strategie für benutzerdefinierte Sub-Agenten (Signal-Herkunft via sub_agent_id).',
    })
    .onConflictDoNothing({ target: strategies.slug })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(strategies).where(eq(strategies.slug, 'sub-agent-runner')).limit(1);
  return existing!.id;
}

function assetClassFor(symbol: string): 'crypto' | 'stock' | 'etf' | 'forex' {
  const s = symbol.toUpperCase();
  if (s.endsWith('/USDT') || s.endsWith('/USDC') || s.includes(':USDT') || s.endsWith('/BTC')) return 'crypto';
  return 'crypto'; // MVP: Sub-Agenten handeln zunächst Krypto (ehrliche Vorgabe)
}

/** Startäquivalent des Tages: 00:00 UTC. */
function dayStartUtc(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Orchestrierung ──────────────────────────────────────────────────────────

export async function runSubAgents(
  db: Db,
  venue: TradingVenue,
  now: Date = new Date(),
): Promise<SubAgentRunSummary> {
  const summary: SubAgentRunSummary = { agentsEvaluated: 0, signalsCreated: 0, positionsClosed: 0, paused: 0, errors: [] };

  const active = await db.select().from(subAgents).where(eq(subAgents.status, 'active'));
  if (active.length === 0) return summary;

  const strategyId = await ensureSubAgentStrategy(db);

  // Geteilte Feeds EINMAL pro Lauf laden (Effizienz; alle Agenten sehen denselben Stand).
  const macroSnap = await getMacroSnapshot(db);
  const macro = {
    vix: macroSnap.fresh ? (macroSnap.vix?.value ?? null) : null,
    grsLabel: macroSnap.grs?.label ?? null,
    dxyChangePct20d: dxyChangePct20d(macroSnap.series.dxy),
  };
  const news = await latestNews(db, 60);
  const events = await upcomingEvents(db, { from: now, days: 2 });

  for (const agent of active) {
    summary.agentsEvaluated++;
    const runRow = { symbolsEvaluated: 0, signalsCreated: 0, positionsClosed: 0, note: null as string | null, error: null as string | null };
    try {
      const parsed = parseSubAgentSpec(reassembleSubAgentSpec(agent));
      if (!parsed.ok) {
        runRow.error = `Ungültige Definition: ${parsed.errors.join('; ')}`;
        await finishRun(db, agent.id, runRow, runRow.error);
        summary.errors.push(`${agent.name}: ${runRow.error}`);
        continue;
      }
      const spec = parsed.spec;
      const llmNotes: string[] = []; // Kurz-Protokoll der LLM-Analyse je Symbol (für sub_agent_runs.note)

      // (1) Tagesverlust-Throttle → Selbst-Pause (Sicherheit vor Autonomie).
      const dayStart = dayStartUtc(now);
      const todayTrades = await db
        .select({ netPnl: executedTrades.netPnl })
        .from(executedTrades)
        .where(and(eq(executedTrades.subAgentId, agent.id), gte(executedTrades.exitTs, dayStart)));
      const todayNet = todayTrades.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);
      if (dailyLossBreached(todayNet, spec.riskParams.maxDailyLossPct, PAPER_START_EQUITY)) {
        await db.update(subAgents).set({ status: 'paused', updatedAt: now, lastRunAt: now, lastError: null }).where(eq(subAgents.id, agent.id));
        await db.insert(auditLog).values({
          actor: 'system', userId: agent.userId, action: 'sub_agent.auto_paused',
          entityType: 'sub_agent', entityId: agent.id,
          details: { reason: 'Tagesverlust-Limit erreicht', todayNet, maxDailyLossPct: spec.riskParams.maxDailyLossPct },
        });
        runRow.note = `Auto-Pause: Tagesverlust ${todayNet.toFixed(2)} (Limit ${spec.riskParams.maxDailyLossPct} %)`;
        await finishRun(db, agent.id, runRow, null);
        summary.paused++;
        continue;
      }

      // Offene Positionen dieses Agenten.
      const openPositions = await db.select().from(positions).where(eq(positions.subAgentId, agent.id));

      // (2) Ausstiege — pro offener Position agenten-verwaltete Exits prüfen.
      for (const pos of openPositions) {
        const snap = await snapshotFor(db, pos.symbol, spec, macro, news, events, now);
        if (!snap) continue;
        const exit = evaluateSubAgentExit(spec, { openedAt: pos.openedAt, direction: pos.direction, entryPrice: Number(pos.entryPrice) }, snap);
        if (exit) {
          const res = await closePositionNow(db, venue, pos.id, 'agent');
          if (res.closed) {
            runRow.positionsClosed++;
            summary.positionsClosed++;
            await db.insert(auditLog).values({
              actor: 'system', userId: agent.userId, action: 'sub_agent.position_closed',
              entityType: 'position', entityId: pos.id, details: { reason: exit.reason, exitPrice: res.exitPrice },
            });
          }
        }
      }

      // (3) Einstiege — nur solange die Konkurrenz-Grenze es zulässt.
      let held = (await db.select({ id: positions.id }).from(positions).where(eq(positions.subAgentId, agent.id))).length;
      for (const symbol of agent.symbols) {
        runRow.symbolsEvaluated++;
        if (held >= spec.riskParams.maxConcurrentPositions) break;
        // Bereits offene Position im Symbol? Dann kein zweiter Einstieg.
        if (openPositions.some((p) => p.symbol === symbol)) continue;

        // Cooldown je Symbol (letztes Signal dieses Agenten im Symbol).
        const [lastSig] = await db
          .select({ createdAt: signals.createdAt })
          .from(signals)
          .where(and(eq(signals.subAgentId, agent.id), eq(signals.symbol, symbol)))
          .orderBy(desc(signals.createdAt))
          .limit(1);
        if (symbolOnCooldown(lastSig?.createdAt ?? null, now, spec.riskParams.cooldownMinutes)) continue;

        const snap = await snapshotFor(db, symbol, spec, macro, news, events, now);
        if (!snap) continue;
        const decision = evaluateSubAgentEntry(spec, snap);
        if (!decision) continue;

        // (3a) Optionaler LLM-Analyse-Layer: NUR wenn Prompt gesetzt. Das LLM ist
        // ein zusätzliches Veto — der regelbasierte Pfad bleibt unangetastet.
        if (agent.analysisPrompt && agent.analysisPrompt.trim().length > 0) {
          const outcome = await runAnalysisGate(envAnthropicProvider(), llmGuard, agent.analysisPrompt, snap, symbol, decision);
          await db.insert(auditLog).values({
            actor: 'system', userId: agent.userId, action: 'sub_agent.llm_analysis',
            entityType: 'sub_agent', entityId: agent.id,
            details: {
              symbol,
              evaluated: outcome.evaluated,
              decision: outcome.evaluated ? outcome.decision : null,
              reason: outcome.reason,
              model: outcome.evaluated ? outcome.model : null,
            },
          });
          if (!outcome.evaluated) {
            llmNotes.push(`${symbol}:übersprungen(kein Key)`);
            console.warn(`[sub-agent-run] ${agent.name}/${symbol}: ${outcome.reason}`);
          } else if (outcome.decision === 'skip') {
            llmNotes.push(`${symbol}:SKIP`);
            continue; // LLM-Veto → kein Signal, regelbasiert erfüllt aber vom LLM abgelehnt
          } else {
            llmNotes.push(`${symbol}:EXECUTE`);
          }
        }

        // EMA-Regime/Marktphase aus Kerzen für die adaptiven Risk-Gates.
        const regime = snap.recentHigh !== null ? await emaRegimeFor(db, symbol, spec.timeframe, snap.price) : 'above';
        const rr = spec.exitRules.takeProfitPct / spec.exitRules.stopLossPct;
        const score = Math.min(10, rr * 3);

        const [sig] = await db
          .insert(signals)
          .values({
            source: 'sub_agent',
            strategyId,
            subAgentId: agent.id,
            symbol,
            timeframe: spec.timeframe,
            assetClass: assetClassFor(symbol),
            venueType: 'cex',
            direction: decision.direction,
            setupType: decision.setupType,
            entry: String(decision.entry),
            stopLoss: String(decision.stopLoss),
            takeProfits: decision.takeProfits.map(String),
            leverageSuggested: String(spec.riskParams.maxLeverage),
            score: String(score),
            riskClass: riskClassOf(score),
            confluence: decision.reasons,
            session: sessionOf(now),
            emaRegime: regime,
            marketPhase: regime === 'above' ? 'bull' : 'bear',
            status: 'new',
          })
          .returning();
        runRow.signalsCreated++;
        summary.signalsCreated++;

        // Paper: autonom durch das HARTE Risk-Gate. Live: Mensch im Loop (bleibt 'new').
        if (agent.mode === 'paper') {
          await db.update(signals).set({ status: 'confirmed', updatedAt: now }).where(eq(signals.id, sig!.id));
          const exec = await executeConfirmedSignal(db, venue, {
            signalId: sig!.id,
            userId: agent.userId,
            riskPctOverride: spec.riskParams.riskPctPerTrade,
          });
          if (exec.emergency) {
            const html = formatEmergencyAlert(sig!.symbol, exec.detail, exec.emergency.closed);
            void notifySafe(db, {
              userId: agent.userId,
              kind: 'emergency',
              severity: 'critical',
              title: `Notfall ${sig!.symbol}`,
              body: telegramHtmlToText(html),
              link: '#/trading',
              telegramHtml: html,
            });
          }
          if (exec.executed) {
            held++;
          } else {
            // Gate hat geblockt → Signal bleibt handlungsfähig ('new'), Grund im Audit.
            await db.update(signals).set({ status: 'new', updatedAt: now }).where(eq(signals.id, sig!.id));
          }
        }
      }

      if (llmNotes.length > 0) runRow.note = `LLM: ${llmNotes.join(' ')}`.slice(0, 500);
      await finishRun(db, agent.id, runRow, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runRow.error = msg;
      await finishRun(db, agent.id, runRow, msg).catch(() => {});
      summary.errors.push(`${agent.name}: ${msg}`);
    }
  }

  return summary;
}

/** Snapshot für ein Symbol bauen (Kerzen + Funding aus DB + geteilte Feeds). */
async function snapshotFor(
  db: Db,
  symbol: string,
  spec: SubAgentSpec,
  macro: { vix: number | null; grsLabel: 'risk-on' | 'neutral' | 'risk-off' | null; dxyChangePct20d: number | null },
  news: { title: string; publishedAt: Date }[],
  events: { importance: number | null; scheduledAt: Date }[],
  now: Date,
): Promise<SubAgentSnapshot | null> {
  const candles = await getOhlcv(db, { symbol, timeframe: spec.timeframe, limit: LOAD_LIMIT });
  if (candles.length === 0) return null;
  let fundingRate: number | null = null;
  if (spec.dataSources.includes('funding')) {
    const [d] = await getDerivativesSnapshot(db, [symbol]);
    fundingRate = d?.fundingRate ?? null;
  }
  const dipLookback = spec.entryRules.price?.dipLookback ?? 20;
  return buildSubAgentSnapshot({
    symbol,
    candles,
    dipLookback,
    changeLookback: BARS_PER_24H[spec.timeframe],
    macro,
    fundingRate,
    events,
    news,
    now,
  });
}

/** EMA200-Regime aus echten Kerzen (für die adaptiven Risk-Gates). */
async function emaRegimeFor(db: Db, symbol: string, timeframe: string, price: number): Promise<'above' | 'below'> {
  const candles = await getOhlcv(db, { symbol, timeframe, limit: EMA_TREND + 10 });
  if (candles.length < 2) return 'above';
  const series = ema(candles.map((c) => c.close), Math.min(EMA_TREND, candles.length));
  const last = series[series.length - 1];
  if (last === null || last === undefined) return 'above';
  return price >= last ? 'above' : 'below';
}

async function finishRun(
  db: Db,
  subAgentId: string,
  run: { symbolsEvaluated: number; signalsCreated: number; positionsClosed: number; note: string | null; error: string | null },
  lastError: string | null,
): Promise<void> {
  await db.insert(subAgentRuns).values({
    subAgentId,
    symbolsEvaluated: run.symbolsEvaluated,
    signalsCreated: run.signalsCreated,
    positionsClosed: run.positionsClosed,
    note: run.note,
    error: run.error,
  });
  await db.update(subAgents).set({ lastRunAt: new Date(), lastError }).where(eq(subAgents.id, subAgentId));
}
