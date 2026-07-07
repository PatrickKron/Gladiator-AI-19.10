import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import {
  initEpisode,
  getState,
  stateToArray,
  step,
  computeEpisodeMetrics,
  ACTION_SPACE,
  createActorCritic,
  getActionProbs,
  getValue,
  sampleAction,
  logProb,
  createTrajectory,
  addToTrajectory,
  ppoUpdate,
  serializeActorCritic,
  deserializeActorCritic,
  computeHRPWeights,
  type AgentPerformanceRecord,
  type EpisodeConfig,
  DEFAULT_EPISODE_CONFIG,
} from '@gladiator/ml';
import { scanUniverse } from './universe.js';

const { rlAgents, rlEpisodes, rlActions, rlAgentPerformance } = schema;

// Simple seeded PRNG for action sampling
function createRng(seed: number) {
  let s = seed | 0 || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/**
 * Gibt die Event-Loop frei. Das Episoden-Training ist rein synchron und CPU-schwer;
 * ohne periodisches Yield blockiert es den (im selben Prozess laufenden) Webserver
 * und verhindert, dass BullMQ seine Job-Lock erneuert → Stall-Retry-Sturm.
 * setImmediate lässt anstehende HTTP-Requests + den Lock-Renew-Timer dazwischen laufen.
 */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export type RlEpisodeResult = {
  episodesRun: number;
  skipped: number;
  errors: string[];
};

/**
 * Run paper-trading episodes for all active RL agents.
 * Each agent runs one episode per call against a random symbol from the universe.
 */
export async function runRlEpisodes(db: Db): Promise<RlEpisodeResult> {
  const result: RlEpisodeResult = { episodesRun: 0, skipped: 0, errors: [] };

  const agents = await db.select().from(rlAgents)
    .where(sql`${rlAgents.status} IN ('paper', 'sandbox')`);

  if (agents.length === 0) return result;

  const universe = await scanUniverse(db);
  if (universe.length === 0) {
    result.errors.push('No symbols in universe');
    return result;
  }

  for (const agent of agents) {
    try {
      // Pick a symbol (rotate based on agent index + time)
      const symIdx = (agents.indexOf(agent) + Math.floor(Date.now() / 3600_000)) % universe.length;
      const symbol = universe[symIdx]!;
      const timeframe = '1h'; // default timeframe for RL episodes

      const candles = await getOhlcv(db, { symbol, timeframe, limit: 1000 });
      if (candles.length < 300) {
        result.skipped++;
        continue;
      }

      // Load or create actor-critic model
      const model = agent.modelBlob
        ? deserializeActorCritic(agent.modelBlob)
        : createActorCritic();

      const rng = createRng(Date.now() + agents.indexOf(agent));
      const config: EpisodeConfig = {
        ...DEFAULT_EPISODE_CONFIG,
        riskBudget: Number(agent.riskBudget),
        maxBars: Math.min(300, candles.length - 221),
      };

      const ctx = initEpisode(candles, config);
      const trajectory = createTrajectory();

      // Create episode record
      const [episode] = await db.insert(rlEpisodes).values({
        agentId: agent.id,
        symbol,
        timeframe,
        startedAt: new Date(),
        config: { ...config, strategyType: agent.strategyType },
      }).returning();

      // Run episode
      const actionRecords: {
        symbol: string;
        ts: Date;
        state: unknown;
        action: string;
        reward: number | null;
        valueEstimate: number | null;
        probability: number | null;
      }[] = [];

      let state = getState(ctx);
      let stepCount = 0;

      while (state) {
        const stateArr = stateToArray(state);
        const probs = getActionProbs(model, stateArr);
        const actionIdx = sampleAction(probs, rng);
        const action = ACTION_SPACE[actionIdx]!;
        const value = getValue(model, stateArr);
        const lp = logProb(probs, actionIdx);

        const stepResult = step(ctx, action);
        if (!stepResult) break;

        addToTrajectory(trajectory, stateArr, actionIdx, stepResult.reward, value, lp, stepResult.done);

        // Record action (sample — don't store every single step for long episodes)
        if (stepCount % 5 === 0 || stepResult.done) {
          actionRecords.push({
            symbol,
            ts: candles[ctx.currentBar]?.ts ?? new Date(),
            state: { features: stateArr.slice(0, 5) }, // abbreviated state for DB
            action,
            reward: stepResult.reward,
            valueEstimate: value,
            probability: probs[actionIdx] ?? null,
          });
        }

        stepCount++;
        if (stepResult.done) break;
        state = stepResult.nextState;

        // Event-Loop periodisch freigeben, damit HTTP-Requests + BullMQ-Lock-Renew
        // während des synchronen Trainings nicht verhungern.
        if (stepCount % 16 === 0) await yieldToLoop();
      }

      // PPO update from trajectory
      if (trajectory.states.length >= 10) {
        await yieldToLoop();
        ppoUpdate(model, trajectory);
      }

      // Compute episode metrics
      const metrics = computeEpisodeMetrics(ctx);

      // Update episode with results
      await db.update(rlEpisodes)
        .set({
          endedAt: new Date(),
          totalReward: String(metrics.totalReturn),
          sharpeRatio: String(metrics.sharpeRatio),
          maxDrawdown: String(metrics.maxDrawdown),
          totalTrades: metrics.totalTrades,
          winRate: String(metrics.winRate),
        })
        .where(eq(rlEpisodes.id, episode!.id));

      // Store sampled actions
      if (actionRecords.length > 0) {
        await db.insert(rlActions).values(
          actionRecords.map(ar => ({
            episodeId: episode!.id,
            agentId: agent.id,
            symbol: ar.symbol,
            ts: ar.ts,
            state: ar.state,
            action: ar.action,
            reward: ar.reward != null ? String(ar.reward) : null,
            valueEstimate: ar.valueEstimate != null ? String(ar.valueEstimate) : null,
            probability: ar.probability != null ? String(ar.probability) : null,
          })),
        );
      }

      // Save updated model
      await db.update(rlAgents)
        .set({
          modelBlob: serializeActorCritic(model),
          updatedAt: new Date(),
        })
        .where(eq(rlAgents.id, agent.id));

      result.episodesRun++;
    } catch (err) {
      result.errors.push(`Agent ${agent.name}: ${String(err)}`);
    }
  }

  return result;
}

export type RlPerfAggResult = {
  aggregated: number;
  errors: string[];
};

/**
 * Aggregate daily performance for all RL agents.
 * Rolls up episode metrics into daily performance records.
 */
export async function aggregateRlPerformance(db: Db): Promise<RlPerfAggResult> {
  const result: RlPerfAggResult = { aggregated: 0, errors: [] };

  const agents = await db.select().from(rlAgents)
    .where(sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`);

  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  for (const agent of agents) {
    try {
      // Get today's episodes
      const episodes = await db.select()
        .from(rlEpisodes)
        .where(and(
          eq(rlEpisodes.agentId, agent.id),
          sql`${rlEpisodes.endedAt} IS NOT NULL`,
          sql`${rlEpisodes.endedAt} >= ${dayStart}`,
          sql`${rlEpisodes.endedAt} < ${dayEnd}`,
        ));

      if (episodes.length === 0) continue;

      const returns = episodes.map(e => Number(e.totalReward ?? 0));
      const sharpes = episodes.filter(e => e.sharpeRatio != null).map(e => Number(e.sharpeRatio));
      const drawdowns = episodes.filter(e => e.maxDrawdown != null).map(e => Number(e.maxDrawdown));
      const winRates = episodes.filter(e => e.winRate != null).map(e => Number(e.winRate));
      const trades = episodes.reduce((sum, e) => sum + e.totalTrades, 0);

      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const avgSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0;
      const maxDD = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
      const avgWinRate = winRates.length > 0 ? winRates.reduce((a, b) => a + b, 0) / winRates.length : 0;

      // Upsert daily record
      await db.insert(rlAgentPerformance).values({
        agentId: agent.id,
        period: 'daily',
        periodStart: dayStart,
        periodEnd: dayEnd,
        returnPct: String(avgReturn),
        sharpeRatio: String(avgSharpe),
        maxDrawdown: String(maxDD),
        winRate: String(avgWinRate),
        totalTrades: trades,
      });

      result.aggregated++;
    } catch (err) {
      result.errors.push(`Agent ${agent.name}: ${String(err)}`);
    }
  }

  return result;
}

export type RlRebalanceResult = {
  rebalanced: boolean;
  agentCount: number;
  weights: { agentId: string; name: string; weight: number }[];
  errors: string[];
};

/**
 * Rebalance HRP portfolio weights across all active agents.
 * Runs weekly to adjust allocations based on rolling performance.
 */
export async function rebalanceRlWeights(db: Db): Promise<RlRebalanceResult> {
  const result: RlRebalanceResult = { rebalanced: false, agentCount: 0, weights: [], errors: [] };

  const agents = await db.select().from(rlAgents)
    .where(sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`);

  if (agents.length === 0) return result;

  const perfRecords: AgentPerformanceRecord[] = [];

  for (const agent of agents) {
    const dailyPerfs = await db.select()
      .from(rlAgentPerformance)
      .where(and(
        eq(rlAgentPerformance.agentId, agent.id),
        eq(rlAgentPerformance.period, 'daily'),
      ))
      .orderBy(desc(rlAgentPerformance.periodEnd))
      .limit(30);

    perfRecords.push({
      agentId: agent.id,
      returns: dailyPerfs.map(p => Number(p.returnPct ?? 0)),
      sharpeRatio: dailyPerfs[0] ? Number(dailyPerfs[0].sharpeRatio ?? 0) : 0,
      maxDrawdown: dailyPerfs[0] ? Number(dailyPerfs[0].maxDrawdown ?? 0) : 0,
      winRate: dailyPerfs[0] ? Number(dailyPerfs[0].winRate ?? 0) : 0,
    });
  }

  const allocations = computeHRPWeights(perfRecords);

  // Store weights as weekly performance records
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  for (const alloc of allocations) {
    const agent = agents.find(a => a.id === alloc.agentId);
    if (!agent) continue;

    // Get latest daily perf for the agent
    const [latestPerf] = await db.select()
      .from(rlAgentPerformance)
      .where(and(
        eq(rlAgentPerformance.agentId, agent.id),
        eq(rlAgentPerformance.period, 'daily'),
      ))
      .orderBy(desc(rlAgentPerformance.periodEnd))
      .limit(1);

    await db.insert(rlAgentPerformance).values({
      agentId: alloc.agentId,
      period: 'weekly',
      periodStart: weekStart,
      periodEnd: weekEnd,
      returnPct: latestPerf?.returnPct ?? '0',
      sharpeRatio: latestPerf?.sharpeRatio ?? '0',
      maxDrawdown: latestPerf?.maxDrawdown ?? '0',
      winRate: latestPerf?.winRate ?? '0',
      totalTrades: latestPerf?.totalTrades ?? 0,
      weight: String(alloc.weight),
    });

    result.weights.push({
      agentId: alloc.agentId,
      name: agent.name,
      weight: alloc.weight,
    });
  }

  result.rebalanced = true;
  result.agentCount = agents.length;
  return result;
}
