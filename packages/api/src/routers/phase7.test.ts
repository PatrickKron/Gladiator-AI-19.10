/**
 * Phase-7-Flows gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen):
 * Live-Freigabe pro Venue (Phrase, Konflikt, Widerruf, Audit) und
 * Nacht-Pipeline-Idempotenz (ein Briefing pro Tag).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { runNightPipeline } from '@gladiator/jobs';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[phase7.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `phase7-test-${RUN}@test.invalid`;
const { users, venueApprovals, briefings } = schema;

describe.skipIf(!hasDb)('Phase 7: Live-Freigabe + Nacht-Pipeline', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Phase7' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    // Saubere Ausgangslage für das Test-Venue
    await db.delete(venueApprovals).where(eq(venueApprovals.venueId, 'hyperliquid-testnet'));
  });

  afterAll(async () => {
    await db.delete(venueApprovals).where(eq(venueApprovals.venueId, 'hyperliquid-testnet'));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('falsche Bestätigungsphrase → abgelehnt, KEINE Freigabe entsteht', async () => {
    await expect(
      caller.trading.approveVenue({ venueId: 'hyperliquid-testnet', confirmation: 'ja bitte' }),
    ).rejects.toThrow(/Bestätigungsphrase/);
    const list = await caller.trading.approvals();
    expect(list.find((a) => a.venueId === 'hyperliquid-testnet')!.approved).toBe(false);
  });

  it('exakte Phrase → Freigabe aktiv + auditiert; Doppel-Freigabe → CONFLICT; Widerruf funktioniert', async () => {
    await caller.trading.approveVenue({
      venueId: 'hyperliquid-testnet',
      confirmation: 'LIVE-FREIGABE hyperliquid-testnet',
      note: 'Testlauf',
    });
    let list = await caller.trading.approvals();
    expect(list.find((a) => a.venueId === 'hyperliquid-testnet')!.approved).toBe(true);

    await expect(
      caller.trading.approveVenue({ venueId: 'hyperliquid-testnet', confirmation: 'LIVE-FREIGABE hyperliquid-testnet' }),
    ).rejects.toThrow(/aktive Freigabe/);

    const audits = await db.execute(
      sql`SELECT action FROM audit_log WHERE action = 'venue.live_approval.granted' ORDER BY ts DESC LIMIT 1`,
    );
    expect(audits.rows.length).toBe(1);

    await caller.trading.revokeVenue({ venueId: 'hyperliquid-testnet' });
    list = await caller.trading.approvals();
    const entry = list.find((a) => a.venueId === 'hyperliquid-testnet')!;
    expect(entry.approved).toBe(false);
    expect(entry.lastRevokedAt).not.toBeNull();
  });

  it('Nacht-Pipeline: EIN Briefing pro Tag (idempotent), Inhalt aus echten Daten', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await db.delete(briefings).where(eq(briefings.day, day));

    const first = await runNightPipeline(db);
    expect(first.day).toBe(day);
    expect(first.created).toBe(true);

    const second = await runNightPipeline(db);
    expect(second.created).toBe(false); // idempotent

    const briefing = await caller.system.briefing();
    expect(briefing).not.toBeNull();
    expect(briefing!.day).toBe(day);
    expect(briefing!.text).toMatch(/Morning-Briefing/);
    expect(briefing!.text).toMatch(/Konto/);
    // Ohne Telegram-Konfiguration in CI: nicht versendet — ehrlich.
    if (!process.env.TELEGRAM_BOT_TOKEN) expect(first.sent).toBe(false);
  });
});
