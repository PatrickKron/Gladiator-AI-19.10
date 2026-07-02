import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './client.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const pool = createPool();
try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log('Migrationen angewendet.');
} finally {
  await pool.end();
}
