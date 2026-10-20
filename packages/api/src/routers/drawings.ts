import { TRPCError } from '@trpc/server';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DRAWING_KINDS,
  MAX_DRAWINGS_PER_SYMBOL,
  validateDrawingPoints,
  validateDrawingStyle,
  type DrawingKind,
  type DrawingPoint,
} from '@gladiator/core';
import { schema, type Db } from '@gladiator/db';
import { protectedProcedure, router } from '../trpc.js';

const { chartDrawings } = schema;

/**
 * Chart-Zeichnungen (Plan §5 „Chart: Zeichenwerkzeuge"): Horizontale,
 * Trendlinie, Fibonacci — pro Nutzer + Symbol, Timeframe-unabhängig
 * (Zeit/Preis-Anker). Alle Prozeduren sind strikt auf ctx.user.id begrenzt;
 * ein fremder Datensatz verhält sich wie ein nicht existierender (NOT_FOUND).
 * Fachregeln (Ankerzahl je Art, Wertebereich, Stil) kommen aus @gladiator/core
 * — dieselbe Wahrheit, die der Browser fürs Rendering nutzt.
 */

const symbolSchema = z.string().trim().min(1).max(40);
const pointSchema = z.object({ time: z.number().finite(), price: z.number().finite() }).strict();
const pointsSchema = z.array(pointSchema).min(1).max(2);
const styleSchema = z
  .object({ color: z.string().max(7).optional(), lineWidth: z.number().optional() })
  .strict()
  .nullable()
  .optional()
  .superRefine((s, ctx) => {
    const err = validateDrawingStyle(s ?? null);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });

function assertPoints(kind: DrawingKind, points: DrawingPoint[]) {
  const err = validateDrawingPoints(kind, points);
  if (err) throw new TRPCError({ code: 'BAD_REQUEST', message: err });
}

type Row = typeof chartDrawings.$inferSelect;
/** Ausgabe-Form: Zahlen bleiben Zahlen (jsonb), Zeitstempel als ISO. */
function toDto(r: Row) {
  return {
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    points: r.points,
    style: r.style ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function ownedDrawing(db: Db, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(chartDrawings)
    .where(and(eq(chartDrawings.id, id), eq(chartDrawings.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Zeichnung nicht gefunden.' });
  return row;
}

export const drawingsRouter = router({
  list: protectedProcedure.input(z.object({ symbol: symbolSchema })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select()
      .from(chartDrawings)
      .where(and(eq(chartDrawings.userId, ctx.user.id), eq(chartDrawings.symbol, input.symbol)))
      .orderBy(asc(chartDrawings.createdAt), asc(chartDrawings.id))
      .limit(MAX_DRAWINGS_PER_SYMBOL);
    return rows.map(toDto);
  }),

  create: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        kind: z.enum(DRAWING_KINDS),
        points: pointsSchema,
        style: styleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertPoints(input.kind, input.points);
      const [existing] = await ctx.db
        .select({ n: count() })
        .from(chartDrawings)
        .where(and(eq(chartDrawings.userId, ctx.user.id), eq(chartDrawings.symbol, input.symbol)));
      if ((existing?.n ?? 0) >= MAX_DRAWINGS_PER_SYMBOL) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Maximal ${MAX_DRAWINGS_PER_SYMBOL} Zeichnungen pro Symbol — bitte alte löschen.`,
        });
      }
      const [row] = await ctx.db
        .insert(chartDrawings)
        .values({
          userId: ctx.user.id,
          symbol: input.symbol,
          kind: input.kind,
          points: input.points,
          style: input.style ?? null,
        })
        .returning();
      return toDto(row!);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), points: pointsSchema, style: styleSchema }))
    .mutation(async ({ ctx, input }) => {
      const current = await ownedDrawing(ctx.db, ctx.user.id, input.id);
      assertPoints(current.kind, input.points);
      const [row] = await ctx.db
        .update(chartDrawings)
        .set({
          points: input.points,
          // style weggelassen → unverändert; null → Stil entfernen
          ...(input.style !== undefined ? { style: input.style } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(chartDrawings.id, input.id), eq(chartDrawings.userId, ctx.user.id)))
        .returning();
      return toDto(row!);
    }),

  delete: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(chartDrawings)
      .where(and(eq(chartDrawings.id, input.id), eq(chartDrawings.userId, ctx.user.id)))
      .returning({ id: chartDrawings.id });
    if (deleted.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Zeichnung nicht gefunden.' });
    return { ok: true as const };
  }),

  clear: protectedProcedure.input(z.object({ symbol: symbolSchema })).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(chartDrawings)
      .where(and(eq(chartDrawings.userId, ctx.user.id), eq(chartDrawings.symbol, input.symbol)))
      .returning({ id: chartDrawings.id });
    return { deleted: deleted.length };
  }),
});
