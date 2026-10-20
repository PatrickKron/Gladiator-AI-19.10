export { encryptSecret, decryptSecret, encryptCredentials, decryptCredentials } from './vault.js';
export type { TradingVenue, VenueOrderRequest, VenueOrderResult, VenuePosition, MarketRules, OrderState } from './venue.js';
export { CcxtLiveVenue, formatClientOrderId, type CcxtLiveClient, type CcxtOrder } from './ccxt-live-venue.js';
export { PaperVenue } from './paper-venue.js';
export { BinanceTestnetVenue } from './binance-venue.js';
export { planFills, type OpenProtectionOrder, type PlannedFill } from './lifecycle.js';
export { paperStudyRow, recordPaperStudyTrade, type PaperStudyInput } from './study-record.js';
export {
  executeConfirmedSignal,
  closePositionNow,
  closePositionManually,
  updateProtection,
  type ManualCloseResult,
  type ProtectionUpdate,
  type ProtectionResult,
  monitorOpenPositions,
  reconcile,
  buildAccountState,
  loadRiskSettings,
  loadActiveGates,
  loadNoTradeWindow,
  loadRiskContext,
  loadOrderRiskInputs,
  loadIntradayMovePct,
  PAPER_START_EQUITY,
  type ExecutionResult,
} from './executor.js';
export { HyperliquidTestnetVenue } from './hyperliquid-venue.js';
export {
  DEMO_MAKER_FEE,
  DEMO_TAKER_FEE,
  DEMO_START_BALANCE,
  DEMO_MAINTENANCE_MARGIN,
  liquidationPrice,
  marginFor,
  midPrice,
  type OrderBookSnapshot,
  type FillResult,
} from './demo/fill-engine.js';
export {
  binanceBookSource,
  BinanceBookSource,
  CcxtBookSource,
  DEMO_DEFAULT_VENUE,
  demoBookSource,
  MultiVenueBookSource,
  type DemoBookSource,
} from './demo/book-source.js';
export {
  COMPARE_VENUES,
  fetchVenueQuotes,
  rankVenueQuotes,
  venueSymbol,
  type CompareVenue,
  type RankedVenueQuote,
  type VenueQuote,
} from './venue-quotes.js';
export { binanceStreamingBook, StreamingBookCache, type BookStreamStatus } from './demo/book-stream.js';
export { summarizeBook, type BookView, type BookViewLevel } from './demo/book-view.js';
export {
  getOrCreateDemoAccount,
  demoAccountOverview,
  previewDemoOrder,
  placeDemoOrder,
  cancelDemoOrder,
  setDemoProtection,
  closeDemoPositionNow,
  resetDemoAccount,
  monitorDemoTick,
  DEMO_MAX_LEVERAGE,
  type PlaceDemoOrderInput,
  type PlaceDemoOrderResult,
} from './demo/engine.js';
export {
  connectExchange,
  connectWallet,
  isValidEvmAddress,
  walletExchanges,
  defaultCreateClient,
  fetchConnectionBalances,
  isSupportedExchange,
  listConnections,
  listSupportedExchanges,
  loadRoutingConnections,
  normalizeSymbol,
  pickConnectionForSymbol,
  refreshConnectionMarkets,
  revokeConnection,
  setConnectionMode,
  summarizeMarkets,
  type CcxtLikeClient,
  type ConnectionBalance,
  type ConnectionDto,
  type ConnectionForRouting,
  type CreateClient,
  type ExchangeCredentialsInput,
  type WalletCredentials,
  type StoredCredentials,
  type ConnectWalletInput,
  type MarketsSummary,
  type SupportedExchange,
} from './connections.js';
export {
  SECRET_KEYS,
  captureBootEnv,
  deleteSecret,
  getSecretStatus,
  loadSecretsIntoEnv,
  maskSecret,
  secretDef,
  setSecret,
  validateSecretValue,
  type SecretDef,
  type SecretKey,
  type SecretStatus,
} from './secrets.js';
export {
  detectExchangeMentions,
  loadPreferredExchanges,
  rankPreferredExchanges,
  type ExchangeMention,
  type PreferredExchange,
  type PreferredExchangeView,
} from './exchange-mentions.js';
