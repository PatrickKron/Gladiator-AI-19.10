import { boolean, index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { exchangeConnections } from './exchange-connections.js';

/**
 * Ziel-Wallet-Adressbuch für den Spot-&-Wallet-Workflow (Welle 27):
 * Speichert ausschließlich ÖFFENTLICHE Empfängeradressen (z. B. Ledger, Phantom, MetaMask).
 * Für den 1-Klick-API-Transfer (`api_withdraw`) muss eine Adresse explizit per
 * Bestätigungsphrase (`WALLET-FREIGABE <Label>`) freigegeben sein (`isWhitelisted = true`).
 * KI/Agenten/Szenarien haben bauartbedingt KEINEN Zugriff auf Auszahlungen.
 */
export const walletAddressBook = pgTable(
  'wallet_address_book',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** 'BTC' | 'SOL' | 'ERC20' | 'ARBITRUM' | 'BASE' | 'BSC' | 'POLYGON' */
    network: text('network').notNull(),
    address: text('address').notNull(),
    memo: text('memo'),
    isWhitelisted: boolean('is_whitelisted').notNull().default(false),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_address_book_user_idx').on(t.userId)],
);

/**
 * Schritt-für-Schritt Spot-Kauf & Wallet-Transfer-Workflows (Welle 27):
 * Dokumentiert CEX-Spot-Kauf (Paper oder Live), geführten oder Whitelist-API-Transfer
 * sowie die echte On-Chain-Eingangsbestätigung auf der Ziel-Wallet.
 */
export const spotWorkflows = pgTable(
  'spot_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'guided_cex' | 'dex_direct' | 'api_withdraw' */
    path: text('path').notNull().default('guided_cex'),
    /** 'paper' | 'live' */
    mode: text('mode').notNull().default('paper'),
    exchangeConnectionId: uuid('exchange_connection_id').references(() => exchangeConnections.id, {
      onDelete: 'set null',
    }),
    exchangeName: text('exchange_name').notNull(),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    quoteAmount: numeric('quote_amount').notNull(),
    filledBaseQty: numeric('filled_base_qty'),
    avgFillPrice: numeric('avg_fill_price'),
    feePaid: numeric('fee_paid'),
    exchangeOrderId: text('exchange_order_id'),
    destinationWalletId: uuid('destination_wallet_id').references(() => walletAddressBook.id, {
      onDelete: 'set null',
    }),
    destinationAddress: text('destination_address'),
    destinationNetwork: text('destination_network'),
    withdrawTxId: text('withdraw_tx_id'),
    withdrawFee: numeric('withdraw_fee'),
    baselineOnchainBalance: numeric('baseline_onchain_balance'),
    confirmedOnchainBalance: numeric('confirmed_onchain_balance'),
    /** 'bought' | 'awaiting_transfer' | 'withdrawn' | 'onchain_confirmed' | 'failed' */
    stage: text('stage').notNull().default('bought'),
    statusNote: text('status_note'),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('spot_workflows_user_idx').on(t.userId, t.createdAt)],
);
