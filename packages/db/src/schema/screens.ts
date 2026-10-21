import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Gespeicherte Screens des Markt-Screeners (Repo-Masterliste, Phase 2): Name,
 * Zeitrahmen und die Bedingungen (Form siehe `packages/api/src/screener/conditions.ts`,
 * beim Speichern und beim Laufen gegen zod geprüft). Je Nutzer.
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('screens_user_idx').on(t.userId)],
);
