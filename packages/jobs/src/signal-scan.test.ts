/**
 * Integrationstest Scan → Persistenz → Dedupe gegen die ECHTE DB
 * (läuft auf dem Server via ci.sh; lokal ohne DATABASE_URL übersprungen).
 * Nutzt die echten BTC-Kerzen aus der DB — erfindet nichts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { ensureSmcCoreStrategy, runSignalScan, scanTargets } from './signal-scan.js';

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

  it('hält die Kerzen der BASIS-Symbole frisch (Befund: Seed-Kerzen veralteten für immer)', async () => {
    await runSignalScan(db);
    const rows = await db.execute(sql`
      SELECT symbol, max(ts) AS ts FROM ohlcv
      WHERE symbol IN ('BTC/USDT', 'ETH/USDT', 'SOL/USDT') AND timeframe = '15m'
      GROUP BY symbol
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows as { symbol: string; ts: string }[]) {
      const ageMs = Date.now() - new Date(r.ts).getTime();
      // < 4 Intervalle: letzte ABGESCHLOSSENE 15m-Kerze + Puffer (echte Börse, kein Fake)
      expect(ageMs, `${r.symbol}: letzte 15m-Kerze ist ${Math.round(ageMs / 60_000)} min alt`).toBeLessThan(4 * 900_000);
    }
  }, 180_000);

  it('scannt alle Symbol×TF-Kombinationen und dedupliziert beim zweiten Lauf', async () => {
    const startedAt = new Date();
    const first = await runSignalScan(db);
    // Universum ist dynamisch (Asset-Register: Basis + ★ Favoriten + Hinzugefügte, jede Quelle) × 4 TFs —
    // die Erwartung wird aus derselben Quelle berechnet, nicht hart kodiert.
    const { targets } = await scanTargets(db);
    expect(targets.length).toBeGreaterThanOrEqual(3);
    expect(first.scanned).toHaveLength(targets.length * 4);
    for (const s of first.scanned) expect(targets.some((t) => t.symbol === s.symbol && t.venue === s.venue)).toBe(true);
    for (const s of first.scanned) {
      expect(s.candles).toBeGreaterThanOrEqual(0);
    }

    // Zweiter Lauf direkt danach: identische Marktlage → alles Duplikate, nichts Neues
    const second = await runSignalScan(db);
    expect(second.inserted).toBe(0);

    // Persistierte Signale (falls die aktuelle Marktlage Setups hergibt) sind valide
    const rows = await db.execute(sql`
      SELECT score::float AS score, entry::float AS entry, stop_loss::float AS sl,
             direction, timeframe, status, venue, asset_class
      FROM signals WHERE source = 'engine' ORDER BY created_at DESC LIMIT 20
    `);
    for (const r of rows.rows as { score: number; entry: number; sl: number; direction: string; status: string; venue: string; asset_class: string }[]) {
      expect(['binance', 'yahoo', 'twelvedata']).toContain(r.venue);
      if (r.venue === 'binance') expect(r.asset_class).toBe('crypto');
      expect(r.score).toBeGreaterThanOrEqual(6);
      expect(r.score).toBeLessThanOrEqual(10);
      if (r.direction === 'long') expect(r.sl).toBeLessThan(r.entry);
      else expect(r.sl).toBeGreaterThan(r.entry);
    }

    // 05_ §9: Jedes NEU erzeugte Engine-Signal trägt Reentry-Plan + Leverage-Upgrade-Bedingungen.
    const fresh = await db.execute(sql`
      SELECT setup_type, reentry, leverage_upgrade FROM signals
      WHERE source = 'engine' AND created_at >= ${startedAt}
    `);
    for (const r of fresh.rows as { setup_type: string; reentry: { minPullbackPct: number } | null; leverage_upgrade: { triggerPct: number } | null }[]) {
      expect(r.reentry, r.setup_type).not.toBeNull();
      expect(r.leverage_upgrade?.triggerPct).toBeGreaterThan(0);
    }
  });
});
