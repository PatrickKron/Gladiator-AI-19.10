import { isCandleVenue, normalizeTradingPair, type CandleVenue } from '@gladiator/jobs';

/**
 * Symbol + Quelle einer Asset-Zeile: Register-Quelle (candle_venue/data_symbol) gewinnt;
 * Katalog-Krypto → Binance-Paar; sonst ehrlich ohne Quelle (venue null, Ticker als Symbol).
 * Eine Wahrheit für Favoriten (product.favoriteSymbols) und den Signal-Favoritenfilter.
 */
export function assetSource(r: {
  ticker: string;
  assetType: string;
  tradingPair: string | null;
  candleVenue: string | null;
  dataSymbol: string | null;
}): { symbol: string; venue: CandleVenue | null } {
  if (isCandleVenue(r.candleVenue) && r.dataSymbol) return { symbol: r.dataSymbol, venue: r.candleVenue };
  const pair = normalizeTradingPair(r.tradingPair);
  if (pair) return { symbol: pair, venue: 'binance' };
  return { symbol: r.ticker.toUpperCase(), venue: null };
}
