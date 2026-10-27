/**
 * Boot des API-Servers (+ Web-UI, wenn gebaut). Pflicht-Secrets werden VOR dem
 * Start geprüft — fehlt eines, bricht der Prozess ab (kein Fallback, Regel 2).
 */
import dns from 'node:dns';
import { sql } from 'drizzle-orm';
import { createDb, requireEnv } from '@gladiator/db';
import { registerDemoBookSource } from '@gladiator/exchange';
import { TWELVEDATA_VENUE, YAHOO_VENUE } from '@gladiator/market-data';
import { CandleCloseBookSource } from './demo/candle-book-source.js';
import { LivePriceFeed, feedPairsFrom } from '@gladiator/market-data';
import { startJobWorker } from '@gladiator/jobs';
import { BinanceTestnetVenue, HyperliquidTestnetVenue, PaperVenue, captureBootEnv, loadSecretsIntoEnv, withCandleClose } from '@gladiator/exchange';
import { createApp } from './app.js';

// Ausgehende Verbindungen zuerst über IPv4: KyberSwap (Cloudflare) deckelt die IPv6-Adresse des
// Servers auf 1 Anfrage je 180 s, über IPv4 gilt das normale Kontingent (Server-CI 2026-10-22,
// per curl -4/-6 belegt). Node nimmt sonst die AAAA-Antwort zuerst. Gilt für API und Worker
// (beide starten hier); die Tests setzen dasselbe in scripts/vitest-setup.ts.
dns.setDefaultResultOrder('ipv4first');

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

/**
 * Rollen-Trennung: ROLE=web → nur HTTP-Server (+ Preis-Feed), ROLE=worker →
 * nur BullMQ-Jobs. Unbesetzt → beides in einem Prozess (Entwicklung/Tests).
 * Grund: CPU-schwere Jobs (RL-Training, ML-Retrain) dürfen den Webserver nie
 * einfrieren — in Produktion laufen zwei systemd-Dienste (gladiator = web,
 * gladiator-worker = worker) gegen dieselbe DB/Redis.
 */
const role: 'web' | 'worker' | 'all' =
  process.env.ROLE === 'web' ? 'web' : process.env.ROLE === 'worker' ? 'worker' : 'all';

const { db } = createDb();
// Demo auch für Aktien/ETF/Forex: Schlusskurs-Quelle je Kerzen-Venue (Mängelliste Punkt 11).
for (const v of [YAHOO_VENUE, TWELVEDATA_VENUE]) registerDemoBookSource(v, new CandleCloseBookSource(db, v));

// UI-gepflegte Secrets (Phase 7+): .env-Snapshot sichern, dann DB-Werte
// entschlüsselt nach process.env laden — VOR der Venue-Konstruktion,
// damit Börsen-Keys aus der DB beim (Neu-)Start greifen. DB > .env.
captureBootEnv();
const loadedSecrets = await loadSecretsIntoEnv(db);
if (loadedSecrets.length > 0) console.log(`[secrets] ${loadedSecrets.length} Key(s) aus der DB geladen: ${loadedSecrets.join(', ')}`);

// Preis-Feed nur für die Web-Rolle (SSE-Stream + /health-Feed-Status); der
// Worker holt sich Kerzen/Preise selbst über die Job-Pipelines.
// Symbole = ALLE Krypto-Paare aus dem Katalog (28) statt hartkodiert 3 —
// damit Watchlist/Pakete für jedes Krypto-Asset echte Live-Ticks zeigen.
// Fallback auf die Kern-3, falls der Katalog (noch) leer ist.
const FALLBACK_FEED = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
/** Asset-Register: neu hinzugefügte Binance-Paare streamen ohne Neustart — die Liste zieht alle 5 min nach. */
const FEED_REFRESH_MS = 5 * 60_000;
async function feedSymbolsFromCatalog(): Promise<string[] | null> {
  try {
    const rows = await db.execute(
      // Nur Krypto mit Binance-Handelspaar (Katalog + Register, Basis zuerst, dann jüngste Zeilen);
      // Kerzenquelle Yahoo/Twelve Data bleibt draußen. Mehrfach-Pakete dedupliziert feedPairsFrom.
      sql`SELECT trading_pair FROM assets
          WHERE asset_type = 'CRYPTO' AND trading_pair IS NOT NULL AND is_active = true
            AND (candle_venue IS NULL OR candle_venue = 'binance')
          ORDER BY (upper(replace(trading_pair, '/', '')) IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')) DESC, created_at DESC`,
    );
    return feedPairsFrom((rows.rows as { trading_pair: string }[]).map((r) => r.trading_pair), FALLBACK_FEED);
  } catch {
    return null; // DB-Schluckauf: beim Start Fallback, beim Nachziehen bleibt die bisherige Liste
  }
}
const prices = role === 'worker' ? null : new LivePriceFeed((await feedSymbolsFromCatalog()) ?? FALLBACK_FEED);
if (prices) console.log(`[feed] Live-Preis-Feed für ${prices.symbols.length} Symbole gestartet`);
prices?.start();
const feedRefresh = prices
  ? setInterval(() => {
      void feedSymbolsFromCatalog().then((next) => {
        if (!next) return;
        const { added, removed } = prices.setSymbols(next);
        if (added.length || removed.length) console.log(`[feed] Symbole nachgezogen: +${added.join(',') || '—'} −${removed.join(',') || '—'}`);
      });
    }, FEED_REFRESH_MS)
  : null;
feedRefresh?.unref();

/**
 * Venue-Wahl (06_ §7): Testnet-Venues NUR wenn Patrick die Zugänge hinterlegt
 * hat (Priorität: TRADING_VENUE-Env > Binance > Hyperliquid > Paper) — sonst
 * die interne Paper-Engine gegen echte Live-Preise. Alles Paper-Modus;
 * Live existiert in dieser Phase nicht.
 */
const binance = new BinanceTestnetVenue(process.env.BINANCE_TESTNET_KEY, process.env.BINANCE_TESTNET_SECRET);
const hyperliquid = new HyperliquidTestnetVenue(
  process.env.HYPERLIQUID_TESTNET_WALLET,
  process.env.HYPERLIQUID_TESTNET_AGENT_KEY,
);
const wanted = process.env.TRADING_VENUE;
const baseVenue =
  wanted === 'hyperliquid-testnet' && hyperliquid.configured
    ? hyperliquid
    : wanted === 'binance-testnet' && binance.configured
      ? binance
      : binance.configured
        ? binance
        : hyperliquid.configured
          ? hyperliquid
          : new PaperVenue();
// A2: Signale aus Yahoo/Twelve Data laufen als Paper-Schlusskurs-Ausführung (eigene Venue-Kennung).
const venue = withCandleClose(db, baseVenue);
console.log(`Trading-Venue: ${venue.id} (${venue.kind}) + Schlusskurs-Paper für Yahoo/Twelve Data`);

// Worker-Rolle: Jobs starten (inkl. Reconciliation). Web-Rolle: überspringen —
// der getrennte gladiator-worker-Dienst übernimmt das.
const jobs = role === 'web' ? null : await startJobWorker(db, venue);

if (role === 'worker') {
  console.log('Gladiator v2 Worker läuft (ROLE=worker) — Jobs aktiv, keine HTTP-Schnittstelle.');
} else {
  const app = createApp(db, { prices, venue });

  for (const host of hosts) {
    const server = app.listen(port, host, () => {
      console.log(`Gladiator v2 läuft auf http://${host}:${port} (Web-UI: /, tRPC: /api/trpc, Health: /health)${role === 'web' ? ' [ROLE=web — Jobs im gladiator-worker-Dienst]' : ''}`);
    });
    // Fail-fast: Wenn eine Bind-Adresse nicht verfügbar ist (z. B. Port belegt),
    // darf der Prozess nicht halb-erreichbar weiterlaufen.
    server.on('error', (err) => {
      console.error(`Bind auf ${host}:${port} fehlgeschlagen — Abbruch:`, err);
      process.exit(1);
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (feedRefresh) clearInterval(feedRefresh);
    void Promise.allSettled([prices?.stop(), jobs?.stop()]).finally(() => process.exit(0));
  });
}
