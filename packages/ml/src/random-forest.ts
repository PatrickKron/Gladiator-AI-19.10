/**
 * Pure TypeScript Random Forest for binary classification.
 *
 * Chosen per López de Prado's recommendation for financial meta-labeling:
 * - Variance reduction via bagging (critical for noisy financial data)
 * - Robust to outliers and non-linear relationships
 * - Built-in feature importance via Mean Decrease Impurity (MDI)
 * - NOT gradient boosting (overfitting risk on financial series)
 * - NOT neural nets (only justified for unstructured data)
 *
 * Implementation uses bootstrap aggregating with random feature subsets
 * at each split (sqrt(nFeatures) candidates per split node).
 */

export type TrainingSample = {
  features: number[];
  label: 0 | 1;
};

export type TreeNode = {
  featureIndex: number;
  threshold: number;
  left: TreeNode | TreeLeaf;
  right: TreeNode | TreeLeaf;
};

export type TreeLeaf = {
  probability: number;
  count: number;
};

export function isLeaf(node: TreeNode | TreeLeaf): node is TreeLeaf {
  return 'probability' in node;
}

export type ForestHyperparams = {
  nTrees: number;
  maxDepth: number;
  minSamplesLeaf: number;
  maxFeaturesRatio: number;
  bootstrapRatio: number;
};

export const DEFAULT_HYPERPARAMS: ForestHyperparams = {
  nTrees: 100,
  maxDepth: 10,
  minSamplesLeaf: 5,
  maxFeaturesRatio: 0.5, // sqrt(25) / 25 ≈ 0.2, but 0.5 is more robust for small feature sets
  bootstrapRatio: 0.8,
};

export type ForestModel = {
  trees: (TreeNode | TreeLeaf)[];
  featureCount: number;
  hyperparams: ForestHyperparams;
  oobScore: number | null;
  featureImportance: number[];
};

export type ForestMetrics = {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number;
};

// Seeded PRNG for reproducibility (xoshiro128** variant)
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

function gini(labels: (0 | 1)[]): number {
  if (labels.length === 0) return 0;
  const p1 = labels.filter(l => l === 1).length / labels.length;
  return 1 - p1 * p1 - (1 - p1) * (1 - p1);
}

function bootstrapSample(data: TrainingSample[], ratio: number, rng: () => number): { inBag: TrainingSample[]; oob: TrainingSample[] } {
  const n = Math.floor(data.length * ratio);
  const chosen = new Set<number>();
  const inBag: TrainingSample[] = [];

  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * data.length);
    chosen.add(idx);
    inBag.push(data[idx]!);
  }

  const oob = data.filter((_, i) => !chosen.has(i));
  return { inBag, oob };
}

function selectFeatureSubset(nFeatures: number, ratio: number, rng: () => number): number[] {
  const count = Math.max(1, Math.floor(nFeatures * ratio));
  const indices: number[] = [];
  const available = Array.from({ length: nFeatures }, (_, i) => i);

  for (let i = 0; i < count && available.length > 0; i++) {
    const idx = Math.floor(rng() * available.length);
    indices.push(available[idx]!);
    available.splice(idx, 1);
  }

  return indices;
}

function findBestSplit(
  data: TrainingSample[],
  featureIndices: number[],
): { featureIndex: number; threshold: number; gain: number } | null {
  const labels = data.map(d => d.label);
  const parentGini = gini(labels);
  const n = data.length;

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;

  for (const fi of featureIndices) {
    const values = data.map(d => d.features[fi]!).sort((a, b) => a - b);
    const unique = [...new Set(values)];

    for (let i = 0; i < unique.length - 1; i++) {
      const threshold = (unique[i]! + unique[i + 1]!) / 2;
      const leftLabels: (0 | 1)[] = [];
      const rightLabels: (0 | 1)[] = [];

      for (const d of data) {
        if (d.features[fi]! <= threshold) leftLabels.push(d.label);
        else rightLabels.push(d.label);
      }

      if (leftLabels.length === 0 || rightLabels.length === 0) continue;

      const leftGini = gini(leftLabels);
      const rightGini = gini(rightLabels);
      const weightedGini = (leftLabels.length / n) * leftGini + (rightLabels.length / n) * rightGini;
      const gain = parentGini - weightedGini;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = fi;
        bestThreshold = threshold;
      }
    }
  }

  if (bestFeature === -1) return null;
  return { featureIndex: bestFeature, threshold: bestThreshold, gain: bestGain };
}

function buildTree(
  data: TrainingSample[],
  depth: number,
  params: ForestHyperparams,
  nFeatures: number,
  rng: () => number,
  importanceAcc: number[],
): TreeNode | TreeLeaf {
  const positives = data.filter(d => d.label === 1).length;
  const probability = data.length > 0 ? positives / data.length : 0.5;

  // Leaf conditions
  if (depth >= params.maxDepth || data.length <= params.minSamplesLeaf) {
    return { probability, count: data.length };
  }
  if (positives === 0 || positives === data.length) {
    return { probability, count: data.length };
  }

  const featureSubset = selectFeatureSubset(nFeatures, params.maxFeaturesRatio, rng);
  const split = findBestSplit(data, featureSubset);

  if (!split || split.gain <= 0) {
    return { probability, count: data.length };
  }

  // Accumulate feature importance (MDI)
  importanceAcc[split.featureIndex] = (importanceAcc[split.featureIndex] ?? 0) + split.gain * data.length;

  const left = data.filter(d => d.features[split.featureIndex]! <= split.threshold);
  const right = data.filter(d => d.features[split.featureIndex]! > split.threshold);

  return {
    featureIndex: split.featureIndex,
    threshold: split.threshold,
    left: buildTree(left, depth + 1, params, nFeatures, rng, importanceAcc),
    right: buildTree(right, depth + 1, params, nFeatures, rng, importanceAcc),
  };
}

function predictTree(node: TreeNode | TreeLeaf, features: number[]): number {
  if (isLeaf(node)) return node.probability;
  if (features[node.featureIndex]! <= node.threshold) {
    return predictTree(node.left, features);
  }
  return predictTree(node.right, features);
}

/**
 * Train a Random Forest meta-classifier.
 *
 * @param data - Training samples with feature vectors and binary labels
 * @param params - Hyperparameters (defaults are tuned for financial meta-labeling)
 * @param seed - Random seed for reproducibility
 * @returns Trained forest model with OOB score and feature importance
 */
export function trainForest(
  data: TrainingSample[],
  params: ForestHyperparams = DEFAULT_HYPERPARAMS,
  seed = 42,
): ForestModel {
  if (data.length === 0) {
    return {
      trees: [],
      featureCount: 0,
      hyperparams: params,
      oobScore: null,
      featureImportance: [],
    };
  }

  const featureCount = data[0]!.features.length;
  const rng = createRng(seed);
  const trees: (TreeNode | TreeLeaf)[] = [];
  const importanceAcc = new Array(featureCount).fill(0) as number[];

  // OOB tracking: for each sample, collect predictions from trees where it was OOB
  const oobPredictions: number[][] = data.map(() => []);

  for (let t = 0; t < params.nTrees; t++) {
    const { inBag, oob } = bootstrapSample(data, params.bootstrapRatio, rng);
    const tree = buildTree(inBag, 0, params, featureCount, rng, importanceAcc);
    trees.push(tree);

    // Collect OOB predictions
    for (const sample of oob) {
      const idx = data.indexOf(sample);
      if (idx >= 0) {
        oobPredictions[idx]!.push(predictTree(tree, sample.features));
      }
    }
  }

  // OOB score: accuracy of averaged OOB predictions
  let oobCorrect = 0;
  let oobTotal = 0;
  for (let i = 0; i < data.length; i++) {
    const preds = oobPredictions[i]!;
    if (preds.length === 0) continue;
    const avgPred = preds.reduce((a, b) => a + b, 0) / preds.length;
    const predicted = avgPred >= 0.5 ? 1 : 0;
    if (predicted === data[i]!.label) oobCorrect++;
    oobTotal++;
  }

  // Normalize feature importance
  const totalImportance = importanceAcc.reduce((a, b) => a + b, 0);
  const featureImportance = totalImportance > 0
    ? importanceAcc.map(v => v / totalImportance)
    : importanceAcc;

  return {
    trees,
    featureCount,
    hyperparams: params,
    oobScore: oobTotal > 0 ? oobCorrect / oobTotal : null,
    featureImportance,
  };
}

/**
 * Predict probability of success for a feature vector.
 * Returns the average probability across all trees (bagging).
 */
export function predictForest(model: ForestModel, features: number[]): number {
  if (model.trees.length === 0) return 0.5;
  const predictions = model.trees.map(tree => predictTree(tree, features));
  return predictions.reduce((a, b) => a + b, 0) / predictions.length;
}

/**
 * Compute classification metrics on a test set.
 */
export function evaluateForest(model: ForestModel, testData: TrainingSample[]): ForestMetrics {
  if (testData.length === 0) {
    return { accuracy: 0, precision: 0, recall: 0, f1: 0, auc: 0 };
  }

  let tp = 0, fp = 0, tn = 0, fn = 0;
  const scored: { prob: number; label: 0 | 1 }[] = [];

  for (const sample of testData) {
    const prob = predictForest(model, sample.features);
    const predicted = prob >= 0.5 ? 1 : 0;
    scored.push({ prob, label: sample.label });

    if (predicted === 1 && sample.label === 1) tp++;
    else if (predicted === 1 && sample.label === 0) fp++;
    else if (predicted === 0 && sample.label === 0) tn++;
    else fn++;
  }

  const accuracy = (tp + tn) / testData.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // AUC via trapezoidal approximation of ROC curve
  const auc = computeAuc(scored);

  return { accuracy, precision, recall, f1, auc };
}

function computeAuc(scored: { prob: number; label: 0 | 1 }[]): number {
  const sorted = [...scored].sort((a, b) => b.prob - a.prob);
  const totalPos = sorted.filter(s => s.label === 1).length;
  const totalNeg = sorted.length - totalPos;
  if (totalPos === 0 || totalNeg === 0) return 0.5;

  let tpCount = 0;
  let fpCount = 0;
  let auc = 0;
  let prevFpr = 0;
  let prevTpr = 0;

  for (const s of sorted) {
    if (s.label === 1) tpCount++;
    else fpCount++;
    const tpr = tpCount / totalPos;
    const fpr = fpCount / totalNeg;
    auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }

  return auc;
}

/**
 * Serialize a forest model to a JSON-safe object (for DB storage).
 */
export function serializeForest(model: ForestModel): string {
  return JSON.stringify({
    trees: model.trees,
    featureCount: model.featureCount,
    hyperparams: model.hyperparams,
    oobScore: model.oobScore,
    featureImportance: model.featureImportance,
  });
}

/**
 * Deserialize a forest model from a JSON string.
 */
export function deserializeForest(json: string): ForestModel {
  const parsed = JSON.parse(json) as ForestModel;
  return parsed;
}
