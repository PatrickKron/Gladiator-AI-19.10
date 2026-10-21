/** Pine `syminfo.tickerid` für ein Gladiator-Symbol ("BTC/USDT" → "BINANCE:BTCUSDT"). */
export function tickerIdOf(venue: string, symbol: string): string {
  return `${venue.toUpperCase()}:${symbol.replace('/', '')}`;
}
