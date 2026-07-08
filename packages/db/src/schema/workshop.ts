import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { strategies } from './strategy.js';
import { runStatusEnum } from './enums.js';

/**
 * Strategie-Workshop: Pine-Script → KI-Analyse → interaktiver Dialog →
 * Agent-Konfiguration (Instruction-DSL) → Draft-Backtests → Version → Paper.
 *
 * Draft-Backtests laufen hier (workshop_backtests), NICHT in `backtests` —
 * die VDB-Studientabellen bleiben sauber. Erst nach „Als Version speichern"
 * (strategies kind 'dsl' + strategy_versions) läuft der offizielle
 * Labor-Backtest, und das bestehende Promotion-Gate entscheidet über Paper.
 */
export const workshopSessions = pgTable(
  'workshop_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Original-Pine-Script (bleibt als Referenz erhalten). */
    pineSource: text('pine_source'),
    /** Strukturierte KI-Analyse des Pine-Scripts (Zod-validiert beim Schreiben). */
    analysis: jsonb('analysis'),
    /** Aktueller Konfigurations-Entwurf (Instruction-DSL-JSON, validiert). */
    draftDsl: jsonb('draft_dsl'),
    /** Patricks textuelle Anweisungen an den Agenten (frei, fließt in den Dialog-Kontext). */
    instructions: text('instructions'),
    /** Verknüpfte registrierte Strategie, sobald eine Version gespeichert wurde. */
    strategyId: uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workshop_sessions_user_idx').on(t.userId, t.updatedAt)],
);

/** Dialog-Verlauf des Workshops — transparent inkl. LLM-Kosten je Antwort. */
export const workshopMessages = pgTable(
  'workshop_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => workshopSessions.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant' (Router-validiert). */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** Vom Assistenten vorgeschlagene DSL (nur nach parseInstructionDsl-Erfolg gesetzt). */
    proposedDsl: jsonb('proposed_dsl'),
    costUsd: numeric('cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workshop_messages_session_idx').on(t.sessionId, t.createdAt)],
);

/**
 * Draft-Backtests je Session — Grundlage für den Parameter-Set-Vergleich.
 * `dsl` hält die EXAKTE Konfiguration des Laufs (reproduzierbar), Kennzahlen
 * sind netto (Kostenmodell Pflicht wie überall).
 */
export const workshopBacktests = pgTable(
  'workshop_backtests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => workshopSessions.id, { onDelete: 'cascade' }),
    /** Frei benennbares Parameter-Set (z. B. „RSI 30 / SL 2 %"). */
    label: text('label'),
    dsl: jsonb('dsl').notNull(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    fromTs: timestamp('from_ts', { withTimezone: true }).notNull(),
    toTs: timestamp('to_ts', { withTimezone: true }).notNull(),
    riskPctPerTrade: numeric('risk_pct_per_trade').notNull().default('1'),
    costModel: jsonb('cost_model').notNull(),
    candles: integer('candles'),
    metrics: jsonb('metrics'),
    equityCurve: jsonb('equity_curve'),
    trades: jsonb('trades'),
    status: runStatusEnum('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('workshop_backtests_session_idx').on(t.sessionId, t.createdAt)],
);
