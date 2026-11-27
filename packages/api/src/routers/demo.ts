import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
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
import { evaluateAssetHedging } from '@gladiator/risk';
import { getMacroSnapshot } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

const { demoOrders, demoPositions, demoTrades, auditLog } = schema;

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

export const demoOrderInput = z.object({
  symbol: z.string().min(1).max(24),
  direction: z.enum(['long', 'short']),
  type: z.enum(['market', 'limit']),
  qty: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  /** Hebel (Isolated Margin); Obergrenze kommt aus den Trading-Einstellungen. */
  leverage: z.number().min(1).max(125).optional(),
  /** Börse, gegen deren echtes Orderbuch ausgeführt wird (Vision-Punkt 2), Standard Binance. */
  venue: z.enum([...COMPARE_VENUES, 'yahoo', 'twelvedata']).optional(),
});

/** Symbol normalisieren + Hebel-Obergrenze aus den Trading-Einstellungen des Users anhängen. */
export type DemoOrderArgs = z.infer<typeof demoOrderInput>;

async function normalized(ctx: { db: Parameters<typeof loadRiskSettings>[0]; user: { id: string } }, input: DemoOrderArgs) {
  const settings = await loadRiskSettings(ctx.db, ctx.user.id);
  const reqLev = typeof input.leverage === 'number' && Number.isFinite(input.leverage) ? Math.min(125, Math.max(1, input.leverage)) : 1;
  return { ...input, symbol: input.symbol.toUpperCase(), maxLeverage: Math.max(settings.maxLeverage, reqLev) };
}


/** Aktive Demo-Buchquelle (Tests können sie ersetzen) — auch für den Gladiator-Chat. */
export function currentDemoBookSource(): DemoBookSource {
  return books();
}

/** Offene Demo-Positionen mit uPnL gegen den echten Buch-Mid (Seite UND Chat; Kurs nicht erreichbar → ehrlich null). */
export async function listDemoPositions(db: Db, source: DemoBookSource, userId: string) {
  const rows = await db.select().from(demoPositions).where(eq(demoPositions.userId, userId)).orderBy(desc(demoPositions.openedAt));
  const marks = new Map<string, number | null>();
  for (const key of new Set(rows.map((p) => `${p.venue}|${p.symbol}`))) {
    const [venue, symbol] = key.split('|') as [string, string];
    try {
      marks.set(key, midPrice(await source.fetchBook(symbol, venue)));
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
}

/** Vorschau wie im Ticket (Seite UND Gladiator-Chat): Symbol normalisiert, Hebel-Obergrenze aus den Trading-Einstellungen. */
export async function previewDemoOrderFor(db: Db, userId: string, input: DemoOrderArgs) {
  return previewDemoOrder(db, books(), userId, await normalized({ db, user: { id: userId } }, input));
}

/** Order wie im Ticket (Seite UND Chat nach Bestätigung): dieselbe Engine, dieselben Grenzen; abgelehnt ⇒ Fehler `demo:<grund>`. */
export async function placeDemoOrderFor(db: Db, userId: string, input: DemoOrderArgs) {
  const r = await placeDemoOrder(db, books(), userId, await normalized({ db, user: { id: userId } }, input));
  if (!r.placed) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `demo:${r.reason}` });
  return r;
}

export const demoRouter = router({
  /** Konto-Übersicht: Balance/Equity/Verfügbar/uPnL — Marks aus echten Büchern. */
  account: protectedProcedure.query(({ ctx }) => demoAccountOverview(ctx.db, books(), ctx.user.id)),

  /** Kosten-Vorschau aus dem ECHTEN Orderbuch (Spread/Slippage/Fee sichtbar vor dem Klick). */
  preview: protectedProcedure.input(demoOrderInput).mutation(({ ctx, input }) => previewDemoOrderFor(ctx.db, ctx.user.id, input)),

  placeOrder: protectedProcedure.input(demoOrderInput).mutation(({ ctx, input }) => placeDemoOrderFor(ctx.db, ctx.user.id, input)),

  /**
   * 1-Klick-Gegen-Hedge im Übungskonto (Welle 21):
   * Liest die diesem Asset zugeordnete Hedging-Strategie + echten Orderbuch-Kurs,
   * berechnet automatisch die Short-Menge und den Schutz-Stop-Loss (`hedgeStopLossPct`)
   * und führt über dieselbe Demo-Engine aus (virtuelles Guthaben, nie echtes Geld).
   */
  placeHedgeOrder: protectedProcedure
    .input(
      z.object({
        targetSymbol: z.string().min(1).max(32),
        notionalUsd: z.number().positive().max(1_000_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const targetSym = input.targetSymbol.trim().toUpperCase();
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const [macro, account, openPos] = await Promise.all([
        getMacroSnapshot(ctx.db).catch(() => null),
        demoAccountOverview(ctx.db, books(), ctx.user.id),
        listDemoPositions(ctx.db, books(), ctx.user.id),
      ]);

      const posForTarget = openPos.filter((p) => p.symbol.toUpperCase() === targetSym && p.direction === 'long');
      const targetExposureUsd = posForTarget.reduce(
        (sum, p) => sum + Math.abs(p.qty * (p.markPrice ?? p.entryPrice)),
        0,
      );
      const totalExposureUsd = openPos.reduce(
        (sum, p) => sum + Math.abs(p.qty * (p.markPrice ?? p.entryPrice)),
        0,
      );
      const drawdownPct =
        account.startBalance > 0
          ? Math.max(0, ((account.startBalance - account.equity) / account.startBalance) * 100)
          : 0;

      const evalRes = evaluateAssetHedging(settings.hedgingConfig, targetSym, {
        drawdownPct,
        vix: macro?.vix?.value ?? null,
        grsLabel: macro?.grs?.label ?? null,
        netExposureUsd: targetExposureUsd > 0 ? targetExposureUsd : totalExposureUsd,
      });

      if (evalRes.mode === 'none') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Für ${targetSym} ist „Kein Hedge“ eingestellt — erst eine Hedging-Strategie zuordnen.`,
        });
      }
      if (evalRes.instrument === 'stablecoin_shift') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Die Strategie „${evalRes.strategyName}“ nutzt Stablecoin-Umschichtung statt Short-Gegenposition — bitte Long-Position direkt teilverkaufen.`,
        });
      }

      const hedgeSymbol = evalRes.hedgeSymbol.toUpperCase();
      const book = await books().fetchBook(hedgeSymbol);
      const mid = midPrice(book);
      if (mid === null || mid <= 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Kein echter Live-Kurs für Hedge-Symbol ${hedgeSymbol} verfügbar.`,
        });
      }

      const strategyObj = evalRes.strategyId
        ? settings.hedgingConfig.strategies.find((s) => s.id === evalRes.strategyId)
        : null;
      const stopPct = strategyObj?.hedgeStopLossPct ?? 8;
      const ratioPct =
        evalRes.evaluation.recommendedHedgePct > 0
          ? evalRes.evaluation.recommendedHedgePct
          : evalRes.effectiveConfig.maxHedgeRatioPct;

      const baseExposure = targetExposureUsd > 0 ? targetExposureUsd : totalExposureUsd;
      const computedNotional =
        input.notionalUsd ??
        (baseExposure > 0
          ? Math.max(25, Math.round((baseExposure * ratioPct) / 100))
          : Math.max(25, Math.min(500, Math.floor(account.available * 0.1))));

      const qty = computedNotional / mid;
      const stopLoss = Math.round(mid * (1 + stopPct / 100) * 1e6) / 1e6;

      const placed = await placeDemoOrderFor(ctx.db, ctx.user.id, {
        symbol: hedgeSymbol,
        direction: 'short',
        type: 'market',
        qty,
        stopLoss,
        leverage: 1,
      });

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'demo.hedge.executed',
        entityType: 'demo_order',
        entityId: placed.orderId,
        details: {
          targetSymbol: targetSym,
          hedgeSymbol,
          strategyId: evalRes.strategyId,
          strategyName: evalRes.strategyName,
          notionalUsd: computedNotional,
          ratioPct,
          stopLoss,
          avgFillPrice: placed.avgFillPrice,
        },
        ip: ctx.ip,
      });

      return {
        placed: true,
        orderId: placed.orderId,
        targetSymbol: targetSym,
        hedgeSymbol,
        direction: 'short' as const,
        qty,
        notionalUsd: computedNotional,
        avgFillPrice: placed.avgFillPrice,
        stopLoss,
        strategyName: evalRes.strategyName,
      };
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
  positions: protectedProcedure.query(({ ctx }) => listDemoPositions(ctx.db, books(), ctx.user.id)),

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
    const rs = rows.map((t) => (t.rMultiple === null ? null : Number(t.rMultiple))).filter((v): v is number => v !== null);
    const expectancyR = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

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
      expectancyR,
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
