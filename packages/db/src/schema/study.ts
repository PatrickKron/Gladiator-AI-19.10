import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { executedTrades } from './trading.js';
import { directionEnum } from './enums.js';

/**
 * VDB1 — study_trades: „eine Zeile = ein Trade" (13_SELBSTOPTIMIERUNG §3).
 * NUR echte geschlossene Trades oder echte Backtests — nie simulierte Zufallsausgänge.
 * Cluster-Key: package|asset|strategy|style|timeframe|session|market_structure.
 */
export const studyTrades = pgTable(
  'study_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterKey: text('cluster_key').notNull(),
    executedTradeId: uuid('executed_trade_id').references(() => executedTrades.id),
    direction: directionEnum('direction').notNull(),
    entryTs: timestamp('entry_ts', { withTimezone: true }).notNull(),
    exitTs: timestamp('exit_ts', { withTimezone: true }).notNull(),
    mfeBps: numeric('mfe_bps'),
    maeBps: numeric('mae_bps'),
    rMultiple: numeric('r_multiple').notNull(),
    session: text('session'),
    marketStructure: text('market_structure'),
    // Netto-Kosten (Pflicht — Kennzahlen rechnen netto)
    fees: numeric('fees').notNull().default('0'),
    funding: numeric('funding').notNull().default('0'),
    slippage: numeric('slippage').notNull().default('0'),
    netPnl: numeric('net_pnl').notNull(),
    liquidationFlag: boolean('liquidation_flag').notNull().default(false),
    // TP-Schema-Simulationsfelder: was hätte Schema A/B/C/D an R gebracht
    pnlRTpA: numeric('pnl_r_tp_a'),
    pnlRTpB: numeric('pnl_r_tp_b'),
    pnlRTpC: numeric('pnl_r_tp_c'),
    pnlRTpD: numeric('pnl_r_tp_d'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('study_trades_cluster_idx').on(t.clusterKey), index('study_trades_exit_idx').on(t.exitTs)],
);

/**
 * VDB2 — study_clusters: gelernte optimale Parameter pro Cluster (13_ §6).
 * WICHTIG (Governance): Der user-facing Chatbot hat KEINEN Zugriff auf diese Tabelle.
 * Vektor-Repräsentation vorerst als jsonb; pgvector folgt, wenn semantische Suche gebaut wird.
 */
export const studyClusters = pgTable('study_clusters', {
  clusterKey: text('cluster_key').primaryKey(),
  optimalLeverage: numeric('optimal_leverage'),
  optimalTpSchemaId: text('optimal_tp_schema_id'),
  optimalRiskPct: numeric('optimal_risk_pct'),
  rapsScore: numeric('raps_score'),
  sharpe: numeric('sharpe'),
  sortino: numeric('sortino'),
  calmar: numeric('calmar'),
  winrate: numeric('winrate'),
  profitFactor: numeric('profit_factor'),
  expectancy: numeric('expectancy'),
  tradeCount: integer('trade_count').notNull().default(0),
  dataWindowDays: integer('data_window_days'),
  lambdaTimeDecay: numeric('lambda_time_decay'),
  isLowSampleSize: boolean('is_low_sample_size').notNull().default(true),
  changelog: jsonb('changelog'),
  /** Natürlichsprachige KI-Begründung jeder Parameteränderung (Transparenz-Pflicht). */
  causalityExplanation: text('causality_explanation'),
  embedding: jsonb('embedding'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
