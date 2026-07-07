import { describe, it, expect } from 'vitest';
import {
  createReplayBuffer,
  addExperience,
  addBatch,
  sample,
  updatePriorities,
  bufferStats,
  serializeBuffer,
  deserializeBuffer,
  DEFAULT_BUFFER_CONFIG,
  type Experience,
} from './replay-buffer.js';

function makeExp(reward: number, tdError = 0.5): Experience {
  return {
    state: [1, 2, 3],
    action: 0,
    reward,
    nextState: [4, 5, 6],
    done: false,
    tdError,
  };
}

function createRng(seed = 42) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

describe('createReplayBuffer', () => {
  it('creates empty buffer with defaults', () => {
    const rb = createReplayBuffer();
    expect(rb.size).toBe(0);
    expect(rb.config.maxSize).toBe(DEFAULT_BUFFER_CONFIG.maxSize);
    expect(rb.config.alpha).toBe(DEFAULT_BUFFER_CONFIG.alpha);
  });
});

describe('addExperience', () => {
  it('adds to buffer and increments size', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    addExperience(rb, makeExp(0.5));
    expect(rb.size).toBe(1);
    addExperience(rb, makeExp(0.3));
    expect(rb.size).toBe(2);
  });

  it('wraps around at max size', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 3 });
    addExperience(rb, makeExp(0.1, 0.1));
    addExperience(rb, makeExp(0.2, 0.2));
    addExperience(rb, makeExp(0.3, 0.3));
    expect(rb.size).toBe(3);

    addExperience(rb, makeExp(0.4, 0.4));
    expect(rb.size).toBe(3); // still 3, wrapped
    expect(rb.buffer[0]!.reward).toBe(0.4); // overwritten position 0
  });
});

describe('addBatch', () => {
  it('adds multiple experiences', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    addBatch(rb, [makeExp(0.1), makeExp(0.2), makeExp(0.3)]);
    expect(rb.size).toBe(3);
  });
});

describe('sample', () => {
  it('returns null for insufficient buffer', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    addExperience(rb, makeExp(0.1));
    expect(sample(rb, 5, createRng())).toBeNull();
  });

  it('returns correct batch size', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    for (let i = 0; i < 20; i++) addExperience(rb, makeExp(i * 0.1, i * 0.1 + 0.01));
    const batch = sample(rb, 5, createRng());
    expect(batch).not.toBeNull();
    expect(batch!.experiences).toHaveLength(5);
    expect(batch!.indices).toHaveLength(5);
    expect(batch!.weights).toHaveLength(5);
  });

  it('weights are between 0 and 1', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    for (let i = 0; i < 20; i++) addExperience(rb, makeExp(i * 0.1, (i + 1) * 0.05));
    const batch = sample(rb, 5, createRng());
    expect(batch).not.toBeNull();
    for (const w of batch!.weights) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1.001); // allow tiny float error
    }
  });

  it('anneals beta over time', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    for (let i = 0; i < 20; i++) addExperience(rb, makeExp(i * 0.1, (i + 1) * 0.05));
    const betaBefore = rb.config.beta;
    sample(rb, 5, createRng());
    expect(rb.config.beta).toBeGreaterThan(betaBefore);
  });
});

describe('updatePriorities', () => {
  it('updates priorities at specified indices', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    for (let i = 0; i < 5; i++) addExperience(rb, makeExp(i * 0.1, 0.1));
    const priBefore = [...rb.priorities];

    updatePriorities(rb, [0, 2], [1.0, 2.0]);
    expect(rb.priorities[0]).not.toBe(priBefore[0]);
    expect(rb.priorities[2]).not.toBe(priBefore[2]);
    expect(rb.priorities[1]).toBe(priBefore[1]); // unchanged
  });
});

describe('bufferStats', () => {
  it('returns correct stats', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 100 });
    for (let i = 0; i < 10; i++) addExperience(rb, makeExp(i * 0.1, (i + 1) * 0.1));
    const stats = bufferStats(rb);
    expect(stats.size).toBe(10);
    expect(stats.maxSize).toBe(100);
    expect(stats.utilization).toBeCloseTo(0.1, 5);
    expect(stats.avgPriority).toBeGreaterThan(0);
  });

  it('handles empty buffer', () => {
    const rb = createReplayBuffer();
    const stats = bufferStats(rb);
    expect(stats.size).toBe(0);
    expect(stats.avgPriority).toBe(0);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips buffer correctly', () => {
    const rb = createReplayBuffer({ ...DEFAULT_BUFFER_CONFIG, maxSize: 50 });
    for (let i = 0; i < 10; i++) addExperience(rb, makeExp(i * 0.1, (i + 1) * 0.05));

    const json = serializeBuffer(rb);
    const restored = deserializeBuffer(json);

    expect(restored.size).toBe(rb.size);
    expect(restored.config.maxSize).toBe(rb.config.maxSize);
    expect(restored.buffer).toHaveLength(rb.buffer.length);
    expect(restored.priorities).toHaveLength(rb.size);
  });
});
