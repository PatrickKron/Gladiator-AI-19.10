import { describe, expect, it } from 'vitest';
import {
  adaptPresetDslToTarget,
  parseInstructionDsl,
  STRATEGY_PRESETS,
  summarizeDslRules,
  synthesizeDslFromPineScript,
} from './index.js';

describe('summarizeDslRules', () => {
  it('summarizes all built-in strategy presets into human-readable rules', () => {
    for (const preset of STRATEGY_PRESETS) {
      const summary = summarizeDslRules(preset.dsl);
      expect(summary.direction).toBe(preset.dsl.direction);
      expect(summary.setupType).toBe(preset.dsl.setupType);
      expect(summary.conditions.length).toBeGreaterThan(0);
      expect(summary.entry.length).toBeGreaterThan(0);
      expect(summary.stopLoss.length).toBeGreaterThan(0);
      expect(summary.takeProfits).toContain('R');
      expect(summary.risk).toContain('% Risiko');
    }
  });

  it('formats Retest entry, ATR stop, and trailing stop accurately', () => {
    const trendBtc = STRATEGY_PRESETS.find((p) => p.slug === 'katalog-trendfolge-btc-4h')!;
    const s = summarizeDslRules({
      ...trendBtc.dsl,
      entry: 'retest@EMA20',
      trailingStop: { pct: 1.2 },
    });
    expect(s.entry).toBe('Retest @ EMA20');
    expect(s.stopLoss).toBe('2.5× ATR');
    expect(s.conditions).toContain('Kurs > EMA 200');
    expect(s.conditions).toContain('Supertrend(10, 3×) ↑');
    expect(s.conditions).toContain('ADX(14) > 20');
    expect(s.trailingStop).toBe('Trail 1.2 %');
  });
});

describe('adaptPresetDslToTarget', () => {
  it('keeps preset id when target symbol matches preset symbol', () => {
    const preset = STRATEGY_PRESETS[0]!;
    const adapted = adaptPresetDslToTarget(preset.dsl, { symbol: preset.dsl.symbol, timeframe: '4h' });
    expect(adapted.id).toBe(preset.dsl.id);
    expect(adapted.symbol).toBe(preset.dsl.symbol);
    expect(adapted.timeframe).toBe('4h');
    expect(parseInstructionDsl(adapted).ok).toBe(true);
  });

  it('appends clean symbol suffix to id when overriding target asset (multi-asset support)', () => {
    const preset = STRATEGY_PRESETS[0]!;
    const adaptedGold = adaptPresetDslToTarget(preset.dsl, { symbol: 'XAU/USD', timeframe: '1d' });
    expect(adaptedGold.symbol).toBe('XAU/USD');
    expect(adaptedGold.timeframe).toBe('1d');
    expect(adaptedGold.id).toBe(`${preset.dsl.id}-xau-usd`);
    expect(parseInstructionDsl(adaptedGold).ok).toBe(true);
  });
});

describe('synthesizeDslFromPineScript', () => {
  it('synthesizes a valid InstructionDsl from Pine Script code', () => {
    const pine = `
//@version=5
strategy("My EMA RSI Setup", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
r = ta.rsi(close, 14)
a = ta.atr(14)
if ta.crossover(fast, slow) and r < 65
    strategy.entry("L", strategy.long)
`;
    const dsl = synthesizeDslFromPineScript(pine, { symbol: 'SOL/USDT', timeframe: '4h' });
    const parsed = parseInstructionDsl(dsl);
    expect(parsed.ok).toBe(true);
    expect(dsl.symbol).toBe('SOL/USDT');
    expect(dsl.timeframe).toBe('4h');
    expect(dsl.direction).toBe('long');
    expect(dsl.stopLoss.type).toBe('ATR');
  });
});
