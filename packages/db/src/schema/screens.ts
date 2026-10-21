import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Gespeicherte Screens des Markt-Screeners (Repo-Masterliste, Phase 2): Name,
 * Zeitrahmen und die Bedingungen (Form siehe `packages/api/src/screener/conditions.ts`,
 * beim Speichern und beim Laufen gegen zod geprüft). Je Nutzer.
 * Screen-Alarm (`alert`): der Worker rechnet den Screen alle 5 min auf echten
 * Kerzen; `lastMatches` = Treffer des letzten Laufs — nur NEUE Treffer werden gemeldet.
 */
export const screens = pgTable(
  'screens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    timeframe: text('timeframe').notNull(),
    conditions: jsonb('conditions').$type<unknown[]>().notNull(),
    /** Kerzenquelle (binance | twelvedata | yahoo) — wie im Screener gewählt. */
    venue: text('venue').notNull().default('binance'),
    alert: boolean('alert').notNull().default(false),
    lastMatches: jsonb('last_matches').$type<string[]>().notNull().default([]),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('screens_user_idx').on(t.userId)],
);
