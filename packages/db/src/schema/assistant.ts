import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Gladiator-Chat (Patricks Mängelliste 2026-10-22, Punkt 4): EIN Dialog, der überall
 * erreichbar ist und in die App eingreift — Strategien entwerfen (Workshop-Entwurf),
 * backtesten, als Version speichern, Screens laufen lassen, Seiten öffnen. Alles, was
 * scharf schaltet (Version → Paper), bleibt eine Bestätigung des Nutzers (Mensch im Loop).
 *
 * Nachrichten speichern den vollen Verlauf inkl. Werkzeug-Aufrufen (`blocks`, neutrale
 * LLM-Blöcke) und den für die Oberfläche gerenderten Karten (`cards`), damit ein Turn
 * nachvollziehbar und das Gespräch nach einem Neuladen vollständig ist.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_conversations_user_idx').on(t.userId, t.updatedAt)],
);

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant' | 'tool' (tool = Ergebnis-Blöcke eines Werkzeug-Aufrufs, als user-Turn ans Modell). */
    role: text('role').notNull(),
    /** Sichtbarer Text (bei tool leer). */
    content: text('content').notNull().default(''),
    /** LLM-Blöcke dieses Turns (text / tool_use / tool_result) — Verlauf fürs Modell. */
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    /** Karten für die Oberfläche (Backtest-Ergebnis, Vorschlag, Bestätigung, Link). */
    cards: jsonb('cards').$type<unknown[]>().notNull().default([]),
    costUsd: numeric('cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);
