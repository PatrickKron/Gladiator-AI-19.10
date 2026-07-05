/**
 * Trading-Pair → Feed-Symbol des Live-Preis-Streams ("BTC/USDT").
 * Die DB hält Paare teils mit Slash ("BTC/USDT"), teils ohne ("BTCUSDT");
 * ein naives replace('USDT', '/USDT') macht aus "BTC/USDT" ein "BTC//USDT"
 * und der Kurs-Lookup läuft ins Leere („kein Live-Kurs" trotz Live-Feed).
 */
const QUOTES = ['USDT', 'USDC'];

export function feedSymbol(tradingPair: string | null | undefined): string | null {
  if (!tradingPair) return null;
  const upper = tradingPair.toUpperCase().trim();
  if (upper.includes('/')) return upper;
  for (const quote of QUOTES) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, -quote.length)}/${quote}`;
    }
  }
  return null;
}
