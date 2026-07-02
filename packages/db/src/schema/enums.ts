import { pgEnum } from 'drizzle-orm/pg-core';

// Hinweis (Entscheidung Patrick 2026-07-02): KEINE Rollen/Tiers.
// Ein User-Typ mit vollem Zugriff — user_role- und tier-Enums wurden entfernt.

// Kanonisches Signal (muss @gladiator/core spiegeln)
export const signalSourceEnum = pgEnum('signal_source', ['engine', 'pine', 'instruction', 'manual']);
export const assetClassEnum = pgEnum('asset_class', ['crypto', 'stock', 'etf', 'forex', 'commodity', 'index']);
export const venueTypeEnum = pgEnum('venue_type', ['cex', 'dex']);
export const directionEnum = pgEnum('direction', ['long', 'short']);
export const setupTypeEnum = pgEnum('setup_type', ['scalp', 'swing', 'position']);
export const riskClassEnum = pgEnum('risk_class', ['low', 'medium', 'high']);
export const tradingSessionEnum = pgEnum('trading_session', ['asia', 'london', 'newyork', 'off']);
export const signalStatusEnum = pgEnum('signal_status', ['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed']);

// Strategie
export const strategyKindEnum = pgEnum('strategy_kind', ['builtin', 'pine', 'dsl']);
export const strategyVersionStatusEnum = pgEnum('strategy_version_status', ['draft', 'paper', 'live', 'retired']);
export const reviewVoteEnum = pgEnum('review_vote', ['confirm', 'reject', 'caution']);

// Trading
export const orderTypeEnum = pgEnum('order_type', ['market', 'limit', 'stop_market', 'take_profit_market']);
export const orderSideEnum = pgEnum('order_side', ['buy', 'sell']);
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'open',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'error',
]);
export const tradeModeEnum = pgEnum('trade_mode', ['paper', 'live']);

// Jobs / Läufe
export const runStatusEnum = pgEnum('run_status', ['queued', 'running', 'done', 'error']);

// Ausspielung
export const channelKindEnum = pgEnum('channel_kind', ['telegram', 'push', 'email']);

// Magazin (aus v1 übernommen)
export const articleCategoryEnum = pgEnum('article_category', ['recap', 'breaking', 'analysis', 'crypto', 'forex']);
