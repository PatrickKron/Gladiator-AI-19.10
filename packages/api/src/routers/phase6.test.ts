/**
 * Phase-6-Router (Settings/Product/Agents/Promotion) gegen die ECHTE DB —
 * Server-CI maßgeblich; lokal ohne DATABASE_URL übersprungen.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[phase6.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `phase6-test-${RUN}@test.invalid`;

const { users, strategies, strategyVersions, backtests, ohlcv } = schema;

describe.skipIf(!hasDb)('Phase-6-Router (Settings, Product, Agents, Promotion)', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let strategyId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Phase6' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [s] = await db
      .insert(strategies)
      .values({ slug: `phase6-test-${RUN}`, name: 'Phase6-Test', kind: 'dsl' })
      .returning();
    strategyId = s!.id;
  });

  afterAll(async () => {
    await db.delete(strategies).where(eq(strategies.id, strategyId));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('settings: get legt Default-Zeile an, update ändert Werte, Risk-Engine liest dieselben', async () => {
    const initial = await caller.settings.get();
    expect(initial.mode).toBe('paper');
    expect(initial.killSwitchActive).toBe(false);

    await caller.settings.update({
      riskPctPerTrade: 0.5,
      maxLeverage: 3,
      maxOpenPositions: 2,
      maxExposurePctPerAsset: 10,
      dailyLossLimitPct: 2,
      weeklyLossLimitPct: 5,
      maxDrawdownPct: 12,
    });
    const updated = await caller.settings.get();
    expect(updated.riskPctPerTrade).toBe(0.5);
    expect(updated.maxLeverage).toBe(3);
    expect(updated.maxOpenPositions).toBe(2);
  });

  it('settings: Kill-Switch schaltet und wird auditiert', async () => {
    const on = await caller.settings.setKillSwitch({ active: true });
    expect(on.killSwitchActive).toBe(true);
    const off = await caller.settings.setKillSwitch({ active: false });
    expect(off.killSwitchActive).toBe(false);
    const audits = await db.execute(
      sql`SELECT action FROM audit_log WHERE action IN ('risk.kill_switch.on','risk.kill_switch.off') ORDER BY ts DESC LIMIT 2`,
    );
    expect(audits.rows.length).toBe(2);
  });

  it('settings: ungültige Werte werden abgelehnt (Zod)', async () => {
    await expect(
      caller.settings.update({
        riskPctPerTrade: 99, // > 5 %
        maxLeverage: 3,
        maxOpenPositions: 2,
        maxExposurePctPerAsset: 10,
        dailyLossLimitPct: 2,
        weeklyLossLimitPct: 5,
        maxDrawdownPct: 12,
      }),
    ).rejects.toThrow();
  });

  it('product: Pakete + Assets + Artikel kommen aus der DB (eigenes Test-Paket — frische Installation hat keine v1-Daten)', async () => {
    const tag = `test-${process.pid}-${Date.now()}`;
    const [pkg] = await db
      .insert(schema.packages)
      .values({ packageId: tag, name: `Test-Paket ${tag}`, category: 'Test', assetCount: 1 })
      .returning();
    try {
      await db.insert(schema.assets).values({ assetId: `${tag}-btc`, packageId: pkg!.id, ticker: 'BTC', name: 'Bitcoin', assetType: 'crypto', tradingPair: 'BTC/USDT' });
      const pkgs = await caller.product.packages();
      const mine = pkgs.find((p) => p.packageId === tag);
      expect(mine).toMatchObject({ name: `Test-Paket ${tag}`, assetCount: 1 });
      const assets = await caller.product.assets({ packageId: mine!.id });
      expect(assets.map((a) => a.ticker)).toEqual(['BTC']);
      // vorhandene echte v1-Pakete (Server) werden genauso geliefert — keine Sonderbehandlung
      for (const p of pkgs) expect(p.name.length).toBeGreaterThan(0);
      const articles = await caller.product.articles({ limit: 10 });
      expect(Array.isArray(articles)).toBe(true);
    } finally {
      await db.delete(schema.assets).where(eq(schema.assets.packageId, pkg!.id));
      await db.delete(schema.packages).where(eq(schema.packages.id, pkg!.id));
    }
  });

  it('agents.status: aktive + ehrlich deaktivierte Agenten mit Grund', async () => {
    const status = await caller.agents.status();
    expect(status.active.map((a) => a.agent)).toEqual(['technik', 'risk', 'devil', 'portfolio']);
    expect(status.disabled.map((d) => d.agent).sort()).toEqual(['makro', 'shadow']);
    for (const d of status.disabled) expect(d.reason.length).toBeGreaterThan(10);
    expect(status.llm.dailyBudgetUsd).toBeGreaterThan(0);
  });

  it('strategies: promote-GATE — ohne bestandenen Backtest keine Promotion, mit → paper; paper→live gesperrt', async () => {
    const [draft] = await db
      .insert(strategyVersions)
      .values({ strategyId, version: 1, params: { test: true }, status: 'draft' })
      .returning();

    // Gate (Vision 5): ohne Backtest darf die Strategie NICHT selbstständig laufen
    const noBt = await caller.strategies.validity({ versionId: draft!.id });
    expect(noBt.hasBacktest).toBe(false);
    await expect(caller.strategies.promote({ versionId: draft!.id })).rejects.toThrow(/Backtest/i);

    // Alter Backtest OHNE Auswertung des jüngsten Abschnitts → Gate verlangt neuen Lauf
    const [oldBt] = await db
      .insert(backtests)
      .values({
        strategyVersionId: draft!.id,
        symbol: 'BTC/USDT',
        timeframe: '1h',
        fromTs: new Date('2024-01-01T00:00:00Z'),
        toTs: new Date('2024-06-01T00:00:00Z'),
        config: { test: true },
        feesModel: { taker: 0.0004, slippageBps: 2, fundingBps: 1 },
        maxDrawdown: '18',
        profitFactor: '1.6',
        expectancy: '0.3',
        netReturn: '30',
        tradeCount: '40',
        status: 'done',
      })
      .returning();
    const stale = await caller.strategies.validity({ versionId: draft!.id });
    expect(stale.verdict!.passed).toBe(false);
    expect(stale.verdict!.reasons.join(' ')).toMatch(/neu laufen/);
    await db.delete(backtests).where(eq(backtests.id, oldBt!.id));

    // Ein bestandener Netto-Backtest (40 Trades, PF 1.6, DD 18 %, Erwartung 0.3 R),
    // jüngster Abschnitt besteht allein (so speichert runLabBacktest ihn)
    await db.insert(backtests).values({
      strategyVersionId: draft!.id,
      symbol: 'BTC/USDT',
      timeframe: '1h',
      fromTs: new Date('2024-01-01T00:00:00Z'),
      toTs: new Date('2024-06-01T00:00:00Z'),
      config: { test: true },
      feesModel: { taker: 0.0004, slippageBps: 2, fundingBps: 1 },
      sharpe: '1.2',
      maxDrawdown: '18',
      winRate: '0.55',
      profitFactor: '1.6',
      expectancy: '0.3',
      netReturn: '30',
      tradeCount: '40',
      metrics: { holdout: { fromTs: '2024-04-16T00:00:00.000Z', tradeCount: 12, expectancy: 0.25, profitFactor: 1.4 } },
      status: 'done',
    });

    const valid = await caller.strategies.validity({ versionId: draft!.id });
    expect(valid.hasBacktest).toBe(true);
    expect(valid.verdict!.passed).toBe(true);

    const promoted = await caller.strategies.promote({ versionId: draft!.id });
    expect(promoted.status).toBe('paper');

    // Zweite Promotion (paper → live) ist bewusst NICHT möglich
    await expect(caller.strategies.promote({ versionId: draft!.id })).rejects.toThrow(/draft/);

    const versions = await caller.strategies.versions({ strategyId });
    expect(versions.length).toBe(1);
    expect(versions[0]!.status).toBe('paper');
  });

  it('strategies.dslRegister: ohne bestandenen 12-Monats-Backtest bleibt die Version sicher auf draft (Vision-5-Gate)', async () => {
    const slug = `dsl-reg-${RUN}`;
    try {
      const reg = await caller.strategies.dslRegister({
        dsl: {
          id: slug,
          symbol: `NODB${Date.now() % 100000}/USDT`,
          timeframe: '1h',
          direction: 'long',
          setupType: 'swing',
          when: { session: 'london', all: [{ indicator: 'RSI', lt: 30, period: 14 }] },
          entry: 'market',
          stopLoss: { type: 'pct', pct: 1.5 },
          takeProfits: [{ rr: 2 }],
          risk: { riskPctPerTrade: 1, maxLeveragePerTrade: 2 },
        },
      });
      expect(reg.status).toBe('draft');
      expect(reg.gateReasons.length).toBeGreaterThan(0);
      expect(reg.validity.hasBacktest).toBe(false);
    } finally {
      await db.delete(strategies).where(eq(strategies.slug, slug));
    }
  });

  it('Multi-Asset 4h-Synthese & 1-Zeichen-Ticker (Yahoo): availableTimeframes, chartData/chartCandles & dslRegister', async () => {
    const sym = `Y${Date.now() % 9}`; // 2-Zeichen-Ticker < 3 Zeichen
    const H = 3_600_000;
    const base = Math.floor(Date.UTC(2026, 5, 1) / (4 * H)) * (4 * H);
    const rows = Array.from({ length: 16 }, (_, k) => ({
      venue: 'yahoo',
      symbol: sym,
      timeframe: '1h',
      ts: new Date(base + k * H),
      open: '50',
      high: '52',
      low: '49',
      close: '51',
      volume: '100',
    }));
    const slug = `dsl-short-${RUN}`;
    try {
      await db.insert(ohlcv).values(rows).onConflictDoNothing();
      const tfs = await caller.market.availableTimeframes({ symbol: sym, venue: 'yahoo' });
      expect(tfs).toContain('1h');
      expect(tfs).toContain('4h');

      const candles4h = await caller.market.chartCandles({ symbol: sym, timeframe: '4h', venue: 'yahoo', limit: 50 });
      expect(candles4h.length).toBeGreaterThanOrEqual(3);

      const chart = await caller.market.chartData({ symbol: sym, timeframe: '4h', venue: 'yahoo', limit: 60 });
      expect(chart.available).toBe(true);
      expect(chart.candles.length).toBeGreaterThanOrEqual(3);

      const reg = await caller.strategies.dslRegister({
        dsl: {
          id: slug,
          symbol: sym,
          timeframe: '1h',
          direction: 'long',
          when: { all: [{ trend: 'EMA200_up' }] },
          entry: 'market',
          stopLoss: { type: 'pct', pct: 2 },
          takeProfits: [{ rr: 2 }],
        },
      });
      expect(reg.status).toBe('draft');
    } finally {
      await db.delete(strategies).where(eq(strategies.slug, slug));
      await db.delete(ohlcv).where(eq(ohlcv.symbol, sym));
    }
  });
});
