import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  STRATEGY_TYPES,
  evaluatePromotion,
  computeHRPWeights,
  aggregateSignals,
  type AgentPerformanceRecord,
  type SubAgentSignal,
} from '@gladiator/ml';
import { protectedProcedure, router } from '../trpc.js';

const { rlAgents, rlEpisodes, rlActions, rlAgentPerformance } = schema;

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

        result.push({
          ...agent,
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
});
