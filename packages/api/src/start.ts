/**
 * Boot des API-Servers (+ Web-UI, wenn gebaut). Pflicht-Secrets werden VOR dem
 * Start geprüft — fehlt eines, bricht der Prozess ab (kein Fallback, Regel 2).
 */
import { createDb, requireEnv } from '@gladiator/db';
import { LivePriceFeed } from '@gladiator/market-data';
import { startJobWorker } from '@gladiator/jobs';
import { BinanceTestnetVenue, PaperVenue } from '@gladiator/exchange';
import { createApp } from './app.js';

requireEnv('DATABASE_URL');
requireEnv('JWT_SECRET');
requireEnv('ENCRYPTION_KEY'); // Vault-Schlüssel (0c) — Boot ohne ihn nicht erlaubt.
requireEnv('REDIS_URL'); // BullMQ-Jobs (Signal-Scan) — Pflicht, keine losen Loops.

const port = Number(process.env.API_PORT ?? 3010);
// Mehrere Bind-Adressen (z. B. "127.0.0.1,100.72.94.1" für localhost + Tailscale).
const hosts = (process.env.API_HOSTS ?? process.env.API_HOST ?? '127.0.0.1')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const { db } = createDb();

const prices = new LivePriceFeed(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
prices.start();

/**
 * Venue-Wahl (06_ §7): Binance-Testnet NUR wenn Patrick Keys hinterlegt hat —
 * sonst die interne Paper-Engine gegen echte Live-Preise. Beides Paper-Modus;
 * Live existiert in dieser Phase nicht.
 */
const binance = new BinanceTestnetVenue(process.env.BINANCE_TESTNET_KEY, process.env.BINANCE_TESTNET_SECRET);
const venue = binance.configured ? binance : new PaperVenue();
console.log(`Trading-Venue: ${venue.id} (${venue.kind})`);

const jobs = await startJobWorker(db, venue);

const app = createApp(db, { prices, venue });

for (const host of hosts) {
  const server = app.listen(port, host, () => {
    console.log(`Gladiator v2 läuft auf http://${host}:${port} (Web-UI: /, tRPC: /api/trpc, Health: /health)`);
  });
  // Fail-fast: Wenn eine Bind-Adresse nicht verfügbar ist (z. B. Port belegt),
  // darf der Prozess nicht halb-erreichbar weiterlaufen.
  server.on('error', (err) => {
    console.error(`Bind auf ${host}:${port} fehlgeschlagen — Abbruch:`, err);
    process.exit(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.allSettled([prices.stop(), jobs.stop()]).finally(() => process.exit(0));
  });
}
