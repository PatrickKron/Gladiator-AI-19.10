import { boolean, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { signals } from './strategy.js';
import { executedTrades } from './trading.js';

/**
 * KI-Trading-Intelligence-Layer („/goal Ergänzung zu Gladiator AI").
 * Rein ADDITIVE Tabellen — bestehende Tabellen unangetastet.
 *
 *  - cot_reports          §6  CFTC Commitments of Traders (wöchentlich)
 *  - valuation_indicators §7  Warren-Buffett-Indikator (Marktkap./BIP)
 *  - signal_intelligence  §11 erweitertes Signalobjekt je Signal
 *  - post_trade_reviews   §4  Post-Trade-Learning je geschlossenem Trade
 *
 * CPI nutzt bewusst KEINE neue Tabelle: die Index-Serie liegt in macro_series
 * (seriesId 'CPI'), die Event-Phase kommt aus economic_events.
 */

/** CFTC-COT-Reports je Markt/Woche (Quelle: publicreporting.cftc.gov, kein Key). */
export const cotReports = pgTable(
  'cot_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** CFTC-Kontrakt-Marktcode. */
    marketCode: text('market_code').notNull(),
    /** Voller CFTC-Marktname (roh). */
    marketName: text('market_name').notNull(),
    /** Kuratiertes Kurzlabel (GOLD, BITCOIN_CME, …). */
    label: text('label').notNull(),
    reportDate: timestamp('report_date', { withTimezone: true }).notNull(),
    openInterest: numeric('open_interest').notNull(),
    noncommLong: numeric('noncomm_long').notNull(),
    noncommShort: numeric('noncomm_short').notNull(),
    commLong: numeric('comm_long').notNull(),
    commShort: numeric('comm_short').notNull(),
    source: text('source').notNull().default('cftc'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cot_reports_market_date_idx').on(t.marketCode, t.reportDate),
    index('cot_reports_label_idx').on(t.label, t.reportDate),
  ],
);

/** Bewertungsindikatoren (Buffett-Indikator = Marktkap./BIP), zeitreihig. */
export const valuationIndicators = pgTable(
  'valuation_indicators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Indikator-Kennung (z. B. 'buffett_us'). */
    indicator: text('indicator').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    /** Berechnetes Verhältnis (Zähler/Nenner). */
    value: numeric('value').notNull(),
    numerator: numeric('numerator'),
    denominator: numeric('denominator'),
    source: text('source').notNull().default('fred-public'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('valuation_indicators_ind_ts_idx').on(t.indicator, t.ts)],
);

/**
 * Erweitertes Signalobjekt (PDF §11) je Signal — das strukturierte KI-Ergebnis,
 * das die App als Karten/Alerts/Historie darstellt. 1:1 zum Signal.
 */
export const signalIntelligence = pgTable(
  'signal_intelligence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id, { onDelete: 'cascade' }),
    assetIsExample: boolean('asset_is_example').notNull().default(false),
    marketRegime: text('market_regime'),
    scoreComponents: jsonb('score_components'),
    riskClass: text('risk_class'),
    positionSizeMode: text('position_size_mode'),
    hedgeMode: text('hedge_mode'),
    cpiStatus: text('cpi_status').notNull().default('none'),
    cotStatus: text('cot_status').notNull().default('not_applicable'),
    buffettStatus: text('buffett_status').notNull().default('not_applicable'),
    shadowWarning: text('shadow_warning').notNull().default(''),
    oracleMacroSummary: text('oracle_macro_summary').notNull().default(''),
    devilsAdvocate: text('devils_advocate').notNull().default(''),
    finalDecision: text('final_decision'),
    explanationForUser: text('explanation_for_user').notNull().default(''),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    postTradeReviewRequired: boolean('post_trade_review_required').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('signal_intelligence_signal_idx').on(t.signalId)],
);

/**
 * Post-Trade-Learning (PDF §4/§13.8): bewertet abgeschlossene Trades —
 * Trefferqualität, Fehlerquellen, Score-Validität, Lehren. Eine Zeile je
 * geschlossenem executed_trade.
 */
export const postTradeReviews = pgTable(
  'post_trade_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executedTradeId: uuid('executed_trade_id')
      .notNull()
      .references(() => executedTrades.id, { onDelete: 'cascade' }),
    signalId: uuid('signal_id').references(() => signals.id, { onDelete: 'set null' }),
    /** 'excellent' | 'good' | 'acceptable' | 'poor' | 'loss'. */
    hitQuality: text('hit_quality').notNull(),
    /** War der ursprüngliche Score im Nachhinein gerechtfertigt? 0..1. */
    scoreValidity: numeric('score_validity').notNull(),
    /** Erkannte Fehlerquellen (stabile Schlüssel). */
    errorSources: jsonb('error_sources').notNull(),
    /** Ableitbare Lehren (stabile Schlüssel). */
    lessons: jsonb('lessons').notNull(),
    rMultiple: numeric('r_multiple'),
    netPnl: numeric('net_pnl'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('post_trade_reviews_trade_idx').on(t.executedTradeId),
    index('post_trade_reviews_created_idx').on(t.createdAt),
  ],
);
