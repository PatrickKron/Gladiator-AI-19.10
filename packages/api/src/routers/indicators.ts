import { TRPCError } from '@trpc/server';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import {
  CATALOG,
  candlesToBars,
  catalogEntry,
  computeIndicator,
  extraNeeds,
  IndicatorComputeError,
  pineTimeframe,
  sanitizeInputs,
  type ComputeBar,
  type IndicatorOutput,
} from '@gladiator/indicators';
import { getOhlcv, SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

const { chartIndicators } = schema;

/**
 * Indikator-Bibliothek (Repo-Masterliste, Phase 1): Katalog, serverseitige
 * Rechnung auf echten DB-Kerzen und die je Nutzer+Symbol gespeicherten
 * Chart-Indikatoren. Gerechnet wird NUR hier (eine Wahrheit für Chart,
 * Screener und Alarme); der Browser zeichnet das Ergebnis.
 */

/** Höchstens so viele Indikatoren je Symbol (Lesbarkeit + Rechenzeit je Abruf). */
export const MAX_INDICATORS_PER_SYMBOL = 12;

const symbolSchema = z.string().trim().min(1).max(40);
const timeframeEnum = z.enum(SUPPORTED_TIMEFRAMES);
const inputsSchema = z.record(z.string().max(64), z.unknown()).optional();
const plotStyleSchema = z
  .object({ visible: z.boolean().optional(), color: z.string().max(40).optional(), lineWidth: z.number().int().min(1).max(6).optional() })
  .strict();
const styleSchema = z.object({ visible: z.boolean().optional(), plots: z.record(z.string().max(40), plotStyleSchema).optional() }).strict();
const liveBarSchema = z
  .object({ time: z.number().int(), open: z.number().finite(), high: z.number().finite(), low: z.number().finite(), close: z.number().finite(), volume: z.number().finite().optional() })
  .strict();

/** Pine `syminfo.tickerid` für ein Gladiator-Symbol ("BTC/USDT" → "BINANCE:BTCUSDT"). */
export function tickerIdOf(venue: string, symbol: string): string {
  return `${venue.toUpperCase()}:${symbol.replace('/', '')}`;
}

/** Live-Kerze des Browsers in die DB-Kerzen einarbeiten (ersetzt die letzte oder hängt an). */
export function applyLiveBar(bars: ComputeBar[], live: ComputeBar | undefined): ComputeBar[] {
  if (!live || bars.length === 0) return bars;
  const last = bars[bars.length - 1]!;
  if (live.time < last.time) return bars;
  return live.time === last.time ? [...bars.slice(0, -1), live] : [...bars, live];
}

type Row = typeof chartIndicators.$inferSelect;
function toDto(r: Row) {
  return {
    id: r.id,
    symbol: r.symbol,
    indicatorId: r.indicatorId,
    inputs: r.inputs,
    style: r.style ?? null,
    position: r.position,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function ownedRow(db: Db, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(chartIndicators)
    .where(and(eq(chartIndicators.id, id), eq(chartIndicators.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Indikator nicht gefunden.' });
  return row;
}

function requireEntry(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new TRPCError({ code: 'BAD_REQUEST', message: `Unbekannter Indikator: ${id}` });
  return entry;
}

export type ComputedItem = {
  key: string;
  id: string;
  inputs: Record<string, unknown>;
  result: IndicatorOutput | null;
  error: string | null;
  ms: number;
};

export const indicatorsRouter = router({
  /** Katalog (reine Metadaten; der Browser baut daraus Menü und Einstellungen). */
  catalog: protectedProcedure.query(() => CATALOG),

  /**
   * Indikatoren auf den Kerzen eines Symbols rechnen. `liveBar`: die vom
   * Browser per Tick fortgeschriebene letzte Kerze (DB hängt bis zu einer
   * Minute hinterher). Fehler je Indikator landen im Ergebnis (`error`), nicht
   * als Abbruch des ganzen Abrufs.
   */
  compute: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        timeframe: timeframeEnum,
        venue: z.string().max(20).optional(),
        limit: z.number().int().min(60).max(1000).default(400),
        items: z.array(z.object({ key: z.string().max(64).optional(), id: z.string().max(64), inputs: inputsSchema })).max(MAX_INDICATORS_PER_SYMBOL),
        liveBar: liveBarSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const symbol = input.symbol.toUpperCase();
      const venue = input.venue ?? 'binance';
      const candles = await getOhlcv(ctx.db, { symbol, timeframe: input.timeframe, limit: input.limit, venue });
      const bars = applyLiveBar(candlesToBars(candles), input.liveBar);
      const tickerid = tickerIdOf(venue, symbol);
      const extraCache = new Map<string, ComputeBar[]>();
      const loadExtra = async (tfs: string[]) => {
        const out: Record<string, ComputeBar[]> = {};
        for (const tf of tfs) {
          if (!extraCache.has(tf)) extraCache.set(tf, candlesToBars(await getOhlcv(ctx.db, { symbol, timeframe: tf, limit: 1000, venue })));
          out[tf] = extraCache.get(tf)!;
        }
        return out;
      };
      const items: ComputedItem[] = [];
      for (const [i, item] of input.items.entries()) {
        const key = item.key ?? String(i);
        if (!catalogEntry(item.id)) {
          items.push({ key, id: item.id, inputs: {}, result: null, error: `Unbekannter Indikator: ${item.id}`, ms: 0 });
          continue;
        }
        if (bars.length === 0) {
          items.push({ key, id: item.id, inputs: sanitizeInputs(catalogEntry(item.id)!, item.inputs), result: null, error: 'Keine Kerzen in der DB.', ms: 0 });
          continue;
        }
        try {
          const needs = extraNeeds(item.id, item.inputs, tickerid);
          const extraBars = needs.timeframes.length > 0 ? await loadExtra(needs.timeframes) : undefined;
          const r = computeIndicator(item.id, bars, item.inputs, {
            timeframe: pineTimeframe(input.timeframe),
            tickerid,
            currency: symbol.split('/')[1] ?? 'USD',
            lastBarConfirmed: input.liveBar === undefined,
            extraBars,
          });
          items.push({ key, id: item.id, inputs: r.inputs, result: r.result, error: null, ms: r.ms });
        } catch (err) {
          const msg = err instanceof IndicatorComputeError || err instanceof Error ? err.message : String(err);
          items.push({ key, id: item.id, inputs: sanitizeInputs(catalogEntry(item.id)!, item.inputs), result: null, error: msg, ms: 0 });
        }
      }
      return { symbol, timeframe: input.timeframe, firstTime: bars[0]?.time ?? null, lastTime: bars[bars.length - 1]?.time ?? null, items };
    }),

  /** Gespeicherte Chart-Indikatoren eines Symbols (Reihenfolge = position). */
  list: protectedProcedure.input(z.object({ symbol: symbolSchema })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select()
      .from(chartIndicators)
      .where(and(eq(chartIndicators.userId, ctx.user.id), eq(chartIndicators.symbol, input.symbol)))
      .orderBy(asc(chartIndicators.position), asc(chartIndicators.createdAt))
      .limit(MAX_INDICATORS_PER_SYMBOL);
    return rows.map(toDto);
  }),

  add: protectedProcedure
    .input(z.object({ symbol: symbolSchema, indicatorId: z.string().max(64), inputs: inputsSchema }))
    .mutation(async ({ ctx, input }) => {
      const entry = requireEntry(input.indicatorId);
      const [{ n } = { n: 0 }] = await ctx.db
        .select({ n: count() })
        .from(chartIndicators)
        .where(and(eq(chartIndicators.userId, ctx.user.id), eq(chartIndicators.symbol, input.symbol)));
      if (n >= MAX_INDICATORS_PER_SYMBOL) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Höchstens ${MAX_INDICATORS_PER_SYMBOL} Indikatoren je Symbol — bitte einen entfernen.` });
      }
      const [row] = await ctx.db
        .insert(chartIndicators)
        .values({ userId: ctx.user.id, symbol: input.symbol, indicatorId: entry.id, inputs: sanitizeInputs(entry, input.inputs), position: n })
        .returning();
      return toDto(row!);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), inputs: inputsSchema, style: styleSchema.nullable().optional(), position: z.number().int().min(0).max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      const current = await ownedRow(ctx.db, ctx.user.id, input.id);
      const entry = requireEntry(current.indicatorId);
      const [row] = await ctx.db
        .update(chartIndicators)
        .set({
          ...(input.inputs !== undefined ? { inputs: sanitizeInputs(entry, input.inputs) } : {}),
          ...(input.style !== undefined ? { style: input.style } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(chartIndicators.id, input.id), eq(chartIndicators.userId, ctx.user.id)))
        .returning();
      return toDto(row!);
    }),

  remove: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(chartIndicators)
      .where(and(eq(chartIndicators.id, input.id), eq(chartIndicators.userId, ctx.user.id)))
      .returning({ id: chartIndicators.id });
    if (deleted.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Indikator nicht gefunden.' });
    return { ok: true as const };
  }),

  clear: protectedProcedure.input(z.object({ symbol: symbolSchema })).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(chartIndicators)
      .where(and(eq(chartIndicators.userId, ctx.user.id), eq(chartIndicators.symbol, input.symbol)))
      .returning({ id: chartIndicators.id });
    return { deleted: deleted.length };
  }),
});
