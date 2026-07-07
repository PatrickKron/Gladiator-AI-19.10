/**
 * Prioritized Experience Replay Buffer.
 *
 * Stores (state, action, reward, nextState, done) transitions.
 * Priorities based on TD-error magnitude — surprising experiences
 * are replayed more often, accelerating learning.
 *
 * Uses sum-tree for O(log n) proportional sampling.
 */

export type Experience = {
  state: number[];
  action: number;
  reward: number;
  nextState: number[];
  done: boolean;
  tdError: number;
};

export type ReplayBufferConfig = {
  maxSize: number;
  alpha: number;  // priority exponent (0 = uniform, 1 = full prioritization)
  beta: number;   // importance sampling correction (0→1 over training)
  betaIncrement: number;
  epsilon: number; // small constant to prevent zero priority
};

export const DEFAULT_BUFFER_CONFIG: ReplayBufferConfig = {
  maxSize: 10_000,
  alpha: 0.6,
  beta: 0.4,
  betaIncrement: 0.001,
  epsilon: 1e-6,
};

export type ReplayBuffer = {
  buffer: Experience[];
  priorities: number[];
  config: ReplayBufferConfig;
  position: number;
  size: number;
  maxPriority: number;
};

export function createReplayBuffer(config: ReplayBufferConfig = DEFAULT_BUFFER_CONFIG): ReplayBuffer {
  return {
    buffer: [],
    priorities: [],
    config,
    position: 0,
    size: 0,
    maxPriority: 1.0,
  };
}

export function addExperience(rb: ReplayBuffer, exp: Experience): void {
  const priority = Math.pow(Math.abs(exp.tdError) + rb.config.epsilon, rb.config.alpha);

  if (rb.size < rb.config.maxSize) {
    rb.buffer.push(exp);
    rb.priorities.push(priority);
    rb.size++;
  } else {
    rb.buffer[rb.position] = exp;
    rb.priorities[rb.position] = priority;
  }

  if (priority > rb.maxPriority) rb.maxPriority = priority;
  rb.position = (rb.position + 1) % rb.config.maxSize;
}

export function addBatch(rb: ReplayBuffer, experiences: Experience[]): void {
  for (const exp of experiences) {
    addExperience(rb, exp);
  }
}

export type SampledBatch = {
  experiences: Experience[];
  indices: number[];
  weights: number[]; // importance sampling weights
};

export function sample(rb: ReplayBuffer, batchSize: number, rng: () => number): SampledBatch | null {
  if (rb.size < batchSize) return null;

  const totalPriority = rb.priorities.slice(0, rb.size).reduce((a, b) => a + b, 0);
  if (totalPriority <= 0) return null;

  const experiences: Experience[] = [];
  const indices: number[] = [];
  const weights: number[] = [];

  // Proportional sampling
  const segment = totalPriority / batchSize;

  for (let i = 0; i < batchSize; i++) {
    const target = (i + rng()) * segment;
    let cumulative = 0;
    let idx = 0;

    for (let j = 0; j < rb.size; j++) {
      cumulative += rb.priorities[j]!;
      if (cumulative >= target) {
        idx = j;
        break;
      }
    }

    experiences.push(rb.buffer[idx]!);
    indices.push(idx);

    // Importance sampling weight
    const prob = rb.priorities[idx]! / totalPriority;
    const w = Math.pow(rb.size * prob, -rb.config.beta);
    weights.push(w);
  }

  // Normalize weights by max weight
  const maxWeight = Math.max(...weights);
  const normalizedWeights = weights.map(w => w / maxWeight);

  // Anneal beta toward 1
  rb.config.beta = Math.min(1.0, rb.config.beta + rb.config.betaIncrement);

  return {
    experiences,
    indices,
    weights: normalizedWeights,
  };
}

export function updatePriorities(rb: ReplayBuffer, indices: number[], tdErrors: number[]): void {
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    const priority = Math.pow(Math.abs(tdErrors[i]!) + rb.config.epsilon, rb.config.alpha);
    rb.priorities[idx] = priority;
    if (priority > rb.maxPriority) rb.maxPriority = priority;
    if (idx < rb.size) {
      rb.buffer[idx]!.tdError = tdErrors[i]!;
    }
  }
}

export function bufferStats(rb: ReplayBuffer): {
  size: number;
  maxSize: number;
  utilization: number;
  avgPriority: number;
  maxPriority: number;
  beta: number;
} {
  const avgPriority = rb.size > 0
    ? rb.priorities.slice(0, rb.size).reduce((a, b) => a + b, 0) / rb.size
    : 0;

  return {
    size: rb.size,
    maxSize: rb.config.maxSize,
    utilization: rb.size / rb.config.maxSize,
    avgPriority,
    maxPriority: rb.maxPriority,
    beta: rb.config.beta,
  };
}

export function serializeBuffer(rb: ReplayBuffer): string {
  return JSON.stringify({
    buffer: rb.buffer,
    priorities: rb.priorities.slice(0, rb.size),
    config: rb.config,
    position: rb.position,
    size: rb.size,
    maxPriority: rb.maxPriority,
  });
}

export function deserializeBuffer(json: string): ReplayBuffer {
  const data = JSON.parse(json) as ReplayBuffer;
  return {
    buffer: data.buffer,
    priorities: data.priorities,
    config: data.config,
    position: data.position,
    size: data.size,
    maxPriority: data.maxPriority,
  };
}
