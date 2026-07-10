import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Universelle Börsen-Verbindungen (CCXT, 100+ Börsen) — Patricks Auftrag
 * „jeder soll die Börse seines Vertrauens verbinden können".
 *
 * Bewusst NEUE Tabelle statt exchange_credentials zu erweitern:
 * exchange_credentials gehört den fest verdrahteten Testnet-Venues
 * (Binance/Hyperliquid) — diese Tabelle gehört dem CCXT-Universalpfad.
 * Additiv, nichts Bestehendes wird angefasst.
 *
 * Sicherheitsmodell wie gehabt: encrypted_payload = Vault (AES-256-GCM),
 * nie Klartext, in Listen nur last4. Auszahlungs-Keys sind by design
 * unerwünscht — wir prüfen es nicht erzwingbar, aber die UI verlangt
 * Keys OHNE Withdraw-Recht.
 */
export const exchangeConnectionModeEnum = pgEnum('exchange_connection_mode', ['read_only', 'trading']);
export const exchangeConnectionStatusEnum = pgEnum('exchange_connection_status', ['active', 'error', 'revoked']);

export const exchangeConnections = pgTable(
  'exchange_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** CCXT-Exchange-ID (z. B. 'kraken', 'bybit', 'okx'). */
    exchangeId: text('exchange_id').notNull(),
    /** Anzeigename der Börse laut CCXT (z. B. 'Kraken'). */
    exchangeName: text('exchange_name').notNull(),
    label: text('label'),
    /** Vault-Payload: JSON {apiKey, secret, password?, uid?} AES-256-GCM-verschlüsselt. */
    encryptedPayload: text('encrypted_payload').notNull(),
    /** Maskierte Anzeige des API-Keys (letzte 4 Zeichen). */
    keyLast4: text('key_last4').notNull(),
    /** read_only = nur Kontostände lesen; trading = darf Orders platzieren (hinter Gates). */
    mode: exchangeConnectionModeEnum('mode').notNull().default('read_only'),
    status: exchangeConnectionStatusEnum('status').notNull().default('active'),
    lastError: text('last_error'),
    /** Letzter erfolgreicher Echt-Kontakt zur Börse (fetchBalance). */
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    /**
     * Ergebnis der automatischen Markt-Erkennung (loadMarkets):
     * { symbolCount, quoteCurrencies: string[], symbols: string[], hasFutures: boolean, maxLeverage: number|null }
     * symbols = handelbare unified Symbole ('BTC/USDT', 'BTC/USDT:USDT', …) — Basis für den Order-Router.
     */
    marketsSummary: jsonb('markets_summary'),
    maxLeverage: numeric('max_leverage'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('exchange_connections_user_idx').on(t.userId),
    index('exchange_connections_exchange_idx').on(t.exchangeId),
  ],
);
