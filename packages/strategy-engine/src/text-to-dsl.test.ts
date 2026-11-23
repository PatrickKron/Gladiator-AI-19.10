import { describe, expect, it } from 'vitest';
import { analyzeFreeTextStrategy, detectStrategyPatterns, parseInstructionDsl, synthesizeDslFromText } from './index.js';

describe('detectStrategyPatterns & synthesizeDslFromText', () => {
  it('erkennt RSI-Divergenz + EMA200 + Stop-Loss + Take-Profit aus natürlichem Deutsch', () => {
    const text = 'Kaufe BTC/USDT im 1h Chart bei bullischer RSI Divergenz über EMA 200 mit SL 1,5% und TP 3R sowie Trailing 2%';
    const patterns = detectStrategyPatterns(text);
    expect(patterns.some((p) => p.id === 'divergence')).toBe(true);
    expect(patterns.some((p) => p.id === 'ema_pullback')).toBe(true);

    const res = synthesizeDslFromText(text);
    expect(parseInstructionDsl(res.dsl).ok).toBe(true);
    expect(res.dsl.symbol).toBe('BTC/USDT');
    expect(res.dsl.timeframe).toBe('1h');
    expect(res.dsl.direction).toBe('long');
    expect(res.dsl.stopLoss).toEqual({ type: 'pct', pct: 1.5 });
    expect(res.dsl.trailingStop).toEqual({ pct: 2 });
    expect(res.dsl.when.all.some((c) => 'divergence' in c && c.divergence.indicator === 'rsi' && c.divergence.kind === 'bullish')).toBe(true);
    expect(res.dsl.when.all.some((c) => 'priceVs' in c && c.priceVs.period === 200 && c.priceVs.is === 'above')).toBe(true);
  });

  it('erkennt Short-Setup mit EMA 20/50 Cross, ADX und 15m Timeframe', () => {
    const res = synthesizeDslFromText('Short ETH auf 15m wenn EMA 20 kreuzt EMA 50 und ADX > 25 mit 1.5 ATR Stop');
    expect(res.dsl.symbol).toBe('ETH/USDT');
    expect(res.dsl.timeframe).toBe('15m');
    expect(res.dsl.direction).toBe('short');
    expect(res.dsl.setupType).toBe('scalp');
    expect(res.dsl.stopLoss).toEqual({ type: 'ATR', mult: 1.5 });
    expect(res.dsl.when.all.some((c) => 'maCross' in c && c.maCross.fast === 20 && c.maCross.slow === 50 && c.maCross.cross === 'bearish')).toBe(true);
    expect(res.dsl.when.all.some((c) => 'adx' in c && c.adx.gt === 25)).toBe(true);
  });

  it('erkennt Bollinger-Rebound + RSI < 30 auf Gold (XAU/USD) 4h', () => {
    const res = synthesizeDslFromText('Long Gold im 4h Chart wenn Preis am unteren Bollinger Band und RSI < 30');
    expect(res.dsl.symbol).toBe('XAU/USD');
    expect(res.dsl.timeframe).toBe('4h');
    expect(res.dsl.when.all.some((c) => 'bollinger' in c)).toBe(true);
    expect(res.dsl.when.all.some((c) => 'indicator' in c && c.indicator === 'RSI' && c.lt === 30)).toBe(true);
  });

  it('erzeugt auch bei allgemeiner Beschreibung immer eine valide DSL mit Optionen-Fallback', () => {
    const res = synthesizeDslFromText('Einstieg nach ruhiger Konsolidierung', {
      name: 'Mein Test Setup',
      symbol: 'SOL/USDT',
      timeframe: '10m',
    });
    expect(parseInstructionDsl(res.dsl).ok).toBe(true);
    expect(res.dsl.id).toBe('mein-test-setup');
    expect(res.dsl.symbol).toBe('SOL/USDT');
    expect(res.dsl.timeframe).toBe('10m');
    expect(res.dsl.when.all.length).toBeGreaterThanOrEqual(1);
  });

  it('erkennt keine falschen Muster in einfachem Smalltalk', () => {
    expect(detectStrategyPatterns('Hallo wie geht es dir heute?')).toEqual([]);
  });
});

describe('analyzeFreeTextStrategy (Machbarkeit & Anwendung, Welle 22)', () => {
  it('erkennt reine Hedging-Strategie aus Text inkl. Cross-Hedge, VIX, Drawdown & Ziel-Assets', () => {
    const res = analyzeFreeTextStrategy(
      'Sichere SOL und ETH zu 50 % über BTC Short ab wenn VIX über 24 oder Drawdown 4 % mit 7 % Hedge-SL',
    );
    expect(res.category).toBe('hedging');
    expect(res.feasibility).toBe('full');
    expect(res.trading).toBeNull();
    expect(res.hedging).not.toBeNull();
    expect(res.hedging!.maxHedgeRatioPct).toBe(50);
    expect(res.hedging!.hedgeSymbol).toBe('BTC/USDT');
    expect(res.hedging!.triggerVix).toBe(24);
    expect(res.hedging!.triggerDrawdownPct).toBe(4);
    expect(res.hedging!.hedgeStopLossPct).toBe(7);
    expect([...res.hedging!.targetAssets].sort()).toEqual(['ETH/USDT', 'SOL/USDT']);
    expect(res.howToApply.length).toBeGreaterThanOrEqual(2);
  });

  it('erkennt hybride Trading- + Hedging-Strategie und Regime-Weiche aus Text', () => {
    const res = analyzeFreeTextStrategy(
      'Kaufe BTC/USDT auf 4h bei EMA 20/50 Cross nur im Trend mit 2 ATR Stop und sichere Portfolio mit 40 % Stablecoin-Puffer ab 5 % Drawdown ab',
    );
    expect(res.category).toBe('hybrid');
    expect(res.feasibility).toBe('full');
    expect(res.trading?.dsl.allowedRegimes).toEqual(['bull', 'bear']);
    expect(res.hedging?.instrument).toBe('stablecoin_shift');
    expect(res.hedging?.maxHedgeRatioPct).toBe(40);
  });

  it('meldet ehrliche Grenzen & konkrete Alternativen bei Optionen, DOM/Orderbuch und Martingale', () => {
    const res = analyzeFreeTextStrategy(
      'Kaufe Put-Optionen auf SPY bei Orderbuch-Imbalance im Tick-Chart und verdopple per Martingale im Verlust',
    );
    expect(res.feasibility).toBe('unsupported');
    expect(res.limitations.length).toBeGreaterThanOrEqual(3);
    expect(res.limitations.every((l) => l.workaround.length > 10)).toBe(true);
  });
});
