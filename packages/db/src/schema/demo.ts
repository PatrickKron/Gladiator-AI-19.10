import { boolean, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { directionEnum, orderSideEnum, orderStatusEnum, orderTypeEnum } from './enums.js';

/**
 * Demo-Trading (Session 5): STRIKT getrennte Tabellen für den manuellen
 * Demo-Modus (virtuelles Guthaben, simulierte Ausführung gegen echte Kurse).
 * Bewusst KEINE Wiederverwendung von orders/positions/executed_trades und
 * KEIN neuer tradeModeEnum-Wert: Agenten-Flows können Demo-Daten physisch
 * nicht sehen, der Demo-Pfad kann keine echten Orders erzeugen.
 */

/** Ein Demo-Konto je User: Balance = Cash (Fees sofort, PnL beim Close). */
export const demoAccounts = pgTable('demo_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  startBalance: numeric('start_balance').notNull().default('100000'),
  balance: numeric('balance').notNull().default('100000'),
  resetCount: integer('reset_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resetAt: timestamp('reset_at', { withTimezone: true }),
});

/** Demo-Orders: Market/Limit/Stop/TP mit Partial-Fill-Zustand (filledQty/avgFillPrice). */
export const demoOrders = pgTable(
  'demo_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => demoAccounts.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    type: orderTypeEnum('type').notNull(),
    side: orderSideEnum('side').notNull(),
    /** Angeforderte Menge (Basis-Asset). */
    qty: numeric('qty').notNull(),
    filledQty: numeric('filled_qty').notNull().default('0'),
    /** Limit-Preis (nur type=limit). */
    limitPrice: numeric('limit_price'),
    /** Trigger (nur stop_market/take_profit_market). */
    triggerPrice: numeric('trigger_price'),
    /** Volumengewichteter Fill-Preis über alle bisherigen Fills. */
    avgFillPrice: numeric('avg_fill_price'),
    feePaid: numeric('fee_paid').notNull().default('0'),
    /** Ausgewiesene Slippage ggü. Mid über alle Fills (steckt bereits im avgFillPrice). */
    slippagePaid: numeric('slippage_paid').notNull().default('0'),
    /** true = darf nur eine bestehende Position reduzieren (SL/TP/Close). */
    reduceOnly: boolean('reduce_only').notNull().default(false),
    status: orderStatusEnum('status').notNull().default('open'),
    /** Ehrlicher Ablehnungs-/Info-Text (z. B. Buch leer, Limit-Regeln). */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_orders_user_status_idx').on(t.userId, t.status), index('demo_orders_symbol_idx').on(t.symbol)],
);

/** Offene Demo-Positionen: eine je (Konto, Symbol, Richtung), Entry volumengewichtet. */
export const demoPositions = pgTable(
  'demo_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => demoAccounts.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    direction: directionEnum('direction').notNull(),
    qty: numeric('qty').notNull(),
    entryPrice: numeric('entry_price').notNull(),
    /** Bereits beim Entry gezahlte Fees (anteilig beim Teil-Close verrechnet). */
    entryFee: numeric('entry_fee').notNull().default('0'),
    /** Beim Entry ausgewiesene Slippage (für die Gesamt-Ausweisung im Trade). */
    entrySlippage: numeric('entry_slippage').notNull().default('0'),
    stopLoss: numeric('stop_loss'),
    takeProfit: numeric('take_profit'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('demo_positions_unique_idx').on(t.accountId, t.symbol, t.direction)],
);

/**
 * Geschlossene Demo-Trades — NETTO wie executed_trades: netPnl = grossPnl −
 * fees − funding. `slippage` ist die AUSGEWIESENE, bereits in den Fill-Preisen
 * enthaltene Slippage ggü. Mid (kein Doppelabzug).
 */
export const demoTrades = pgTable(
  'demo_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => demoAccounts.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    direction: directionEnum('direction').notNull(),
    entryTs: timestamp('entry_ts', { withTimezone: true }).notNull(),
    exitTs: timestamp('exit_ts', { withTimezone: true }).notNull(),
    entryPrice: numeric('entry_price').notNull(),
    exitPrice: numeric('exit_price').notNull(),
    qty: numeric('qty').notNull(),
    grossPnl: numeric('gross_pnl').notNull(),
    fees: numeric('fees').notNull().default('0'),
    slippage: numeric('slippage').notNull().default('0'),
    fundingPaid: numeric('funding_paid').notNull().default('0'),
    netPnl: numeric('net_pnl').notNull(),
    rMultiple: numeric('r_multiple'),
    /** Warum geschlossen: sl | tp | manual | order (reduzierende Limit/Market-Order). */
    reason: text('reason').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_trades_user_idx').on(t.userId), index('demo_trades_exit_ts_idx').on(t.exitTs)],
);
