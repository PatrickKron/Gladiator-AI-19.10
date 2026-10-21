import { TRPCError } from '@trpc/server';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { pineTimeframe } from '@gladiator/indicators';
import { getOhlcv, SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { tickerIdOf } from './indicators.js';
import { conditionsSchema, MAX_UNIVERSE, MIN_CANDLES, SCREEN_CANDLES } from '../screener/conditions.js';
import { evaluateScreen, type ScreenResult } from '../screener/evaluate.js';
import { SCREEN_PRESETS } from '../screener/presets.js';
import { protectedProcedure, router } from '../trpc.js';

const { screens } = schema;

/**
 * Markt-Screener (Repo-Masterliste, Phase 2): Bedingungen über das Universum
 * (alle Symbole mit echten Kerzen im gewählten Zeitrahmen) auswerten — auf dem
 * Server, mit derselben Indikator-Bibliothek und Smart-Money-Engine wie der
 * Chart. Gespeicherte Screens je Nutzer.
 */

export const MAX_SCREENS_PER_USER = 30;

const timeframeEnum = z.enum(SUPPORTED_TIMEFRAMES);
const symbolSchema = z.string().trim().min(1).max(40);

export type ScreenRow = { symbol: string; candles: number; error: string | null } & Partial<ScreenResult>;

type UniverseRow = { symbol: string; candles: number };

/** Symbole mit genug echten Kerzen im Zeitrahmen (ehrlich: nur was in der DB liegt). */
export async function universeFor(db: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }, timeframe: string, venue: string): Promise<UniverseRow[]> {
  const res = await db.execute(sql`
    SELECT symbol, count(*)::int AS candles
    FROM ohlcv
    WHERE venue = ${venue} AND timeframe = ${timeframe}
    GROUP BY symbol
    HAVING count(*) >= ${MIN_CANDLES}
    ORDER BY symbol
    LIMIT ${MAX_UNIVERSE}
  `);
  return res.rows as UniverseRow[];
}

function toDto(r: typeof screens.$inferSelect) {
  return { id: r.id, name: r.name, timeframe: r.timeframe, conditions: r.conditions, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export const screenerRouter = router({
  /** Vorlagen (Namen über i18n-Schlüssel). */
  presets: protectedProcedure.query(() => SCREEN_PRESETS),

  /** Universum: Symbole mit ≥ MIN_CANDLES echten Kerzen im Zeitrahmen. */
  universe: protectedProcedure
    .input(z.object({ timeframe: timeframeEnum, venue: z.string().max(20).optional() }))
    .query(({ ctx, input }) => universeFor(ctx.db, input.timeframe, input.venue ?? 'binance')),

  /**
   * Screen laufen lassen. Fehler je Symbol (keine/zu wenige Kerzen, Indikator)
   * landen in der Zeile — ein Symbol reißt nie den ganzen Lauf.
   */
  run: protectedProcedure
    .input(
      z.object({
        timeframe: timeframeEnum,
        conditions: conditionsSchema,
        symbols: z.array(symbolSchema).max(MAX_UNIVERSE).optional(),
        venue: z.string().max(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const venue = input.venue ?? 'binance';
      const t0 = Date.now();
      const universe = input.symbols ? input.symbols.map((s) => s.toUpperCase()) : (await universeFor(ctx.db, input.timeframe, venue)).map((r) => r.symbol);
      const pineTf = pineTimeframe(input.timeframe);
      const rows: ScreenRow[] = [];
      for (const symbol of universe.slice(0, MAX_UNIVERSE)) {
        const candles = await getOhlcv(ctx.db, { symbol, timeframe: input.timeframe, limit: SCREEN_CANDLES, venue });
        if (candles.length === 0) {
          rows.push({ symbol, candles: 0, error: 'Keine Kerzen in der DB.' });
          continue;
        }
        try {
          const r = evaluateScreen(candles, input.conditions, { timeframe: pineTf, tickerid: tickerIdOf(venue, symbol) });
          rows.push({ symbol, candles: candles.length, error: null, ...r });
        } catch (err) {
          rows.push({ symbol, candles: candles.length, error: err instanceof Error ? err.message : String(err) });
        }
      }
      rows.sort((a, b) => Number(b.matches ?? false) - Number(a.matches ?? false) || a.symbol.localeCompare(b.symbol));
      return { timeframe: input.timeframe, scanned: rows.length, matched: rows.filter((r) => r.matches).length, ms: Date.now() - t0, rows };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(screens).where(eq(screens.userId, ctx.user.id)).orderBy(asc(screens.name));
    return rows.map(toDto);
  }),

  save: protectedProcedure
    .input(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60), timeframe: timeframeEnum, conditions: conditionsSchema }))
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        const [row] = await ctx.db
          .update(screens)
          .set({ name: input.name, timeframe: input.timeframe, conditions: input.conditions, updatedAt: new Date() })
          .where(and(eq(screens.id, input.id), eq(screens.userId, ctx.user.id)))
          .returning();
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screen nicht gefunden.' });
        return toDto(row);
      }
      const [{ n } = { n: 0 }] = await ctx.db.select({ n: count() }).from(screens).where(eq(screens.userId, ctx.user.id));
      if (n >= MAX_SCREENS_PER_USER) throw new TRPCError({ code: 'BAD_REQUEST', message: `Höchstens ${MAX_SCREENS_PER_USER} gespeicherte Screens — bitte einen löschen.` });
      const [row] = await ctx.db
        .insert(screens)
        .values({ userId: ctx.user.id, name: input.name, timeframe: input.timeframe, conditions: input.conditions })
        .returning();
      return toDto(row!);
    }),

  remove: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(screens)
      .where(and(eq(screens.id, input.id), eq(screens.userId, ctx.user.id)))
      .returning({ id: screens.id });
    if (deleted.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screen nicht gefunden.' });
    return { ok: true as const };
  }),
});
