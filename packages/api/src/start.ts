/**
 * Boot des API-Servers. Pflicht-Secrets werden VOR dem Start geprüft —
 * fehlt eines, bricht der Prozess ab (kein Fallback, eiserne Regel 2).
 */
import { createDb, requireEnv } from '@gladiator/db';
import { createApp } from './app.js';

requireEnv('DATABASE_URL');
requireEnv('JWT_SECRET');

const port = Number(process.env.API_PORT ?? 3010);
const host = process.env.API_HOST ?? '127.0.0.1';

const { db } = createDb();
const app = createApp(db);

app.listen(port, host, () => {
  console.log(`Gladiator v2 API läuft auf http://${host}:${port} (tRPC: /api/trpc, Health: /health)`);
});
