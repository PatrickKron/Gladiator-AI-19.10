import { TRPCError } from '@trpc/server';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import { conditionsSchema, evaluateScreen, MAX_UNIVERSE, MIN_CANDLES, pineTimeframe, SCREEN_CANDLES, SCREEN_PRESETS, tickerIdOf, type ScreenResult } from '@gladiator/indicators';
import { candleUniverse, getOhlcv, SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
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

/** Symbole mit genug echten Kerzen im Zeitrahmen (ehrlich: nur was in der DB liegt) — dieselbe Abfrage wie der Screen-Alarm im Worker. */
export function universeFor(db: Db, timeframe: string, venue: string): Promise<UniverseRow[]> {
  return candleUniverse(db, { timeframe, venue, minCandles: MIN_CANDLES, limit: MAX_UNIVERSE });
}


export type RunScreenInput = { timeframe: string; conditions: z.infer<typeof conditionsSchema>; symbols?: string[]; venue?: string };

/**
 * Screen laufen lassen (Seite UND Gladiator-Chat): Fehler je Symbol (keine/zu wenige
 * Kerzen, Indikator) landen in der Zeile — ein Symbol reißt nie den ganzen Lauf.
 */
export async function runScreen(db: Db, input: RunScreenInput) {
  const venue = input.venue ?? 'binance';
  const t0 = Date.now();
  const universe = input.symbols ? input.symbols.map((s) => s.toUpperCase()) : (await universeFor(db, input.timeframe, venue)).map((r) => r.symbol);
  const pineTf = pineTimeframe(input.timeframe);
  const rows: ScreenRow[] = [];
  for (const symbol of universe.slice(0, MAX_UNIVERSE)) {
    const candles = await getOhlcv(db, { symbol, timeframe: input.timeframe, limit: SCREEN_CANDLES, venue });
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
}

function toDto(r: typeof screens.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    timeframe: r.timeframe,
    venue: r.venue,
    conditions: r.conditions,
    alert: r.alert,
    lastMatches: r.lastMatches ?? [],
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastAlertAt: r.lastAlertAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
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
    .query(({ ctx, input }) => runScreen(ctx.db, input)),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(screens).where(eq(screens.userId, ctx.user.id)).orderBy(asc(screens.name));
    return rows.map(toDto);
  }),

  save: protectedProcedure
    .input(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60), timeframe: timeframeEnum, venue: z.string().max(20).optional(), conditions: conditionsSchema }))
    .mutation(async ({ ctx, input }) => {
      const venue = input.venue ?? 'binance';
      if (input.id) {
        // Geänderte Bedingungen: der nächste Alarm-Lauf startet ohne alten Treffer-Stand (sonst würden Treffer der neuen Regel verschluckt).
        const [row] = await ctx.db
          .update(screens)
          .set({ name: input.name, timeframe: input.timeframe, venue, conditions: input.conditions, lastMatches: [], updatedAt: new Date() })
          .where(and(eq(screens.id, input.id), eq(screens.userId, ctx.user.id)))
          .returning();
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screen nicht gefunden.' });
        return toDto(row);
      }
      const [{ n } = { n: 0 }] = await ctx.db.select({ n: count() }).from(screens).where(eq(screens.userId, ctx.user.id));
      if (n >= MAX_SCREENS_PER_USER) throw new TRPCError({ code: 'BAD_REQUEST', message: `Höchstens ${MAX_SCREENS_PER_USER} gespeicherte Screens — bitte einen löschen.` });
      const [row] = await ctx.db
        .insert(screens)
        .values({ userId: ctx.user.id, name: input.name, timeframe: input.timeframe, venue, conditions: input.conditions })
        .returning();
      return toDto(row!);
    }),

  /**
   * Screen-Alarm ein/aus: der Worker rechnet Alarm-Screens alle 5 min auf echten
   * Kerzen und meldet NEUE Treffer (Glocke/Push/Telegram). Beim Einschalten
   * beginnt der Treffer-Stand leer — der nächste Lauf nennt alle aktuellen Treffer einmal.
   */
  setAlert: protectedProcedure.input(z.object({ id: z.string().uuid(), alert: z.boolean() })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(screens)
      .set({ alert: input.alert, ...(input.alert ? { lastMatches: [], lastRunAt: null, lastAlertAt: null } : {}), updatedAt: new Date() })
      .where(and(eq(screens.id, input.id), eq(screens.userId, ctx.user.id)))
      .returning();
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screen nicht gefunden.' });
    return toDto(row);
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
