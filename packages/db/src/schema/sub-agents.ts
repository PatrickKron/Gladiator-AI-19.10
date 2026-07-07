import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { subAgentStatusEnum, tradeModeEnum } from './enums.js';

/**
 * Sub-Agenten (Trading-Agenten-Werkstatt): benutzerdefinierte, autonome
 * Trading-Agenten — wie CHAMÆLIEN-Workflows, aber fürs Trading. Jeder Agent
 * hat eine These, eigene Datenquellen, Ein-/Ausstiegs-Regeln und ein eigenes
 * Risk-Budget. Der Agent-Runner (BullMQ) wertet aktive Agenten periodisch aus;
 * erzeugte Signale laufen durch DIESELBE Signal-Pipeline + Risk-Engine wie alles
 * andere (eine Wahrheit). Paper-Default; Live nur nach expliziter Freigabe.
 *
 * Regel-Struktur (data_sources/entry_rules/exit_rules/risk_params/config) ist als
 * `jsonb` abgelegt und wird beim Lesen/Schreiben gegen die Zod-Schemas aus
 * `@gladiator/strategy-engine` (subAgentSpec) validiert — kein Blackbox-Blob.
 */
export const subAgents = pgTable(
  'sub_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** These in natürlicher Sprache (z. B. „Kauft Dips, zahlt bei +10 % aus"). */
    thesis: text('thesis'),
    /**
     * Optionaler KI-Analyse-Prompt: ist er gesetzt, prüft das LLM bei erfüllten
     * Regeln zusätzlich (EXECUTE/SKIP), bevor ein Signal entsteht. Leer/NULL =
     * rein regelbasiert (funktioniert ohne ANTHROPIC_API_KEY).
     */
    analysisPrompt: text('analysis_prompt'),
    /** Welche Feeds der Agent auswertet: ['price','macro','funding','calendar','news']. */
    dataSources: jsonb('data_sources').notNull(),
    /** Strukturierte Einstiegs-Regeln (subAgentSpec.entryRules). */
    entryRules: jsonb('entry_rules').notNull(),
    /** Ausstiegs-Regeln: TP%/SL% (Pflicht-Schutz) + Zeit-/Event-basiert. */
    exitRules: jsonb('exit_rules').notNull(),
    /** Eigenes Risk-Budget: riskPct, maxLeverage, maxConcurrent, maxDailyLoss, cooldown. */
    riskParams: jsonb('risk_params').notNull(),
    /** Kern-Konfiguration: side (long/short), setupType, timeframe. */
    config: jsonb('config').notNull(),
    /** Gehandelte Assets, z. B. ['BTC/USDT','ETH/USDT']. */
    symbols: text('symbols').array().notNull().default([]),
    status: subAgentStatusEnum('status').notNull().default('paused'),
    /** Ausführungsmodus — bleibt hart 'paper', bis Patrick pro Agent freigibt. */
    mode: tradeModeEnum('mode').notNull().default('paper'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sub_agents_user_idx').on(t.userId), index('sub_agents_status_idx').on(t.status)],
);

/**
 * Protokoll je Evaluations-Takt eines Agenten — macht das autonome Verhalten
 * transparent (welcher Lauf hat wie viele Signale erzeugt / Positionen geschlossen).
 * Keine Blackbox: die UI zeigt die letzten Läufe je Agent.
 */
export const subAgentRuns = pgTable(
  'sub_agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subAgentId: uuid('sub_agent_id')
      .notNull()
      .references(() => subAgents.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    symbolsEvaluated: integer('symbols_evaluated').notNull().default(0),
    signalsCreated: integer('signals_created').notNull().default(0),
    positionsClosed: integer('positions_closed').notNull().default(0),
    note: text('note'),
    error: text('error'),
  },
  (t) => [index('sub_agent_runs_agent_idx').on(t.subAgentId, t.ranAt)],
);
