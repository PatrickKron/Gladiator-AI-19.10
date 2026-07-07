import { describe, it, expect } from 'vitest';
import {
  trainForest,
  predictForest,
  evaluateForest,
  serializeForest,
  deserializeForest,
  DEFAULT_HYPERPARAMS,
  type TrainingSample,
} from './random-forest.js';

function makeLinearData(n: number, seed = 42): TrainingSample[] {
  // Simple separable: label = 1 if feature[0] + feature[1] > 1, else 0
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const data: TrainingSample[] = [];
  for (let i = 0; i < n; i++) {
    const f0 = rng();
    const f1 = rng();
    const noise = (rng() - 0.5) * 0.1;
    const label: 0 | 1 = f0 + f1 + noise > 1 ? 1 : 0;
    data.push({ features: [f0, f1], label });
  }
  return data;
}

function makeXorData(n: number, seed = 42): TrainingSample[] {
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const data: TrainingSample[] = [];
  for (let i = 0; i < n; i++) {
    const f0 = rng();
    const f1 = rng();
    const label: 0 | 1 = (f0 > 0.5) !== (f1 > 0.5) ? 1 : 0;
    data.push({ features: [f0, f1], label });
  }
  return data;
}

describe('trainForest', () => {
  it('trains on empty data without crashing', () => {
    const model = trainForest([]);
    expect(model.trees.length).toBe(0);
    expect(model.oobScore).toBeNull();
  });

  it('trains on linearly separable data', () => {
    const data = makeLinearData(200);
    const model = trainForest(data, { ...DEFAULT_HYPERPARAMS, nTrees: 20 });
    expect(model.trees.length).toBe(20);
    expect(model.featureCount).toBe(2);
    expect(model.oobScore).not.toBeNull();
    expect(model.oobScore!).toBeGreaterThan(0.7);
  });

  it('produces feature importance that sums to ~1', () => {
    const data = makeLinearData(200);
    const model = trainForest(data, { ...DEFAULT_HYPERPARAMS, nTrees: 20 });
    const sum = model.featureImportance.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 1);
  });
});

describe('predictForest', () => {
  it('returns 0.5 for empty model', () => {
    const model = trainForest([]);
    expect(predictForest(model, [0.5, 0.5])).toBe(0.5);
  });

  it('predicts high probability for clearly positive samples', () => {
    const data = makeLinearData(300);
    const model = trainForest(data, { ...DEFAULT_HYPERPARAMS, nTrees: 30 });
    // f0=0.9, f1=0.9 → sum=1.8 >> 1 → should predict label=1 with high prob
    const prob = predictForest(model, [0.9, 0.9]);
    expect(prob).toBeGreaterThan(0.7);
  });

  it('predicts low probability for clearly negative samples', () => {
    const data = makeLinearData(300);
    const model = trainForest(data, { ...DEFAULT_HYPERPARAMS, nTrees: 30 });
    // f0=0.1, f1=0.1 → sum=0.2 << 1 → should predict label=0
    const prob = predictForest(model, [0.1, 0.1]);
    expect(prob).toBeLessThan(0.3);
  });
});

describe('evaluateForest', () => {
  it('evaluates on test set with reasonable accuracy', () => {
    const train = makeLinearData(300, 1);
    const test = makeLinearData(100, 2);
    const model = trainForest(train, { ...DEFAULT_HYPERPARAMS, nTrees: 30 });
    const metrics = evaluateForest(model, test);

    expect(metrics.accuracy).toBeGreaterThan(0.7);
    expect(metrics.precision).toBeGreaterThan(0);
    expect(metrics.recall).toBeGreaterThan(0);
    expect(metrics.f1).toBeGreaterThan(0);
    expect(metrics.auc).toBeGreaterThan(0.5);
  });

  it('handles XOR pattern (non-linear)', () => {
    const train = makeXorData(400, 1);
    const test = makeXorData(100, 2);
    const model = trainForest(train, { ...DEFAULT_HYPERPARAMS, nTrees: 50, maxDepth: 8 });
    const metrics = evaluateForest(model, test);
    // RF should handle XOR better than a linear classifier
    expect(metrics.accuracy).toBeGreaterThan(0.6);
  });

  it('returns zero metrics for empty test set', () => {
    const model = trainForest(makeLinearData(100));
    const metrics = evaluateForest(model, []);
    expect(metrics.accuracy).toBe(0);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips model correctly', () => {
    const data = makeLinearData(200);
    const model = trainForest(data, { ...DEFAULT_HYPERPARAMS, nTrees: 10 });

    const json = serializeForest(model);
    const restored = deserializeForest(json);

    expect(restored.trees.length).toBe(model.trees.length);
    expect(restored.featureCount).toBe(model.featureCount);
    expect(restored.oobScore).toBeCloseTo(model.oobScore!, 5);

    // Predictions should match
    const testPoint = [0.8, 0.8];
    expect(predictForest(restored, testPoint)).toBeCloseTo(predictForest(model, testPoint), 10);
  });
});
