import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  fredConfigured,
  getDerivativesSnapshot,
  getMacroSnapshot,
  getStockQuotes,
  latestNews,
  upcomingEvents,
  getOhlcv,
} from '@gladiator/market-data';
import { noTradeWindowFor } from '@gladiator/risk';
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

  /** Makro-Snapshot (Phase-1-Rest): echte VIX/DXY/US10Y-Serien + GRS. Keine Daten ⇒ nulls. */
  macro: protectedProcedure.query(async ({ ctx }) => {
    const snap = await getMacroSnapshot(ctx.db);
    return {
      fresh: snap.fresh,
      fredConfigured: fredConfigured(),
      vix: snap.vix,
      dxy: snap.dxy,
      us10y: snap.us10y,
      grs: snap.grs,
      series: {
        vix: snap.series.vix.slice(-90),
        dxy: snap.series.dxy.slice(-90),
        us10y: snap.series.us10y.slice(-90),
      },
    };
  }),

  /** Wirtschaftskalender (echter Feed) + aktives No-Trade-Fenster. */
  calendar: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(14).default(7) }))
    .query(async ({ ctx, input }) => {
      const events = await upcomingEvents(ctx.db, { days: input.days });
      const now = new Date();
      const noTrade = noTradeWindowFor(
        events.map((e) => ({ title: e.title, currency: e.currency, importance: e.importance, scheduledAt: e.scheduledAt })),
        now,
      );
      return {
        events: events.map((e) => ({
          id: e.id,
          title: e.title,
          currency: e.currency,
          importance: e.importance,
          scheduledAt: e.scheduledAt,
          forecast: e.forecast,
          previous: e.previous,
        })),
        noTrade: noTrade ? { reason: noTrade.reason } : null,
      };
    }),

  /** Echte News aus RSS-Ingestion. */
  news: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(({ ctx, input }) => latestNews(ctx.db, input.limit)),

  /** Aktien-/ETF-Quotes (Yahoo, 5-min-Cache). Unbekannt ⇒ null (ehrlich kein Kurs). */
  stockQuotes: protectedProcedure
    .input(z.object({ symbols: z.array(z.string().min(1)).min(1).max(30) }))
    .query(({ input }) => getStockQuotes(input.symbols)),

  /** Funding/OI-Snapshot (Binance-Futures, Basis des Shadow-Agenten). */
  derivatives: protectedProcedure.query(({ ctx }) => getDerivativesSnapshot(ctx.db)),
});
