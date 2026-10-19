export * from './types.js';
export * from './indicators.js';
export * from './indicators-extra.js';
export { computeSwings } from './swings.js';
export { detectStructure, type StructureOptions } from './structure.js';
export { detectOrderBlocks, detectFvgs, type Zone } from './zones.js';
export { computeScore, riskClassOf, type ConfluenceFlags, type RiskClass, type TradingSession } from './scoring.js';
export { sessionOf, isActiveSession } from './session.js';
export { evaluateSmcCoreAt, SMC_CORE_DEFAULTS, type SmcCoreParams, type SetupCandidate, type SmcContext } from './smc-core.js';
export {
  evaluateDslAt,
  instructionDslSchema,
  parseInstructionDsl,
  DSL_TIMEFRAMES,
  type DslCondition,
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
export { analyzePineScript, type PineAnalysis, type PineInput } from './pine-analyze.js';

export { presetBySlug, STRATEGY_PRESETS, type PresetCategory, type StrategyPreset } from './strategy-presets.js';
export { trailStep, type TrailInput } from './trailing.js';
