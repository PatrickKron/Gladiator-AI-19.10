import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  STRATEGY_TYPES,
  evaluatePromotion,
  computeHRPWeights,
  aggregateSignals,
  evaluateAgent,
  computeVaR,
  computeExpectedShortfall,
  computeSortino,
  computeCalmar,
  type AgentPerformanceRecord,
  type SubAgentSignal,
} from '@gladiator/ml';
import { protectedProcedure, router } from '../trpc.js';

const { rlAgents, rlEpisodes, rlActions, rlAgentPerformance, performanceSnapshots } = schema;

export const rlRouter = router({
  /** List all RL agents with their latest performance. */
  agents: protectedProcedure
    .query(async ({ ctx }) => {
      const agents = await ctx.db.select().from(rlAgents)
        .orderBy(desc(rlAgents.createdAt));

      const result = [];
      for (const agent of agents) {
        // Get latest performance record
        const [latestPerf] = await ctx.db.select()
          .from(rlAgentPerformance)
          .where(eq(rlAgentPerformance.agentId, agent.id))
          .orderBy(desc(rlAgentPerformance.periodEnd))
          .limit(1);

        // Count total episodes and trades
        const [stats] = await ctx.db.select({
          episodeCount: sql<number>`count(distinct ${rlEpisodes.id})::int`,
          totalTrades: sql<number>`coalesce(sum(${rlEpisodes.totalTrades}), 0)::int`,
        })
          .from(rlEpisodes)
          .where(eq(rlEpisodes.agentId, agent.id));

        // model_blob (komplette PPO-Gewichte, mehrere hundert KB) gehört nicht
        // in die Listen-Antwort — kein Client nutzt es.
        const { modelBlob, ...agentPublic } = agent;
        void modelBlob;
        result.push({
          ...agentPublic,
          latestPerformance: latestPerf ?? null,
          episodeCount: stats?.episodeCount ?? 0,
          totalTrades: stats?.totalTrades ?? 0,
        });
      }

      return { agents: result };
    }),

  /** Create a new RL sub-agent. */
  createAgent: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      strategyType: z.enum(STRATEGY_TYPES),
      riskBudget: z.number().min(0.01).max(1.0).default(0.1),
      config: z.record(z.unknown()).default({}),
    }))
    .mutation(async ({ ctx, input }) => {
      const [agent] = await ctx.db.insert(rlAgents).values({
        name: input.name,
        strategyType: input.strategyType,
        riskBudget: String(input.riskBudget),
        config: input.config,
      }).returning();

      return { agent: agent! };
    }),

  /** Get detailed performance history for an agent. */
  agentPerformance: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      const [agent] = await ctx.db.select().from(rlAgents)
        .where(eq(rlAgents.id, input.agentId))
        .limit(1);

      if (!agent) return { agent: null, episodes: [], performance: [], reason: 'Agent not found' };

      const episodes = await ctx.db.select()
        .from(rlEpisodes)
        .where(eq(rlEpisodes.agentId, input.agentId))
        .orderBy(desc(rlEpisodes.createdAt))
        .limit(50);

      const performance = await ctx.db.select()
        .from(rlAgentPerformance)
        .where(eq(rlAgentPerformance.agentId, input.agentId))
        .orderBy(desc(rlAgentPerformance.periodEnd))
        .limit(90);

      return { agent, episodes, performance, reason: null };
    }),

  /** Run a paper-trading episode for an agent. Returns episode ID — actual execution is async via jobs. */
  runEpisode: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid(),
      symbol: z.string(),
      timeframe: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [agent] = await ctx.db.select().from(rlAgents)
        .where(eq(rlAgents.id, input.agentId))
        .limit(1);

      if (!agent) return { episodeId: null, reason: 'Agent not found' };
      if (agent.status === 'retired') return { episodeId: null, reason: 'Agent is retired' };

      const [episode] = await ctx.db.insert(rlEpisodes).values({
        agentId: input.agentId,
        symbol: input.symbol,
        timeframe: input.timeframe,
        startedAt: new Date(),
        config: { manual: true },
      }).returning();

      return { episodeId: episode!.id, reason: null };
    }),

  /** Get current HRP portfolio weights across all active agents. */
  portfolioWeights: protectedProcedure
    .query(async ({ ctx }) => {
      const activeAgents = await ctx.db.select().from(rlAgents)
        .where(
          sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`,
        );

      if (activeAgents.length === 0) return { weights: [], totalAgents: 0 };

      // Gather performance records for HRP
      const perfRecords: AgentPerformanceRecord[] = [];

      for (const agent of activeAgents) {
        const perfs = await ctx.db.select()
          .from(rlAgentPerformance)
          .where(and(
            eq(rlAgentPerformance.agentId, agent.id),
            eq(rlAgentPerformance.period, 'daily'),
          ))
          .orderBy(desc(rlAgentPerformance.periodEnd))
          .limit(30);

        perfRecords.push({
          agentId: agent.id,
          returns: perfs.map(p => Number(p.returnPct ?? 0)),
          sharpeRatio: perfs[0] ? Number(perfs[0].sharpeRatio ?? 0) : 0,
          maxDrawdown: perfs[0] ? Number(perfs[0].maxDrawdown ?? 0) : 0,
          winRate: perfs[0] ? Number(perfs[0].winRate ?? 0) : 0,
        });
      }

      const allocations = computeHRPWeights(perfRecords);

      return {
        weights: allocations.map(a => ({
          ...a,
          agentName: activeAgents.find(ag => ag.id === a.agentId)?.name ?? '?',
          strategyType: activeAgents.find(ag => ag.id === a.agentId)?.strategyType ?? '?',
        })),
        totalAgents: activeAgents.length,
      };
    }),

  /** Get aggregated coordinator signal for a symbol across all active agents. */
  coordinatorSignal: protectedProcedure
    .input(z.object({
      symbol: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const activeAgents = await ctx.db.select().from(rlAgents)
        .where(sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`);

      if (activeAgents.length === 0) return { signal: null, reason: 'No active agents' };

      // Get latest action per agent for this symbol
      const signals: SubAgentSignal[] = [];
      for (const agent of activeAgents) {
        const [latestAction] = await ctx.db.select()
          .from(rlActions)
          .where(and(
            eq(rlActions.agentId, agent.id),
            eq(rlActions.symbol, input.symbol),
          ))
          .orderBy(desc(rlActions.ts))
          .limit(1);

        if (latestAction) {
          const action = latestAction.action;
          const isBuy = action.startsWith('buy');
          const isSell = action.startsWith('sell');
          signals.push({
            agentId: agent.id,
            symbol: input.symbol,
            direction: isBuy ? 'long' : isSell ? 'short' : 'flat',
            strength: isBuy ? Number(latestAction.probability ?? 0.5) : isSell ? -Number(latestAction.probability ?? 0.5) : 0,
            confidence: Number(latestAction.probability ?? 0.5),
          });
        }
      }

      if (signals.length === 0) return { signal: null, reason: 'No recent signals from agents' };

      // Get portfolio weights
      const perfRecords: AgentPerformanceRecord[] = activeAgents.map(a => ({
        agentId: a.id,
        returns: [],
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
      }));

      const allocations = computeHRPWeights(perfRecords);
      const coordSignal = aggregateSignals(signals, allocations);

      return { signal: coordSignal, reason: null };
    }),

  /** Promote an agent to the next status level (requires human approval). */
  promoteAgent: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid(),
      confirm: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [agent] = await ctx.db.select().from(rlAgents)
        .where(eq(rlAgents.id, input.agentId))
        .limit(1);

      if (!agent) return { promoted: false, reason: 'Agent not found' };

      // Gather performance data
      const episodes = await ctx.db.select()
        .from(rlEpisodes)
        .where(eq(rlEpisodes.agentId, input.agentId));

      const totalTrades = episodes.reduce((sum, e) => sum + e.totalTrades, 0);
      const sharpes = episodes.filter(e => e.sharpeRatio != null).map(e => Number(e.sharpeRatio));
      const drawdowns = episodes.filter(e => e.maxDrawdown != null).map(e => Number(e.maxDrawdown));
      const winRates = episodes.filter(e => e.winRate != null).map(e => Number(e.winRate));
      const returns = episodes.filter(e => e.totalReward != null).map(e => Number(e.totalReward));

      const avgSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0;
      const maxDD = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
      const avgWinRate = winRates.length > 0 ? winRates.reduce((a, b) => a + b, 0) / winRates.length : 0;

      const promotion = evaluatePromotion(
        agent.status as 'paper' | 'sandbox' | 'live' | 'retired',
        {
          agentId: agent.id,
          returns,
          sharpeRatio: avgSharpe,
          maxDrawdown: maxDD,
          winRate: avgWinRate,
        },
        totalTrades,
      );

      if (!promotion.eligible) {
        return {
          promoted: false,
          reason: `Not eligible: ${promotion.reasons.join('; ')}`,
          evaluation: promotion,
        };
      }

      if (!input.confirm) {
        return {
          promoted: false,
          reason: 'Eligible but not confirmed — human approval required',
          evaluation: promotion,
        };
      }

      // Execute promotion
      await ctx.db.update(rlAgents)
        .set({
          status: promotion.targetStatus,
          updatedAt: new Date(),
        })
        .where(eq(rlAgents.id, input.agentId));

      return {
        promoted: true,
        reason: `Promoted from ${agent.status} to ${promotion.targetStatus}`,
        evaluation: promotion,
      };
    }),

  /**
   * Retire an agent (P0-Workover): stoppt die geplanten 30-min-Episoden
   * (runRlEpisodes nimmt nur paper/sandbox) — ohne diesen Endpoint erzeugt
   * jeder einmal angelegte Agent für immer Server-Last. Idempotent.
   */
  retireAgent: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid(),
      confirm: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!input.confirm) return { retired: false, reason: 'Human approval required' };

      const [agent] = await ctx.db.select().from(rlAgents)
        .where(eq(rlAgents.id, input.agentId))
        .limit(1);

      if (!agent) return { retired: false, reason: 'Agent not found' };
      if (agent.status === 'retired') return { retired: true, reason: null };

      await ctx.db.update(rlAgents)
        .set({ status: 'retired', updatedAt: new Date() })
        .where(eq(rlAgents.id, input.agentId));

      return { retired: true, reason: null };
    }),

  /** Performance dashboard: aggregated metrics across all or one agent. */
  performanceDashboard: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid().optional(),
      period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(rlAgentPerformance.period, input.period)];
      if (input.agentId) conditions.push(eq(rlAgentPerformance.agentId, input.agentId));

      const perfs = await ctx.db.select()
        .from(rlAgentPerformance)
        .where(and(...conditions))
        .orderBy(desc(rlAgentPerformance.periodEnd))
        .limit(90);

      if (perfs.length === 0) return { metrics: null, dataPoints: 0 };

      const returns = perfs.map(p => Number(p.returnPct ?? 0));
      const sharpes = perfs.filter(p => p.sharpeRatio != null).map(p => Number(p.sharpeRatio));
      const drawdowns = perfs.filter(p => p.maxDrawdown != null).map(p => Number(p.maxDrawdown));
      const winRates = perfs.filter(p => p.winRate != null).map(p => Number(p.winRate));
      const totalTradesSum = perfs.reduce((s, p) => s + (p.totalTrades ?? 0), 0);

      const totalReturn = returns.reduce((a, b) => a + b, 0);
      const avgSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0;
      const maxDD = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
      const avgWinRate = winRates.length > 0 ? winRates.reduce((a, b) => a + b, 0) / winRates.length : 0;

      return {
        metrics: {
          totalReturn,
          avgSharpe,
          maxDrawdown: maxDD,
          avgWinRate,
          totalTrades: totalTradesSum,
          sortino: computeSortino(returns),
          calmar: computeCalmar(totalReturn, maxDD),
          var95: computeVaR(returns, 0.95),
          es95: computeExpectedShortfall(returns, 0.95),
        },
        dataPoints: perfs.length,
        timeSeries: perfs.map(p => ({
          ts: p.periodEnd,
          returnPct: Number(p.returnPct ?? 0),
          sharpe: Number(p.sharpeRatio ?? 0),
          drawdown: Number(p.maxDrawdown ?? 0),
          winRate: Number(p.winRate ?? 0),
        })).reverse(),
      };
    }),

  /** Equity curve data for charting. */
  equityCurve: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(365).default(90),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(rlAgentPerformance.period, 'daily')];
      if (input.agentId) conditions.push(eq(rlAgentPerformance.agentId, input.agentId));

      const perfs = await ctx.db.select({
        periodEnd: rlAgentPerformance.periodEnd,
        returnPct: rlAgentPerformance.returnPct,
      })
        .from(rlAgentPerformance)
        .where(and(...conditions))
        .orderBy(desc(rlAgentPerformance.periodEnd))
        .limit(input.limit);

      // Build cumulative equity curve starting at 1.0
      const sorted = perfs.reverse();
      let equity = 1.0;
      const curve = sorted.map(p => {
        equity *= (1 + Number(p.returnPct ?? 0));
        return { ts: p.periodEnd, value: equity };
      });

      return { curve };
    }),

  /** Risk metrics for portfolio or single agent. */
  riskMetrics: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(rlAgentPerformance.period, 'daily')];
      if (input.agentId) conditions.push(eq(rlAgentPerformance.agentId, input.agentId));

      const perfs = await ctx.db.select()
        .from(rlAgentPerformance)
        .where(and(...conditions))
        .orderBy(desc(rlAgentPerformance.periodEnd))
        .limit(90);

      if (perfs.length < 5) return { metrics: null, reason: 'Insufficient data (need ≥5 daily records)' };

      const returns = perfs.map(p => Number(p.returnPct ?? 0));
      const drawdowns = perfs.filter(p => p.maxDrawdown != null).map(p => Number(p.maxDrawdown));

      return {
        metrics: {
          var95: computeVaR(returns, 0.95),
          var99: computeVaR(returns, 0.99),
          es95: computeExpectedShortfall(returns, 0.95),
          maxDrawdown: drawdowns.length > 0 ? Math.max(...drawdowns) : 0,
          currentDrawdown: drawdowns.length > 0 ? drawdowns[0] : 0,
          sortino: computeSortino(returns),
          sharpe: (() => {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
            return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
          })(),
        },
        reason: null,
      };
    }),

  /** Run self-evaluation for an agent. */
  autoEvaluate: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      const [agent] = await ctx.db.select().from(rlAgents)
        .where(eq(rlAgents.id, input.agentId))
        .limit(1);

      if (!agent) return { evaluation: null, reason: 'Agent not found' };

      const episodes = await ctx.db.select()
        .from(rlEpisodes)
        .where(and(
          eq(rlEpisodes.agentId, input.agentId),
          sql`${rlEpisodes.endedAt} IS NOT NULL`,
        ))
        .orderBy(desc(rlEpisodes.endedAt))
        .limit(90);

      if (episodes.length < 5) {
        return { evaluation: null, reason: `Insufficient episodes (${episodes.length}, need ≥5)` };
      }

      const returns = episodes.map(e => Number(e.totalReward ?? 0));
      const wins = episodes.map(e => Number(e.winRate ?? 0) > 0.5);
      const bars = episodes.map(() => 50); // approximate
      const benchmark = returns.map(() => 0.001); // naive benchmark

      const evaluation = evaluateAgent(
        input.agentId,
        returns,
        wins,
        bars,
        benchmark,
        [],
      );

      return { evaluation, reason: null };
    }),

  /** Get performance snapshots with equity curves and regime breakdown. */
  performanceSnapshots: protectedProcedure
    .input(z.object({
      agentId: z.string().uuid().optional(),
      snapshotType: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
      limit: z.number().int().min(1).max(365).default(90),
    }))
    .query(async ({ ctx, input }) => {
      const conditions = [eq(performanceSnapshots.snapshotType, input.snapshotType)];
      if (input.agentId) conditions.push(eq(performanceSnapshots.agentId, input.agentId));

      const snapshots = await ctx.db.select()
        .from(performanceSnapshots)
        .where(and(...conditions))
        .orderBy(desc(performanceSnapshots.periodEnd))
        .limit(input.limit);

      return { snapshots };
    }),
});
