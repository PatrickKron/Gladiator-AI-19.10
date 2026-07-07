import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { signals } from './strategy.js';
import { subAgents } from './sub-agents.js';
import {
  directionEnum,
  orderSideEnum,
  orderStatusEnum,
  orderTypeEnum,
  tradeModeEnum,
  venueTypeEnum,
} from './enums.js';

/**
 * Börsen-Zugänge: NUR verschlüsselte Payload (AES-256-GCM, Schlüssel aus dem Vault).
 * Nie Klartext. `canWithdraw` MUSS false bleiben (Keys ohne Auszahlrecht — by design).
 */
export const exchangeCredentials = pgTable(
  'exchange_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    venue: text('venue').notNull(),
    venueType: venueTypeEnum('venue_type').notNull(),
    label: text('label'),
    encryptedPayload: text('encrypted_payload').notNull(),
    canWithdraw: boolean('can_withdraw').notNull().default(false),
    testnet: boolean('testnet').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('exchange_credentials_user_idx').on(t.userId)],
);

/** Risk-Parameter pro User — werden von der Risk-Engine (Phase 4a) erzwungen. */
export const tradingSettings = pgTable('trading_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  riskPctPerTrade: numeric('risk_pct_per_trade').notNull().default('1'),
  maxLeverage: numeric('max_leverage').notNull().default('10'),
  maxOpenPositions: integer('max_open_positions').notNull().default(5),
  maxExposurePctPerAsset: numeric('max_exposure_pct_per_asset').notNull().default('20'),
  dailyLossLimitPct: numeric('daily_loss_limit_pct').notNull().default('3'),
  weeklyLossLimitPct: numeric('weekly_loss_limit_pct').notNull().default('7'),
  maxDrawdownPct: numeric('max_drawdown_pct').notNull().default('15'),
  killSwitchActive: boolean('kill_switch_active').notNull().default(false),
  mode: tradeModeEnum('mode').notNull().default('paper'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Orders — jede Order idempotent über clientOrderId, voll auditiert. */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    signalId: uuid('signal_id').references(() => signals.id),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    exchangeOrderId: text('exchange_order_id'),
    type: orderTypeEnum('type').notNull(),
    side: orderSideEnum('side').notNull(),
    qty: numeric('qty').notNull(),
    price: numeric('price'),
    reduceOnly: boolean('reduce_only').notNull().default(false),
    status: orderStatusEnum('status').notNull().default('pending'),
    mode: tradeModeEnum('mode').notNull().default('paper'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_client_order_id_idx').on(t.clientOrderId),
    index('orders_user_idx').on(t.userId),
    index('orders_signal_idx').on(t.signalId),
  ],
);

/**
 * Abgeschlossene Trades. Netto-Kostenfelder sind PFLICHT (08_ §3a):
 * netPnl = grossPnl − makerTakerFee − slippage − fundingPaid. Alle Kennzahlen rechnen netto.
 */
export const executedTrades = pgTable(
  'executed_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    signalId: uuid('signal_id').references(() => signals.id),
    /** Zuordnung zum Sub-Agenten (Trading-Werkstatt) — echte Performance je Agent. */
    subAgentId: uuid('sub_agent_id').references(() => subAgents.id, { onDelete: 'set null' }),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    direction: directionEnum('direction').notNull(),
    entryTs: timestamp('entry_ts', { withTimezone: true }).notNull(),
    exitTs: timestamp('exit_ts', { withTimezone: true }),
    entryPrice: numeric('entry_price').notNull(),
    exitPrice: numeric('exit_price'),
    qty: numeric('qty').notNull(),
    leverage: numeric('leverage').notNull().default('1'),
    grossPnl: numeric('gross_pnl'),
    makerTakerFee: numeric('maker_taker_fee').notNull().default('0'),
    slippage: numeric('slippage').notNull().default('0'),
    fundingPaid: numeric('funding_paid').notNull().default('0'),
    netPnl: numeric('net_pnl'),
    rMultiple: numeric('r_multiple'),
    mode: tradeModeEnum('mode').notNull().default('paper'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('executed_trades_user_idx').on(t.userId),
    index('executed_trades_symbol_idx').on(t.symbol),
    index('executed_trades_entry_ts_idx').on(t.entryTs),
  ],
);

/** Offene Positionen (live aus dem Fill-/Position-Stream; Börse = Wahrheit, DB = Abbild). */
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Zuordnung zum Sub-Agenten (Trading-Werkstatt) — für agenten-verwaltete Exits. */
    subAgentId: uuid('sub_agent_id').references(() => subAgents.id, { onDelete: 'set null' }),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    direction: directionEnum('direction').notNull(),
    qty: numeric('qty').notNull(),
    entryPrice: numeric('entry_price').notNull(),
    leverage: numeric('leverage').notNull().default('1'),
    liquidationPrice: numeric('liquidation_price'),
    unrealizedPnl: numeric('unrealized_pnl'),
    mode: tradeModeEnum('mode').notNull().default('paper'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('positions_unique_idx').on(t.userId, t.venue, t.symbol, t.mode)],
);
