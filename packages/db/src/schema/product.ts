import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { articleCategoryEnum, channelKindEnum, tierEnum } from './enums.js';

/**
 * Asset-Pakete (TECH33, DAX40, …). Integer-IDs bewusst beibehalten,
 * damit die echten v1-Daten (35 Pakete, 221 Assets) 1:1 portierbar sind.
 */
export const packages = pgTable('packages', {
  id: serial('id').primaryKey(),
  packageId: text('package_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category').notNull(),
  subcategory: text('subcategory'),
  icon: text('icon'),
  color: text('color'),
  assetCount: integer('asset_count').notNull().default(0),
  totalSignals: integer('total_signals').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Handelbare Instrumente innerhalb der Pakete. */
export const assets = pgTable(
  'assets',
  {
    id: serial('id').primaryKey(),
    assetId: text('asset_id').notNull().unique(),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    ticker: text('ticker').notNull(),
    name: text('name').notNull(),
    exchange: text('exchange'),
    assetType: text('asset_type').notNull(),
    tradingPair: text('trading_pair'),
    baseCurrency: text('base_currency'),
    quoteCurrency: text('quote_currency'),
    totalSignals: integer('total_signals').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assets_package_idx').on(t.packageId)],
);

/** Paket-Abos je User. */
export const packageSubscriptions = pgTable(
  'package_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    tier: tierEnum('tier').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (t) => [index('package_subscriptions_user_idx').on(t.userId)],
);

/** Preisstufen Free/Pro/VIP (+ Add-ons). Checkout kommt erst nach Rechtsklärung (Phase 7). */
export const pricing = pgTable('pricing', {
  id: serial('id').primaryKey(),
  tier: tierEnum('tier').notNull(),
  name: text('name').notNull(),
  pricePerMonth: numeric('price_per_month'),
  currency: text('currency').notNull().default('EUR'),
  features: jsonb('features'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Ausspiel-Kanäle (Telegram-Gruppen/Topics, Push, E-Mail). */
export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  kind: channelKindEnum('kind').notNull(),
  name: text('name').notNull(),
  /** Kanal-Konfiguration (z. B. Telegram-Chat/Topic-IDs) — keine Secrets hier. */
  config: jsonb('config'),
  tier: tierEnum('tier').notNull().default('free'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Kanal-Abos je User. */
export const channelSubscriptions = pgTable(
  'channel_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (t) => [index('channel_subscriptions_user_idx').on(t.userId)],
);

/** Magazin-Artikel (KI-kuratiert) — echte v1-Daten werden portiert. */
export const magazineArticles = pgTable('magazine_articles', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  summary: text('summary'),
  category: articleCategoryEnum('category').notNull(),
  imageUrl: text('image_url'),
  sourceUrl: text('source_url'),
  isPublished: boolean('is_published').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  locale: text('locale').notNull().default('de'),
  subscribedAt: timestamp('subscribed_at', { withTimezone: true }).notNull().defaultNow(),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
});

/** Web-Push-Subscriptions. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    keys: jsonb('keys').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);
