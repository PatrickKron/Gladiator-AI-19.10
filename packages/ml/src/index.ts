export {
  computeFeatures,
  featureVectorToArray,
  arrayToFeatureVector,
  FEATURE_NAMES,
  type FeatureVector,
} from './features.js';

export {
  labelSignal,
  batchLabel,
  type LabelInput,
  type Label,
} from './meta-label.js';

export {
  trainForest,
  predictForest,
  evaluateForest,
  serializeForest,
  deserializeForest,
  isLeaf,
  DEFAULT_HYPERPARAMS,
  type ForestModel,
  type ForestMetrics,
  type ForestHyperparams,
  type TrainingSample,
  type TreeNode,
  type TreeLeaf,
} from './random-forest.js';

export {
  normalCdf,
  zScore,
  computeBetSize,
  type BetSizeResult,
} from './bet-sizing.js';

export {
  runTruthCore,
  type TruthCoreInput,
  type TruthCoreCheck,
  type TruthCoreResult,
} from './truth-core.js';

// RL Agent Architecture (Phase 2)
export * from './agents/index.js';
