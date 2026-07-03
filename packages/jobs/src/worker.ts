import { Queue, Worker } from 'bullmq';
import { requireEnv, type Db } from '@gladiator/db';
import { monitorOpenPositions, reconcile, type TradingVenue } from '@gladiator/exchange';
import { runSignalScan } from './signal-scan.js';

/**
 * BullMQ-Worker (04_ §2: robuste Jobs statt loser Loops — der v1-Fehler).
 * signal-scan alle 5 Minuten; position-monitor jede Minute (06_ §5).
 */

const QUEUE_NAME = 'gladiator-jobs';
const SCAN_JOB = 'signal-scan';
const MONITOR_JOB = 'position-monitor';
const SCAN_EVERY_MS = 5 * 60 * 1000;
const MONITOR_EVERY_MS = 60 * 1000;

function redisConnection() {
  const url = new URL(requireEnv('REDIS_URL'));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

export async function startJobWorker(db: Db, venue: TradingVenue): Promise<{ stop: () => Promise<void> }> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });

  await queue.upsertJobScheduler(SCAN_JOB, { every: SCAN_EVERY_MS }, { name: SCAN_JOB });
  await queue.upsertJobScheduler(MONITOR_JOB, { every: MONITOR_EVERY_MS }, { name: MONITOR_JOB });

  // Absturz-Reconciliation beim Start (06_ §7c): Befunde landen im Audit-Log.
  const rec = await reconcile(db, venue);
  if (!rec.ok) console.warn('[reconciliation] Befunde:', rec.findings.join(' | '));
  else console.log('[reconciliation] sauber — Positionen und Schutz-Orders konsistent.');

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === SCAN_JOB) {
        const res = await runSignalScan(db);
        console.log(
          `[signal-scan] ${new Date().toISOString()} neu=${res.inserted} dupes=${res.skippedDuplicates} ` +
            res.scanned.map((s) => `${s.symbol}@${s.timeframe}:${s.candles}`).join(' '),
        );
        return res;
      }
      if (job.name === MONITOR_JOB) {
        const res = await monitorOpenPositions(db, venue);
        if (res.fills > 0) {
          console.log(`[position-monitor] ${new Date().toISOString()} Positionen=${res.checked} Fills=${res.fills}`);
        }
        return res;
      }
      return;
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[jobs] ${job?.name ?? '?'} fehlgeschlagen:`, err.message);
  });

  // Ein Sofort-Scan beim Start, damit die UI nicht 5 Minuten leer wartet
  await queue.add(SCAN_JOB, {});

  return {
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
