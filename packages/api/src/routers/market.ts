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
import { scanUniverse } from '@gladiator/jobs';
import {
  atr,
  bollinger,
  detectFvgs,
  detectOrderBlocks,
  detectStructure,
  ema,
  macd,
  rsi,
} from '@gladiator/strategy-engine';
import { protectedProcedure, router } from '../trpc.js';

/** Indikator-Serie (index-basiert) → zeitgestempelte, null-freie Punkte für den Chart. */
function toTimed(times: number[], values: (number | null)[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push({ time: times[i]!, value: v });
  }
  return out;
}

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

  /** Aktuelles Scan-Universum (Basis + Stern-Favoriten) — für Selektoren. */
  scanUniverse: protectedProcedure.query(({ ctx }) => scanUniverse(ctx.db)),

  /**
   * Asset-Kontext (Patrick-Lücke 2/6): ALLES echt aus eigenen Kerzen + Feeds
   * für GENAU dieses Asset — Basis für Oracle/Aegis/Favoriten-Briefing.
   */
  assetContext: protectedProcedure
    .input(z.object({ symbol: z.string().min(3) }))
    .query(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      const candles1h = await getOhlcv(ctx.db, { symbol, timeframe: '1h', limit: 400 });
      if (candles1h.length < 30) {
        return { symbol, available: false as const, candles: candles1h.length };
      }
      const closes = candles1h.map((c) => c.close);
      const last = closes[closes.length - 1]!;
      const ago24h = closes.length > 24 ? closes[closes.length - 1 - 24]! : closes[0]!;

      const ema200Series = ema(closes, 200);
      const ema200 = ema200Series[ema200Series.length - 1];
      const rsiSeries = rsi(closes);
      const rsi14 = rsiSeries[rsiSeries.length - 1];
      const atrSeries = atr(candles1h);
      const atr14 = atrSeries[atrSeries.length - 1];
      const events = detectStructure(candles1h);
      const lastEvent = events[events.length - 1] ?? null;

      // Intraday-Range (heute UTC) für SAFE-003-Kontext (BTC > 10 % Regel)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todays = candles1h.filter((c) => c.ts >= todayStart);
      const dayHigh = todays.length > 0 ? Math.max(...todays.map((c) => c.high)) : null;
      const dayLow = todays.length > 0 ? Math.min(...todays.map((c) => c.low)) : null;
      const intradayRangePct = dayHigh !== null && dayLow !== null && dayLow > 0 ? ((dayHigh - dayLow) / dayLow) * 100 : null;

      // Derivate für dieses Symbol (echt; null wenn kein Perp-Feed)
      const deriv = (await getDerivativesSnapshot(ctx.db, [symbol]))[0] ?? null;

      // Offene Signale + passende aktive Gates für dieses Symbol
      const openSignals = await ctx.db.execute(
        sql`SELECT count(*)::int AS n FROM signals WHERE symbol = ${symbol} AND status = 'new'`,
      );
      const gates = await ctx.db.execute(
        sql`SELECT reason FROM risk_gates WHERE is_active = true AND (symbol IS NULL OR symbol = ${symbol}) LIMIT 10`,
      );
      // Exposure aus offenen Positionen (alle User — ein User-Typ)
      const exposure = await ctx.db.execute(
        sql`SELECT coalesce(sum(qty::float * entry_price::float), 0) AS notional FROM positions WHERE symbol = ${symbol}`,
      );
      // News-Treffer: Basis-Ticker im Titel (echte RSS-Items)
      const base = symbol.split('/')[0]!;
      const news = await ctx.db.execute(
        sql`SELECT title, url, published_at FROM news_items WHERE title ILIKE ${'%' + base + '%'} ORDER BY published_at DESC LIMIT 3`,
      );

      return {
        symbol,
        available: true as const,
        candles: candles1h.length,
        price: last,
        change24hPct: ago24h > 0 ? (last / ago24h - 1) * 100 : null,
        emaRegime: ema200 != null ? ((last >= ema200 ? 'above' : 'below') as 'above' | 'below') : null,
        marketPhase: lastEvent ? ((lastEvent.direction === 'bullish' ? 'bull' : 'bear') as 'bull' | 'bear') : null,
        lastStructure: lastEvent ? { kind: lastEvent.kind, direction: lastEvent.direction, level: lastEvent.brokenLevel } : null,
        rsi14: rsi14 ?? null,
        atrPct: atr14 != null && last > 0 ? (atr14 / last) * 100 : null,
        intradayRangePct,
        funding: deriv ? { rate: deriv.fundingRate, oiChangePct24h: deriv.oiChangePct24h } : null,
        openSignals: (openSignals.rows[0] as { n: number }).n,
        matchingGates: (gates.rows as { reason: string }[]).map((g) => g.reason),
        exposureNotional: Number((exposure.rows[0] as { notional: number }).notional),
        news: (news.rows as { title: string; url: string; published_at: string }[]).map((n) => ({
          title: n.title,
          url: n.url,
          publishedAt: n.published_at,
        })),
      };
    }),

  /** Kerzen für den Signal-Chart (echte eigene DB-Kerzen, alle 4 TFs). */
  chartCandles: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3),
        timeframe: z.enum(['15m', '1h', '4h', '1d']),
        limit: z.number().int().min(50).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const candles = await getOhlcv(ctx.db, { symbol: input.symbol.toUpperCase(), timeframe: input.timeframe, limit: input.limit });
      return candles.map((c) => ({ time: Math.floor(c.ts.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
    }),

  /**
   * Voll-Chart-Daten (Krypto-Charting): echte Kerzen + ALLE Indikatorserien
   * (EMA 20/50/200, Bollinger, RSI, MACD, ATR) + Smart-Money-Marker
   * (BOS/CHoCH-Struktur, Order Blocks, FVG-Zonen) — zeitlich ausgerichtet.
   * Nichts erfunden: Indikatoren rechnen exakt auf denselben DB-Kerzen wie
   * die Signal-Engine; Positionen ohne Historie fehlen (kein Raten).
   */
  chartData: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3),
        timeframe: z.enum(['15m', '1h', '4h', '1d']),
        limit: z.number().int().min(60).max(1000).default(400),
      }),
    )
    .query(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      const candles = await getOhlcv(ctx.db, { symbol, timeframe: input.timeframe, limit: input.limit });
      if (candles.length === 0) {
        return { symbol, timeframe: input.timeframe, candles: [], available: false as const };
      }

      const times = candles.map((c) => Math.floor(c.ts.getTime() / 1000));
      const closes = candles.map((c) => c.close);

      const bb = bollinger(closes, 20, 2);
      const mac = macd(closes, 12, 26, 9);
      const macdHist = mac.histogram.map((v, i) =>
        v != null && Number.isFinite(v) ? { time: times[i]!, value: v, color: v >= 0 ? '#3ddc97' : '#ff5c6c' } : null,
      ).filter((x): x is { time: number; value: number; color: string } => x !== null);

      // Struktur (BOS/CHoCH) → Zeit + gebrochenes Level
      const structure = detectStructure(candles).map((e) => ({
        time: times[e.index]!,
        kind: e.kind,
        direction: e.direction,
        level: e.brokenLevel,
      }));

      // Zonen: Order Blocks + FVG; Zeitspanne von Entstehung bis Mitigation/Füllung
      // (aktive Zonen laufen bis zur letzten Kerze). Cap: die 12 jüngsten, damit
      // der Chart lesbar bleibt (ehrlich protokolliert im Feld `zonesTotal`).
      const lastTime = times[times.length - 1]!;
      const allZones = [...detectOrderBlocks(candles), ...detectFvgs(candles)].map((z) => {
        const closeIdx = z.mitigatedAt ?? z.filledAt ?? null;
        return {
          kind: z.kind,
          top: z.top,
          bottom: z.bottom,
          fromTime: times[z.createdAt] ?? times[z.index]!,
          toTime: closeIdx != null ? times[closeIdx]! : lastTime,
          active: closeIdx == null,
        };
      });
      const zones = allZones.sort((a, b) => b.fromTime - a.fromTime).slice(0, 12);

      return {
        symbol,
        timeframe: input.timeframe,
        available: true as const,
        candles: candles.map((c, i) => ({
          time: times[i]!,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
        volume: candles.map((c, i) => ({
          time: times[i]!,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(61,220,151,0.4)' : 'rgba(255,92,108,0.4)',
        })),
        ema: {
          e20: toTimed(times, ema(closes, 20)),
          e50: toTimed(times, ema(closes, 50)),
          e200: toTimed(times, ema(closes, 200)),
        },
        bollinger: {
          upper: toTimed(times, bb.upper),
          middle: toTimed(times, bb.middle),
          lower: toTimed(times, bb.lower),
        },
        rsi: toTimed(times, rsi(closes, 14)),
        macd: {
          line: toTimed(times, mac.macd),
          signal: toTimed(times, mac.signal),
          histogram: macdHist,
        },
        atr: toTimed(times, atr(candles, 14)),
        structure,
        zones,
        zonesTotal: allZones.length,
      };
    }),
});
