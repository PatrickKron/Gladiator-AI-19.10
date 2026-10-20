import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  COMPARE_VENUES,
  demoBookSource,
  cancelDemoOrder,
  closeDemoPositionNow,
  demoAccountOverview,
  midPrice,
  placeDemoOrder,
  previewDemoOrder,
  resetDemoAccount,
  setDemoProtection,
  getOrCreateDemoAccount,
  liquidationPrice,
  loadRiskSettings,
  marginFor,
  type DemoBookSource,
} from '@gladiator/exchange';
import { computeMetrics } from '@gladiator/backtest';
import { protectedProcedure, router } from '../trpc.js';

const { demoOrders, demoPositions, demoTrades } = schema;

/**
 * Demo-Trading (Session 5): manueller Übungsmodus mit virtuellem Guthaben.
 * Schreibt AUSSCHLIESSLICH demo_*-Tabellen und ruft NIE ctx.venue an —
 * der Demo-Modus kann bauartbedingt keine echten Orders auslösen. Preise
 * und Orderbücher sind IMMER echt (Binance public REST).
 */

/** Tests können die Buch-Quelle ersetzen; Produktion nutzt den Binance-Singleton. */
let bookSourceOverride: DemoBookSource | null = null;
export function setDemoBookSourceForTests(source: DemoBookSource | null): void {
  bookSourceOverride = source;
}
function books(): DemoBookSource {
  return bookSourceOverride ?? demoBookSource();
}

const orderInput = z.object({
  symbol: z.string().min(3).max(20),
  direction: z.enum(['long', 'short']),
  type: z.enum(['market', 'limit']),
  qty: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  /** Hebel (Isolated Margin); Obergrenze kommt aus den Trading-Einstellungen. */
  leverage: z.number().min(1).max(125).optional(),
  /** Börse, gegen deren echtes Orderbuch ausgeführt wird (Vision-Punkt 2), Standard Binance. */
  venue: z.enum(COMPARE_VENUES).optional(),
});

/** Symbol normalisieren + Hebel-Obergrenze aus den Trading-Einstellungen des Users anhängen. */
async function normalized(ctx: { db: Parameters<typeof loadRiskSettings>[0]; user: { id: string } }, input: z.infer<typeof orderInput>) {
  const settings = await loadRiskSettings(ctx.db, ctx.user.id);
  return { ...input, symbol: input.symbol.toUpperCase(), maxLeverage: settings.maxLeverage };
}

export const demoRouter = router({
  /** Konto-Übersicht: Balance/Equity/Verfügbar/uPnL — Marks aus echten Büchern. */
  account: protectedProcedure.query(({ ctx }) => demoAccountOverview(ctx.db, books(), ctx.user.id)),

  /** Kosten-Vorschau aus dem ECHTEN Orderbuch (Spread/Slippage/Fee sichtbar vor dem Klick). */
  preview: protectedProcedure
    .input(orderInput)
    .mutation(async ({ ctx, input }) => previewDemoOrder(ctx.db, books(), ctx.user.id, await normalized(ctx, input))),

  placeOrder: protectedProcedure.input(orderInput).mutation(async ({ ctx, input }) => {
    const r = await placeDemoOrder(ctx.db, books(), ctx.user.id, await normalized(ctx, input));
    if (!r.placed) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `demo:${r.reason}` });
    }
    return r;
  }),

  cancelOrder: protectedProcedure.input(z.object({ orderId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const ok = await cancelDemoOrder(ctx.db, ctx.user.id, input.orderId);
    if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Order nicht gefunden oder nicht mehr offen.' });
    return { ok: true };
  }),

  /** Offene + teilgefüllte Orders (ruhende Limits). */
  openOrders: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(demoOrders)
      .where(and(eq(demoOrders.userId, ctx.user.id), inArray(demoOrders.status, ['open', 'partially_filled'])))
      .orderBy(desc(demoOrders.createdAt));
    return rows.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      type: o.type,
      side: o.side,
      qty: Number(o.qty),
      filledQty: Number(o.filledQty),
      limitPrice: o.limitPrice === null ? null : Number(o.limitPrice),
      avgFillPrice: o.avgFillPrice === null ? null : Number(o.avgFillPrice),
      feePaid: Number(o.feePaid),
      status: o.status,
      venue: o.venue,
      createdAt: o.createdAt.toISOString(),
    }));
  }),

  /** Offene Positionen mit uPnL gegen den echten Buch-Mid (nicht erreichbar → ehrlich null). */
  positions: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(demoPositions)
      .where(eq(demoPositions.userId, ctx.user.id))
      .orderBy(desc(demoPositions.openedAt));
    const marks = new Map<string, number | null>();
    for (const key of new Set(rows.map((p) => `${p.venue}|${p.symbol}`))) {
      const [venue, symbol] = key.split('|') as [string, string];
      try {
        marks.set(key, midPrice(await books().fetchBook(symbol, venue)));
      } catch {
        marks.set(key, null);
      }
    }
    return rows.map((p) => {
      const mark = marks.get(`${p.venue}|${p.symbol}`) ?? null;
      const sign = p.direction === 'long' ? 1 : -1;
      const entry = Number(p.entryPrice);
      const qty = Number(p.qty);
      return {
        id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        qty,
        entryPrice: entry,
        entryFee: Number(p.entryFee),
        stopLoss: p.stopLoss === null ? null : Number(p.stopLoss),
        takeProfit: p.takeProfit === null ? null : Number(p.takeProfit),
        leverage: Number(p.leverage),
        venue: p.venue,
        margin: marginFor(entry * qty, Number(p.leverage)),
        liquidationPrice: liquidationPrice(p.direction, entry, Number(p.leverage)),
        markPrice: mark,
        unrealizedPnl: mark === null ? null : (mark - entry) * qty * sign,
        openedAt: p.openedAt.toISOString(),
      };
    });
  }),

  closePosition: protectedProcedure
    .input(z.object({ positionId: z.string().uuid(), qty: z.number().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const r = await closeDemoPositionNow(ctx.db, books(), ctx.user.id, input.positionId, { qty: input.qty });
      if (!r.closed) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `demo:${r.reason ?? 'unknown'}` });
      }
      return r;
    }),

  setProtection: protectedProcedure
    .input(
      z.object({
        positionId: z.string().uuid(),
        stopLoss: z.number().positive().nullable().optional(),
        takeProfit: z.number().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await setDemoProtection(ctx.db, books(), ctx.user.id, input.positionId, {
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
      });
      if (!r.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `demo:${r.reason ?? 'unknown'}` });
      return r;
    }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(demoTrades)
        .where(eq(demoTrades.userId, ctx.user.id))
        .orderBy(desc(demoTrades.exitTs))
        .limit(input.limit);
      return rows.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        direction: t.direction,
        entryTs: t.entryTs.toISOString(),
        exitTs: t.exitTs.toISOString(),
        entryPrice: Number(t.entryPrice),
        exitPrice: Number(t.exitPrice),
        qty: Number(t.qty),
        grossPnl: Number(t.grossPnl),
        fees: Number(t.fees),
        slippage: Number(t.slippage),
        fundingPaid: Number(t.fundingPaid),
        netPnl: Number(t.netPnl),
        rMultiple: t.rMultiple === null ? null : Number(t.rMultiple),
        reason: t.reason,
        venue: t.venue,
      }));
    }),

  /**
   * Kennzahlen NETTO über alle geschlossenen Demo-Trades. Sharpe/Sortino auf
   * Tages-Equity (barsPerYear=365) — gleiche Mathematik wie das Labor
   * (@gladiator/backtest.computeMetrics, eine Wahrheit).
   */
  performance: protectedProcedure.query(async ({ ctx }) => {
    const account = await getOrCreateDemoAccount(ctx.db, ctx.user.id);
    const rows = await ctx.db
      .select()
      .from(demoTrades)
      .where(eq(demoTrades.accountId, account.id))
      .orderBy(demoTrades.exitTs);
    if (rows.length === 0) return { trades: 0 as const };

    const start = Number(account.startBalance);
    let equity = start;
    const tradeCurve = rows.map((t) => {
      equity += Number(t.netPnl);
      return { ts: t.exitTs.toISOString(), equity: Math.round(equity * 100) / 100 };
    });

    // Tages-Equity für Sharpe/Sortino (Trade-Kurve wäre keine Zeitreihe)
    const byDay = new Map<string, number>();
    equity = start;
    for (const t of rows) {
      equity += Number(t.netPnl);
      byDay.set(t.exitTs.toISOString().slice(0, 10), equity);
    }
    const dailyEquity = [start, ...byDay.values()];

    const metrics = computeMetrics(
      rows.map((t) => ({ netPnl: Number(t.netPnl), rMultiple: t.rMultiple === null ? 0 : Number(t.rMultiple) })),
      dailyEquity,
      { barsPerYear: 365 },
    );

    const bySymbol = new Map<string, { trades: number; netPnl: number; wins: number }>();
    for (const t of rows) {
      const e = bySymbol.get(t.symbol) ?? { trades: 0, netPnl: 0, wins: 0 };
      e.trades++;
      e.netPnl += Number(t.netPnl);
      if (Number(t.netPnl) > 0) e.wins++;
      bySymbol.set(t.symbol, e);
    }

    const totalFees = rows.reduce((a, t) => a + Number(t.fees), 0);
    const totalSlippage = rows.reduce((a, t) => a + Number(t.slippage), 0);
    const totalFunding = rows.reduce((a, t) => a + Number(t.fundingPaid), 0);

    return {
      trades: rows.length,
      netPnl: metrics.netPnl,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      expectancyR: metrics.expectancy,
      sharpe: metrics.sharpe,
      sortino: metrics.sortino,
      maxDrawdownPct: metrics.maxDrawdownPct,
      totalFees,
      totalSlippage,
      totalFunding,
      equityCurve: tradeCurve,
      bySymbol: [...bySymbol.entries()].map(([symbol, v]) => ({ symbol, ...v })),
    };
  }),

  /** Demo zurücksetzen: löscht alle Demo-Daten des Users, Startguthaben neu (auditiert). */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await resetDemoAccount(ctx.db, ctx.user.id, ctx.ip);
    return { ok: true, balance: Number(account.balance), resetCount: account.resetCount };
  }),
});
