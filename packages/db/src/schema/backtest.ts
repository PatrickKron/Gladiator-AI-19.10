import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { strategies, strategyVersions } from './strategy.js';
import { runStatusEnum } from './enums.js';

/**
 * Backtests — IMMER mit Kostenmodell (feesModel Pflicht): Gebühren, Slippage, Funding.
 * Kennzahlen-Spalten sind NETTO-Werte. Ohne Kostenmodell keine Promotion (08_ §3a).
 */
export const backtests = pgTable(
  'backtests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    fromTs: timestamp('from_ts', { withTimezone: true }).notNull(),
    toTs: timestamp('to_ts', { withTimezone: true }).notNull(),
    /** Engine-Konfiguration inkl. PFLICHT-Kostenmodell (fees/slippage/funding). */
    config: jsonb('config').notNull(),
    feesModel: jsonb('fees_model').notNull(),
    // Kern-Metriken (netto) als Spalten für Abfragen; Rest in metrics.
    sharpe: numeric('sharpe'),
    sortino: numeric('sortino'),
    maxDrawdown: numeric('max_drawdown'),
    winRate: numeric('win_rate'),
    profitFactor: numeric('profit_factor'),
    expectancy: numeric('expectancy'),
    netReturn: numeric('net_return'),
    tradeCount: numeric('trade_count'),
    metrics: jsonb('metrics'),
    status: runStatusEnum('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backtests_version_idx').on(t.strategyVersionId)],
);

/** Walk-Forward-Läufe (In-Sample-Optimierung → Out-of-Sample-Validierung). */
export const walkforwardRuns = pgTable(
  'walkforward_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'cascade' }),
    config: jsonb('config').notNull(),
    /** Fenster-Definitionen + je Fenster IS/OOS-Metriken. */
    windows: jsonb('windows'),
    oosMetrics: jsonb('oos_metrics'),
    status: runStatusEnum('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('walkforward_runs_version_idx').on(t.strategyVersionId)],
);

/** Parameter-Optimierungen (Grid/Bayesian/Hyperopt) — erzeugen VORSCHLÄGE, keine Auto-Promotion. */
export const optimizations = pgTable(
  'optimizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    baseVersionId: uuid('base_version_id').references(() => strategyVersions.id),
    method: text('method').notNull(),
    paramSpace: jsonb('param_space').notNull(),
    results: jsonb('results'),
    bestParams: jsonb('best_params'),
    bestScore: numeric('best_score'),
    status: runStatusEnum('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('optimizations_strategy_idx').on(t.strategyId)],
);
