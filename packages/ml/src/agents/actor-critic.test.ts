import { describe, it, expect } from 'vitest';
import {
  createActorCritic,
  getActionProbs,
  getValue,
  sampleAction,
  logProb,
  computeGAE,
  serializeActorCritic,
  deserializeActorCritic,
  createTrajectory,
  addToTrajectory,
  DEFAULT_PPO_PARAMS,
} from './actor-critic.js';
import { NUM_ACTIONS, STATE_DIM } from './environment.js';

function makeState(): number[] {
  return new Array(STATE_DIM).fill(0).map((_, i) => Math.sin(i) * 0.5);
}

function createRng(seed = 42) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

describe('createActorCritic', () => {
  it('initializes with correct dimensions', () => {
    const model = createActorCritic();
    expect(model.actor.w1).toHaveLength(STATE_DIM);
    expect(model.actor.w1[0]).toHaveLength(DEFAULT_PPO_PARAMS.hiddenSize);
    expect(model.actor.w3[0]).toHaveLength(NUM_ACTIONS);
    expect(model.critic.w3[0]).toHaveLength(1);
    expect(model.updateCount).toBe(0);
  });
});

describe('getActionProbs', () => {
  it('returns valid probability distribution', () => {
    const model = createActorCritic();
    const state = makeState();
    const probs = getActionProbs(model, state);

    expect(probs).toHaveLength(NUM_ACTIONS);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(probs.every(p => p >= 0 && p <= 1)).toBe(true);
  });

  it('gives different probs for different states', () => {
    const model = createActorCritic();
    const s1 = new Array(STATE_DIM).fill(0.5);
    const s2 = new Array(STATE_DIM).fill(-0.5);
    const p1 = getActionProbs(model, s1);
    const p2 = getActionProbs(model, s2);
    // At least one probability should differ
    const differs = p1.some((p, i) => Math.abs(p - p2[i]!) > 0.001);
    expect(differs).toBe(true);
  });
});

describe('getValue', () => {
  it('returns a finite number', () => {
    const model = createActorCritic();
    const value = getValue(model, makeState());
    expect(typeof value).toBe('number');
    expect(isFinite(value)).toBe(true);
  });
});

describe('sampleAction', () => {
  it('returns valid action index', () => {
    const rng = createRng();
    const probs = [0.1, 0.2, 0.3, 0.1, 0.1, 0.1, 0.1];
    for (let i = 0; i < 50; i++) {
      const action = sampleAction(probs, rng);
      expect(action).toBeGreaterThanOrEqual(0);
      expect(action).toBeLessThan(NUM_ACTIONS);
    }
  });

  it('samples proportionally', () => {
    const rng = createRng(123);
    const probs = [0, 0, 1, 0, 0, 0, 0]; // always action 2
    for (let i = 0; i < 10; i++) {
      expect(sampleAction(probs, rng)).toBe(2);
    }
  });
});

describe('logProb', () => {
  it('returns negative value for valid probabilities', () => {
    const probs = [0.2, 0.3, 0.5, 0, 0, 0, 0];
    expect(logProb(probs, 0)).toBeLessThan(0);
    expect(logProb(probs, 2)).toBeCloseTo(Math.log(0.5), 5);
  });

  it('handles near-zero probabilities', () => {
    const probs = [0, 0, 0, 0, 0, 0, 1];
    const lp = logProb(probs, 0);
    expect(isFinite(lp)).toBe(true);
    expect(lp).toBeLessThan(-10);
  });
});

describe('computeGAE', () => {
  it('computes advantages for simple sequence', () => {
    const rewards = [1, 0, 1, 0, 0];
    const values = [0.5, 0.4, 0.6, 0.3, 0.2];
    const dones = [false, false, false, false, true];

    const { advantages, returns } = computeGAE(rewards, values, dones, 0.99, 0.95);
    expect(advantages).toHaveLength(5);
    expect(returns).toHaveLength(5);

    // Last step with done=true: advantage = reward - value
    expect(advantages[4]).toBeCloseTo(0 - 0.2, 5);

    // All values should be finite
    expect(advantages.every(a => isFinite(a))).toBe(true);
    expect(returns.every(r => isFinite(r))).toBe(true);
  });

  it('returns are advantages + values', () => {
    const rewards = [0.1, 0.2, -0.1];
    const values = [0.5, 0.6, 0.4];
    const dones = [false, false, true];

    const { advantages, returns } = computeGAE(rewards, values, dones, 0.99, 0.95);
    for (let i = 0; i < 3; i++) {
      expect(returns[i]).toBeCloseTo(advantages[i]! + values[i]!, 5);
    }
  });
});

describe('serialize / deserialize', () => {
  it('round-trips model correctly', () => {
    const model = createActorCritic();
    const state = makeState();
    const probsBefore = getActionProbs(model, state);
    const valueBefore = getValue(model, state);

    const json = serializeActorCritic(model);
    const restored = deserializeActorCritic(json);

    const probsAfter = getActionProbs(restored, state);
    const valueAfter = getValue(restored, state);

    for (let i = 0; i < NUM_ACTIONS; i++) {
      expect(probsAfter[i]).toBeCloseTo(probsBefore[i]!, 10);
    }
    expect(valueAfter).toBeCloseTo(valueBefore, 10);
  });
});

describe('trajectory', () => {
  it('accumulates steps', () => {
    const traj = createTrajectory();
    const state = makeState();

    addToTrajectory(traj, state, 0, 0.1, 0.5, -1.5, false);
    addToTrajectory(traj, state, 2, 0.2, 0.6, -1.2, false);
    addToTrajectory(traj, state, 1, -0.1, 0.4, -1.8, true);

    expect(traj.states).toHaveLength(3);
    expect(traj.actions).toEqual([0, 2, 1]);
    expect(traj.rewards).toEqual([0.1, 0.2, -0.1]);
    expect(traj.dones).toEqual([false, false, true]);
  });
});
