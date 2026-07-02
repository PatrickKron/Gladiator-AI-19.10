import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Audit-Log — append-only. Jede Order, Limit-Änderung, Login, Key-Zugriff.
 * App-Code führt hier NIE UPDATE/DELETE aus (Beleggrundlage, 10_ §5/§6).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    /** Handelnder: 'user' | 'system' | Agent-/Job-Name. */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    details: jsonb('details'),
    ip: text('ip'),
  },
  (t) => [index('audit_log_ts_idx').on(t.ts), index('audit_log_user_idx').on(t.userId)],
);
