/**
 * Integrationstest Schwarm-Review → signal_reviews gegen die ECHTE DB
 * (Server-CI via ci.sh; lokal ohne DATABASE_URL übersprungen).
 * Ohne ANTHROPIC_API_KEY müssen Makro/Shadow ehrlich als deaktiviert
 * markiert sein — im Portfolio-Verdict sichtbar, ohne erfundene Zeilen.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { PaperVenue } from '@gladiator/exchange';
import type pg from 'pg';
import { ensureSmcCoreStrategy } from './signal-scan.js';
import { reviewNewSignals } from './review.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[review.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}

const { signals, signalReviews, users } = schema;

describe.skipIf(!hasDb)('Schwarm-Review neuer Signale', () => {
  let db: Db;
  let pool: pg.Pool;
  let signalId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const { strategyId, versionId } = await ensureSmcCoreStrategy(db);
    // Test-Signal AUSSERHALB der Gate-Scopes (Symbol TEST/USDT wie im Executor-Test)
    const [s] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId,
        strategyVersionId: versionId,
        symbol: 'TEST/USDT',
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '95',
        takeProfits: ['110', '115'],
        leverageSuggested: '1',
        score: '8',
        riskClass: 'medium',
        confluence: ['BOS', 'Retest'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'new',
      })
      .returning();
    signalId = s!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${signalId}`);
    await db.delete(signals).where(eq(signals.id, signalId));
    await pool.end();
  });

  it('erzeugt Verdicts aller lauffähigen Agenten + Portfolio; Makro/Shadow deaktiviert markiert', async () => {
    const userCount = await db.select().from(users).limit(1);
    if (userCount.length === 0) {
      console.warn('[review.test] kein User in der DB — Test nicht aussagekräftig, übersprungen.');
      return;
    }

    const res = await reviewNewSignals(db, new PaperVenue());
    expect(res.reviewed).toBeGreaterThanOrEqual(1);

    const reviews = await db.select().from(signalReviews).where(eq(signalReviews.signalId, signalId));
    const agents = reviews.map((r) => r.agent).sort();
    expect(agents).toContain('technik');
    expect(agents).toContain('risk');
    expect(agents).toContain('devil');
    expect(agents).toContain('portfolio');
    // KEINE Fake-Zeilen für deaktivierte Agenten:
    expect(agents).not.toContain('makro');
    expect(agents).not.toContain('shadow');

    const portfolio = reviews.find((r) => r.agent === 'portfolio')!;
    const refs = portfolio.refs as { disabled: { agent: string; reason: string }[] };
    const disabledAgents = refs.disabled.map((d) => d.agent).sort();
    expect(disabledAgents).toEqual(['makro', 'shadow']);
    for (const r of reviews) {
      const c = Number(r.confidence);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('zweiter Lauf reviewt dasselbe Signal nicht doppelt', async () => {
    const before = await db.select().from(signalReviews).where(eq(signalReviews.signalId, signalId));
    await reviewNewSignals(db, new PaperVenue());
    const after = await db.select().from(signalReviews).where(eq(signalReviews.signalId, signalId));
    expect(after.length).toBe(before.length);
  });
});
