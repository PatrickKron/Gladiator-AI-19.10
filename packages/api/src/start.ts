/**
 * Boot des API-Servers (+ Web-UI, wenn gebaut). Pflicht-Secrets werden VOR dem
 * Start geprüft — fehlt eines, bricht der Prozess ab (kein Fallback, Regel 2).
 */
import { createDb, requireEnv } from '@gladiator/db';
import { LivePriceFeed } from '@gladiator/market-data';
import { createApp } from './app.js';

requireEnv('DATABASE_URL');
requireEnv('JWT_SECRET');
requireEnv('ENCRYPTION_KEY'); // Vault-Schlüssel (0c) — Boot ohne ihn nicht erlaubt.

const port = Number(process.env.API_PORT ?? 3010);
// Mehrere Bind-Adressen (z. B. "127.0.0.1,100.72.94.1" für localhost + Tailscale).
const hosts = (process.env.API_HOSTS ?? process.env.API_HOST ?? '127.0.0.1')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const { db } = createDb();

const prices = new LivePriceFeed(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
prices.start();

const app = createApp(db, { prices });

for (const host of hosts) {
  app.listen(port, host, () => {
    console.log(`Gladiator v2 läuft auf http://${host}:${port} (Web-UI: /, tRPC: /api/trpc, Health: /health)`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void prices.stop().finally(() => process.exit(0));
  });
}
