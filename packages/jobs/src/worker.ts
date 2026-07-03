import { Queue, Worker } from 'bullmq';
import { requireEnv, type Db } from '@gladiator/db';
import { runSignalScan } from './signal-scan.js';

/**
 * BullMQ-Worker (04_ §2: robuste Jobs statt loser Loops — der v1-Fehler).
 * signal-scan läuft wiederholt alle 5 Minuten; Ergebnisse werden geloggt.
 */

const QUEUE_NAME = 'gladiator-jobs';
const SCAN_JOB = 'signal-scan';
const SCAN_EVERY_MS = 5 * 60 * 1000;

function redisConnection() {
  const url = new URL(requireEnv('REDIS_URL'));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

export async function startJobWorker(db: Db): Promise<{ stop: () => Promise<void> }> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });

  await queue.upsertJobScheduler(SCAN_JOB, { every: SCAN_EVERY_MS }, { name: SCAN_JOB });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== SCAN_JOB) return;
      const res = await runSignalScan(db);
      console.log(
        `[signal-scan] ${new Date().toISOString()} neu=${res.inserted} dupes=${res.skippedDuplicates} ` +
          res.scanned.map((s) => `${s.symbol}@${s.timeframe}:${s.candles}`).join(' '),
      );
      return res;
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
