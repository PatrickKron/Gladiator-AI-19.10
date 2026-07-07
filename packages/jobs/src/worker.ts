import { Queue, Worker } from 'bullmq';
import { requireEnv, type Db } from '@gladiator/db';
import { monitorOpenPositions, reconcile, type TradingVenue } from '@gladiator/exchange';
import { fredConfigured, syncDerivatives, syncEconomicCalendar, syncFredSeries, syncMacroSeries, syncNews } from '@gladiator/market-data';
import { runNightPipeline } from './briefing.js';
import { runSignalScan } from './signal-scan.js';
import { runDslScan } from './dsl-scan.js';
import { reviewNewSignals } from './review.js';
import { checkPriceAlerts } from './alerts.js';
import { runSubAgents } from './sub-agent-runner.js';
import { computeAllFeatures, autoLabelSignals, retrainModel } from './ml-pipeline.js';
import { runRlEpisodes, aggregateRlPerformance, rebalanceRlWeights } from './rl-pipeline.js';

/**
 * BullMQ-Worker (04_ §2: robuste Jobs statt loser Loops — der v1-Fehler).
 * signal-scan 5 min · position-monitor 1 min · macro-sync 30 min ·
 * calendar-sync 60 min · news-sync 15 min · derivatives-sync 30 min.
 */

const QUEUE_NAME = 'gladiator-jobs';
const SCAN_JOB = 'signal-scan';
const MONITOR_JOB = 'position-monitor';
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

/**
 * Worker-Heartbeat (Phase 7): /health prüft das Alter; der Monitor-Job pingt
 * zusätzlich HEALTHCHECKS_URL (externer Dead-Man's-Switch, legt Patrick an —
 * bleiben die Pings aus, alarmiert der externe Dienst unabhängig vom Server).
 */
let lastHeartbeat: Date | null = null;
export function workerHeartbeatAgeSec(): number | null {
  return lastHeartbeat ? Math.floor((Date.now() - lastHeartbeat.getTime()) / 1000) : null;
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

const SCHEDULES: [string, number][] = [
  [SCAN_JOB, 5 * 60_000],
  [MONITOR_JOB, 60_000],
  [MACRO_JOB, 30 * 60_000],
  [CALENDAR_JOB, 60 * 60_000],
  [NEWS_JOB, 15 * 60_000],
  [DERIVATIVES_JOB, 30 * 60_000],
  [SUB_AGENT_JOB, 5 * 60_000],
  [ML_FEATURES_JOB, 30 * 60_000],     // Feature-Berechnung alle 30 min
  [ML_LABEL_JOB, 60 * 60_000],         // Auto-Labeling stündlich
  [RL_EPISODE_JOB, 30 * 60_000],       // RL-Episoden alle 30 min
];

/** Nacht-Pipeline: täglich 03:30 UTC (08_ §5) — Cron statt Intervall. */
const NIGHT_CRON = '30 3 * * *';
/** ML-Retraining: wöchentlich sonntags 04:00 UTC — genug Labels sammeln vor Neutraining. */
const ML_RETRAIN_CRON = '0 4 * * 0';
/** RL-Performance-Aggregation: täglich 23:55 UTC — Tages-Rollup der Agenten-Metriken. */
const RL_PERF_CRON = '55 23 * * *';
/** RL-HRP-Rebalancing: sonntags 05:00 UTC — wöchentliche Portfolio-Gewichtung. */
const RL_REBALANCE_CRON = '0 5 * * 0';

function redisConnection() {
  const url = new URL(requireEnv('REDIS_URL'));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

export async function startJobWorker(db: Db, venue: TradingVenue): Promise<{ stop: () => Promise<void> }> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });

  for (const [name, every] of SCHEDULES) {
    await queue.upsertJobScheduler(name, { every }, { name });
  }
  await queue.upsertJobScheduler(NIGHT_JOB, { pattern: NIGHT_CRON }, { name: NIGHT_JOB });
  await queue.upsertJobScheduler(ML_RETRAIN_JOB, { pattern: ML_RETRAIN_CRON }, { name: ML_RETRAIN_JOB });
  await queue.upsertJobScheduler(RL_PERF_JOB, { pattern: RL_PERF_CRON }, { name: RL_PERF_JOB });
  await queue.upsertJobScheduler(RL_REBALANCE_JOB, { pattern: RL_REBALANCE_CRON }, { name: RL_REBALANCE_JOB });

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
        case MONITOR_JOB: {
          const res = await monitorOpenPositions(db, venue);
          if (res.fills > 0) {
            console.log(`[position-monitor] ${new Date().toISOString()} Positionen=${res.checked} Fills=${res.fills}`);
          }
          const alerts = await checkPriceAlerts(db, venue);
          if (alerts.triggered > 0) console.log(`[price-alerts] ausgelöst=${alerts.triggered}`);
          for (const e of alerts.errors) console.warn('[price-alerts]', e);
          lastHeartbeat = new Date();
          await pingDeadMansSwitch();
          return res;
        }
        case NIGHT_JOB: {
          const res = await runNightPipeline(db);
          console.log(`[night-pipeline] ${res.day} erstellt=${res.created} versendet=${res.sent}`);
          return res;
        }
        case MACRO_JOB: {
          const res = await syncMacroSeries(db);
          console.log(
            `[macro-sync] ${res.series.map((s) => `${s.seriesId}:${s.latest ?? '—'}`).join(' ')} Fehler=${res.errors.length}`,
          );
          for (const e of res.errors) console.warn('[macro-sync]', e);
          if (fredConfigured()) {
            const fred = await syncFredSeries(db);
            console.log(`[macro-sync] FRED: ${fred.synced.join(',') || 'nichts'}`);
          }
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
          const res = await runRlEpisodes(db);
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
        default:
          return;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
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
      await worker.close();
      await queue.close();
    },
  };
}
