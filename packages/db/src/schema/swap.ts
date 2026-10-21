import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    /**
     * Nur bei `pending` (gesendet, Ausgang unklar): bestätigtes Angebot + Kurs,
     * damit der Worker den Swap nach Klärung auf der Kette genau so verbucht,
     * wie er ausgeführt wurde. Nach der Klärung wieder null.
     */
    pendingContext: jsonb('pending_context').$type<{ quote: Record<string, unknown>; nativePriceUsd: number; nonce?: number | null }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('swap_trades_wallet_created_idx').on(t.walletId, t.createdAt),
    check('swap_trades_side_check', sql`${t.side} IN ('buy', 'sell')`),
    check('swap_trades_status_check', sql`${t.status} IN ('filled', 'pending', 'failed')`),
  ],
);

/**
 * Limit-Orders + Auto-Sell (Vision-Punkt 5e, „wie Trojan“): Take-Profit,
 * Stop-Loss, Trailing-Stop (Verkauf eines Anteils), Limit-Kauf, DCA
 * (fester Betrag in festen Abständen, optional mit Preisgrenze) und reine
 * Preisalarme (`alert_above`/`alert_below`: nur Meldung, nie ein Swap). Der Worker
 * prüft die Kurse jede Minute; ausgelöst wird über denselben Swap-Pfad wie das
 * Ticket (Gate, Paper/Live). Live nur, wenn beim Anlegen bestätigt.
 */
export const swapOrders = pgTable(
  'swap_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => swapWallets.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    symbol: text('symbol').notNull(),
    kind: text('kind').$type<'take_profit' | 'stop_loss' | 'trailing_stop' | 'limit_buy' | 'dca' | 'alert_above' | 'alert_below' | 'rug_guard'>().notNull(),
    /** Auslösepreis (USD) für Take-Profit, Stop-Loss, Limit-Kauf */
    triggerPriceUsd: numeric('trigger_price_usd'),
    /** Trailing-Stop: Abstand vom Höchstkurs in % */
    trailPct: numeric('trail_pct'),
    /** Trailing-Stop: bisheriger Höchstkurs (USD) */
    peakPriceUsd: numeric('peak_price_usd'),
    /** Rug-Schutz: bisher höchste Pool-Liquidität (USD); Abfall in % steht in `trailPct` */
    peakLiquidityUsd: numeric('peak_liquidity_usd'),
    /** Verkäufe: Anteil des Bestands beim Auslösen in % */
    sellPercent: numeric('sell_percent'),
    /** Limit-Kauf: Betrag in nativer Währung (Dezimal-String) */
    buyAmount: text('buy_amount'),
    slippageBps: integer('slippage_bps'),
    /** DCA: Abstand zwischen zwei Käufen (Minuten) */
    intervalMinutes: integer('interval_minutes'),
    /** DCA: Anzahl Käufe insgesamt / bereits erledigt (ausgeführt oder übersprungen) */
    runsTotal: integer('runs_total'),
    runsDone: integer('runs_done').notNull().default(0),
    /** DCA: nächster fälliger Kauf */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** DCA: über diesem Preis (USD) wird der Kauf übersprungen */
    maxPriceUsd: numeric('max_price_usd'),
    /** Live-Wallet: beim Anlegen ausdrücklich bestätigt (ersetzt die Bestätigung im Moment des Auslösens) */
    confirmedLive: boolean('confirmed_live').notNull().default(false),
    status: text('status').$type<'open' | 'executing' | 'filled' | 'failed' | 'cancelled'>().notNull().default('open'),
    tradeId: uuid('trade_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('swap_orders_status_idx').on(t.status),
    index('swap_orders_wallet_idx').on(t.walletId, t.createdAt),
    check('swap_orders_kind_check', sql`${t.kind} IN ('take_profit', 'stop_loss', 'trailing_stop', 'limit_buy', 'dca', 'alert_above', 'alert_below', 'rug_guard')`),
    check('swap_orders_dca_check', sql`${t.kind} <> 'dca' OR (${t.intervalMinutes} > 0 AND ${t.runsTotal} > 0 AND ${t.nextRunAt} IS NOT NULL)`),
    check('swap_orders_status_check', sql`${t.status} IN ('open', 'executing', 'filled', 'failed', 'cancelled')`),
  ],
);

/**
 * Beobachtete Wallets + Copy-Trading (Vision-Punkt 5, „wie Trojan“): fremde
 * Wallets (Solana und EVM-Ketten), deren Swaps direkt von der Kette gelesen
 * werden (ohne Schlüssel). Copy-Modus `paper` kauft jeden erkannten Kauf mit festem Betrag
 * in einer Paper-Swap-Wallet nach und verkauft den ganzen Bestand, wenn die
 * beobachtete Wallet verkauft. Echtes Copy-Trading gibt es bewusst nicht.
 */
export const watchedWallets = pgTable(
  'watched_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: text('chain').notNull().default('solana'),
    address: text('address').notNull(),
    label: text('label').notNull(),
    /** Lese-Cursor — Solana: neueste verarbeitete Signatur, EVM: zuletzt gelesener Block. Nichts wird doppelt kopiert. */
    lastSignature: text('last_signature'),
    copyMode: text('copy_mode').$type<'off' | 'paper'>().notNull().default('off'),
    copyWalletId: uuid('copy_wallet_id').references(() => swapWallets.id, { onDelete: 'set null' }),
    /** Betrag je Kopie in nativer Währung (Dezimal-String, z. B. „0.1“ SOL bzw. ETH). */
    copyAmount: text('copy_amount'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('watched_wallets_user_addr_uq').on(t.userId, t.chain, t.address),
    check('watched_wallets_copy_check', sql`${t.copyMode} IN ('off', 'paper')`),
  ],
);

/** Erkannte Swaps beobachteter Wallets (+ was die Kopie daraus gemacht hat). */
export const watchedWalletSwaps = pgTable(
  'watched_wallet_swaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    watchedId: uuid('watched_id')
      .notNull()
      .references(() => watchedWallets.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull(),
    side: text('side').$type<'buy' | 'sell'>().notNull(),
    token: text('token').notNull(),
    tokenAtomic: numeric('token_atomic').notNull(),
    tokenDecimals: integer('token_decimals').notNull(),
    /** Gegenwert in nativer Währung (kleinste Einheit: Lamports, Wei …); Spaltenname historisch */
    nativeAtomic: numeric('sol_lamports'),
    counterToken: text('counter_token'),
    txTime: timestamp('tx_time', { withTimezone: true }),
    copyStatus: text('copy_status').$type<'none' | 'filled' | 'skipped' | 'failed'>().notNull().default('none'),
    copyTradeId: uuid('copy_trade_id'),
    copyNote: text('copy_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watched_wallet_swaps_sig_uq').on(t.watchedId, t.signature), index('watched_wallet_swaps_created_idx').on(t.watchedId, t.createdAt)],
);
