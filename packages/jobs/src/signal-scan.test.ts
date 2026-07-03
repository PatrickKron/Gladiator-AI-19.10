/**
 * Integrationstest Scan → Persistenz → Dedupe gegen die ECHTE DB
 * (läuft auf dem Server via ci.sh; lokal ohne DATABASE_URL übersprungen).
 * Nutzt die echten BTC-Kerzen aus der DB — erfindet nichts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { ensureSmcCoreStrategy, runSignalScan } from './signal-scan.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[signal-scan.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}

describe.skipIf(!hasDb)('Signal-Scan (Multi-TF, echte Kerzen)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    await pool.end();
  });

  it('registriert die SMC-Core-Strategie idempotent (v1, Status paper)', async () => {
    const first = await ensureSmcCoreStrategy(db);
    const second = await ensureSmcCoreStrategy(db);
    expect(first.strategyId).toBe(second.strategyId);
    expect(first.versionId).toBe(second.versionId);
  });

  it('scannt alle Symbol×TF-Kombinationen und dedupliziert beim zweiten Lauf', async () => {
    const first = await runSignalScan(db);
    // 3 Symbole × 4 TFs = 12 Scans (auch wenn 15m evtl. noch ohne Historie ist)
    expect(first.scanned).toHaveLength(12);
    for (const s of first.scanned) {
      expect(s.candles).toBeGreaterThanOrEqual(0);
    }

    // Zweiter Lauf direkt danach: identische Marktlage → alles Duplikate, nichts Neues
    const second = await runSignalScan(db);
    expect(second.inserted).toBe(0);

    // Persistierte Signale (falls die aktuelle Marktlage Setups hergibt) sind valide
    const rows = await db.execute(sql`
      SELECT score::float AS score, entry::float AS entry, stop_loss::float AS sl,
             direction, timeframe, status
      FROM signals WHERE source = 'engine' ORDER BY created_at DESC LIMIT 20
    `);
    for (const r of rows.rows as { score: number; entry: number; sl: number; direction: string; status: string }[]) {
      expect(r.score).toBeGreaterThanOrEqual(6);
      expect(r.score).toBeLessThanOrEqual(10);
      if (r.direction === 'long') expect(r.sl).toBeLessThan(r.entry);
      else expect(r.sl).toBeGreaterThan(r.entry);
    }
  });
});
