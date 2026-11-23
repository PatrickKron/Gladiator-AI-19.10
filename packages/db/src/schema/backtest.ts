import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { signals, strategies, strategyVersions } from './strategy.js';
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

/**
 * Autonome Signal-Studien (Welle 23): wertet benutzte (`used`: filled/closed/confirmed)
 * UND ungenutzte/verpasste (`missed`: expired/rejected) Signale look-ahead-frei über
 * 5 Studien-Parameter-Varianten + Session + echtes Makro-Event-Fenster (±120 Min.) aus.
 * Strikt getrennt von `executed_trades` (rein hypothetische Labor-Auswertung).
 */
export const signalStudies = pgTable(
  'signal_studies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    strategySlug: text('strategy_slug').notNull(),
    symbol: text('symbol').notNull(),
    venue: text('venue').notNull().default('binance'),
    timeframe: text('timeframe').notNull(),
    direction: text('direction').notNull(),
    setupType: text('setup_type').notNull(),
    signalStatus: text('signal_status').notNull(),
    usageGroup: text('usage_group').notNull(), // 'used' | 'missed'
    variant: text('variant').notNull(), // 'baseline' | 'wide_sl' | 'conservative_tp1' | 'runner_trail' | 'no_be'
    studyStatus: text('study_status').notNull(), // 'closed' | 'open' | 'no_data'
    rMultiple: numeric('r_multiple'),
    mfeR: numeric('mfe_r'),
    maeR: numeric('mae_r'),
    exitReason: text('exit_reason'),
    barsHeld: integer('bars_held'),
    session: text('session').notNull(),
    marketPhase: text('market_phase').notNull(),
    emaRegime: text('ema_regime').notNull(),
    score: numeric('score').notNull(),
    eventCategory: text('event_category').notNull().default('none'),
    eventTitle: text('event_title'),
    eventDeltaMin: integer('event_delta_min'),
    signalCreatedAt: timestamp('signal_created_at', { withTimezone: true }).notNull(),
    exitTs: timestamp('exit_ts', { withTimezone: true }),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('signal_studies_signal_variant_uidx').on(t.signalId, t.variant),
    index('signal_studies_created_idx').on(t.signalCreatedAt),
    index('signal_studies_usage_variant_idx').on(t.usageGroup, t.variant),
    index('signal_studies_session_event_idx').on(t.session, t.eventCategory),
  ],
);
