import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,

  text,
  timestamp,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { mlModels } from './ml.js';
import { rlAgents } from './rl.js';

/**
 * Market regime classifications per symbol/timeframe.
 * Bull/Bear/Sideways/HighVol/Crisis with component scores.
 */
export const marketRegimes = pgTable(
  'market_regimes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    regime: text('regime').notNull(), // bull, bear, sideways, high_vol, crisis
    confidence: numeric('confidence').notNull(),
    components: jsonb('components').notNull(), // RegimeComponent[]
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('market_regimes_symbol_tf_ts_idx').on(t.symbol, t.timeframe, t.ts),
    index('market_regimes_regime_idx').on(t.regime),
  ],
);

/**
 * Model version history with metrics comparison.
 * Tracks every trained model version and whether it was promoted to active.
 */
export const modelVersions = pgTable(
  'model_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    modelId: integer('model_id').references(() => mlModels.id),
    version: integer('version').notNull(),
    metrics: jsonb('metrics').notNull(), // accuracy, precision, recall, f1, auc
    comparison: jsonb('comparison'), // vs previous version delta
    promoted: boolean('promoted').notNull().default(false),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    promotedBy: text('promoted_by'), // 'auto' or 'manual'
    sampleCount: integer('sample_count'),
    trainSize: integer('train_size'),
    testSize: integer('test_size'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('model_versions_model_idx').on(t.modelId),
    index('model_versions_promoted_idx').on(t.promoted),
  ],
);

/**
 * Performance snapshots for RL agents.
 * Daily/weekly/monthly rollups with equity curve, risk metrics, and regime breakdown.
 */
export const performanceSnapshots = pgTable(
  'performance_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').references(() => rlAgents.id),
    snapshotType: text('snapshot_type').notNull(), // daily, weekly, monthly
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    equityCurve: jsonb('equity_curve'), // {ts, value}[]
    metrics: jsonb('metrics').notNull(), // sharpe, sortino, calmar, max_dd, win_rate, profit_factor, var_95, es_95
    regimeBreakdown: jsonb('regime_breakdown'), // performance per regime
    benchmarkReturn: numeric('benchmark_return'), // buy-and-hold return for comparison
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('perf_snapshots_agent_idx').on(t.agentId),
    index('perf_snapshots_type_period_idx').on(t.snapshotType, t.periodStart),
  ],
);
