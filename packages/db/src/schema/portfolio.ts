import { index, jsonb, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Vermögens-Zeitverlauf (Phase 2 „Vermögen"): stündliche Snapshots des
 * Gesamtvermögens je User, geschrieben vom Worker. Ehrliche Nulls:
 * - realEquityUsd ist null, solange keine Börse verbunden/bewertbar ist.
 * - totalEur ist null, wenn kein echter EUR/USD-Kurs verfügbar war —
 *   es wird NIE ein Kurs erfunden.
 * Der Verlauf entsteht ab Aktivierung; Vergangenheit wird nicht gefälscht.
 */
export const accountValueSnapshots = pgTable(
  'account_value_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** Übungskonto: manuell (Demo-Engine, 100k-Start). */
    demoEquityUsd: numeric('demo_equity_usd'),
    /** Übungskonto: Agenten (Paper, 10k-Start). */
    paperEquityUsd: numeric('paper_equity_usd'),
    /** Echtes Geld über verbundene Börsen, USD-bewertet; null = keine/nicht bewertbar. */
    realEquityUsd: numeric('real_equity_usd'),
    /** Echter EUR/USD-Kurs zum Snapshot-Zeitpunkt; null = Quelle nicht erreichbar. */
    eurUsdRate: numeric('eur_usd_rate'),
    /** Gesamt in EUR (nur wenn Kurs vorhanden — sonst null, nie erfunden). */
    totalEur: numeric('total_eur'),
    /** Aufschlüsselung je Quelle/Börse für die Detail-Ansicht. */
    breakdown: jsonb('breakdown'),
  },
  (t) => [index('account_value_snapshots_user_ts_idx').on(t.userId, t.ts)],
);
