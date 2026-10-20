import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Wallet-Trading / Spot-Swaps (Vision-Punkt 5, Freigabe Patrick 2026-10-20).
 * Eine Swap-Wallet gehört zu genau einer Kette. Modus `paper` = virtuelles
 * Guthaben, ausgeführt zum echten Aggregator-Angebot; `live` = eigene
 * Trading-Wallet (Schlüssel verschlüsselt, nur wenn der Betreiber der Instanz
 * es ausdrücklich erlaubt). Grenzen je Wallet frei einstellbar (judgeSwap).
 */
export const swapWallets = pgTable(
  'swap_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: text('chain').notNull(),
    label: text('label').notNull(),
    mode: text('mode').$type<'paper' | 'live'>().notNull().default('paper'),
    /** Öffentliche Adresse (live). Paper-Wallets haben eine eigene, nicht-on-chain Kennung. */
    address: text('address').notNull(),
    /** Vault-Payload (AES-256-GCM) des Private Keys — nur live, nur mit Betreiber-Freigabe. */
    encryptedKey: text('encrypted_key'),
    /** Live-Freigabe durch den User (Mensch im Loop) — ohne sie keine echte Transaktion. */
    liveApprovedAt: timestamp('live_approved_at', { withTimezone: true }),
    maxTradeUsd: numeric('max_trade_usd').notNull(),
    maxSlippageBps: integer('max_slippage_bps').notNull(),
    maxPriceImpactPct: numeric('max_price_impact_pct').notNull(),
    minLiquidityUsd: numeric('min_liquidity_usd').notNull(),
    maxTokenTaxPct: numeric('max_token_tax_pct').notNull().default('3'),
    /** Standard-Slippage im Ticket (Bps). */
    slippageBps: integer('slippage_bps').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('swap_wallets_user_idx').on(t.userId),
    check('swap_wallets_mode_check', sql`${t.mode} IN ('paper', 'live')`),
    check('swap_wallets_live_key_check', sql`${t.mode} = 'live' OR ${t.encryptedKey} IS NULL`),
  ],
);

/** Bestände je Wallet + Token (Paper: virtuell; live: Spiegel der Kette nach jedem Swap). */
export const swapBalances = pgTable(
  'swap_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => swapWallets.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    /** Menge in kleinster Einheit (exakt, ganzzahlig). */
    amountAtomic: numeric('amount_atomic').notNull().default('0'),
    /** Einstand in USD (Durchschnittskosten inkl. Gebühren) für die PnL. */
    costUsd: numeric('cost_usd').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('swap_balances_wallet_token_uq').on(t.walletId, t.token), check('swap_balances_nonneg', sql`${t.amountAtomic} >= 0`)],
);

export const swapTrades = pgTable(
  'swap_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => swapWallets.id, { onDelete: 'cascade' }),
    side: text('side').$type<'buy' | 'sell'>().notNull(),
    mode: text('mode').$type<'paper' | 'live'>().notNull(),
    status: text('status').$type<'filled' | 'pending' | 'failed'>().notNull(),
    aggregator: text('aggregator').notNull(),
    inToken: text('in_token').notNull(),
    inSymbol: text('in_symbol').notNull(),
    inAtomic: numeric('in_atomic').notNull(),
    inDecimals: integer('in_decimals').notNull(),
    outToken: text('out_token').notNull(),
    outSymbol: text('out_symbol').notNull(),
    outAtomic: numeric('out_atomic').notNull(),
    outDecimals: integer('out_decimals').notNull(),
    valueUsd: numeric('value_usd'),
    feeUsd: numeric('fee_usd'),
    /** Realisierter Gewinn/Verlust (nur Verkäufe), USD. */
    realizedPnlUsd: numeric('realized_pnl_usd'),
    priceImpactPct: numeric('price_impact_pct'),
    slippageBps: integer('slippage_bps').notNull(),
    route: jsonb('route').$type<string[]>().notNull().default([]),
    txHash: text('tx_hash'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('swap_trades_wallet_created_idx').on(t.walletId, t.createdAt),
    check('swap_trades_side_check', sql`${t.side} IN ('buy', 'sell')`),
    check('swap_trades_status_check', sql`${t.status} IN ('filled', 'pending', 'failed')`),
  ],
);
