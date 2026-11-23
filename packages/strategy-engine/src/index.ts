export * from './types.js';
export * from './indicators.js';
export * from './indicators-extra.js';
export { computeSwings } from './swings.js';
export { detectStructure, type StructureOptions } from './structure.js';
export {
  detectAllDivergences,
  detectDivergences,
  type DivergenceEvent,
  type DivergenceIndicator,
  type DivergenceKind,
  type DivergenceOptions,
} from './divergences.js';
export { detectOrderBlocks, detectFvgs, type Zone } from './zones.js';
export {
  dealingRangeAt,
  detectEqualLevels,
  detectLiquidity,
  detectSweeps,
  premiumDiscount,
  type DealingRange,
  type LiquidityLevel,
  type LiquidityOptions,
  type LiquiditySweep,
} from './liquidity.js';
export { computeScore, riskClassOf, type ConfluenceFlags, type RiskClass, type TradingSession } from './scoring.js';
export { sessionOf, isActiveSession } from './session.js';
export {
  evaluateSmcCoreAt,
  setupTypeForTimeframe,
  SMC_CORE_DEFAULTS,
  type SmcCoreParams,
  type SetupCandidate,
  type SmcContext,
} from './smc-core.js';
export {
  evaluateDslAt,
  dslExecutionPlan,
  instructionDslSchema,
  parseInstructionDsl,
  DSL_REGIMES,
  DSL_TIMEFRAMES,
  type DslRegime,
  type DslCondition,
  type DslExecutionPlan,
  type DslParseResult,
  type DslSetup,
  type DslTimeframe,
  type InstructionDsl,
} from './dsl.js';
export { DSL_SCHEMA_DOC, DSL_LIMITS_DOC } from './dsl-doc.js';
export {
  subAgentSpecSchema,
  subAgentDataSourceSchema,
  parseSubAgentSpec,
  evaluateSubAgentEntry,
  evaluateSubAgentExit,
  priceSnapshotFromCandles,
  type SubAgentSpec,
  type SubAgentSpecParseResult,
  type SubAgentDataSource,
  type SubAgentEntryRules,
  type SubAgentExitRules,
  type SubAgentRiskParams,
  type SubAgentSnapshot,
  type SubAgentNewsItem,
  type SubAgentEntryDecision,
  type SubAgentExitDecision,
  type SubAgentPositionView,
} from './sub-agent.js';
export { analyzePineScript, synthesizeDslFromPineScript, type PineAnalysis, type PineInput } from './pine-analyze.js';
export {
  adaptPresetDslToTarget,
  summarizeDslCondition,
  summarizeDslRules,
  type DslRuleSummary,
} from './dsl-summary.js';

export { presetBySlug, STRATEGY_PRESETS, type PresetCategory, type StrategyPreset } from './strategy-presets.js';
export { trailStep, type TrailInput } from './trailing.js';
export { DEFAULT_TP_WEIGHTS, MAX_LIVE_TAKE_PROFITS, tpFractions } from './tp-weights.js';
export {
  AUTO_KILL_SCORE_THRESHOLD,
  MAX_REENTRIES,
  SETUP_LIFECYCLE_RULES,
  assessOpenSignal,
  deriveLeverageUpgradePlan,
  deriveLifecyclePlans,
  deriveReentryPlan,
  evaluateLeverageUpgrade,
  evaluateReentry,
  reentryZone,
  rescoreSignal,
  structureBrokenSince,
  type AutoKillReason,
  type LeverageUpgradePlan,
  type LeverageUpgradeSuggestion,
  type OpenSignalAssessment,
  type ReentryDecision,
  type ReentryPlan,
} from './signal-lifecycle.js';
export {
  analyzeFreeTextStrategy,
  detectStrategyPatterns,
  synthesizeDslFromText,
  type FreeTextStrategyAnalysis,
  type ParsedTextHedgingDraft,
  type PatternMatch,
  type StrategyLimitation,
  type TextSynthesisOptions,
  type TextSynthesisResult,
} from './text-to-dsl.js';
export {
  buildClusterKey,
  parseClusterKey,
  clusterKeyLevels,
  isLegacyClusterKey,
  marketStructureOf,
  CLUSTER_ALL,
  type ClusterKeyInput,
  type ClusterKeyParts,
  type ClusterLevel,
  type MarketStructure,
} from './study-cluster.js';
export {
  evaluateScenarioConfirmation,
  evaluateScenarioTrigger,
  parseScenarioFromText,
  scenarioActionSchema,
  scenarioConfirmationSchema,
  scenarioPlaybookSpecSchema,
  scenarioTriggerSchema,
  SCENARIO_CONFIRMATION_KINDS,
  SCENARIO_EVENT_CATEGORIES,
  SCENARIO_EXECUTION_MODES,
  SCENARIO_STATUSES,
  SCENARIO_TARGET_SCOPES,
  SCENARIO_TEMPLATES,
  type ConfirmationEvalResult,
  type ParsedScenarioResult,
  type ScenarioAction,
  type ScenarioConfirmation,
  type ScenarioConfirmationKind,
  type ScenarioEventCategory,
  type ScenarioExecutionMode,
  type ScenarioFeasibility,
  type ScenarioPlaybookSpec,
  type ScenarioStatus,
  type ScenarioTargetScope,
  type ScenarioTrigger,
  type TriggerEvalContext,
  type TriggerEvalResult,
  type TriggerNewsInput,
} from './scenarios.js';
