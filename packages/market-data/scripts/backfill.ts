/**
 * Backfill echter historischer OHLCV (Binance, öffentlich) in die Timescale-DB.
 * Aufruf: npm run backfill -w @gladiator/market-data [-- --since=2024-01-01]
 */
import { createDb } from '@gladiator/db';
import { backfillOhlcv } from '../src/ohlcv.js';

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const TIMEFRAMES = ['1h', '4h', '1d'];

const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
const since = new Date(sinceArg ?? '2024-01-01T00:00:00Z');
if (Number.isNaN(since.getTime())) throw new Error(`Ungültiges --since: ${sinceArg}`);

const { db, pool } = createDb();
try {
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const res = await backfillOhlcv(db, { symbol, timeframe, since }, (m) => console.warn(m));
      console.log(
        `${symbol} ${timeframe}: ${res.fetched} geladen, ${res.inserted} neu, ${res.rejected} verworfen`,
      );
    }
  }
} finally {
  await pool.end();
}
