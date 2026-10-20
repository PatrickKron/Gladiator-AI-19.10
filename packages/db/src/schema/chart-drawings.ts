import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Chart-Zeichnungen (Plan §5): Horizontale, Trendlinie, Fibonacci — pro Nutzer
 * und Symbol, Timeframe-unabhängig. `points` = [{ time: Unix-Sekunden, price }]
 * (Zeit/Preis-verankert, daher beim TF-Wechsel korrekt). Anzahl/Wertebereich
 * der Anker prüft die API (`@gladiator/core` drawings), die DB sichert die Art ab.
 */
export const chartDrawings = pgTable(
  'chart_drawings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    kind: text('kind').$type<'hline' | 'trend' | 'fib'>().notNull(),
    points: jsonb('points').$type<{ time: number; price: number }[]>().notNull(),
    style: jsonb('style').$type<{ color?: string; lineWidth?: number }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chart_drawings_user_symbol_idx').on(t.userId, t.symbol),
    check('chart_drawings_kind_check', sql`${t.kind} IN ('hline', 'trend', 'fib')`),
  ],
);
