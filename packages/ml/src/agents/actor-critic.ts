/**
 * PPO (Proximal Policy Optimization) Actor-Critic for trading.
 *
 * Pure TypeScript — no TensorFlow/PyTorch dependency.
 * Uses simple feedforward networks with softmax (actor) and linear (critic).
 * PPO clip ratio ensures stable policy updates on noisy financial data.
 * GAE (Generalized Advantage Estimation) reduces variance in advantage estimates.
 *
 * Architecture:
 *   Actor:  state → hidden → hidden → softmax(action_probs)
 *   Critic: state → hidden → hidden → value_estimate
 *
 * Both networks share no weights (separate for stability on financial data).
 */

import { NUM_ACTIONS, STATE_DIM } from './environment.js';

export type PPOHyperparams = {
  learningRate: number;
  gamma: number;           // discount factor
  lambda: number;          // GAE lambda
  clipRatio: number;       // PPO clip
  entropyCoeff: number;    // encourage exploration
  valueLossCoeff: number;  // critic loss weight
  epochs: number;          // PPO update epochs per batch
  batchSize: number;       // mini-batch size
  hiddenSize: number;      // neurons per hidden layer
};

export const DEFAULT_PPO_PARAMS: PPOHyperparams = {
  learningRate: 0.0003,
  gamma: 0.99,
  lambda: 0.95,
  clipRatio: 0.2,
  entropyCoeff: 0.01,
  valueLossCoeff: 0.5,
  epochs: 4,
  batchSize: 64,
  hiddenSize: 64,
};

export type NetworkWeights = {
  w1: number[][];   // input → hidden1
  b1: number[];
  w2: number[][];   // hidden1 → hidden2
  b2: number[];
  w3: number[][];   // hidden2 → output
  b3: number[];
};

export type ActorCriticModel = {
  actor: NetworkWeights;
  critic: NetworkWeights;
  params: PPOHyperparams;
  updateCount: number;
};

export type Trajectory = {
  states: number[][];
  actions: number[];
  rewards: number[];
  values: number[];
  logProbs: number[];
  dones: boolean[];
};

// Seeded PRNG (same as random-forest.ts for consistency)
function createRng(seed: number) {
  let s0 = seed | 0 || 1;
  let s1 = (seed * 1597334677) | 0 || 2;
  let s2 = (seed * 2654435761) | 0 || 3;
  let s3 = (seed * 668265263) | 0 || 4;

  return () => {
    const t = s1 << 9;
    let result = (s0 + s3) | 0;
    result = ((result << 7) | (result >>> 25)) * 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    return (result >>> 0) / 4294967296;
  };
}

function initWeights(inputDim: number, outputDim: number, rng: () => number): { w: number[][]; b: number[] } {
  // Xavier initialization: scale = sqrt(2 / (fan_in + fan_out))
  const scale = Math.sqrt(2 / (inputDim + outputDim));
  const w: number[][] = [];
  for (let i = 0; i < inputDim; i++) {
    const row: number[] = [];
    for (let j = 0; j < outputDim; j++) {
      row.push((rng() * 2 - 1) * scale);
    }
    w.push(row);
  }
  const b = new Array(outputDim).fill(0) as number[];
  return { w, b };
}

function initNetwork(inputDim: number, hiddenSize: number, outputDim: number, rng: () => number): NetworkWeights {
  const l1 = initWeights(inputDim, hiddenSize, rng);
  const l2 = initWeights(hiddenSize, hiddenSize, rng);
  const l3 = initWeights(hiddenSize, outputDim, rng);
  return { w1: l1.w, b1: l1.b, w2: l2.w, b2: l2.b, w3: l3.w, b3: l3.b };
}

export function createActorCritic(
  params: PPOHyperparams = DEFAULT_PPO_PARAMS,
  seed = 42,
): ActorCriticModel {
  const rng = createRng(seed);
  return {
    actor: initNetwork(STATE_DIM, params.hiddenSize, NUM_ACTIONS, rng),
    critic: initNetwork(STATE_DIM, params.hiddenSize, 1, rng),
    params,
    updateCount: 0,
  };
}

// Forward pass helpers
function relu(x: number): number {
  return x > 0 ? x : 0;
}

function matmulBias(input: number[], w: number[][], b: number[]): number[] {
  const out = new Array(b.length) as number[];
  for (let j = 0; j < b.length; j++) {
    let sum = b[j]!;
    for (let i = 0; i < input.length; i++) {
      sum += input[i]! * w[i]![j]!;
    }
    out[j] = sum;
  }
  return out;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function forwardNetwork(net: NetworkWeights, input: number[], applySoftmax: boolean): number[] {
  const h1 = matmulBias(input, net.w1, net.b1).map(relu);
  const h2 = matmulBias(h1, net.w2, net.b2).map(relu);
  const out = matmulBias(h2, net.w3, net.b3);
  return applySoftmax ? softmax(out) : out;
}

export function getActionProbs(model: ActorCriticModel, state: number[]): number[] {
  return forwardNetwork(model.actor, state, true);
}

export function getValue(model: ActorCriticModel, state: number[]): number {
  const out = forwardNetwork(model.critic, state, false);
  return out[0]!;
}

export function sampleAction(probs: number[], rng: () => number): number {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i]!;
    if (r <= cumulative) return i;
  }
  return probs.length - 1;
}

export function logProb(probs: number[], action: number): number {
  const p = Math.max(probs[action]!, 1e-8);
  return Math.log(p);
}

/**
 * Compute GAE (Generalized Advantage Estimation).
 * Reduces variance while controlling bias via lambda.
 */
export function computeGAE(
  rewards: number[],
  values: number[],
  dones: boolean[],
  gamma: number,
  lambda: number,
): { advantages: number[]; returns: number[] } {
  const n = rewards.length;
  const advantages = new Array(n).fill(0) as number[];
  const returns = new Array(n).fill(0) as number[];

  let lastGaeLam = 0;
  for (let t = n - 1; t >= 0; t--) {
    const nextValue = t + 1 < n && !dones[t]! ? values[t + 1]! : 0;
    const delta = rewards[t]! + gamma * nextValue - values[t]!;
    const mask = dones[t]! ? 0 : 1;
    lastGaeLam = delta + gamma * lambda * mask * lastGaeLam;
    advantages[t] = lastGaeLam;
    returns[t] = advantages[t]! + values[t]!;
  }

  return { advantages, returns };
}

// Numerical gradient for a scalar loss w.r.t. a single weight
function numericalGrad(
  fn: () => number,
  weights: number[][],
  i: number,
  j: number,
  eps = 1e-4,
): number {
  const original = weights[i]![j]!;
  weights[i]![j] = original + eps;
  const fPlus = fn();
  weights[i]![j] = original - eps;
  const fMinus = fn();
  weights[i]![j] = original;
  return (fPlus - fMinus) / (2 * eps);
}

function numericalGradBias(
  fn: () => number,
  bias: number[],
  j: number,
  eps = 1e-4,
): number {
  const original = bias[j]!;
  bias[j] = original + eps;
  const fPlus = fn();
  bias[j] = original - eps;
  const fMinus = fn();
  bias[j] = original;
  return (fPlus - fMinus) / (2 * eps);
}

/**
 * PPO update step.
 *
 * Uses numerical differentiation (finite differences) for gradients.
 * This is intentional: pure TS, no autograd library, works for our
 * network sizes (29→64→64→7 actor, 29→64→64→1 critic).
 * Performance is acceptable for the update frequencies we need
 * (a few updates per episode, not millions of gradient steps).
 */
export function ppoUpdate(
  model: ActorCriticModel,
  trajectory: Trajectory,
): { policyLoss: number; valueLoss: number; entropy: number } {
  const { params } = model;
  const { states, actions, logProbs: oldLogProbs } = trajectory;

  const { advantages, returns } = computeGAE(
    trajectory.rewards,
    trajectory.values,
    trajectory.dones,
    params.gamma,
    params.lambda,
  );

  // Normalize advantages
  const advMean = advantages.reduce((a, b) => a + b, 0) / advantages.length;
  const advStd = Math.sqrt(
    advantages.reduce((sum, a) => sum + (a - advMean) ** 2, 0) / advantages.length,
  ) || 1;
  const normAdvantages = advantages.map(a => (a - advMean) / advStd);

  let totalPolicyLoss = 0;
  let totalValueLoss = 0;
  let totalEntropy = 0;

  for (let epoch = 0; epoch < params.epochs; epoch++) {
    for (let i = 0; i < states.length; i++) {
      const state = states[i]!;
      const action = actions[i]!;
      const oldLogP = oldLogProbs[i]!;
      const advantage = normAdvantages[i]!;
      const ret = returns[i]!;

      // Current policy
      const probs = getActionProbs(model, state);
      const newLogP = logProb(probs, action);
      const ratio = Math.exp(newLogP - oldLogP);

      // PPO clipped objective
      const surr1 = ratio * advantage;
      const surr2 = Math.max(Math.min(ratio, 1 + params.clipRatio), 1 - params.clipRatio) * advantage;
      const policyLoss = -Math.min(surr1, surr2);

      // Value loss
      const value = getValue(model, state);
      const valueLoss = (value - ret) ** 2;

      // Entropy bonus (encourage exploration)
      const entropy = -probs.reduce((sum, p) => sum + (p > 1e-8 ? p * Math.log(p) : 0), 0);

      totalPolicyLoss += policyLoss;
      totalValueLoss += valueLoss;
      totalEntropy += entropy;

      // Apply gradients via finite differences to actor
      updateNetworkWeights(model.actor, state, () => {
        const p = getActionProbs(model, state);
        const lp = logProb(p, action);
        const r = Math.exp(lp - oldLogP);
        const s1 = r * advantage;
        const s2 = Math.max(Math.min(r, 1 + params.clipRatio), 1 - params.clipRatio) * advantage;
        const ent = -p.reduce((sum, pp) => sum + (pp > 1e-8 ? pp * Math.log(pp) : 0), 0);
        return -Math.min(s1, s2) - params.entropyCoeff * ent;
      }, params.learningRate);

      // Apply gradients to critic
      updateNetworkWeights(model.critic, state, () => {
        const v = getValue(model, state);
        return (v - ret) ** 2;
      }, params.learningRate * params.valueLossCoeff);
    }
  }

  const n = states.length * params.epochs;
  model.updateCount++;

  return {
    policyLoss: totalPolicyLoss / n,
    valueLoss: totalValueLoss / n,
    entropy: totalEntropy / n,
  };
}

function updateNetworkWeights(
  net: NetworkWeights,
  _state: number[],
  lossFn: () => number,
  lr: number,
): void {
  const eps = 1e-4;

  // Update each layer's weights and biases
  const layers: { w: number[][]; b: number[] }[] = [
    { w: net.w1, b: net.b1 },
    { w: net.w2, b: net.b2 },
    { w: net.w3, b: net.b3 },
  ];

  for (const layer of layers) {
    // Stochastic subset: update ~10% of weights per step for efficiency
    for (let i = 0; i < layer.w.length; i++) {
      for (let j = 0; j < layer.w[i]!.length; j++) {
        if (((i * 7 + j * 13) % 10) !== 0) continue; // sparse update
        const grad = numericalGrad(lossFn, layer.w, i, j, eps);
        layer.w[i]![j]! -= lr * grad;
      }
    }
    for (let j = 0; j < layer.b.length; j++) {
      const grad = numericalGradBias(lossFn, layer.b, j, eps);
      layer.b[j]! -= lr * grad;
    }
  }
}

export function serializeActorCritic(model: ActorCriticModel): string {
  return JSON.stringify({
    actor: model.actor,
    critic: model.critic,
    params: model.params,
    updateCount: model.updateCount,
  });
}

export function deserializeActorCritic(json: string): ActorCriticModel {
  return JSON.parse(json) as ActorCriticModel;
}

export function createTrajectory(): Trajectory {
  return {
    states: [],
    actions: [],
    rewards: [],
    values: [],
    logProbs: [],
    dones: [],
  };
}

export function addToTrajectory(
  traj: Trajectory,
  state: number[],
  action: number,
  reward: number,
  value: number,
  logP: number,
  done: boolean,
): void {
  traj.states.push(state);
  traj.actions.push(action);
  traj.rewards.push(reward);
  traj.values.push(value);
  traj.logProbs.push(logP);
  traj.dones.push(done);
}
