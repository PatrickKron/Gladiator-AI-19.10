import type { Condition, Operand } from './conditions.js';

/**
 * Vorlagen des Screeners — Namen über i18n-Schlüssel (`screener.preset_<id>`),
 * damit sie in allen fünf Sprachen stimmen. Bedingungen nutzen Katalog-Ids der
 * Indikator-Bibliothek und die Smart-Money-Engine.
 */
export type ScreenPreset = { id: string; nameKey: string; conditions: Condition[] };

const ind = (id: string, plot?: string, inputs?: Record<string, unknown>): Operand => ({ kind: 'indicator', id, ...(plot ? { plot } : {}), ...(inputs ? { inputs } : {}) });

export const SCREEN_PRESETS: ScreenPreset[] = [
  {
    id: 'oversold_uptrend',
    nameKey: 'screener.preset_oversold_uptrend',
    conditions: [
      { kind: 'compare', left: ind('rsi', 'plot0'), op: '<', right: { kind: 'number', value: 30 } },
      { kind: 'compare', left: { kind: 'price' }, op: '>', right: ind('ema', 'plot0', { length: 200 }) },
    ],
  },
  {
    id: 'overbought_downtrend',
    nameKey: 'screener.preset_overbought_downtrend',
    conditions: [
      { kind: 'compare', left: ind('rsi', 'plot0'), op: '>', right: { kind: 'number', value: 70 } },
      { kind: 'compare', left: { kind: 'price' }, op: '<', right: ind('ema', 'plot0', { length: 200 }) },
    ],
  },
  {
    id: 'bull_engulf_discount',
    nameKey: 'screener.preset_bull_engulf_discount',
    conditions: [
      { kind: 'pattern', id: 'engulfing-bullish', withinBars: 3 },
      { kind: 'range', zone: 'discount' },
    ],
  },
  {
    id: 'sweep_choch_bull',
    nameKey: 'screener.preset_sweep_choch_bull',
    conditions: [
      { kind: 'liquidity', what: 'sweep_sell_side', withinBars: 12 },
      { kind: 'structure', event: 'CHoCH', direction: 'bullish', withinBars: 12 },
    ],
  },
  {
    id: 'bos_bull_fresh',
    nameKey: 'screener.preset_bos_bull_fresh',
    conditions: [{ kind: 'structure', event: 'BOS', direction: 'bullish', withinBars: 5 }],
  },
  {
    id: 'macd_cross_bull',
    nameKey: 'screener.preset_macd_cross_bull',
    conditions: [{ kind: 'compare', left: ind('macd', 'plot1'), op: 'crosses_above', right: ind('macd', 'plot2') }],
  },
  {
    id: 'price_cross_ema50',
    nameKey: 'screener.preset_price_cross_ema50',
    conditions: [{ kind: 'compare', left: { kind: 'price' }, op: 'crosses_above', right: ind('ema', 'plot0', { length: 50 }) }],
  },
  {
    id: 'volume_spike',
    nameKey: 'screener.preset_volume_spike',
    conditions: [{ kind: 'compare', left: { kind: 'volume' }, op: '>', right: { kind: 'volume_avg', bars: 20, mult: 2 } }],
  },
  {
    id: 'eqh_open',
    nameKey: 'screener.preset_eqh_open',
    conditions: [{ kind: 'liquidity', what: 'eqh_open', withinBars: 100 }],
  },
  {
    id: 'strong_move',
    nameKey: 'screener.preset_strong_move',
    conditions: [{ kind: 'compare', left: { kind: 'change', bars: 24 }, op: '>', right: { kind: 'number', value: 5 } }],
  },
];

export function presetById(id: string): ScreenPreset | undefined {
  return SCREEN_PRESETS.find((p) => p.id === id);
}
