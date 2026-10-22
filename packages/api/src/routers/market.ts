import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@gladiator/db';
import {
  fredConfigured,
  getDerivativesSnapshot,
  getMacroSnapshot,
  getMacroSeries,
  grsHistory,
  getStockQuotes,
  latestNews,
  upcomingEvents,
  eventsBetween,
  classifyEvent,
  getAssetQuotes,
  getEurUsdRate,
  getOhlcv,
  ingestTwelveData,
  twelveDataConfigured,
  twelveDataIntervalFor,
  TWELVE_DATA_INTERVALS,
  TWELVEDATA_VENUE,
  ingestYahooChart,
  YAHOO_VENUE,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MS,
  orderTimeframes,
  addFredWatch,
  listFredWatch,
  readFredWatchSeries,
  removeFredWatch,
  suggestFredSeries,
  listBinanceSpotPairs,
  searchSpotPairs,
} from '@gladiator/market-data';
import { noTradeWindowFor } from '@gladiator/risk';
import { hindsightOutcome, type HindsightSignal } from '@gladiator/backtest';
import { ensureCandles, scanUniverse } from '@gladiator/jobs';
import { CostGuard, envAnthropicProvider, guardedComplete } from '@gladiator/agents';
import {
  atr,
  bollinger,
  dealingRangeAt,
  detectFvgs,
  detectLiquidity,
  detectOrderBlocks,
  detectStructure,
  ema,
  macd,
  rsi,
} from '@gladiator/strategy-engine';
import { binanceStreamingBook, COMPARE_VENUES, fetchVenueQuotes, rankVenueQuotes, summarizeBook, type VenueQuote } from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Alle unterstützten Chart-Timeframes (Feature A) als zod-Enum — für chartData,
 * chartCandles und ohlcv. Die UI zeigt je Asset nur die, für die echte Kerzen
 * existieren (siehe availableTimeframes).
 */
const timeframeEnum = z.enum(SUPPORTED_TIMEFRAMES);

/** Börsen-Vergleich: 15-s-Cache je Symbol (öffentliche Endpunkte, ratelimit-freundlich). */
const VENUE_QUOTE_TTL_MS = 15_000;
const venueQuoteCache = new Map<string, { at: number; quotes: VenueQuote[] }>();

/**
 * Kosten-Wächter für die News-Zusammenfassung — gleiche Budget-Logik wie im
 * Workshop (LLM_DAILY_BUDGET_USD, Default 5 USD/Tag). WARUM eigener Guard:
 * jede Router-Datei hält ihren eigenen In-Memory-Wächter (siehe strategies.ts),
 * das Budget gilt pro Prozess und Tag als weiche Obergrenze.
 */
const newsLlmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

/** Anzeigenamen für die Antwortsprache der News-Zusammenfassung (B6-Sprachen). */
const SUMMARY_LANGUAGES: Record<string, string> = {
  de: 'Deutsch',
  en: 'English',
  it: 'Italiano',
  es: 'Español',
  fr: 'Français',
};

/** Indikator-Serie (index-basiert) → zeitgestempelte, null-freie Punkte für den Chart. */
function toTimed(times: number[], values: (number | null)[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push({ time: times[i]!, value: v });
  }
  return out;
}

/** Basis-Ticker aus einem Handelspaar (z. B. „BTC/USDT" → „BTC"). */
function baseTicker(pair: string): string {
  return (pair.split('/')[0] ?? pair).toUpperCase();
}

type AffectedAsset = { symbol: string; level: 1 | 2 | 3; kind: 'crypto' | 'stock' };

/**
 * Konkrete, ECHT im System vorhandene Assets, die ein Event voraussichtlich
 * bewegt — Schnitt aus Impact-Profil und dem tatsächlichen Gladiator-Universum
 * (Krypto = Scan-Universum, Aktien/ETF/Forex = geladene Twelve-Data-Symbole).
 * Nichts erfunden: sind keine Aktien geladen, erscheinen auch keine.
 */
function resolveAffectedAssets(
  impact: ReturnType<typeof classifyEvent>,
  cryptoTickers: string[],
  stockTickers: string[],
): AffectedAsset[] {
  const out: AffectedAsset[] = [];
  const cryptoLevel = Math.min(impact.severity, impact.cryptoRelevance);
  if (cryptoLevel > 0) {
    for (const s of cryptoTickers) out.push({ symbol: s, level: cryptoLevel as 1 | 2 | 3, kind: 'crypto' });
  }
  const stockLevel = Math.min(impact.severity, impact.equityRelevance);
  if (stockLevel > 0) {
    for (const s of stockTickers) out.push({ symbol: s, level: stockLevel as 1 | 2 | 3, kind: 'stock' });
  }
  return out;
}

export const marketRouter = router({
  /** Echter EUR/USD-Kurs (Binance EURUSDT, 60s-Cache) — null wenn nicht verfügbar. */
  eurUsd: protectedProcedure.query(async () => ({ rate: await getEurUsdRate() })),

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
        timeframe: timeframeEnum,
        limit: z.number().int().min(2).max(500).default(168),
      }),
    )
    .query(({ ctx, input }) => getOhlcv(ctx.db, input)),

  /**
   * Verfügbare Timeframes je Asset (Feature A): exakt die unterstützten TFs, für
   * die ECHTE Kerzen in der DB liegen (venue-spezifisch), in kanonischer
   * Reihenfolge. Basis für die TF-Buttons — es wird nichts angeboten, wofür
   * keine Kerzen existieren (eiserne Regel: nichts erfunden).
   */
  availableTimeframes: protectedProcedure
    .input(z.object({ symbol: z.string().min(1), venue: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(sql`
        SELECT DISTINCT timeframe FROM ohlcv
        WHERE symbol = ${input.symbol.toUpperCase()} AND venue = ${input.venue ?? 'binance'}
      `);
      return orderTimeframes((rows.rows as { timeframe: string }[]).map((r) => r.timeframe));
    }),

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

  /**
   * Daten-Assistent: eigene offizielle FRED-Serien. `dataSuggest` übersetzt
   * Klartext („Geldmenge", „Zinskurve") in echte FRED-IDs; `dataAdd` prüft die
   * Serie gegen FRED und speichert nur echte Punkte; der macro-sync zieht nach.
   */
  dataSuggest: protectedProcedure
    .input(z.object({ query: z.string().max(80) }))
    .query(({ input }) => suggestFredSeries(input.query)),

  dataWatchlist: protectedProcedure.query(async ({ ctx }) => {
    const list = await listFredWatch(ctx.db);
    return Promise.all(
      list.map(async (w) => ({
        ...w,
        latestTs: w.latestTs.toISOString(),
        series: (await readFredWatchSeries(ctx.db, w.seriesId, 120)).map((p) => ({ ts: p.ts.toISOString(), value: p.value })),
      })),
    );
  }),

  dataAdd: protectedProcedure.input(z.object({ seriesId: z.string().min(1).max(30) })).mutation(async ({ ctx, input }) => {
    try {
      const res = await addFredWatch(ctx.db, input.seriesId);
      await ctx.db.insert(schema.auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'data.watch.add',
        entityType: 'macro_series',
        entityId: null,
        details: { source: 'fred-user', seriesId: res.seriesId, points: res.points },
        ip: ctx.ip,
      });
      return { ...res, latestTs: res.latestTs.toISOString() };
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) });
    }
  }),

  dataRemove: protectedProcedure.input(z.object({ seriesId: z.string().min(1).max(30) })).mutation(async ({ ctx, input }) => {
    await removeFredWatch(ctx.db, input.seriesId);
    return { ok: true };
  }),

  /**
   * GRS-Verlauf der letzten 30 Handelstage (P2.11) — je Stichtag mit derselben
   * dokumentierten Formel aus echten VIX/DXY/US10Y-Serien berechnet. Zu wenig
   * Historie ⇒ leeres Ergebnis (kein geratener Verlauf).
   */
  grsHistory: protectedProcedure.query(async ({ ctx }) => {
    const [vix, dxy, us10y] = await Promise.all([
      getMacroSeries(ctx.db, 'VIX', 60),
      getMacroSeries(ctx.db, 'DXY', 60),
      getMacroSeries(ctx.db, 'US10Y', 60),
    ]);
    return grsHistory(vix, dxy, us10y, 30).map((p) => ({ ts: p.ts.toISOString(), score: Math.round(p.score * 10) / 10 }));
  }),

  /**
   * Wirtschaftskalender (echter Feed) + aktives No-Trade-Fenster.
   * Jedes Event wird regelbasiert um sein Impact-Profil angereichert: Kategorie,
   * typisch reagierende Märkte und die konkret betroffenen Gladiator-Assets
   * (Krypto-Universum + geladene Twelve-Data-Symbole), farbfähig nach Impact.
   * Wahlweise `from`/`to` (ISO) für die Monats-/Wochenansicht, sonst `days` ab jetzt.
   */
  calendar: protectedProcedure
    .input(
      z.object({
        days: z.number().int().min(1).max(14).default(7),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const useRange = Boolean(input.from || input.to);
      const rangeFrom = input.from ? new Date(input.from) : now;
      const rangeTo = input.to ? new Date(input.to) : new Date(rangeFrom.getTime() + input.days * 86_400_000);

      const events = useRange
        ? await eventsBetween(ctx.db, rangeFrom, rangeTo)
        : await upcomingEvents(ctx.db, { days: input.days });

      // No-Trade-Fenster hängt IMMER an „jetzt", unabhängig vom Blätter-Fenster.
      const nowEvents = useRange ? await upcomingEvents(ctx.db, { days: 3 }) : events;
      const noTrade = noTradeWindowFor(
        nowEvents.map((e) => ({ title: e.title, currency: e.currency, importance: e.importance, scheduledAt: e.scheduledAt })),
        now,
      );

      // Reales Universum EINMAL auflösen (nicht je Event neu abfragen).
      const cryptoTickers = [...new Set((await scanUniverse(ctx.db)).map(baseTicker))];
      const stockRows = await ctx.db.execute(
        sql`SELECT DISTINCT symbol FROM ohlcv WHERE venue = ${TWELVEDATA_VENUE} ORDER BY symbol`,
      );
      const stockTickers = (stockRows.rows as { symbol: string }[]).map((r) => r.symbol.toUpperCase());

      return {
        events: events.map((e) => {
          const impact = classifyEvent({ title: e.title, currency: e.currency, importance: e.importance });
          return {
            id: e.id,
            title: e.title,
            currency: e.currency,
            importance: e.importance,
            scheduledAt: e.scheduledAt,
            forecast: e.forecast,
            previous: e.previous,
            impact: {
              category: impact.category,
              severity: impact.severity,
              scope: impact.scope,
              markets: impact.markets,
              assets: resolveAffectedAssets(impact, cryptoTickers, stockTickers),
            },
          };
        }),
        noTrade: noTrade ? { reason: noTrade.reason } : null,
      };
    }),

  /** Echte News aus RSS-Ingestion. */
  news: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(({ ctx, input }) => latestNews(ctx.db, input.limit)),

  /**
   * KI-Kurzzusammenfassung der Favoriten-News (Magazin „Für meine Märkte").
   * Der Client schickt die ECHTEN, bereits den Favoriten zugeordneten
   * RSS-Schlagzeilen — das LLM kennt nur diese Titel und darf nichts erfinden
   * (keine Kurse, keine Fakten außerhalb der Schlagzeilen). Ohne
   * ANTHROPIC_API_KEY gibt es einen ehrlichen PRECONDITION_FAILED statt eines
   * Fake-Summaries; der Budget-Wächter deckelt die Tageskosten.
   */
  newsSummarize: protectedProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              title: z.string().min(3).max(400),
              source: z.string().min(1).max(60),
              publishedAt: z.string().datetime(),
              /** Ticker der Favoriten, die diese Schlagzeile getroffen hat (Wortabgleich im Client). */
              favorites: z.array(z.string().min(1).max(20)).min(1).max(10),
            }),
          )
          .min(1)
          .max(24),
        language: z.string().min(2).max(5).default('de'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const provider = envAnthropicProvider();
      if (!provider.configured) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Kein ANTHROPIC_API_KEY hinterlegt — die KI-Zusammenfassung braucht ihn. In Einstellungen → API-Schlüssel eintragen; die Favoriten-Zuordnung der News funktioniert auch ohne.',
        });
      }

      const language = SUMMARY_LANGUAGES[input.language] ?? 'Deutsch';
      const lines = input.items.map(
        (i) => `- [${i.favorites.join(', ')}] (${i.source}, ${i.publishedAt.slice(0, 16)}) ${i.title}`,
      );
      const completion = await guardedComplete(provider, newsLlmGuard, {
        system: [
          'Du fasst für einen Trader die wichtigsten News zu seinen Favoriten-Märkten zusammen.',
          'Du kennst AUSSCHLIESSLICH die gelieferten RSS-Schlagzeilen — NICHT die Artikel dahinter.',
          'Erfinde nichts: keine Kurse, keine Zahlen, keine Fakten, die nicht wörtlich in den Schlagzeilen stehen.',
          'Wenn die Schlagzeilen für eine Aussage nicht reichen, sag das ehrlich, statt zu spekulieren.',
          'Gliedere nach den Tickern in eckigen Klammern (wichtigster Markt zuerst), je Markt 1-3 kurze Sätze.',
          'Keine Anlageberatung, keine Kauf-/Verkaufsempfehlung. Maximal ~150 Wörter, reiner Fließtext ohne Markdown-Tabellen.',
          `Antworte auf ${language}.`,
        ].join('\n'),
        prompt: `Aktuelle Schlagzeilen zu den Favoriten (Format: [Ticker] (Quelle, Zeit) Titel):\n\n${lines.join('\n')}`,
        maxTokens: 1200,
      });

      await ctx.db.insert(schema.auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'market.news.summarized',
        entityType: 'news',
        details: {
          items: input.items.length,
          favorites: [...new Set(input.items.flatMap((i) => i.favorites))],
          costUsd: completion.costUsd,
        },
        ip: ctx.ip,
      });

      return { summary: completion.text.trim(), costUsd: completion.costUsd };
    }),

  /**
   * Orderbuch-Ansicht: echtes Binance-Buch per Websocket-Stream (warm gehalten,
   * solange jemand hinschaut); bis der Stream liefert bzw. bei Ausfall REST
   * (3-s-Cache). `live` sagt ehrlich, welche Quelle gerade antwortet.
   * Nicht erreichbar/kein Markt ⇒ ehrlicher Fehler, nie ein erfundenes Buch.
   */
  orderBook: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3).max(30),
        levels: z.number().int().min(5).max(50).default(15),
        group: z.number().positive().max(100_000).optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        const stream = binanceStreamingBook();
        const book = await stream.get(input.symbol);
        const live = stream.status(input.symbol) === 'live';
        return { ...summarizeBook(book, { levels: input.levels, ...(input.group ? { group: input.group } : {}) }), live };
      } catch (err) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /**
   * Börsen-Vergleich (Vision-Punkt 2): echte, öffentliche Kurse je Börse für
   * ein Symbol, gerankt nach effektivem Preis inkl. Taker-Gebühr (Kauf: Ask,
   * Verkauf: Bid). `connected` = du hast diese Börse in den Einstellungen
   * angeschlossen. Nicht erreichbare Börsen bleiben sichtbar, nie geschätzt.
   */
  venueQuotes: protectedProcedure
    .input(z.object({ symbol: z.string().min(3).max(30), side: z.enum(['buy', 'sell']).default('buy') }))
    .query(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      let cached = venueQuoteCache.get(symbol);
      if (!cached || Date.now() - cached.at > VENUE_QUOTE_TTL_MS) {
        cached = { at: Date.now(), quotes: await fetchVenueQuotes(symbol, COMPARE_VENUES) };
        venueQuoteCache.set(symbol, cached);
      }
      const conns = await ctx.db
        .select({ exchangeId: schema.exchangeConnections.exchangeId })
        .from(schema.exchangeConnections)
        .where(and(eq(schema.exchangeConnections.userId, ctx.user.id), eq(schema.exchangeConnections.status, 'active')));
      const connected = new Set(conns.map((c) => c.exchangeId));
      return {
        symbol,
        side: input.side,
        fetchedAt: new Date(cached.at).toISOString(),
        venues: rankVenueQuotes(cached.quotes, input.side).map((q) => ({ ...q, connected: connected.has(q.venue) })),
      };
    }),

  /** Aktien-/ETF-Quotes (Yahoo, 5-min-Cache). Unbekannt ⇒ null (ehrlich kein Kurs). */
  stockQuotes: protectedProcedure
    .input(z.object({ symbols: z.array(z.string().min(1)).min(1).max(30) }))
    .query(({ input }) => getStockQuotes(input.symbols)),

  /**
   * Live-Quotes für Katalog-Assets ALLER Klassen (Krypto → Binance,
   * Aktien/ETF/Index/Future/Rohstoff → TradingView-Scanner, VVIX/GVZ → CBOE).
   * Ehrlich: Assets ohne funktionierende Quelle kommen als null zurück.
   */
  assetQuotes: protectedProcedure
    .input(
      z
        .object({ packageId: z.number().int().optional(), assetIds: z.array(z.number().int()).min(1).max(250).optional() })
        .refine((v) => v.packageId !== undefined || v.assetIds !== undefined, 'packageId oder assetIds nötig'),
    )
    .query(async ({ ctx, input }) => {
      const { assets } = schema;
      const rows = await ctx.db
        .select({ ticker: assets.ticker, assetType: assets.assetType, tradingPair: assets.tradingPair })
        .from(assets)
        .where(input.packageId !== undefined ? eq(assets.packageId, input.packageId) : inArray(assets.id, input.assetIds!));
      return getAssetQuotes(rows);
    }),

  /** Funding/OI-Snapshot (Binance-Futures, Basis des Shadow-Agenten). */
  derivatives: protectedProcedure.query(({ ctx }) => getDerivativesSnapshot(ctx.db)),

  /** Aktuelles Scan-Universum (Basis + Stern-Favoriten) — für Selektoren. */
  scanUniverse: protectedProcedure.query(({ ctx }) => scanUniverse(ctx.db)),

  /**
   * Asset-Suche (Patricks Mängelliste 2026-10-22, Punkt 3): alle Binance-Spot-Paare gegen
   * USDT, live von der Börse (1 h gemerkt). `hasCandles` sagt, ob schon echte Kerzen in der
   * DB liegen; ohne Verbindung zur Börse ehrlich `connected: false` statt einer Teilliste.
   */
  symbolSearch: protectedProcedure
    .input(z.object({ q: z.string().max(32).default(''), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      let pairs;
      try {
        pairs = await listBinanceSpotPairs();
      } catch (err) {
        return { connected: false as const, total: 0, results: [] as { symbol: string; hasCandles: boolean }[], error: String(err).slice(0, 200) };
      }
      const hits = searchSpotPairs(pairs, input.q, input.limit);
      const known = await ctx.db.execute(sql`SELECT DISTINCT symbol FROM ohlcv WHERE venue = 'binance' AND timeframe = '1h'`);
      const withCandles = new Set((known.rows as { symbol: string }[]).map((r) => r.symbol));
      return { connected: true as const, total: pairs.length, results: hits.map((p) => ({ symbol: p.symbol, hasCandles: withCandles.has(p.symbol) })), error: null };
    }),

  /**
   * Kerzen auf Abruf: für ein Binance-Spot-Paar alle Zeitrahmen inkrementell nachladen
   * (derselbe Backfill wie der Scan für Favoriten). Nur echte Paare — ein unbekanntes
   * Symbol ist ein Fehler, keine leere Historie.
   */
  ensureCandles: protectedProcedure.input(z.object({ symbol: z.string().min(3).max(24) })).mutation(async ({ ctx, input }) => {
    const symbol = input.symbol.toUpperCase();
    let pairs;
    try {
      pairs = await listBinanceSpotPairs();
    } catch (err) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Binance nicht erreichbar — ${String(err instanceof Error ? err.message : err).slice(0, 160)}` });
    }
    if (!pairs.some((p) => p.symbol === symbol)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `${symbol} ist kein Binance-Spot-Paar gegen USDT.` });
    }
    const res = await ensureCandles(ctx.db, symbol);
    const n = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM ohlcv WHERE venue = 'binance' AND symbol = ${symbol} AND timeframe = '1h'`);
    return { symbol, inserted: res.inserted, errors: res.errors, candles1h: (n.rows[0] as { n: number }).n };
  }),

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
        symbol: z.string().min(1),
        timeframe: timeframeEnum,
        limit: z.number().int().min(50).max(500).default(200),
        venue: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const candles = await getOhlcv(ctx.db, { symbol: input.symbol.toUpperCase(), timeframe: input.timeframe, limit: input.limit, venue: input.venue });
      return candles.map((c) => ({ time: Math.floor(c.ts.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
    }),

  /**
   * Kerzen über ein Zeitfenster (Backtest-Overlay): das gesamte [from,to]-Fenster
   * aufsteigend, gekappt bei `max` (ehrlich als `truncated` markiert). Getrennt
   * von chartCandles, damit der Signal-Chart unberührt bleibt. Optional `venue`
   * (z. B. 'twelvedata' für Aktien) und beliebiger Timeframe-String.
   */
  rangedCandles: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(3),
        timeframe: z.string().min(2).max(4),
        from: z.string().datetime(),
        to: z.string().datetime(),
        max: z.number().int().min(200).max(6000).default(5000),
        venue: z.string().min(2).max(32).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const candles = await getOhlcv(ctx.db, {
        symbol: input.symbol.toUpperCase(),
        timeframe: input.timeframe,
        venue: input.venue,
        since: new Date(input.from),
        until: new Date(input.to),
        limit: input.max,
      });
      const bars = candles.map((c) => ({ time: Math.floor(c.ts.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
      return { bars, truncated: candles.length >= input.max };
    }),

  /**
   * Voll-Chart-Daten (Krypto-Charting): echte Kerzen + ALLE Indikatorserien
   * (EMA 20/50/200, Bollinger, RSI, MACD, ATR) + Smart-Money-Marker
   * (BOS/CHoCH-Struktur, Order Blocks, FVG-Zonen) — zeitlich ausgerichtet.
   * Nichts erfunden: Indikatoren rechnen exakt auf denselben DB-Kerzen wie
   * die Signal-Engine; Positionen ohne Historie fehlen (kein Raten).
   */
  /**
   * Übungs-Trade im Bar-Replay (Repo-Masterliste, Phase 3): Einstieg zum Schluss
   * der Kerze `entryTime` (die Replay-Kerze beim Klick), Stop/Ziel absolut; der
   * Ausgang kommt aus DERSELBEN Engine wie Backtest und „Was wäre passiert"
   * (hindsightOutcome: Stop zuerst, gap-realistisch, netto nach Kosten) auf den
   * echten Kerzen bis zum Replay-Stand `until`. Nichts wird gespeichert — Training.
   */
  replayTrade: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1),
        timeframe: timeframeEnum,
        venue: z.string().optional(),
        direction: z.enum(['long', 'short']),
        entryTime: z.number().int().positive(),
        stopLoss: z.number().positive(),
        takeProfit: z.number().positive(),
        until: z.number().int().positive(),
        /** Noch offen am Replay-Stand → zum Schluss dieser Kerze schließen (manueller Ausstieg). */
        closeAtEnd: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const tfMs = TIMEFRAME_MS[input.timeframe];
      const symbol = input.symbol.toUpperCase();
      const candles = await getOhlcv(ctx.db, {
        symbol,
        timeframe: input.timeframe,
        venue: input.venue,
        since: new Date(input.entryTime * 1000),
        until: new Date(input.until * 1000),
      });
      const entryBar = candles.find((c) => c.ts.getTime() === input.entryTime * 1000);
      const none = { entry: null, rMultiple: null, exitReason: null, exitTime: null, barsHeld: null, lastClose: null };
      if (!entryBar) return { status: 'no_data' as const, ...none };
      const entry = entryBar.close;
      const wrongSide = input.direction === 'long' ? input.stopLoss >= entry || input.takeProfit <= entry : input.stopLoss <= entry || input.takeProfit >= entry;
      if (wrongSide) return { status: 'invalid' as const, ...none, entry };
      const sig: HindsightSignal = {
        id: 'replay',
        symbol,
        timeframe: input.timeframe,
        direction: input.direction,
        setupType: 'swing',
        entry,
        stopLoss: input.stopLoss,
        takeProfits: [input.takeProfit],
        trailPct: null,
        createdAt: new Date(input.entryTime * 1000 + tfMs), // Entry-Kerze ist zum Klick geschlossen
      };
      const out = hindsightOutcome(sig, candles, tfMs);
      const last = candles[candles.length - 1]!;
      const lastClose = last.close;
      if (out.status === 'no_data') return { status: 'open' as const, ...none, entry, lastClose }; // noch keine Folge-Kerze
      const exitTime = out.exitTs ? Math.floor(out.exitTs.getTime() / 1000) : null;
      if (out.status === 'open' && input.closeAtEnd) {
        return { status: 'closed' as const, entry, rMultiple: out.rMultiple, exitReason: 'manual' as const, exitTime: Math.floor(last.ts.getTime() / 1000), barsHeld: out.barsHeld, lastClose };
      }
      return { status: out.status, entry, rMultiple: out.rMultiple, exitReason: out.exitReason, exitTime, barsHeld: out.barsHeld, lastClose };
    }),

  chartData: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1),
        timeframe: timeframeEnum,
        limit: z.number().int().min(60).max(1000).default(400),
        /** Kerzenquelle: 'binance' (Krypto, Default) oder 'yahoo'/'twelvedata' (Aktien/ETF). */
        venue: z.string().optional(),
        /** Replay: nur Kerzen bis zu dieser Zeit (Unix-Sekunden) — alles darunter wird aus genau diesen Kerzen gerechnet. */
        until: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      const until = input.until !== undefined ? new Date(input.until * 1000) : undefined;
      const candles = await getOhlcv(ctx.db, { symbol, timeframe: input.timeframe, limit: input.limit, venue: input.venue, until });
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

      // Liquidität (Equal Highs/Lows + Sweeps) und Dealing Range (Premium/Discount)
      // — eigene Engine, dieselben Pivots (8/8) wie die Struktur. Cap wie bei den
      // Zonen: die 8 jüngsten Level, die 20 jüngsten Sweeps (`levelsTotal` ehrlich).
      const liq = detectLiquidity(candles);
      const allLevels = liq.levels.map((lv) => {
        const endIdx = lv.sweptAt ?? lv.brokenAt ?? null;
        return {
          kind: lv.kind,
          price: lv.price,
          swings: lv.swingIndices.length,
          fromTime: times[lv.swingIndices[0]!]!,
          toTime: endIdx != null ? times[endIdx]! : lastTime,
          active: endIdx == null,
        };
      });
      const liquidity = {
        levels: allLevels.sort((a, b) => b.fromTime - a.fromTime).slice(0, 8),
        levelsTotal: allLevels.length,
        sweeps: liq.sweeps
          .slice(-20)
          .map((sw) => ({ time: times[sw.index]!, side: sw.side, level: sw.level, source: sw.source })),
      };
      const dr = dealingRangeAt(candles, liq.swings, candles.length - 1);
      const range = dr
        ? {
            high: dr.high,
            low: dr.low,
            equilibrium: dr.equilibrium,
            fromTime: times[Math.min(dr.highIndex, dr.lowIndex)]!,
            position: dr.position,
            zone: dr.zone,
          }
        : null;

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
        liquidity,
        range,
      };
    }),

  /**
   * Aktien/ETF/Forex im Haupt-Chart (Repo-Masterliste, Phase 5): alle Symbole
   * mit echten Kerzen aus Twelve Data oder Yahoo, je Quelle mit Zeitrahmen —
   * plus ob ein Twelve-Data-Key gesetzt ist (ohne Key und ohne Kerzen: ehrlich
   * „nicht verbunden“).
   */
  stockSymbols: protectedProcedure.query(async ({ ctx }) => {
    const res = await ctx.db.execute(sql`
      SELECT venue, symbol, array_agg(DISTINCT timeframe ORDER BY timeframe) AS timeframes, count(*)::int AS candles
      FROM ohlcv WHERE venue IN (${TWELVEDATA_VENUE}, ${YAHOO_VENUE})
      GROUP BY venue, symbol ORDER BY symbol, venue
    `);
    return {
      configured: { twelvedata: twelveDataConfigured() },
      rows: res.rows as { venue: 'twelvedata' | 'yahoo'; symbol: string; timeframes: string[]; candles: number }[],
    };
  }),

  /**
   * Twelve-Data-Status (Feature 4): ist ein Key gesetzt, welche Auflösungen sind
   * verfügbar, und welche Aktien-Kerzen liegen schon in der DB (venue=twelvedata).
   */
  twelveDataStatus: protectedProcedure.query(async ({ ctx }) => {
    const res = await ctx.db.execute(sql`
      SELECT symbol, timeframe, count(*)::int AS candles,
             min(ts) AS from_ts, max(ts) AS to_ts
      FROM ohlcv WHERE venue = ${TWELVEDATA_VENUE}
      GROUP BY symbol, timeframe ORDER BY symbol, timeframe
    `);
    return {
      configured: twelveDataConfigured(),
      timeframes: Object.keys(TWELVE_DATA_INTERVALS),
      symbols: res.rows as { symbol: string; timeframe: string; candles: number; from_ts: string; to_ts: string }[],
    };
  }),

  /**
   * Aktien-/ETF-/Forex-Kerzen EINER Auflösung von Twelve Data in die DB laden
   * (echt, idempotent). Ein Timeframe je Aufruf → schnell + rate-limit-schonend;
   * die UI durchläuft alle gewünschten Auflösungen mit clientseitigem Pacing.
   */
  ingestStock: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(20),
        timeframe: z.enum(Object.keys(TWELVE_DATA_INTERVALS) as [string, ...string[]]),
        outputsize: z.number().int().min(50).max(5000).default(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!twelveDataConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein TWELVE_DATA_API_KEY gesetzt — in den Einstellungen eintragen.' });
      }
      // Frühe, klare Fehlermeldung bei unbekanntem Timeframe (defensiv)
      twelveDataIntervalFor(input.timeframe);
      try {
        return await ingestTwelveData(ctx.db, { symbol: input.symbol.toUpperCase(), timeframe: input.timeframe, outputsize: input.outputsize });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Ingest fehlgeschlagen.' });
      }
    }),

  /**
   * Aktien-/ETF-Kerzen von Yahoo (v8-Chart, KEIN API-Key — Reverse-Engineering,
   * Patricks bevorzugter Weg). Echte OHLCV, venue='yahoo', idempotent. Ein Symbol
   * je Aufruf, schonend gegen das Rate-Limit. Ehrlicher Fehler bei Nichterreichbarkeit.
   */
  ingestStockYahoo: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(12),
        timeframe: z.enum(['1h', '1d', '1wk', '1M']).default('1d'),
        range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']).default('2y'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await ingestYahooChart(ctx.db, { symbol: input.symbol, timeframe: input.timeframe, range: input.range });
      if (res.error) {
        throw new TRPCError({ code: 'BAD_GATEWAY', message: `Yahoo: ${res.error}` });
      }
      await ctx.db.insert(schema.auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'market.stock.ingest_yahoo',
        entityType: 'ohlcv',
        details: { venue: YAHOO_VENUE, symbol: res.symbol, timeframe: res.timeframe, fetched: res.fetched, inserted: res.inserted },
        ip: ctx.ip,
      });
      return res;
    }),
});
