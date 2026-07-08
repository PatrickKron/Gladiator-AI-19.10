/**
 * Workshop-Flows gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): Sitzungs-CRUD, Entwurfs-Validierung, Vorschlags-Übernahme,
 * Draft-Backtest gegen echte Kerzen, Version speichern/wiederherstellen.
 * LLM-Prozeduren (analyze/chat) werden hier NICHT gegen die echte API getestet
 * (Kosten/Flakiness) — deren Logik ist in workshop/llm.test.ts mit Fake-Provider
 * abgedeckt; ohne Key liefern sie PRECONDITION_FAILED (hier mitgeprüft, falls
 * kein Key gesetzt ist).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[workshop.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `workshop-test-${RUN}@test.invalid`;
const SLUG = `workshop-test-${RUN}`;
const { users, strategies, workshopSessions } = schema;

const VALID_DSL = {
  id: SLUG,
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  when: { all: [{ priceVs: { kind: 'EMA', period: 50, is: 'above' } }, { adx: { gt: 15 } }] },
  entry: 'market',
  stopLoss: { type: 'ATR', mult: 2 },
  takeProfits: [{ rr: 1.5 }, { rr: 3 }],
  risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
};

describe.skipIf(!hasDb)('Workshop: Sitzungen, Entwurf, Backtest, Versionen', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let sessionId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Workshop' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
  });

  afterAll(async () => {
    // strategies.createdBy hat KEIN cascade — Strategie explizit vor dem User löschen.
    await db.delete(strategies).where(eq(strategies.slug, SLUG));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('create → list → get (mit Pine-Quelle)', async () => {
    const created = await caller.workshop.create({
      name: `Workshop-Test ${RUN}`,
      pineSource: '//@version=5\nstrategy("RSI Dip")\nrsi = ta.rsi(close, 14)',
    });
    sessionId = created.id;
    expect(created.pineSource).toContain('RSI Dip');

    const list = await caller.workshop.list();
    expect(list.some((s) => s.id === sessionId)).toBe(true);

    const got = await caller.workshop.get({ id: sessionId });
    expect(got.session.name).toContain('Workshop-Test');
    expect(got.messages).toEqual([]);
  });

  it('update: Anweisungen + Name pflegen', async () => {
    const updated = await caller.workshop.update({ id: sessionId, instructions: 'Konservativ, kein FOMO.' });
    expect(updated.instructions).toBe('Konservativ, kein FOMO.');
  });

  it('updateDraft: ungültige DSL → ok:false mit Fehlern; valide DSL → gespeichert (Defaults angewandt)', async () => {
    const bad = await caller.workshop.updateDraft({ id: sessionId, dsl: { id: 'x' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);

    const good = await caller.workshop.updateDraft({ id: sessionId, dsl: VALID_DSL });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.dsl.setupType).toBe('swing'); // Default angewandt
      expect(good.dsl.when.all).toHaveLength(2);
    }
    const got = await caller.workshop.get({ id: sessionId });
    expect((got.session.draftDsl as { id: string }).id).toBe(SLUG);
  });

  it('applyProposal: Vorschlag aus Coach-Nachricht wird erst per Klick Entwurf', async () => {
    const { workshopMessages } = schema;
    const proposal = { ...VALID_DSL, stopLoss: { type: 'pct', pct: 3 } };
    const [msg] = await db
      .insert(workshopMessages)
      .values({ sessionId, role: 'assistant', content: 'Vorschlag: SL auf 3 %.', proposedDsl: proposal })
      .returning();
    const applied = await caller.workshop.applyProposal({ id: sessionId, messageId: msg!.id });
    expect(applied.dsl.stopLoss).toEqual({ type: 'pct', pct: 3 });
    // Zurück auf ATR-Variante für die Folge-Tests.
    const back = await caller.workshop.updateDraft({ id: sessionId, dsl: VALID_DSL });
    expect(back.ok).toBe(true);
  });

  it('runBacktest: Entwurf gegen echte Kerzen (netto) — oder ehrlicher Fehler bei zu wenig Historie', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86_400_000);
    const candles = await getOhlcv(db, { symbol: 'BTC/USDT', timeframe: '1h', since: from, until: to });

    if (candles.length < 250) {
      // Ehrlicher Pfad: Engine lehnt dünne Daten ab, Lauf wird als error persistiert.
      await expect(
        caller.workshop.runBacktest({ id: sessionId, from: from.toISOString(), to: to.toISOString() }),
      ).rejects.toThrow(/Zu wenig echte Kerzen/);
      const runs = await caller.workshop.backtests({ id: sessionId });
      expect(runs[0]!.status).toBe('error');
      return;
    }

    const out = await caller.workshop.runBacktest({
      id: sessionId,
      label: `Set-A ${RUN}`,
      from: from.toISOString(),
      to: to.toISOString(),
      riskPctPerTrade: 1,
    });
    expect(out.candles).toBeGreaterThanOrEqual(250);
    expect(out.metrics.tradeCount).toBeGreaterThanOrEqual(0);
    expect(out.equityCurve.length).toBeGreaterThan(0);
    expect(out.equityCurve.length).toBeLessThanOrEqual(401);

    const runs = await caller.workshop.backtests({ id: sessionId });
    const row = runs.find((r) => r.label === `Set-A ${RUN}`);
    expect(row?.status).toBe('done');
    expect(row?.metrics).toBeTruthy();

    const trades = await caller.workshop.backtestTrades({ id: sessionId, backtestId: row!.id });
    expect(Array.isArray(trades)).toBe(true);
  });

  it('saveVersion: Entwurf → strategies (dsl) + Version 1 (draft, NICHT paper) + Session-Verknüpfung', async () => {
    const saved = await caller.workshop.saveVersion({ id: sessionId });
    expect(saved.version).toBe(1);
    expect(saved.status).toBe('draft');

    const got = await caller.workshop.get({ id: sessionId });
    expect(got.session.strategyId).toBe(saved.strategyId);

    const versions = await caller.workshop.versions({ id: sessionId });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe('draft');
  });

  it('zweite Version + restoreVersion holt Version 1 in den Entwurf zurück', async () => {
    const v2Dsl = { ...VALID_DSL, stopLoss: { type: 'pct', pct: 2.5 } };
    const upd = await caller.workshop.updateDraft({ id: sessionId, dsl: v2Dsl });
    expect(upd.ok).toBe(true);
    const saved2 = await caller.workshop.saveVersion({ id: sessionId });
    expect(saved2.version).toBe(2);

    const versions = await caller.workshop.versions({ id: sessionId });
    const v1 = versions.find((v) => v.version === 1)!;
    const restored = await caller.workshop.restoreVersion({ id: sessionId, versionId: v1.id });
    expect(restored.version).toBe(1);
    expect(restored.dsl.stopLoss).toEqual({ type: 'ATR', mult: 2 });
  });

  it('ohne ANTHROPIC_API_KEY: analyze/chat scheitern EHRLICH mit Klartext (falls Key fehlt)', async () => {
    if (process.env.ANTHROPIC_API_KEY) return; // Server hat Key — LLM-Pfad ist per Fake-Provider getestet.
    await expect(caller.workshop.analyze({ id: sessionId })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(caller.workshop.chat({ id: sessionId, message: 'Hallo' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('remove: Sitzung löschen (cascade auf Messages/Backtests), Strategie bleibt', async () => {
    await caller.workshop.remove({ id: sessionId });
    await expect(caller.workshop.get({ id: sessionId })).rejects.toThrow(/nicht gefunden/);
    const [strategy] = await db.select().from(strategies).where(eq(strategies.slug, SLUG)).limit(1);
    expect(strategy).toBeTruthy();
    const rows = await db.select().from(workshopSessions).where(eq(workshopSessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });
});
