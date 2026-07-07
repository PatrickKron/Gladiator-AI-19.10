import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import { parseSubAgentSpec, subAgentSpecSchema } from '@gladiator/strategy-engine';
import { backtestSubAgent } from '@gladiator/backtest';
import { PAPER_START_EQUITY } from '@gladiator/exchange';
import { SUB_AGENT_TEMPLATES } from './sub-agent-templates.js';
import { protectedProcedure, router } from '../trpc.js';

const { subAgents, subAgentRuns, signals, positions, executedTrades, auditLog } = schema;

/**
 * Trading-Agenten-Werkstatt (Sub-Agenten): CRUD + Steuerung + echte Performance.
 * Alle Definitionen laufen gegen `subAgentSpecSchema` (keine Blackbox). Der Modus
 * bleibt hart 'paper', bis Patrick pro Agent freigibt (Paper-Default, Regel 3).
 * Performance/Historie werden IMMER aus echten Zeilen berechnet — nie gecacht.
 */

const metaInput = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  thesis: z.string().max(2000).optional(),
  symbols: z.array(z.string().min(3).max(20)).min(1).max(20),
});

/** Validiert die Regel-Definition und zerlegt sie in die DB-Spalten. */
function specColumns(rawSpec: unknown): {
  config: { side: string; setupType: string; timeframe: string };
  dataSources: unknown;
  entryRules: unknown;
  exitRules: unknown;
  riskParams: unknown;
} {
  const parsed = parseSubAgentSpec(rawSpec);
  if (!parsed.ok) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Regel-Definition ungültig: ${parsed.errors.join('; ')}` });
  }
  const s = parsed.spec;
  return {
    config: { side: s.side, setupType: s.setupType, timeframe: s.timeframe },
    dataSources: s.dataSources,
    entryRules: s.entryRules,
    exitRules: s.exitRules,
    riskParams: s.riskParams,
  };
}

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))];
}

/** DB-Zeile → API-Objekt (Regeln als ein Spec-Objekt zusammengeführt). */
function toDto(row: typeof subAgents.$inferSelect) {
  const cfg = row.config as { side: string; setupType: string; timeframe: string };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    thesis: row.thesis,
    symbols: row.symbols,
    status: row.status,
    mode: row.mode,
    spec: {
      side: cfg.side,
      setupType: cfg.setupType,
      timeframe: cfg.timeframe,
      dataSources: row.dataSources,
      entryRules: row.entryRules,
      exitRules: row.exitRules,
      riskParams: row.riskParams,
    },
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadOwned(ctx: { db: Db; user: { id: string } }, id: string) {
  const [row] = await ctx.db
    .select()
    .from(subAgents)
    .where(and(eq(subAgents.id, id), eq(subAgents.userId, ctx.user.id)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Sub-Agent nicht gefunden.' });
  return row;
}

export const subAgentsRouter = router({
  /** Vorlagen für gängige Agent-Typen (Dip-Buyer, Makro, Event-Trader, Momentum). */
  templates: protectedProcedure.query(() => SUB_AGENT_TEMPLATES),

  /** Liste aller Agenten des Users + echte Kurzstatistik (offene Positionen, Netto-PnL). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(subAgents)
      .where(eq(subAgents.userId, ctx.user.id))
      .orderBy(desc(subAgents.createdAt));

    const openByAgent = new Map<string, number>();
    const openRows = await ctx.db
      .select({ subAgentId: positions.subAgentId, n: sql<number>`count(*)::int` })
      .from(positions)
      .where(eq(positions.userId, ctx.user.id))
      .groupBy(positions.subAgentId);
    for (const r of openRows) if (r.subAgentId) openByAgent.set(r.subAgentId, r.n);

    const statByAgent = new Map<string, { trades: number; netPnl: number }>();
    const statRows = await ctx.db
      .select({
        subAgentId: executedTrades.subAgentId,
        trades: sql<number>`count(*)::int`,
        netPnl: sql<number>`coalesce(sum(net_pnl::float), 0)::float`,
      })
      .from(executedTrades)
      .where(eq(executedTrades.userId, ctx.user.id))
      .groupBy(executedTrades.subAgentId);
    for (const r of statRows) if (r.subAgentId) statByAgent.set(r.subAgentId, { trades: r.trades, netPnl: r.netPnl });

    return rows.map((r) => ({
      ...toDto(r),
      openPositions: openByAgent.get(r.id) ?? 0,
      closedTrades: statByAgent.get(r.id)?.trades ?? 0,
      netPnl: statByAgent.get(r.id)?.netPnl ?? 0,
    }));
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    return toDto(await loadOwned(ctx, input.id));
  }),

  create: protectedProcedure
    .input(metaInput.extend({ spec: subAgentSpecSchema }))
    .mutation(async ({ ctx, input }) => {
      const cols = specColumns(input.spec);
      const [row] = await ctx.db
        .insert(subAgents)
        .values({
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          thesis: input.thesis ?? null,
          symbols: normalizeSymbols(input.symbols),
          status: 'paused', // startet immer pausiert — bewusst scharfschalten
          mode: 'paper', // Paper-Default (Regel 3)
          ...cols,
        })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user', userId: ctx.user.id, action: 'sub_agent.create',
        entityType: 'sub_agent', entityId: row!.id, details: { name: input.name, symbols: row!.symbols }, ip: ctx.ip,
      });
      return toDto(row!);
    }),

  update: protectedProcedure
    .input(metaInput.extend({ id: z.string().uuid(), spec: subAgentSpecSchema }))
    .mutation(async ({ ctx, input }) => {
      await loadOwned(ctx, input.id);
      const cols = specColumns(input.spec);
      const [row] = await ctx.db
        .update(subAgents)
        .set({
          name: input.name,
          description: input.description ?? null,
          thesis: input.thesis ?? null,
          symbols: normalizeSymbols(input.symbols),
          ...cols,
          updatedAt: new Date(),
        })
        .where(and(eq(subAgents.id, input.id), eq(subAgents.userId, ctx.user.id)))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user', userId: ctx.user.id, action: 'sub_agent.update',
        entityType: 'sub_agent', entityId: input.id, details: { name: input.name }, ip: ctx.ip,
      });
      return toDto(row!);
    }),

  /** Ein-/Ausschalten oder Archivieren. 'active' = Runner handelt autonom (Paper). */
  setStatus: protectedProcedure
    .input(z.object({ id: z.string().uuid(), status: z.enum(['active', 'paused', 'archived']) }))
    .mutation(async ({ ctx, input }) => {
      const row = await loadOwned(ctx, input.id);
      if (row.status === 'archived' && input.status === 'active') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Archivierter Agent kann nicht direkt aktiviert werden.' });
      }
      const [updated] = await ctx.db
        .update(subAgents)
        .set({ status: input.status, updatedAt: new Date(), lastError: null })
        .where(and(eq(subAgents.id, input.id), eq(subAgents.userId, ctx.user.id)))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user', userId: ctx.user.id, action: `sub_agent.status.${input.status}`,
        entityType: 'sub_agent', entityId: input.id, details: { from: row.status, to: input.status }, ip: ctx.ip,
      });
      return toDto(updated!);
    }),

  /** Echte Performance je Agent aus geschlossenen Trades (nie gecacht). */
  performance: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    await loadOwned(ctx, input.id);
    const trades = await ctx.db
      .select()
      .from(executedTrades)
      .where(and(eq(executedTrades.subAgentId, input.id), eq(executedTrades.userId, ctx.user.id)))
      .orderBy(executedTrades.createdAt);
    const closed = trades.filter((t) => t.exitTs !== null);
    if (closed.length === 0) return { trades: 0 as const };

    const pnls = closed.map((t) => Number(t.netPnl ?? 0));
    const wins = pnls.filter((v) => v > 0);
    const losses = pnls.filter((v) => v < 0);
    const rs = closed.map((t) => (t.rMultiple ? Number(t.rMultiple) : null)).filter((v): v is number => v !== null);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

    let cum = 0;
    const curve = closed.map((t) => {
      cum += Number(t.netPnl ?? 0);
      return { ts: (t.exitTs ?? t.createdAt).toISOString(), cumulativePnl: Math.round(cum * 100) / 100 };
    });

    return {
      trades: closed.length,
      netPnl: pnls.reduce((a, b) => a + b, 0),
      winRate: wins.length / closed.length,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      expectancyR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      avgWinPnl: wins.length > 0 ? grossWin / wins.length : null,
      avgLossPnl: losses.length > 0 ? -grossLoss / losses.length : null,
      curve,
    };
  }),

  /** Offene Positionen dieses Agenten inkl. unrealisiertem PnL gegen den echten Live-Preis. */
  positions: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    await loadOwned(ctx, input.id);
    const rows = await ctx.db
      .select()
      .from(positions)
      .where(and(eq(positions.subAgentId, input.id), eq(positions.userId, ctx.user.id)))
      .orderBy(desc(positions.openedAt));
    const out = [];
    for (const p of rows) {
      let mark: number | null = null;
      try {
        mark = ctx.venue ? await ctx.venue.markPrice(p.symbol) : null;
      } catch {
        mark = null;
      }
      const entry = Number(p.entryPrice);
      const qty = Number(p.qty);
      const sign = p.direction === 'long' ? 1 : -1;
      out.push({
        id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        qty,
        entryPrice: entry,
        openedAt: p.openedAt.toISOString(),
        markPrice: mark,
        unrealizedPnl: mark === null ? null : (mark - entry) * qty * sign,
      });
    }
    return out;
  }),

  /** Signal-Historie des Agenten (transparente Herkunft). */
  signalHistory: protectedProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      await loadOwned(ctx, input.id);
      return ctx.db
        .select({
          id: signals.id,
          createdAt: signals.createdAt,
          symbol: signals.symbol,
          direction: signals.direction,
          entry: signals.entry,
          stopLoss: signals.stopLoss,
          takeProfits: signals.takeProfits,
          status: signals.status,
          confluence: signals.confluence,
        })
        .from(signals)
        .where(eq(signals.subAgentId, input.id))
        .orderBy(desc(signals.createdAt))
        .limit(input.limit);
    }),

  /** Letzte Evaluations-Läufe (was der Agent wann getan hat). */
  runs: protectedProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      await loadOwned(ctx, input.id);
      return ctx.db
        .select()
        .from(subAgentRuns)
        .where(eq(subAgentRuns.subAgentId, input.id))
        .orderBy(desc(subAgentRuns.ranAt))
        .limit(input.limit);
    }),

  /**
   * Backtest über echte historische Kerzen (Preis-Dimension, netto-kostend).
   * Ehrlich: Live-only-Bedingungen (Makro/News/Kalender) werden als übersprungen
   * ausgewiesen statt stillschweigend ignoriert.
   */
  backtest: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        symbol: z.string().min(3).max(20).optional(),
        days: z.number().int().min(7).max(730).default(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await loadOwned(ctx, input.id);
      const parsed = parseSubAgentSpec({
        side: (row.config as { side: string }).side,
        setupType: (row.config as { setupType: string }).setupType,
        timeframe: (row.config as { timeframe: string }).timeframe,
        dataSources: row.dataSources,
        entryRules: row.entryRules,
        exitRules: row.exitRules,
        riskParams: row.riskParams,
      });
      if (!parsed.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: `Regel-Definition ungültig: ${parsed.errors.join('; ')}` });

      const symbol = (input.symbol ?? row.symbols[0] ?? '').toUpperCase();
      if (!symbol) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Kein Symbol für den Backtest.' });

      const since = new Date(Date.now() - input.days * 86_400_000);
      const candles = await getOhlcv(ctx.db, { symbol, timeframe: parsed.spec.timeframe, since });
      if (candles.length < 30) {
        return {
          symbol,
          candleCount: candles.length,
          insufficient: true as const,
          detail: `Zu wenig Historie für ${symbol} @ ${parsed.spec.timeframe} (${candles.length} Kerzen) — bitte Backfill/anderes Symbol.`,
        };
      }
      const res = backtestSubAgent(candles, parsed.spec);
      return {
        symbol,
        candleCount: candles.length,
        insufficient: false as const,
        priceOnly: res.priceOnly,
        notBacktestable: res.notBacktestable,
        skippedConditions: res.skippedConditions,
        initialEquity: PAPER_START_EQUITY,
        metrics: res.metrics,
        trades: res.trades.length,
        equityCurve: res.equityCurve.map((p) => ({ ts: p.ts.toISOString(), equity: Math.round(p.equity * 100) / 100 })),
      };
    }),
});
