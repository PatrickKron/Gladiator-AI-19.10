import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/** Stil-Übersteuerungen eines Chart-Indikators (je Plot sichtbar/Farbe/Breite). */
export type ChartIndicatorStyle = {
  visible?: boolean;
  plots?: Record<string, { visible?: boolean; color?: string; lineWidth?: number }>;
};

/**
 * Indikatoren auf dem Voll-Chart (Repo-Masterliste, Phase 1): je Nutzer und
 * Symbol die aktiven Katalog-Indikatoren (`@gladiator/indicators`) mit ihren
 * bereinigten Eingaben und Stil-Übersteuerungen. Timeframe-unabhängig — der
 * Server rechnet beim Laden auf den Kerzen des gewählten Zeitrahmens.
 */
export const chartIndicators = pgTable(
  'chart_indicators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** Katalog-Id (z. B. 'rsi', 'supertrend', 'engulfing-bullish') */
    indicatorId: text('indicator_id').notNull(),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull(),
    style: jsonb('style').$type<ChartIndicatorStyle>(),
    /** Reihenfolge in Legende und Unterfenstern */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chart_indicators_user_symbol_idx').on(t.userId, t.symbol)],
);
