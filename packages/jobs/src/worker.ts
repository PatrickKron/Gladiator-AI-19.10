import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { requireEnv, type Db } from '@gladiator/db';
import { demoBookSource, monitorDemoTick, monitorOpenPositions, reconcile, type TradingVenue } from '@gladiator/exchange';
import { failStuckSwapOrders, runSwapOrders } from './swap-orders.js';
import { fredConfigured, syncDerivatives, syncFredWatch, syncEconomicCalendar, syncFredSeries, syncMacroSeries, syncNews } from '@gladiator/market-data';
import { runNightPipeline } from './briefing.js';
import { runSignalScan } from './signal-scan.js';
import { runDslScan } from './dsl-scan.js';
import { runSignalLifecycle } from './signal-lifecycle.js';
import { reviewNewSignals } from './review.js';
import { checkPriceAlerts } from './alerts.js';
import { runSubAgents } from './sub-agent-runner.js';
import { computeAllFeatures, autoLabelSignals, retrainModel } from './ml-pipeline.js';
import { runRlEpisodes, aggregateRlPerformance, rebalanceRlWeights } from './rl-pipeline.js';
import { detectAllRegimes, runSelfEvaluation, runModelComparison, createPerformanceSnapshots } from './self-improve-pipeline.js';
import { snapshotAccountValues } from './portfolio-snapshot.js';
import { recomputeStudyClusters } from '@gladiator/backtest';
import { runStrategyOptimization } from './optimization.js';

/**
 * BullMQ-Worker (04_ §2: robuste Jobs statt loser Loops — der v1-Fehler).
 * signal-scan 5 min · position-monitor 1 min (eigene Queue) · macro-sync 30 min ·
 * calendar-sync 60 min · news-sync 15 min · derivatives-sync 30 min ·
 * signal-lifecycle 1 min (05_ §9: Auto-Kill, Reentry, Leverage-Upgrade).
 * strategy-optimize So 03:00 UTC (nur Vorschläge, Mensch promotet).
 */

export const QUEUE_NAME = 'gladiator-jobs';
/**
 * Eigene Queue für den Positions-Monitor (SL/TP, Trailing, Notfall-Pfad):
 * Die Haupt-Queue läuft mit concurrency 1, CPU-schwere Jobs (RL-Episoden,
 * ML-Retrain, Optimierung) dauern Minuten — der Monitor darf nie dahinter warten.
 */
export const FAST_QUEUE_NAME = 'gladiator-monitor';
const SCAN_JOB = 'signal-scan';
export const MONITOR_JOB = 'position-monitor';
const MACRO_JOB = 'macro-sync';
const CALENDAR_JOB = 'calendar-sync';
const NEWS_JOB = 'news-sync';
const DERIVATIVES_JOB = 'derivatives-sync';
const SUB_AGENT_JOB = 'sub-agent-run';
const NIGHT_JOB = 'night-pipeline';
const ML_FEATURES_JOB = 'ml-features';
const ML_LABEL_JOB = 'ml-auto-label';
const ML_RETRAIN_JOB = 'ml-retrain';
const RL_EPISODE_JOB = 'rl-episodes';
const RL_PERF_JOB = 'rl-perf-aggregate';
const RL_REBALANCE_JOB = 'rl-rebalance';
const REGIME_JOB = 'regime-detect';
const SELF_EVAL_JOB = 'self-evaluate';
const MODEL_COMPARE_JOB = 'model-compare';
const PERF_SNAPSHOT_JOB = 'perf-snapshot';
const PORTFOLIO_SNAPSHOT_JOB = 'portfolio-snapshot';
const SIGNAL_LIFECYCLE_JOB = 'signal-lifecycle';
const STUDY_CLUSTER_JOB = 'study-clusters';
const OPTIMIZE_JOB = 'strategy-optimize';

/**
 * Worker-Heartbeat (Phase 7): /health prüft das Alter; der Monitor-Job pingt
 * zusätzlich HEALTHCHECKS_URL (externer Dead-Man's-Switch, legt Patrick an —
 * bleiben die Pings aus, alarmiert der externe Dienst unabhängig vom Server).
 */
let lastHeartbeat: Date | null = null;
export function workerHeartbeatAgeSec(): number | null {
  return lastHeartbeat ? Math.floor((Date.now() - lastHeartbeat.getTime()) / 1000) : null;
}

/**
 * Prozessübergreifender Heartbeat (ROLE-Trennung): Der Worker schreibt seinen
 * Takt zusätzlich nach Redis, damit der Web-Prozess (/health) ihn sehen kann,
 * wenn Worker und HTTP-Server in getrennten Prozessen laufen. Im selben
 * Prozess (ROLE unbesetzt) greift weiterhin der lokale Wert — kein Redis nötig.
 */
const HEARTBEAT_KEY = 'gladiator:worker-heartbeat';
let heartbeatReader: Redis | null = null;
export async function workerHeartbeatAgeSecAsync(): Promise<number | null> {
  const local = workerHeartbeatAgeSec();
  if (local !== null) return local;
  // Nur die reine Web-Rolle schaut in Redis — im Ein-Prozess-Betrieb (Tests,
  // Entwicklung) ist der lokale Wert die Wahrheit und Redis bleibt unberührt
  // (keine offene Verbindung, die z. B. Test-Runner am Beenden hindert).
  if (process.env.ROLE !== 'web') return null;
  try {
    if (!heartbeatReader) {
      const { host, port } = redisConnection();
      heartbeatReader = new Redis({ host, port, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    }
    const v = await heartbeatReader.get(HEARTBEAT_KEY);
    return v ? Math.max(0, Math.floor((Date.now() - Number(v)) / 1000)) : null;
  } catch {
    // Redis nicht erreichbar → ehrlich "unbekannt" statt erfundener Frische.
    return null;
  }
}
/**
 * On-demand-Enqueue aus dem Web-Prozess (ROLE=web): Die API stößt damit einen
 * RL-Episoden-Lauf im getrennten Worker an, statt selbst zu rechnen. Lazy
 * Queue-Singleton — verbindet erst beim ersten Aufruf mit Redis.
 */
let enqueueQueue: Queue | null = null;
export async function enqueueRlEpisodeRun(agentId?: string): Promise<void> {
  if (!enqueueQueue) enqueueQueue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  await enqueueQueue.add(RL_EPISODE_JOB, agentId ? { agentId } : {});
}

let healthchecksWarned = false;
async function pingDeadMansSwitch(): Promise<void> {
  const url = process.env.HEALTHCHECKS_URL;
  if (!url) {
    if (!healthchecksWarned) {
      console.warn('[dead-man] HEALTHCHECKS_URL nicht gesetzt — externer Dead-Man-Switch inaktiv (nur lokaler Watchdog).');
      healthchecksWarned = true;
    }
    return;
  }
  try {
    await fetch(url, { method: 'GET' });
  } catch (err) {
    console.warn('[dead-man] Ping fehlgeschlagen:', String(err));
  }
}

export const SCHEDULES: [string, number][] = [
  [SCAN_JOB, 5 * 60_000],
  [MACRO_JOB, 30 * 60_000],
  [CALENDAR_JOB, 60 * 60_000],
  [NEWS_JOB, 15 * 60_000],
  [DERIVATIVES_JOB, 30 * 60_000],
  [SUB_AGENT_JOB, 5 * 60_000],
  [ML_FEATURES_JOB, 30 * 60_000],     // Feature-Berechnung alle 30 min
  [ML_LABEL_JOB, 60 * 60_000],         // Auto-Labeling stündlich
  [RL_EPISODE_JOB, 30 * 60_000],       // RL-Episoden alle 30 min
  [REGIME_JOB, 15 * 60_000],            // Regime-Erkennung alle 15 min
  [PORTFOLIO_SNAPSHOT_JOB, 60 * 60_000], // Vermögens-Snapshot stündlich (Zeitverlauf „Vermögen")
  [SIGNAL_LIFECYCLE_JOB, 60_000],        // 05_ §9: Auto-Kill/Reentry/Leverage-Upgrade je Minute (echte Preise)
  // VDB2-Batch (13_ §4) wöchentlich: study_clusters aus study_trades (Labor + Paper) neu rechnen.
  // Zusatzläufe (Neustart) sind unschädlich: die Hebel-Stufengrenze bezieht sich auf die Vorwoche.
  [STUDY_CLUSTER_JOB, 7 * 24 * 60 * 60_000],
];

/** Schnelle Queue: nur der Positions-Monitor, jede Minute. */
export const FAST_SCHEDULES: [string, number][] = [[MONITOR_JOB, 60_000]];

/** Nacht-Pipeline: täglich 03:30 UTC (08_ §5) — Cron statt Intervall. */
const NIGHT_CRON = '30 3 * * *';
/**
 * Strategie-Optimierung → Vorschläge (08_ §4/§5): sonntags 03:00 UTC — wöchentlich,
 * weil sich das Ergebnis eines 1000/250-Bar-Walk-Forwards über einen Tag kaum
 * ändert (täglich wären es nur Doppel-Vorschläge), und VOR dem Briefing um 03:30,
 * das offene Vorschläge nennt. Erzeugt NUR Vorschläge, schaltet nichts scharf.
 */
const OPTIMIZE_CRON = '0 3 * * 0';
/** ML-Retraining: wöchentlich sonntags 04:00 UTC — genug Labels sammeln vor Neutraining. */
const ML_RETRAIN_CRON = '0 4 * * 0';
/** RL-Performance-Aggregation: täglich 23:55 UTC — Tages-Rollup der Agenten-Metriken. */
const RL_PERF_CRON = '55 23 * * *';
/** RL-HRP-Rebalancing: sonntags 05:00 UTC — wöchentliche Portfolio-Gewichtung. */
const RL_REBALANCE_CRON = '0 5 * * 0';
/** Self-Evaluation: täglich 00:30 UTC — Agenten bewerten und Vorschläge erstellen. */
const SELF_EVAL_CRON = '30 0 * * *';
/** Model-Vergleich: sonntags 04:30 UTC — nach Retrain neues vs. altes Modell. */
const MODEL_COMPARE_CRON = '30 4 * * 0';
/** Performance-Snapshots: täglich 23:50 UTC (vor RL-Perf-Aggregation). */
const PERF_SNAPSHOT_DAILY_CRON = '50 23 * * *';
/** Wöchentliche Snapshots: sonntags 23:50 UTC. */
const PERF_SNAPSHOT_WEEKLY_CRON = '50 23 * * 0';
/** Monatliche Snapshots: 1. des Monats 00:10 UTC. */
const PERF_SNAPSHOT_MONTHLY_CRON = '10 0 1 * *';

function redisConnection() {
  const url = new URL(requireEnv('REDIS_URL'));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

export async function startJobWorker(db: Db, venue: TradingVenue): Promise<{ stop: () => Promise<void> }> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });

  const fastQueue = new Queue(FAST_QUEUE_NAME, { connection });

  for (const [name, every] of SCHEDULES) {
    await queue.upsertJobScheduler(name, { every }, { name });
  }
  for (const [name, every] of FAST_SCHEDULES) {
    await fastQueue.upsertJobScheduler(name, { every }, { name });
  }
  // Altbestand: der Monitor-Takt lag früher in der Haupt-Queue → dort entfernen (idempotent),
  // sonst liefe er doppelt.
  await queue.removeJobScheduler(MONITOR_JOB);
  await queue.upsertJobScheduler(NIGHT_JOB, { pattern: NIGHT_CRON }, { name: NIGHT_JOB });
  await queue.upsertJobScheduler(OPTIMIZE_JOB, { pattern: OPTIMIZE_CRON }, { name: OPTIMIZE_JOB });
  await queue.upsertJobScheduler(ML_RETRAIN_JOB, { pattern: ML_RETRAIN_CRON }, { name: ML_RETRAIN_JOB });
  await queue.upsertJobScheduler(RL_PERF_JOB, { pattern: RL_PERF_CRON }, { name: RL_PERF_JOB });
  await queue.upsertJobScheduler(RL_REBALANCE_JOB, { pattern: RL_REBALANCE_CRON }, { name: RL_REBALANCE_JOB });
  await queue.upsertJobScheduler(SELF_EVAL_JOB, { pattern: SELF_EVAL_CRON }, { name: SELF_EVAL_JOB });
  await queue.upsertJobScheduler(MODEL_COMPARE_JOB, { pattern: MODEL_COMPARE_CRON }, { name: MODEL_COMPARE_JOB });
  await queue.upsertJobScheduler(PERF_SNAPSHOT_JOB + '-daily', { pattern: PERF_SNAPSHOT_DAILY_CRON }, { name: PERF_SNAPSHOT_JOB, data: { type: 'daily' } });
  await queue.upsertJobScheduler(PERF_SNAPSHOT_JOB + '-weekly', { pattern: PERF_SNAPSHOT_WEEKLY_CRON }, { name: PERF_SNAPSHOT_JOB, data: { type: 'weekly' } });
  await queue.upsertJobScheduler(PERF_SNAPSHOT_JOB + '-monthly', { pattern: PERF_SNAPSHOT_MONTHLY_CRON }, { name: PERF_SNAPSHOT_JOB, data: { type: 'monthly' } });

  // Absturz-Reconciliation beim Start (06_ §7c): Befunde landen im Audit-Log.
  const rec = await reconcile(db, venue);
  if (!rec.ok) console.warn('[reconciliation] Befunde:', rec.findings.join(' | '));
  else console.log('[reconciliation] sauber — Positionen und Schutz-Orders konsistent.');

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case SCAN_JOB: {
          const res = await runSignalScan(db);
          console.log(
            `[signal-scan] ${new Date().toISOString()} neu=${res.inserted} dupes=${res.skippedDuplicates} ` +
              res.scanned.map((s) => `${s.symbol}@${s.timeframe}:${s.candles}`).join(' '),
          );
          // DSL-Strategien (07_ §3) scannen — dieselbe Pipeline, source 'instruction'.
          const dsl = await runDslScan(db);
          if (dsl.inserted > 0 || dsl.errors.length > 0) {
            console.log(`[dsl-scan] neu=${dsl.inserted} dupes=${dsl.skippedDuplicates} Fehler=${dsl.errors.length}`);
            for (const e of dsl.errors) console.warn('[dsl-scan]', e);
          }
          // Schwarm-Review direkt nach dem Scan (08_ §1): neue Signale bewerten.
          const rev = await reviewNewSignals(db, venue);
          if (rev.reviewed > 0 || rev.errors.length > 0) {
            console.log(`[signal-review] bewertet=${rev.reviewed} Fehler=${rev.errors.length}`);
            for (const e of rev.errors) console.warn('[signal-review]', e);
          }
          return res;
        }
        case NIGHT_JOB: {
          const res = await runNightPipeline(db);
          console.log(`[night-pipeline] ${res.day} erstellt=${res.created} versendet=${res.sent}`);
          return res;
        }
        case OPTIMIZE_JOB: {
          const res = await runStrategyOptimization(db);
          console.log(
            `[strategy-optimize] bewertet=${res.evaluated} Vorschläge=${res.proposals.length} übersprungen=${res.skipped.length} Fehler=${res.errors.length}`,
          );
          for (const p of res.proposals) console.log(`[strategy-optimize] Vorschlag für ${p.strategy} v${p.baseVersion} (${p.optimizationId})`);
          for (const s of res.skipped) console.log(`[strategy-optimize] ${s.target}: ${s.reason}`);
          for (const e of res.errors) console.warn('[strategy-optimize]', e);
          return res;
        }
        case MACRO_JOB: {
          const res = await syncMacroSeries(db);
          console.log(
            // COT hat keinen Einzelwert (latest=null) → Anzahl neuer Zeilen loggen statt „—".
            `[macro-sync] ${res.series.map((s) => `${s.seriesId}:${s.latest ?? `${s.points} neu`}`).join(' ')} Fehler=${res.errors.length}`,
          );
          for (const e of res.errors) console.warn('[macro-sync]', e);
          if (fredConfigured()) {
            const fred = await syncFredSeries(db);
            console.log(`[macro-sync] FRED: ${fred.synced.join(',') || 'nichts'}`);
          }
          // Daten-Assistent: vom Nutzer hinzugefügte FRED-Serien (offizielle CSV, kein Key)
          const watch = await syncFredWatch(db);
          if (watch.synced.length || watch.errors.length) console.log(`[macro-sync] Watchlist: ${watch.synced.join(',') || '—'} Fehler=${watch.errors.length}`);
          for (const e of watch.errors) console.warn('[macro-sync] Watchlist', e);
          return res;
        }
        case CALENDAR_JOB: {
          const res = await syncEconomicCalendar(db);
          console.log(`[calendar-sync] fetched=${res.fetched} neu=${res.inserted} aktualisiert=${res.updated}`);
          return res;
        }
        case NEWS_JOB: {
          const res = await syncNews(db);
          if (res.inserted > 0 || res.errors.length > 0) {
            console.log(`[news-sync] fetched=${res.fetched} neu=${res.inserted} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[news-sync]', e);
          }
          return res;
        }
        case DERIVATIVES_JOB: {
          const res = await syncDerivatives(db);
          console.log(`[derivatives-sync] funding=${res.funding} oi=${res.openInterest} Fehler=${res.errors.length}`);
          for (const e of res.errors) console.warn('[derivatives-sync]', e);
          return res;
        }
        case SIGNAL_LIFECYCLE_JOB: {
          // Nur Vorschläge/Entwertungen — platziert NIE eine Order, ändert NIE einen Hebel.
          const res = await runSignalLifecycle(db, { priceOf: (symbol) => venue.markPrice(symbol) });
          if (res.killed > 0 || res.reentries > 0 || res.upgrades > 0 || res.errors.length > 0) {
            console.log(
              `[signal-lifecycle] geprüft=${res.checked} auto-kill=${res.killed} reentry=${res.reentries} ` +
                `hebel-vorschläge=${res.upgrades} Fehler=${res.errors.length}`,
            );
            for (const e of res.errors) console.warn('[signal-lifecycle]', e);
          }
          return res;
        }
        case PORTFOLIO_SNAPSHOT_JOB: {
          const res = await snapshotAccountValues(db);
          console.log(`[portfolio-snapshot] User=${res.users} geschrieben=${res.written} Fehler=${res.errors.length}`);
          for (const e of res.errors) console.warn('[portfolio-snapshot]', e);
          return res;
        }
        case SUB_AGENT_JOB: {
          // Trading-Agenten-Werkstatt: aktive Sub-Agenten gegen echte Feeds auswerten.
          const res = await runSubAgents(db, venue);
          if (res.agentsEvaluated > 0) {
            console.log(
              `[sub-agent-run] Agenten=${res.agentsEvaluated} Signale=${res.signalsCreated} ` +
                `geschlossen=${res.positionsClosed} pausiert=${res.paused} Fehler=${res.errors.length}`,
            );
            for (const e of res.errors) console.warn('[sub-agent-run]', e);
          }
          return res;
        }
        case ML_FEATURES_JOB: {
          const res = await computeAllFeatures(db);
          if (res.computed > 0 || res.errors.length > 0) {
            console.log(`[ml-features] computed=${res.computed} skipped=${res.skipped} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[ml-features]', e);
          }
          return res;
        }
        case ML_LABEL_JOB: {
          const res = await autoLabelSignals(db);
          if (res.labeled > 0 || res.errors.length > 0) {
            console.log(`[ml-auto-label] labeled=${res.labeled} skipped=${res.skipped} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[ml-auto-label]', e);
          }
          return res;
        }
        case ML_RETRAIN_JOB: {
          const res = await retrainModel(db);
          if (res.retrained) {
            console.log(`[ml-retrain] Modell neu trainiert: ${res.sampleCount} Samples, Accuracy=${(res.metrics as Record<string, number>)?.accuracy?.toFixed(3) ?? '?'}`);
          } else {
            console.log(`[ml-retrain] Kein Retraining: ${res.reason}`);
          }
          return res;
        }
        case RL_EPISODE_JOB: {
          // job.data.agentId: manuell über die UI angestoßener Lauf für EINEN Agenten.
          const agentId = (job.data as { agentId?: string } | undefined)?.agentId;
          const res = await runRlEpisodes(db, agentId ? { agentId } : undefined);
          if (res.episodesRun > 0 || res.errors.length > 0) {
            console.log(`[rl-episodes] Episoden=${res.episodesRun} übersprungen=${res.skipped} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[rl-episodes]', e);
          }
          return res;
        }
        case RL_PERF_JOB: {
          const res = await aggregateRlPerformance(db);
          if (res.aggregated > 0 || res.errors.length > 0) {
            console.log(`[rl-perf] aggregiert=${res.aggregated} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[rl-perf]', e);
          }
          return res;
        }
        case RL_REBALANCE_JOB: {
          const res = await rebalanceRlWeights(db);
          if (res.rebalanced) {
            console.log(`[rl-rebalance] Agenten=${res.agentCount} Gewichte=${res.weights.map(w => `${w.name}:${(w.weight * 100).toFixed(1)}%`).join(' ')}`);
          }
          for (const e of res.errors) console.warn('[rl-rebalance]', e);
          return res;
        }
        case REGIME_JOB: {
          const res = await detectAllRegimes(db);
          if (res.detected > 0 || res.errors.length > 0) {
            console.log(`[regime-detect] erkannt=${res.detected} übersprungen=${res.skipped} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[regime-detect]', e);
          }
          return res;
        }
        case SELF_EVAL_JOB: {
          const res = await runSelfEvaluation(db);
          console.log(`[self-eval] bewertet=${res.evaluated} Vorschläge=${res.proposals.length}`);
          for (const p of res.proposals) {
            console.log(`[self-eval] ${p.agentName}: ${p.recommendation} — ${p.reasons.join('; ')}`);
          }
          for (const e of res.errors) console.warn('[self-eval]', e);
          return res;
        }
        case MODEL_COMPARE_JOB: {
          const res = await runModelComparison(db);
          if (res.retrained) {
            console.log(`[model-compare] Version=${res.version} Accuracy=${res.accuracy?.toFixed(3)} Verbesserung=${((res.improvement ?? 0) * 100).toFixed(1)}pp promoted=${res.promoted}`);
          } else {
            console.log(`[model-compare] ${res.reason}`);
          }
          return res;
        }
        case PERF_SNAPSHOT_JOB: {
          const snapshotType = (job.data as { type?: string })?.type as 'daily' | 'weekly' | 'monthly' ?? 'daily';
          const res = await createPerformanceSnapshots(db, snapshotType);
          if (res.snapshots > 0 || res.errors.length > 0) {
            console.log(`[perf-snapshot] typ=${snapshotType} erstellt=${res.snapshots} Fehler=${res.errors.length}`);
            for (const e of res.errors) console.warn('[perf-snapshot]', e);
          }
          return res;
        }
        case STUDY_CLUSTER_JOB: {
          const res = await recomputeStudyClusters(db);
          console.log(
            `[study-clusters] Cluster=${res.clusters} mit Vorschlag=${res.recommended} ` +
              `Trades=${res.rowsUsed} verworfen=${res.rowsSkipped}`,
          );
          return res;
        }
        default:
          return;
      }
    },
    // lockDuration großzügig (3 min): CPU-schwere Jobs (RL-Episoden, ML-Retrain) dürfen
    // länger als der 30-s-Default laufen, ohne als "stalled" zu gelten und in einen
    // Retry-Sturm zu geraten, der den Webserver verhungert. maxStalledCount als Sicherung.
    { connection, concurrency: 1, lockDuration: 180_000, maxStalledCount: 2 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[jobs] ${job?.name ?? '?'} fehlgeschlagen:`, err.message);
  });

  // Schneller Worker nur für den Positions-Monitor — unabhängig vom Rückstau der Haupt-Queue.
  const fastWorker = new Worker(
    FAST_QUEUE_NAME,
    async (job) => {
      if (job.name !== MONITOR_JOB) return;
      const res = await monitorOpenPositions(db, venue);
      if (res.fills > 0) {
        console.log(`[position-monitor] ${new Date().toISOString()} Positionen=${res.checked} Fills=${res.fills}`);
      }
      const alerts = await checkPriceAlerts(db, venue);
      if (alerts.triggered > 0) console.log(`[price-alerts] ausgelöst=${alerts.triggered}`);
      for (const e of alerts.errors) console.warn('[price-alerts]', e);
      // Demo-Modus (Session 5): ruhende Limit-Orders + SL/TP gegen echte
      // Orderbücher — fehlerisoliert, darf Monitor/Heartbeat nie blockieren.
      try {
        const demo = await monitorDemoTick(db, demoBookSource());
        if (demo.orderFills > 0 || demo.triggeredCloses > 0) {
          console.log(`[demo-monitor] Fills=${demo.orderFills} SL/TP-Closes=${demo.triggeredCloses}`);
        }
      } catch (err) {
        console.warn('[demo-monitor] Tick fehlgeschlagen:', String(err));
      }
      // Wallet-Trading (Vision-Punkt 5e): Limit-Orders + Auto-Sell — fehlerisoliert wie der Demo-Takt.
      try {
        await failStuckSwapOrders(db);
        const so = await runSwapOrders(db);
        if (so.triggered > 0) console.log(`[swap-orders] ausgelöst=${so.triggered} ausgeführt=${so.filled} fehlgeschlagen=${so.failed}`);
        for (const e of so.errors) console.warn('[swap-orders]', e);
      } catch (err) {
        console.warn('[swap-orders] Tick fehlgeschlagen:', String(err));
      }
      lastHeartbeat = new Date();
      // Heartbeat auch nach Redis — sichtbar für den getrennten Web-Prozess (/health).
      try {
        await (await queue.client).set(HEARTBEAT_KEY, String(Date.now()));
      } catch {
        // Redis-Schluckauf ist kein Job-Fehler; /health meldet dann ehrlich null/degraded.
      }
      await pingDeadMansSwitch();
      return res;
    },
    { connection, concurrency: 1, lockDuration: 60_000, maxStalledCount: 2 },
  );
  fastWorker.on('failed', (job, err) => {
    console.error(`[jobs] ${job?.name ?? '?'} fehlgeschlagen:`, err.message);
  });

  // Sofort-Läufe beim Start, damit die UI nicht auf den ersten Takt wartet
  await queue.add(SCAN_JOB, {});
  await queue.add(MACRO_JOB, {});
  await queue.add(CALENDAR_JOB, {});
  await queue.add(NEWS_JOB, {});
  await queue.add(DERIVATIVES_JOB, {});

  return {
    stop: async () => {
      await fastWorker.close();
      await worker.close();
      await fastQueue.close();
      await queue.close();
    },
  };
}
