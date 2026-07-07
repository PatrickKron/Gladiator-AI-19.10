import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { normalizeTradingPair } from '@gladiator/jobs';
import { protectedProcedure, router } from '../trpc.js';

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
   * Favoriten als normalisierte Handelspaare ('BTC/USDT') — für den Stern-Zustand
   * überall dort, wo mit Symbolen statt asset-IDs gearbeitet wird (Charts/Aegis/Oracle).
   */
  favoriteSymbols: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ pair: assets.tradingPair })
      .from(assetFavorites)
      .innerJoin(assets, eq(assets.id, assetFavorites.assetId))
      .where(eq(assetFavorites.userId, ctx.user.id));
    const set = new Set<string>();
    for (const r of rows) {
      const norm = normalizeTradingPair(r.pair);
      if (norm) set.add(norm);
    }
    return [...set];
  }),

  /**
   * Favorit per Symbol toggeln (P0.3): findet die Asset-Zeile(n) mit passendem
   * Handelspaar und setzt/entfernt den Stern. `ok:false`, wenn das Symbol nicht
   * im Asset-Register liegt (dann kein Favorit möglich — ehrlich, kein Fake).
   */
  toggleFavoriteBySymbol: protectedProcedure
    .input(z.object({ symbol: z.string().min(3).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const pair = normalizeTradingPair(input.symbol);
      if (!pair) return { ok: false as const, favorite: false };
      const noSlash = pair.replace('/', '');
      const matches = await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`upper(replace(${assets.tradingPair}, '/', '')) = ${noSlash}`);
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
