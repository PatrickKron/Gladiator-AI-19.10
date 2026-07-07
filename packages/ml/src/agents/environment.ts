import type { Candle } from '@gladiator/strategy-engine';
import { computeFeatures, featureVectorToArray, FEATURE_NAMES, type FeatureVector } from '../features.js';

/**
 * Trading environment for RL agents.
 *
 * State = feature vector (25 market features) + portfolio state (4).
 * Actions = 7 discrete: hold, buy_small/med/large, sell_small/med/large.
 * Reward = risk-adjusted log-return with drawdown penalty (Sharpe-like).
 *
 * Stateless pure functions — no side effects, no DB access.
 * The episode runner (in jobs/) manages the loop and persistence.
 */

export const ACTION_SPACE = [
  'hold',
  'buy_small',    // 25% of risk budget
  'buy_medium',   // 50%
  'buy_large',    // 75%
  'sell_small',   // 25% of position
  'sell_medium',  // 50%
  'sell_large',   // 75%
] as const;

export type Action = typeof ACTION_SPACE[number];
export const NUM_ACTIONS = ACTION_SPACE.length;

export type PortfolioState = {
  positionSize: number;   // -1 (full short) to +1 (full long), 0 = flat
  unrealizedPnl: number;  // current unrealized P&L as fraction of entry
  holdingBars: number;    // how many bars we've held current position
  cashRatio: number;      // fraction of capital not deployed (0–1)
};

export type EnvState = {
  features: number[];        // 25 market features
  portfolio: PortfolioState; // 4 portfolio features
  raw: FeatureVector | null; // original feature vector for debugging
};

export const STATE_DIM = FEATURE_NAMES.length + 4; // 25 + 4 = 29

export type StepResult = {
  nextState: EnvState;
  reward: number;
  done: boolean;
  info: {
    action: Action;
    price: number;
    positionBefore: number;
    positionAfter: number;
    pnlStep: number;
    totalReturn: number;
    maxDrawdown: number;
  };
};

export type EpisodeConfig = {
  initialCapital: number;
  maxBars: number;        // max bars per episode
  transactionCost: number; // fraction (e.g. 0.001 = 0.1%)
  riskBudget: number;      // max position fraction (0–1)
  drawdownPenalty: number;  // multiplier for drawdown in reward
  holdingCostPerBar: number; // cost of holding per bar (encourages action)
};

export const DEFAULT_EPISODE_CONFIG: EpisodeConfig = {
  initialCapital: 10_000,
  maxBars: 500,
  transactionCost: 0.001,
  riskBudget: 1.0,
  drawdownPenalty: 2.0,
  holdingCostPerBar: 0.0001,
};

export type EpisodeContext = {
  config: EpisodeConfig;
  candles: Candle[];
  currentBar: number;
  position: number;          // -1 to +1
  entryPrice: number | null;
  capital: number;
  peakCapital: number;
  totalReturn: number;
  returns: number[];         // per-step returns for Sharpe calculation
  maxDrawdown: number;
  totalTrades: number;
};

export function initEpisode(candles: Candle[], config: EpisodeConfig = DEFAULT_EPISODE_CONFIG): EpisodeContext {
  return {
    config,
    candles,
    currentBar: 220, // skip warmup (need 220 candles for features)
    position: 0,
    entryPrice: null,
    capital: config.initialCapital,
    peakCapital: config.initialCapital,
    totalReturn: 0,
    returns: [],
    maxDrawdown: 0,
    totalTrades: 0,
  };
}

export function getState(ctx: EpisodeContext): EnvState | null {
  if (ctx.currentBar >= ctx.candles.length) return null;

  const slice = ctx.candles.slice(0, ctx.currentBar + 1);
  const fv = computeFeatures(slice);
  if (!fv) return null;

  const features = featureVectorToArray(fv);
  const price = ctx.candles[ctx.currentBar]!.close;

  let unrealizedPnl = 0;
  if (ctx.position !== 0 && ctx.entryPrice != null && ctx.entryPrice > 0) {
    unrealizedPnl = ctx.position > 0
      ? (price - ctx.entryPrice) / ctx.entryPrice
      : (ctx.entryPrice - price) / ctx.entryPrice;
    unrealizedPnl *= Math.abs(ctx.position);
  }

  return {
    features,
    portfolio: {
      positionSize: ctx.position,
      unrealizedPnl,
      holdingBars: ctx.entryPrice != null ? ctx.currentBar - (ctx.candles.findIndex(c => c.close === ctx.entryPrice) || 0) : 0,
      cashRatio: 1 - Math.abs(ctx.position),
    },
    raw: fv,
  };
}

export function stateToArray(state: EnvState): number[] {
  return [
    ...state.features,
    state.portfolio.positionSize,
    state.portfolio.unrealizedPnl,
    state.portfolio.holdingBars / 100, // normalize
    state.portfolio.cashRatio,
  ];
}

function actionToPositionDelta(action: Action, currentPosition: number, riskBudget: number): number {
  switch (action) {
    case 'hold': return 0;
    case 'buy_small': return 0.25 * riskBudget;
    case 'buy_medium': return 0.50 * riskBudget;
    case 'buy_large': return 0.75 * riskBudget;
    case 'sell_small': return -0.25 * Math.abs(currentPosition || riskBudget);
    case 'sell_medium': return -0.50 * Math.abs(currentPosition || riskBudget);
    case 'sell_large': return -0.75 * Math.abs(currentPosition || riskBudget);
  }
}

export function step(ctx: EpisodeContext, action: Action): StepResult | null {
  if (ctx.currentBar >= ctx.candles.length - 1) return null;

  const priceBefore = ctx.candles[ctx.currentBar]!.close;
  const positionBefore = ctx.position;

  // Apply action
  const delta = actionToPositionDelta(action, ctx.position, ctx.config.riskBudget);
  const newPosition = Math.max(-1, Math.min(1, ctx.position + delta));
  const traded = Math.abs(newPosition - ctx.position);

  // Transaction cost
  const txCost = traded * ctx.config.transactionCost * ctx.capital;
  ctx.capital -= txCost;

  // Update entry price on new positions
  if (ctx.position === 0 && newPosition !== 0) {
    ctx.entryPrice = priceBefore;
  } else if (newPosition === 0) {
    ctx.entryPrice = null;
  }

  if (traded > 0) ctx.totalTrades++;
  ctx.position = newPosition;

  // Advance to next bar
  ctx.currentBar++;
  const priceAfter = ctx.candles[ctx.currentBar]!.close;

  // P&L from position
  const priceReturn = priceBefore > 0 ? (priceAfter - priceBefore) / priceBefore : 0;
  const pnlStep = ctx.position * priceReturn * ctx.capital;
  ctx.capital += pnlStep;

  // Holding cost
  if (ctx.position !== 0) {
    ctx.capital -= ctx.config.holdingCostPerBar * Math.abs(ctx.position) * ctx.capital;
  }

  // Track peak and drawdown
  if (ctx.capital > ctx.peakCapital) ctx.peakCapital = ctx.capital;
  const drawdown = ctx.peakCapital > 0 ? (ctx.peakCapital - ctx.capital) / ctx.peakCapital : 0;
  if (drawdown > ctx.maxDrawdown) ctx.maxDrawdown = drawdown;

  const stepReturn = ctx.config.initialCapital > 0
    ? pnlStep / ctx.config.initialCapital
    : 0;
  ctx.returns.push(stepReturn);
  ctx.totalReturn = (ctx.capital - ctx.config.initialCapital) / ctx.config.initialCapital;

  // Reward: risk-adjusted return with drawdown penalty
  const reward = stepReturn - ctx.config.drawdownPenalty * Math.max(0, drawdown - 0.05);

  const done = ctx.currentBar >= ctx.candles.length - 1
    || ctx.currentBar - 220 >= ctx.config.maxBars
    || ctx.capital <= ctx.config.initialCapital * 0.5; // stop at 50% loss

  const nextState = getState(ctx);

  return {
    nextState: nextState ?? {
      features: new Array(FEATURE_NAMES.length).fill(0),
      portfolio: { positionSize: 0, unrealizedPnl: 0, holdingBars: 0, cashRatio: 1 },
      raw: null,
    },
    reward,
    done,
    info: {
      action,
      price: priceAfter,
      positionBefore,
      positionAfter: ctx.position,
      pnlStep,
      totalReturn: ctx.totalReturn,
      maxDrawdown: ctx.maxDrawdown,
    },
  };
}

export function computeEpisodeMetrics(ctx: EpisodeContext): {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
} {
  const returns = ctx.returns;
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)
    : 0;
  const std = Math.sqrt(variance);

  // Annualized Sharpe (assuming returns are per-bar)
  const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const wins = returns.filter(r => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;

  return {
    totalReturn: ctx.totalReturn,
    sharpeRatio,
    maxDrawdown: ctx.maxDrawdown,
    totalTrades: ctx.totalTrades,
    winRate,
  };
}
