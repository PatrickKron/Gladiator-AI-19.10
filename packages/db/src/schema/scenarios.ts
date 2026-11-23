import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Szenario-Playbooks / Wenn-Dann-Wetten (Welle 24):
 * Verbindet News-/Makro-Auslöser mit optionaler technischer Bestätigung (BOS/CHoCH/Kurs)
 * und konkreten Reaktions-Aktionen (Short/Long auf Asset oder Asset-Gruppe, Spot-Verkaufsplan,
 * Hedging-Anpassung). Immer Paper/Demo-Default, keine blinde Live-Ausführung, keine Auszahlungen.
 */
export const scenarioPlaybooks = pgTable(
  'scenario_playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    rawText: text('raw_text'),
    /** 'draft' | 'armed' | 'triggered' | 'executed' | 'paused' */
    status: text('status').notNull().default('draft'),
    /** 'signal_only' (Mensch-im-Loop) | 'demo_auto' (nur Demo-Konto) */
    executionMode: text('execution_mode').notNull().default('signal_only'),
    trigger: jsonb('trigger').notNull(),
    confirmation: jsonb('confirmation').notNull(),
    actions: jsonb('actions').notNull(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastEvaluation: jsonb('last_evaluation'),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
    triggerEvidence: jsonb('trigger_evidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scenario_playbooks_user_idx').on(t.userId),
    index('scenario_playbooks_status_idx').on(t.status),
  ],
);

/** Verlauf / Audit jeder Szenario-Prüfung, Auslösung und Ausführung. */
export const scenarioRuns = pgTable(
  'scenario_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => scenarioPlaybooks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'check' | 'trigger' | 'manual_trigger' | 'execute' */
    kind: text('kind').notNull(),
    matched: boolean('matched').notNull().default(false),
    summary: text('summary').notNull(),
    evidence: jsonb('evidence'),
    actionsTaken: jsonb('actions_taken'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scenario_runs_playbook_idx').on(t.playbookId, t.createdAt),
    index('scenario_runs_user_idx').on(t.userId, t.createdAt),
  ],
);
