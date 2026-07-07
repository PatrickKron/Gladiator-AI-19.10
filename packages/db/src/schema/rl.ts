import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * RL Sub-Agents: each agent has a strategy type, status (promotion path),
 * risk budget, and serialized actor-critic model.
 */
export const rlAgents = pgTable(
  'rl_agents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    strategyType: text('strategy_type').notNull(), // momentum, mean_reversion, breakout, etc.
    status: text('status').notNull().default('paper'), // paper, sandbox, live, retired
    config: jsonb('config').notNull().default({}),
    riskBudget: numeric('risk_budget').notNull().default('0.1'),
    modelBlob: text('model_blob'), // serialized ActorCriticModel
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rl_agents_status_idx').on(t.status),
    index('rl_agents_strategy_idx').on(t.strategyType),
  ],
);

/**
 * RL Episodes: a training/paper-trading run for one agent on one symbol/timeframe.
 * Stores aggregate metrics per episode.
 */
export const rlEpisodes = pgTable(
  'rl_episodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => rlAgents.id),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    totalReward: numeric('total_reward'),
    sharpeRatio: numeric('sharpe_ratio'),
    maxDrawdown: numeric('max_drawdown'),
    totalTrades: integer('total_trades').notNull().default(0),
    winRate: numeric('win_rate'),
    config: jsonb('config'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rl_episodes_agent_idx').on(t.agentId),
    index('rl_episodes_symbol_tf_idx').on(t.symbol, t.timeframe),
  ],
);

/**
 * RL Actions: individual actions taken during an episode.
 * State + action + reward + value estimate for replay and analysis.
 */
export const rlActions = pgTable(
  'rl_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    episodeId: uuid('episode_id').notNull().references(() => rlEpisodes.id),
    agentId: uuid('agent_id').notNull().references(() => rlAgents.id),
    symbol: text('symbol').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    state: jsonb('state').notNull(),
    action: text('action').notNull(),
    reward: numeric('reward'),
    valueEstimate: numeric('value_estimate'),
    probability: numeric('probability'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rl_actions_episode_idx').on(t.episodeId),
    index('rl_actions_agent_idx').on(t.agentId),
    index('rl_actions_ts_idx').on(t.ts),
  ],
);

/**
 * RL Agent Performance: periodic rollup of agent performance metrics.
 * Used for HRP weight calculation and promotion decisions.
 */
export const rlAgentPerformance = pgTable(
  'rl_agent_performance',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => rlAgents.id),
    period: text('period').notNull(), // daily, weekly, monthly
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    returnPct: numeric('return_pct'),
    sharpeRatio: numeric('sharpe_ratio'),
    maxDrawdown: numeric('max_drawdown'),
    winRate: numeric('win_rate'),
    totalTrades: integer('total_trades'),
    weight: numeric('weight'), // current HRP portfolio weight
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rl_perf_agent_idx').on(t.agentId),
    index('rl_perf_period_idx').on(t.period, t.periodStart),
  ],
);
