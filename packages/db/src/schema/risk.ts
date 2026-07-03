import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { directionEnum, tradingSessionEnum } from './enums.js';

/**
 * Adaptive Risk-Gates (Selbst-Kalibrierung, Patrick 2026-07-03):
 * evidenzbasierte, RESTRIKTIVE Regeln, die das Labor aus echten
 * Trade-Statistiken ableitet (z. B. „keine Longs unter EMA200, weil
 * Expectancy über 42 Trades negativ"). Governance:
 * - Gates können nur VERSCHÄRFEN, nie statische Limits lockern.
 * - Jede Ableitung/Aktivierung wird auditiert; Patrick kann jedes Gate
 *   deaktivieren (disabledAt/disabledBy) — Mensch im Loop.
 * - Ein Gate ohne ausreichende Stichprobe entsteht gar nicht erst.
 */
export const riskGates = pgTable(
  'risk_gates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().default('block'),
    // Match-Kriterien (null = Kriterium egal). Ein Gate greift, wenn ALLE gesetzten passen.
    direction: directionEnum('direction'),
    emaRegime: text('ema_regime'),
    session: tradingSessionEnum('session'),
    marketPhase: text('market_phase'),
    symbol: text('symbol'),
    timeframe: text('timeframe'),
    /** Beleg: {trades, expectancyR, winRate, netPnl, source, window} — nie ohne Evidenz. */
    evidence: jsonb('evidence').notNull(),
    reason: text('reason').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    source: text('source').notNull().default('lab-calibration'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: uuid('disabled_by').references(() => users.id),
  },
  (t) => [index('risk_gates_active_idx').on(t.isActive)],
);
