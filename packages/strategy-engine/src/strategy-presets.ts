import type { InstructionDsl } from './dsl.js';

/**
 * Strategie-Katalog (Patricks Auftrag: „umfassendes Sortiment an Strategien,
 * die auch nachweislich funktionieren"):
 *
 * WICHTIG — was „nachweislich" hier bedeutet: Diese Presets sind bewährte,
 * klassische Setups (Trendfolge, Mean-Reversion, Momentum, Breakout), aber
 * das System behauptet NIE Performance ohne Beweis. Jede Aktivierung läuft
 * durch einen ECHTEN Backtest gegen echte DB-Kerzen + das Validitäts-Gate
 * (minTrades/ProfitFactor/MaxDD/Expectancy, alles netto). Erst wenn das Gate
 * besteht, geht die Strategie auf Paper. Die Katalog-Karte zeigt ausschließlich
 * die ECHTEN Backtest-Zahlen — oder ehrlich „noch nicht geprüft".
 *
 * Kategorien steuern nur Risiko-Defaults + UI-Einordnung:
 * conservative ≤ 0.5 % Risiko/Trade, Hebel 1 · balanced ≤ 1 %, Hebel ≤ 2
 * · aggressive ≤ 2 %, Hebel ≤ 5.
 * Symbole: BTC/ETH/SOL-USDT — dafür existiert echte Kerzen-Historie (Backfill).
 */

export type PresetCategory = 'conservative' | 'balanced' | 'aggressive';

export type StrategyPreset = {
  slug: string;
  category: PresetCategory;
  /** Anzeige läuft über i18n: catalog.preset_<slugKey>_name / _desc. */
  slugKey: string;
  dsl: InstructionDsl;
};

export const STRATEGY_PRESETS: StrategyPreset[] = [
  // ── KONSERVATIV: Trendfolge mit doppelter Bestätigung, kleines Risiko, Hebel 1 ──
  {
    slug: 'katalog-trendfolge-btc-4h',
    category: 'conservative',
    slugKey: 'trend_btc',
    dsl: {
      id: 'katalog-trendfolge-btc-4h',
      symbol: 'BTC/USDT',
      timeframe: '4h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [
          { trend: 'EMA200_up' },
          { supertrend: { period: 10, mult: 3, direction: 'up' } },
          { adx: { period: 14, gt: 20 } },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 2.5 },
      takeProfits: [{ rr: 1.5 }, { rr: 2.5 }, { rr: 4 }],
      risk: { maxLeveragePerTrade: 1, riskPctPerTrade: 0.5 },
    },
  },
  {
    slug: 'katalog-ruecksetzer-eth-4h',
    category: 'conservative',
    slugKey: 'dip_eth',
    dsl: {
      id: 'katalog-ruecksetzer-eth-4h',
      symbol: 'ETH/USDT',
      timeframe: '4h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [
          { trend: 'EMA200_up' },
          { bollinger: { period: 20, mult: 2, event: 'close_below_lower' } },
          { indicator: 'RSI', lt: 40 },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'pct', pct: 3 },
      takeProfits: [{ rr: 1.5 }, { rr: 2.5 }],
      risk: { maxLeveragePerTrade: 1, riskPctPerTrade: 0.5 },
    },
  },
  {
    slug: 'katalog-langfrist-btc-1d',
    category: 'conservative',
    slugKey: 'longterm_btc',
    dsl: {
      id: 'katalog-langfrist-btc-1d',
      symbol: 'BTC/USDT',
      timeframe: '1d',
      venueType: 'cex',
      direction: 'long',
      setupType: 'position',
      when: {
        all: [
          { trend: 'EMA200_up' },
          { priceVs: { kind: 'EMA', period: 50, is: 'above' } },
          { indicator: 'RSI', gt: 50 },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'pct', pct: 8 },
      takeProfits: [{ rr: 2 }, { rr: 3 }],
      risk: { maxLeveragePerTrade: 1, riskPctPerTrade: 0.5 },
    },
  },

  // ── AUSGEWOGEN: Momentum/Swing, 1 % Risiko, Hebel bis 2 ──
  {
    slug: 'katalog-momentum-btc-1h',
    category: 'balanced',
    slugKey: 'momentum_btc',
    dsl: {
      id: 'katalog-momentum-btc-1h',
      symbol: 'BTC/USDT',
      timeframe: '1h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [
          { maCross: { kind: 'EMA', fast: 21, slow: 55, cross: 'bullish', withinBars: 3 } },
          { adx: { period: 14, gt: 18 } },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 2 },
      takeProfits: [{ rr: 1.5 }, { rr: 2.5 }, { rr: 4 }],
      risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
    },
  },
  {
    slug: 'katalog-rsi-swing-eth-1h',
    category: 'balanced',
    slugKey: 'rsi_eth',
    dsl: {
      id: 'katalog-rsi-swing-eth-1h',
      symbol: 'ETH/USDT',
      timeframe: '1h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [{ trend: 'EMA200_up' }, { indicator: 'RSI', lt: 32 }],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 2 },
      takeProfits: [{ rr: 2 }, { rr: 3 }],
      risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
    },
  },
  {
    slug: 'katalog-supertrend-sol-4h',
    category: 'balanced',
    slugKey: 'supertrend_sol',
    dsl: {
      id: 'katalog-supertrend-sol-4h',
      symbol: 'SOL/USDT',
      timeframe: '4h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [
          { supertrend: { period: 10, mult: 3, direction: 'up' } },
          { macd: { fast: 12, slow: 26, signal: 9, event: 'histogram_positive', withinBars: 1 } },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 2 },
      takeProfits: [{ rr: 1.5 }, { rr: 3 }],
      risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
    },
  },

  // ── AGGRESSIV: Breakout/Scalp/Short, bis 2 % Risiko, Hebel bis 5 ──
  {
    slug: 'katalog-breakout-sol-1h',
    category: 'aggressive',
    slugKey: 'breakout_sol',
    dsl: {
      id: 'katalog-breakout-sol-1h',
      symbol: 'SOL/USDT',
      timeframe: '1h',
      venueType: 'cex',
      direction: 'long',
      setupType: 'swing',
      when: {
        all: [{ signal: 'BOS' }, { adx: { period: 14, gt: 25 } }],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 1.5 },
      takeProfits: [{ rr: 2 }, { rr: 3 }, { rr: 5 }],
      risk: { maxLeveragePerTrade: 3, riskPctPerTrade: 2 },
    },
  },
  {
    slug: 'katalog-scalp-btc-15m',
    category: 'aggressive',
    slugKey: 'scalp_btc',
    dsl: {
      id: 'katalog-scalp-btc-15m',
      symbol: 'BTC/USDT',
      timeframe: '15m',
      venueType: 'cex',
      direction: 'long',
      setupType: 'scalp',
      when: {
        all: [
          { trend: 'EMA200_up' },
          { macd: { fast: 12, slow: 26, signal: 9, event: 'bullish_cross', withinBars: 2 } },
          { indicator: 'RSI', gt: 50 },
        ],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 1.2 },
      takeProfits: [{ rr: 1 }, { rr: 1.5 }, { rr: 2 }],
      risk: { maxLeveragePerTrade: 5, riskPctPerTrade: 2 },
    },
  },
  {
    slug: 'katalog-short-eth-1h',
    category: 'aggressive',
    slugKey: 'short_eth',
    dsl: {
      id: 'katalog-short-eth-1h',
      symbol: 'ETH/USDT',
      timeframe: '1h',
      venueType: 'cex',
      direction: 'short',
      setupType: 'swing',
      when: {
        all: [{ trend: 'EMA200_down' }, { indicator: 'RSI', gt: 65 }],
      },
      entry: 'market',
      stopLoss: { type: 'ATR', mult: 2 },
      takeProfits: [{ rr: 1.5 }, { rr: 2.5 }],
      risk: { maxLeveragePerTrade: 3, riskPctPerTrade: 2 },
    },
  },
];

export function presetBySlug(slug: string): StrategyPreset | null {
  return STRATEGY_PRESETS.find((p) => p.slug === slug) ?? null;
}
