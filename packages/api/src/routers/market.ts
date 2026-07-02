import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getOhlcv } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

export const marketRouter = router({
  /** Letzter echter Tick je Symbol + Verbindungsstatus. Kein Feed → ehrlich 'offline'. */
  tickers: protectedProcedure.query(({ ctx }) => {
    if (!ctx.prices) {
      return { feed: 'offline' as const, tickers: [], status: {} as Record<string, string> };
    }
    const snap = ctx.prices.snapshot();
    return { feed: 'online' as const, tickers: snap.tickers, status: snap.status };
  }),

  /** Historische Kerzen aus der DB (echte Binance-Daten, kein Random-Walk). */
  ohlcv: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1),
        timeframe: z.enum(['1h', '4h', '1d']),
        limit: z.number().int().min(2).max(500).default(168),
      }),
    )
    .query(({ ctx, input }) => getOhlcv(ctx.db, input)),

  /** Ehrliche Übersicht: wie viele echte Kerzen liegen je Symbol/Timeframe in der DB. */
  ingestStatus: protectedProcedure.query(async ({ ctx }) => {
    const res = await ctx.db.execute(sql`
      SELECT symbol, timeframe, count(*)::int AS candles,
             min(ts) AS from_ts, max(ts) AS to_ts
      FROM ohlcv GROUP BY symbol, timeframe ORDER BY symbol, timeframe
    `);
    return res.rows as { symbol: string; timeframe: string; candles: number; from_ts: string; to_ts: string }[];
  }),
});
