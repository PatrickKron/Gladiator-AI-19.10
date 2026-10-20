export { runBacktest, DEFAULT_COSTS, ZERO_COSTS, type BacktestConfig, type BacktestResult, type BacktestTrade, type CostModel, type Evaluator } from './engine.js';
export { computeMetrics, maxDrawdownPct, type Metrics } from './metrics.js';
export { runWalkForward, type WalkForwardConfig, type WalkForwardResult, type WalkForwardWindow } from './walkforward.js';
export { rapsGrid, explainRapsChoice, LEVERAGE_CANDIDATES, TP_SCHEMA_IDS, type RapsResult, type RapsCell, type RapsTrade, type TpSchemaId } from './raps.js';
export {
  runLabBacktest,
  runLabWalkForward,
  loadLabMarketData,
  BARS_PER_YEAR,
  WF_WARMUP_BARS,
  type LabRunInput,
  type LabRunOutput,
  type LabWalkForwardInput,
  type LabWalkForwardOutput,
  type LabMarketData,
} from './lab.js';
export {
  assessDataQuality,
  assertDataQuality,
  fundingSettlements,
  MAX_GAP_RATIO,
  SPIKE_Z,
  type DataQualityReport,
  type FundingPoint,
} from './data-quality.js';
export { analyzeTrades, type AnalyzableTrade, type TradeAnalysis, type BucketStats, type ConfluenceStats } from './analysis.js';
export { backtestSubAgent, subAgentSkippedConditions, type SubAgentBacktestResult } from './sub-agent-backtest.js';
export {
  evaluateBacktestValidity,
  holdoutMetrics,
  readHoldout,
  HOLDOUT_FRACTION,
  type HoldoutMetrics,
  DEFAULT_VALIDITY_THRESHOLDS,
  type BacktestMetricsInput,
  type ValidityThresholds,
  type ValidityVerdict,
  type ValidityCheck,
} from './validity.js';
export { labStudyRow, type LabStudyContext } from './study-rows.js';
export {
  computeCluster,
  groupRowsByCluster,
  studyRowFromDb,
  recomputeStudyClusters,
  pickOptimalParams,
  getOptimalParams,
  MIN_TRADES_PER_CLUSTER,
  MIN_HOLDOUT_TRADES,
  STUDY_WINDOW_DAYS,
  STUDY_LAMBDA_TIME_DECAY,
  STUDY_HOLDOUT_FRACTION,
  RISK_PCT_CANDIDATES,
  type StudyRow,
  type StudyDbRow,
  type ClusterComputation,
  type OptimalParams,
  type RiskCaps,
  type StoredCluster,
} from './study-clusters.js';
export {
  runOptimizationStudy,
  judgeOptimization,
  pickProposal,
  paramsKey,
  smcCoreGrid,
  dslGrid,
  MAX_GRID,
  OPTIMIZATION_THRESHOLDS,
  type OptimizationThresholds,
  type OptimizationJudgeInput,
  type OptimizationSpec,
  type OptimizationStudy,
  type StudyMarket,
} from './optimize.js';
export {
  diffParams,
  summarizeMetrics,
  readProposalState,
  type ParamChange,
  type ProposalReviewState,
  type ProposalMetricsSummary,
  type OptimizationProposalResults,
} from './optimize.js';
export {
  evaluateExpiredSignals,
  hindsightOutcome,
  summarizeHindsight,
  HINDSIGHT_MAX_BARS,
  type HindsightItem,
  type HindsightOutcome,
  type HindsightSignal,
  type HindsightStatus,
  type HindsightSummary,
} from './hindsight.js';
