import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { signals } from './strategy.js';

/**
 * ML-Feature-Vektoren je Symbol/Timeframe/Zeitpunkt.
 * Berechnet aus OHLCV-Kerzen via @gladiator/ml computeFeatures().
 */
export const mlFeatures = pgTable(
  'ml_features',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    features: jsonb('features').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ml_features_unique_idx').on(t.symbol, t.timeframe, t.ts),
    index('ml_features_symbol_tf_idx').on(t.symbol, t.timeframe),
  ],
);

/**
 * Meta-Labels: War ein Signal profitabel (1) oder nicht (0)?
 * Retrospektiv berechnet aus echten Kursdaten — kein Raten.
 */
export const mlLabels = pgTable(
  'ml_labels',
  {
    id: serial('id').primaryKey(),
    signalId: uuid('signal_id').references(() => signals.id),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    signalType: text('signal_type').notNull(),
    signalDirection: text('signal_direction').notNull(),
    outcome: integer('outcome').notNull(), // 0=loss, 1=profit
    returnPct: numeric('return_pct'),
    holdingBars: integer('holding_bars'),
    features: jsonb('features'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ml_labels_signal_idx').on(t.signalId),
    index('ml_labels_symbol_tf_idx').on(t.symbol, t.timeframe),
  ],
);

/**
 * Trainierte ML-Modelle (Random Forest). Serialisiertes Modell im model_blob,
 * Performance-Metriken im metrics-JSONB. Nur EIN Modell je Symbol/TF aktiv.
 */
export const mlModels = pgTable(
  'ml_models',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    modelType: text('model_type').notNull().default('random_forest'),
    symbol: text('symbol'),
    timeframe: text('timeframe'),
    hyperparams: jsonb('hyperparams'),
    metrics: jsonb('metrics'),
    modelBlob: text('model_blob'),
    trainedAt: timestamp('trained_at', { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(false),
  },
  (t) => [
    index('ml_models_active_idx').on(t.symbol, t.timeframe, t.isActive),
  ],
);

/**
 * ML-Vorhersagen: Meta-Label-Probability + Bet Size + Truth Core für jedes Signal.
 */
export const mlPredictions = pgTable(
  'ml_predictions',
  {
    id: serial('id').primaryKey(),
    modelId: integer('model_id').references(() => mlModels.id),
    signalId: uuid('signal_id'),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    probability: numeric('probability').notNull(),
    betSize: numeric('bet_size').notNull(),
    truthCorePass: boolean('truth_core_pass').notNull().default(false),
    truthCoreReasons: jsonb('truth_core_reasons'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ml_predictions_signal_idx').on(t.signalId),
    index('ml_predictions_symbol_ts_idx').on(t.symbol, t.ts),
  ],
);
