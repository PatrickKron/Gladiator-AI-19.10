export { runBacktest, DEFAULT_COSTS, ZERO_COSTS, type BacktestConfig, type BacktestResult, type BacktestTrade, type CostModel, type Evaluator } from './engine.js';
export { computeMetrics, maxDrawdownPct, type Metrics } from './metrics.js';
export { runWalkForward, type WalkForwardConfig, type WalkForwardResult, type WalkForwardWindow } from './walkforward.js';
export { rapsGrid, explainRapsChoice, LEVERAGE_CANDIDATES, TP_SCHEMA_IDS, type RapsResult, type RapsCell, type RapsTrade, type TpSchemaId } from './raps.js';
export { runLabBacktest, runLabWalkForward, BARS_PER_YEAR, type LabRunInput, type LabRunOutput, type LabWalkForwardInput } from './lab.js';
export { analyzeTrades, type AnalyzableTrade, type TradeAnalysis, type BucketStats, type ConfluenceStats } from './analysis.js';
export { backtestSubAgent, subAgentSkippedConditions, type SubAgentBacktestResult } from './sub-agent-backtest.js';
export {
  evaluateBacktestValidity,
  DEFAULT_VALIDITY_THRESHOLDS,
  type BacktestMetricsInput,
  type ValidityThresholds,
  type ValidityVerdict,
  type ValidityCheck,
} from './validity.js';
