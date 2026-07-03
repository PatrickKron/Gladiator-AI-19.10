import { index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * OHLCV-Kerzen (Timescale-Hypertable, Partition auf ts — siehe Custom-Migration).
 * NUR echte Daten (ccxt/Yahoo/Polygon). Kein Random-Walk (Alt-Fehler).
 */
export const ohlcv = pgTable(
  'ohlcv',
  {
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    open: numeric('open').notNull(),
    high: numeric('high').notNull(),
    low: numeric('low').notNull(),
    close: numeric('close').notNull(),
    volume: numeric('volume').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.venue, t.symbol, t.timeframe, t.ts] }),
    index('ohlcv_symbol_tf_ts_idx').on(t.symbol, t.timeframe, t.ts),
  ],
);

/** Funding-Rates für Perps (Hypertable). */
export const fundingRates = pgTable(
  'funding_rates',
  {
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    rate: numeric('rate').notNull(),
  },
  (t) => [primaryKey({ columns: [t.venue, t.symbol, t.ts] })],
);

/** Open Interest (Hypertable). */
export const openInterest = pgTable(
  'open_interest',
  {
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    openInterest: numeric('open_interest').notNull(),
  },
  (t) => [primaryKey({ columns: [t.venue, t.symbol, t.ts] })],
);

/** Makro-Zeitreihen (z. B. FRED-Serien: VIX, DXY, US10Y …). */
export const macroSeries = pgTable(
  'macro_series',
  {
    seriesId: text('series_id').notNull(),
    source: text('source').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    value: numeric('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.seriesId, t.ts] })],
);

/** News-Items (echte RSS-Feeds — Phase-1-Rest). Dedupe über die URL. */
export const newsItems = pgTable(
  'news_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull().unique(),
    summary: text('summary'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('news_items_published_idx').on(t.publishedAt)],
);

/** Wirtschaftskalender-Events (echter Feed, kein MockMacroProvider). */
export const economicEvents = pgTable(
  'economic_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    externalId: text('external_id'),
    title: text('title').notNull(),
    country: text('country'),
    currency: text('currency'),
    /** 1 = niedrig … 3 = hoch (Impact). */
    importance: integer('importance'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    actual: numeric('actual'),
    forecast: numeric('forecast'),
    previous: numeric('previous'),
    unit: text('unit'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('economic_events_scheduled_idx').on(t.scheduledAt),
    index('economic_events_source_ext_idx').on(t.source, t.externalId),
  ],
);
