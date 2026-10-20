import ccxt from 'ccxt';

/**
 * Öffentliche Binance-Marktdaten mit Standort-Ausweichweg. Binance sperrt
 * manche Standorte (z. B. US-Rechenzentren wie die GitHub-Runner) mit HTTP 451.
 * Für ÖFFENTLICHE Marktdaten betreibt Binance selbst den Spiegel
 * data-api.binance.vision — gleiche Kerzen/Bücher, keine Konto-Funktionen.
 * Nur bei einer echten 451-Sperre wird umgeleitet; alles andere bleibt ein Fehler.
 */
export const BINANCE_MARKET_DATA_MIRROR = 'https://data-api.binance.vision';

export function isGeoBlocked(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b451\b/.test(err.message) && /restricted location|Eligibility/i.test(err.message);
}

type BinanceClient = InstanceType<typeof ccxt.binance>;

export function binancePublicClient(mirror: boolean): BinanceClient {
  const ex = new ccxt.binance({ enableRateLimit: true });
  if (mirror) {
    (ex.urls.api as Record<string, string>).public = `${BINANCE_MARKET_DATA_MIRROR}/api/v3`;
    ex.options.fetchMarkets = { ...(ex.options.fetchMarkets as object), types: ['spot'] };
  }
  return ex;
}

/** Prozessweit gemerkt: ist die Sperre einmal erkannt, gleich den Spiegel nehmen. */
let useMirror = process.env.BINANCE_USE_DATA_MIRROR === '1';

export function binanceMirrorActive(): boolean {
  return useMirror;
}

/** Zwei geteilte Clients (direkt + Spiegel) — Markets-Cache und Rate-Limit bleiben erhalten. */
const shared: { direct?: BinanceClient; mirror?: BinanceClient } = {};
function sharedClient(mirror: boolean): BinanceClient {
  if (mirror) return (shared.mirror ??= binancePublicClient(true));
  return (shared.direct ??= binancePublicClient(false));
}

/** Führt fn mit dem passenden Client aus; bei 451 einmalig (prozessweit) auf den Spiegel wechseln. */
export async function withBinancePublic<T>(fn: (ex: BinanceClient) => Promise<T>): Promise<T> {
  if (useMirror) return fn(sharedClient(true));
  try {
    return await fn(sharedClient(false));
  } catch (err) {
    if (!isGeoBlocked(err)) throw err;
    useMirror = true;
    console.warn('[binance] Standort gesperrt (HTTP 451) — öffentliche Marktdaten über data-api.binance.vision.');
    return fn(sharedClient(true));
  }
}
