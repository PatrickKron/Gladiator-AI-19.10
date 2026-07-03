import { Queue, Worker } from 'bullmq';
import { requireEnv, type Db } from '@gladiator/db';
import { monitorOpenPositions, reconcile, type TradingVenue } from '@gladiator/exchange';
import { fredConfigured, syncDerivatives, syncEconomicCalendar, syncFredSeries, syncMacroSeries, syncNews } from '@gladiator/market-data';
import { runSignalScan } from './signal-scan.js';
import { runDslScan } from './dsl-scan.js';
import { reviewNewSignals } from './review.js';

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

const SCHEDULES: [string, number][] = [
  [SCAN_JOB, 5 * 60_000],
  [MONITOR_JOB, 60_000],
  [MACRO_JOB, 30 * 60_000],
  [CALENDAR_JOB, 60 * 60_000],
  [NEWS_JOB, 15 * 60_000],
  [DERIVATIVES_JOB, 30 * 60_000],
];

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
