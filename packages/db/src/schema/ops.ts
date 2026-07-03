import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Betriebs-Tabellen (Phase 7): Morning-Briefings (Nacht-Pipeline, 08_ §5/§7)
 * und Live-Freigaben pro Börse (Mensch im Loop — NUR Patrick, 10_ §5).
 */

/** Ein Briefing pro Tag — Inhalt strukturiert (jsonb) + gerenderter Text. */
export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** UTC-Tagesdatum als 'YYYY-MM-DD' (ein Briefing je Tag). */
    day: text('day').notNull(),
    content: jsonb('content').notNull(),
    text: text('text').notNull(),
    /** Ausspielung: wurde das Briefing per Telegram versendet? */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('briefings_day_idx').on(t.day)],
);

/**
 * App-Secrets (Phase 7+): von Patrick ÜBER DIE UI gepflegte API-Keys.
 * NIE Klartext — nur Vault-Ciphertext (AES-256-GCM, ENCRYPTION_KEY) + last4
 * für die maskierte Anzeige. Auflösung zur Laufzeit: DB überschreibt .env.
 */
export const appSecrets = pgTable('app_secrets', {
  /** Whitelist-Key (z. B. TELEGRAM_BOT_TOKEN) — Registry in @gladiator/exchange. */
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  last4: text('last4').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Live-Freigabe PRO Börse (10_ §5 / 11_ Phase 7): existiert keine aktive
 * Freigabe, ist Live für dieses Venue unmöglich. Freigabe erteilt NUR
 * Patrick (UI mit Bestätigungsphrase), jederzeit widerrufbar, voll auditiert.
 */
export const venueApprovals = pgTable(
  'venue_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venueId: text('venue_id').notNull(),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    note: text('note'),
  },
  (t) => [index('venue_approvals_venue_idx').on(t.venueId)],
);
