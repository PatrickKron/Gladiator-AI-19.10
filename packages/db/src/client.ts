import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

/**
 * Pflicht-Umgebungsvariable lesen — KEIN Fallback (eiserne Regel 2).
 * Fehlt sie, bricht der Prozess mit klarer Meldung ab.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Pflicht-Umgebungsvariable ${name} fehlt — Abbruch. Kein Klartext-Fallback erlaubt.`);
  }
  return value;
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
}

export function createDb(pool: pg.Pool = createPool()): { db: Db; pool: pg.Pool } {
  return { db: drizzle(pool, { schema }), pool };
}
