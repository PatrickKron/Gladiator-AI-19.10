import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Benachrichtigungen in der App (Vision-Punkt 3): EINE Quelle für Signale,
 * Preis-Alarme, Notfälle, Kill-Switch und Briefing. Jede Zeile erscheint in
 * der Glocke der App; Web-Push (Abos in `push_subscriptions`, product.ts) und
 * (optional) Telegram sind nur Zustellwege.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'signal' | 'price_alert' | 'screen' | 'emergency' | 'kill_switch' | 'briefing' | 'system'>().notNull(),
    severity: text('severity').$type<'info' | 'warn' | 'critical'>().notNull().default('info'),
    title: text('title').notNull(),
    /** Klartext (kein HTML) — Push und App zeigen ihn unverändert. */
    body: text('body').notNull(),
    /** Ziel in der App (Hash-Route, z. B. '#/signals'). */
    link: text('link'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    check('notifications_kind_check', sql`${t.kind} IN ('signal', 'price_alert', 'screen', 'emergency', 'kill_switch', 'briefing', 'system')`),
    check('notifications_severity_check', sql`${t.severity} IN ('info', 'warn', 'critical')`),
  ],
);
