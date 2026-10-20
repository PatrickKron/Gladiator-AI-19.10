export { runSignalScan, ensureSmcCoreStrategy, SCAN_SYMBOLS, SCAN_TIMEFRAMES, type ScanResult } from './signal-scan.js';
export { startJobWorker } from './worker.js';
export { reviewNewSignals, buildDevilEvidence, type ReviewResult } from './review.js';
export { runDslScan, type DslScanResult } from './dsl-scan.js';
export { escapeHtml, formatEmergencyAlert, formatKillSwitchAlert, formatSignalAlert, sendTelegram, telegramConfigured, type SignalAlertData } from './telegram.js';
export { notify, notifySafe, pushConfig, pushPayload, telegramHtmlToText, type NotifyEvent, type NotifyKind, type PushSender } from './notify.js';
export { buildBriefing, latestBriefing, renderBriefing, runNightPipeline, type BriefingData, type NightPipelineResult } from './briefing.js';
export { enqueueRlEpisodeRun, workerHeartbeatAgeSec, workerHeartbeatAgeSecAsync } from './worker.js';
export { explainForUser, deterministicExplanation, buildExplanationMessages, sanitizeExplanation, type ExplanationFacts } from './explanation.js';
export { buildUniverse, ensureCandles, normalizeTradingPair, scanUniverse, BASE_SYMBOLS } from './universe.js';
export { alertTriggered, checkPriceAlerts } from './alerts.js';
export { expireStaleSignals, isSignalExpired, signalExpiryCutoff, ttlHoursFor, SIGNAL_TTL_HOURS, DEFAULT_TTL_HOURS } from './signal-expiry.js';
export {
  runSubAgents,
  ensureSubAgentStrategy,
  reassembleSubAgentSpec,
  buildSubAgentSnapshot,
  dailyLossBreached,
  symbolOnCooldown,
  minutesToNextHighImpact,
  newsToItems,
  dxyChangePct20d,
  type SubAgentRunSummary,
} from './sub-agent-runner.js';
export {
  runAnalysisGate,
  buildAnalysisMessages,
  buildAnalysisContext,
  fillPromptPlaceholders,
  parseAnalysisDecision,
  type LlmGateOutcome,
} from './sub-agent-llm.js';
export {
  computeAllFeatures,
  autoLabelSignals,
  retrainModel,
  type MlFeatureResult,
  type MlAutoLabelResult,
  type MlRetrainResult,
} from './ml-pipeline.js';
export {
  detectAllRegimes,
  runSelfEvaluation,
  runModelComparison,
  createPerformanceSnapshots,
  type RegimeDetectionResult,
  type SelfEvaluationResult,
  type ModelComparisonResult,
  type SnapshotResult,
} from './self-improve-pipeline.js';
export { snapshotAccountValues, loadValueHistory, type SnapshotResult as PortfolioSnapshotResult } from './portfolio-snapshot.js';
export { runSignalLifecycle, type SignalLifecycleOptions, type SignalLifecycleResult } from './signal-lifecycle.js';
export {
  runStrategyOptimization,
  openOptimizationProposals,
  OPT_IS_BARS,
  OPT_OOS_BARS,
  OPT_MIN_BARS,
  OPT_MAX_BARS,
  SMC_OPT_TIMEFRAME,
  type OptimizationRunOptions,
  type OptimizationRunSummary,
  type OpenProposal,
} from './optimization.js';
export {
  SwapError,
  netError,
  liveKeysAllowed,
  setSwapFetchForTests,
  setLiveSwapExecutorForTests,
  swapNet,
  cachedTokenInfo,
  cachedTokenSafety,
  limitsOf,
  syncLiveBalances,
  prepareSwap,
  quoteView,
  executePreparedSwap,
  valueSwapWallets,
  type WalletValuation,
  type SwapRequest,
  type PreparedSwap,
  type SwapWalletRow,
  type ExecuteContext,
  type ExecuteResult,
} from './swap-service.js';
export {
  evaluateSwapOrder,
  validateNewOrder,
  runSwapOrders,
  failStuckSwapOrders,
  SWAP_ORDER_LABEL,
  type SwapOrderKind,
  type OrderState,
  type SwapOrdersResult,
} from './swap-orders.js';
export { checkWatchedWallet, runWalletCopy, WATCH_INTERVAL_SECONDS, WATCH_TX_LIMIT, type WalletCopyResult } from './wallet-copy.js';
