import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { CANDLE_VENUES, isCandleVenue, normalizeTradingPair, type CandleVenue } from '@gladiator/jobs';
import { protectedProcedure, router } from '../trpc.js';
import { newsTicker } from '../market/asset-news.js';
import { registerOrThrow } from '../market/register.js';
import { assetSource } from '../market/asset-source.js';

const { packages, assets, magazineArticles, assetFavorites } = schema;

/**
 * Produkt-Daten (09_ §3.3 Pakete, §3.6 Magazin) — echte v1-Bestände aus der DB
 * (35 Pakete, 221 Assets, 45 Artikel). Keine Tier-Gates (Scope-Entscheidung).
 */
export const productRouter = router({
  packages: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: packages.id,
        packageId: packages.packageId,
        name: packages.name,
        description: packages.description,
        category: packages.category,
        subcategory: packages.subcategory,
        icon: packages.icon,
        color: packages.color,
        assetCount: packages.assetCount,
        isActive: packages.isActive,
      })
      .from(packages)
      .orderBy(asc(packages.category), asc(packages.name));
    return rows;
  }),

  assets: protectedProcedure
    .input(z.object({ packageId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: assets.id,
          ticker: assets.ticker,
          name: assets.name,
          exchange: assets.exchange,
          assetType: assets.assetType,
          tradingPair: assets.tradingPair,
        })
        .from(assets)
        .where(eq(assets.packageId, input.packageId))
        .orderBy(asc(assets.ticker));
      const favs = await ctx.db
        .select({ assetId: assetFavorites.assetId })
        .from(assetFavorites)
        .where(eq(assetFavorites.userId, ctx.user.id));
      const favSet = new Set(favs.map((f) => f.assetId));
      return rows.map((r) => ({ ...r, isFavorite: favSet.has(r.id) }));
    }),

  /**
   * ALLE Assets (Command-Palette P1.5): einmalig geladen, client-seitig gefiltert.
   * `isFavorite` (Stern-Zustand) und `hasChart` (echte Kerzen vorhanden → Chart öffenbar)
   * je Zeile — ohne Kerzen wird ehrlich markiert. Seit dem Asset-Register mit Quelle:
   * `symbol` + `venue` (Binance-Paar oder Yahoo-/Twelve-Data-Symbol; null = keine Quelle).
   */
  allAssets: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: assets.id,
        ticker: assets.ticker,
        name: assets.name,
        assetType: assets.assetType,
        tradingPair: assets.tradingPair,
        candleVenue: assets.candleVenue,
        dataSymbol: assets.dataSymbol,
      })
      .from(assets)
      .where(eq(assets.isActive, true))
      .orderBy(asc(assets.ticker));

    const favs = await ctx.db
      .select({ assetId: assetFavorites.assetId })
      .from(assetFavorites)
      .where(eq(assetFavorites.userId, ctx.user.id));
    const favSet = new Set(favs.map((f) => f.assetId));

    // Symbole mit echten Krypto-Kerzen (Chart öffenbar über die Charts-Seite).
    const chartRows = await ctx.db.execute(sql`SELECT DISTINCT symbol FROM ohlcv WHERE venue = 'binance'`);
    const chartSet = new Set((chartRows.rows as { symbol: string }[]).map((r) => r.symbol.toUpperCase()));

    return rows.map((r) => {
      const src = assetSource(r);
      const registered = isCandleVenue(r.candleVenue) && r.dataSymbol !== null;
      return {
        id: r.id,
        ticker: r.ticker,
        name: r.name,
        assetType: r.assetType,
        tradingPair: r.tradingPair,
        // Kerzen-Symbol ('BTC/USDT', 'SAP.DE', '^GSPC') oder null (Katalog-Asset ohne Quelle)
        symbol: src.venue ? src.symbol : null,
        venue: src.venue,
        isFavorite: favSet.has(r.id),
        // Register-Zeilen entstehen nur mit echten Kerzen; Katalog-Krypto: Binance-Kerzen vorhanden?
        hasChart: src.venue === 'binance' ? chartSet.has(src.symbol) : registered,
      };
    });
  }),

  /** Stern-Favoriten (Patrick-Lücke 5): steuern Scan, Signal-Filter und Dashboard-Briefing. */
  toggleFavorite: protectedProcedure
    .input(z.object({ assetId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(assetFavorites)
        .where(and(eq(assetFavorites.userId, ctx.user.id), eq(assetFavorites.assetId, input.assetId)))
        .limit(1);
      if (existing) {
        await ctx.db
          .delete(assetFavorites)
          .where(and(eq(assetFavorites.userId, ctx.user.id), eq(assetFavorites.assetId, input.assetId)));
        return { favorite: false };
      }
      await ctx.db.insert(assetFavorites).values({ userId: ctx.user.id, assetId: input.assetId });
      return { favorite: true };
    }),

  favorites: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        assetId: assets.id,
        ticker: assets.ticker,
        name: assets.name,
        assetType: assets.assetType,
        tradingPair: assets.tradingPair,
        packageName: packages.name,
      })
      .from(assetFavorites)
      .innerJoin(assets, eq(assets.id, assetFavorites.assetId))
      .innerJoin(packages, eq(packages.id, assets.packageId))
      .where(eq(assetFavorites.userId, ctx.user.id))
      .orderBy(asc(assets.ticker));
  }),

  /**
   * Favoriten mit Quelle (Asset-Register 2026-10-25): je Stern das Kerzen-Symbol und die Quelle
   * (`binance` | `yahoo` | `twelvedata`; null = Katalog-Asset ohne Quelle), Anzeige-Ticker, Name,
   * Klasse und `newsTicker` (Ticker ohne Yahoo-Zusätze für den Schlagzeilen-Abgleich) — für den
   * Stern-Zustand überall, „Meine Märkte“ im Asset-Feld und das Magazin.
   */
  favoriteSymbols: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        ticker: assets.ticker,
        name: assets.name,
        assetType: assets.assetType,
        tradingPair: assets.tradingPair,
        candleVenue: assets.candleVenue,
        dataSymbol: assets.dataSymbol,
        favoritedAt: assetFavorites.createdAt,
      })
      .from(assetFavorites)
      .innerJoin(assets, eq(assets.id, assetFavorites.assetId))
      .where(eq(assetFavorites.userId, ctx.user.id))
      .orderBy(sql`${assetFavorites.createdAt} DESC`);
    const seen = new Set<string>();
    const out: { symbol: string; venue: CandleVenue | null; ticker: string; name: string; assetType: string; newsTicker: string }[] = [];
    for (const r of rows) {
      const src = assetSource(r);
      const key = `${src.venue ?? '-'}:${src.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...src, ticker: r.ticker, name: r.name, assetType: r.assetType.toUpperCase(), newsTicker: newsTicker(src.symbol) });
    }
    return out;
  }),

  /**
   * Favorit per Symbol toggeln (P0.3) — seit dem Asset-Register für JEDE Quelle: `venue`
   * binance (oder ohne venue ein Krypto-Paar) trifft Katalog-Paare und Register-Zeilen; yahoo/
   * twelvedata trifft die Register-Zeile mit genau diesem Kerzen-Symbol; ohne venue und ohne
   * Krypto-Paar entscheidet das Register. `ok:false`, wenn das Symbol nicht im Register liegt
   * (Hinzufügen geht über product.addAsset bzw. die Asset-Suche) — ehrlich, kein Fake.
   */
  toggleFavoriteBySymbol: protectedProcedure
    .input(z.object({ symbol: z.string().trim().min(1).max(32), venue: z.enum(CANDLE_VENUES).optional() }))
    .mutation(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      const pair = normalizeTradingPair(symbol);
      let where;
      if (input.venue === 'binance' || (!input.venue && pair)) {
        if (!pair) return { ok: false as const, favorite: false };
        where = sql`(upper(replace(${assets.tradingPair}, '/', '')) = ${pair.replace('/', '')} AND (${assets.candleVenue} IS NULL OR ${assets.candleVenue} = 'binance')) OR (${assets.candleVenue} = 'binance' AND ${assets.dataSymbol} = ${pair})`;
      } else if (input.venue) {
        where = sql`${assets.candleVenue} = ${input.venue} AND upper(${assets.dataSymbol}) = ${symbol}`;
      } else {
        where = sql`${assets.candleVenue} IS NOT NULL AND upper(${assets.dataSymbol}) = ${symbol}`;
      }
      const matches = await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(where)
        // Register-Zeile zuerst — der neue Stern landet dort, wo die Quelle hängt.
        .orderBy(sql`(${assets.dataSymbol} IS NOT NULL) DESC`, asc(assets.id));
      const ids = matches.map((m) => m.id);
      if (ids.length === 0) return { ok: false as const, favorite: false };

      const [existing] = await ctx.db
        .select({ assetId: assetFavorites.assetId })
        .from(assetFavorites)
        .where(and(eq(assetFavorites.userId, ctx.user.id), inArray(assetFavorites.assetId, ids)))
        .limit(1);

      if (existing) {
        await ctx.db
          .delete(assetFavorites)
          .where(and(eq(assetFavorites.userId, ctx.user.id), inArray(assetFavorites.assetId, ids)));
        return { ok: true as const, favorite: false };
      }
      await ctx.db.insert(assetFavorites).values({ userId: ctx.user.id, assetId: ids[0]! }).onConflictDoNothing();
      return { ok: true as const, favorite: true };
    }),

  /**
   * Markt hinzufügen — auch einen, den es im Katalog noch nicht gibt (Patrick 2026-10-25):
   * Symbol gegen die echte Quelle prüfen (Binance-Paarliste bzw. Yahoo), echte Kerzen laden,
   * ins Register (Paket „Eigene Märkte“ oder vorhandenes Katalog-Asset), Stern setzen, Audit.
   * Ab dann laufen Kerzen-Refresh, Alarme, News und Kalender automatisch mit.
   */
  addAsset: protectedProcedure
    .input(
      z.object({
        venue: z.enum(['binance', 'yahoo']),
        symbol: z.string().trim().min(1).max(32),
        name: z.string().trim().max(120).optional(),
        kind: z.string().trim().max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await registerOrThrow(ctx.db, {
        venue: input.venue,
        symbol: input.symbol,
        name: input.name ?? null,
        kind: input.kind ?? null,
        userId: ctx.user.id,
        favorite: true,
        ip: ctx.ip,
        via: 'add-asset',
      });
      return { ...r.asset, favorite: r.favorite, created: r.created, inserted: r.inserted, candles: r.candles, errors: r.errors };
    }),

  articles: protectedProcedure
    .input(z.object({ category: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: magazineArticles.id,
          title: magazineArticles.title,
          summary: magazineArticles.summary,
          content: magazineArticles.content,
          category: magazineArticles.category,
          imageUrl: magazineArticles.imageUrl,
          sourceUrl: magazineArticles.sourceUrl,
          isPublished: magazineArticles.isPublished,
          publishedAt: magazineArticles.publishedAt,
          createdAt: magazineArticles.createdAt,
        })
        .from(magazineArticles)
        .orderBy(asc(magazineArticles.category))
        .limit(input.limit);
      return input.category ? rows.filter((r) => r.category === input.category) : rows;
    }),
});
