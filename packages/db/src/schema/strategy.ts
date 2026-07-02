import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import {
  assetClassEnum,
  directionEnum,
  reviewVoteEnum,
  riskClassEnum,
  setupTypeEnum,
  signalSourceEnum,
  signalStatusEnum,
  strategyKindEnum,
  strategyVersionStatusEnum,
  tierEnum,
  tradingSessionEnum,
  venueTypeEnum,
} from './enums.js';

/** Strategie-Registry (eingebaut / Pine-gemappt / DSL). */
export const strategies = pgTable('strategies', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: strategyKindEnum('kind').notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Versionierte Parameter-Sätze — Grundlage für reproduzierbare Backtests & Promotion. */
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    params: jsonb('params').notNull(),
    status: strategyVersionStatusEnum('status').notNull().default('draft'),
    /** Promotion (draft→paper→live) ist Mensch-im-Loop: wer + wann. */
    promotedBy: uuid('promoted_by').references(() => users.id),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('strategy_versions_unique_idx').on(t.strategyId, t.version)],
);

/** Kanonische Signale — EIN Modell für alle Quellen (Spiegel von @gladiator/core). */
export const signals = pgTable(
  'signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    source: signalSourceEnum('source').notNull(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id),
    strategyVersionId: uuid('strategy_version_id').references(() => strategyVersions.id),
    symbol: text('symbol').notNull(),
    assetClass: assetClassEnum('asset_class').notNull(),
    venueType: venueTypeEnum('venue_type').notNull(),
    direction: directionEnum('direction').notNull(),
    setupType: setupTypeEnum('setup_type').notNull(),
    entry: numeric('entry').notNull(),
    stopLoss: numeric('stop_loss').notNull(),
    takeProfits: numeric('take_profits').array().notNull(),
    leverageSuggested: numeric('leverage_suggested').notNull().default('1'),
    /** 0..10, IMMER echt berechnet (nie hartkodiert). */
    score: numeric('score').notNull(),
    riskClass: riskClassEnum('risk_class').notNull(),
    confluence: text('confluence').array().notNull().default([]),
    session: tradingSessionEnum('session').notNull(),
    reentry: jsonb('reentry'),
    leverageUpgrade: jsonb('leverage_upgrade'),
    status: signalStatusEnum('status').notNull().default('new'),
    tier: tierEnum('tier').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('signals_symbol_created_idx').on(t.symbol, t.createdAt),
    index('signals_strategy_idx').on(t.strategyId),
    index('signals_status_idx').on(t.status),
  ],
);

/** Agenten-Urteile am Signal (Schwarm-Review, transparent — keine Blackbox). */
export const signalReviews = pgTable(
  'signal_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    vote: reviewVoteEnum('vote').notNull(),
    /** 0..1 */
    confidence: numeric('confidence').notNull(),
    reason: text('reason').notNull(),
    refs: jsonb('refs'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('signal_reviews_signal_idx').on(t.signalId)],
);
