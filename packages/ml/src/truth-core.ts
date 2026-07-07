import type { Candle } from '@gladiator/strategy-engine';
import { ema, rsi, atr, macd } from '@gladiator/strategy-engine';
import type { FeatureVector } from './features.js';
import type { RegimeResult } from './regime.js';

/**
 * Truth Core: Cross-reference validation layer for signals.
 *
 * Prevents false/hallucinated signals by requiring multiple independent
 * confirmations before a signal passes to the meta-classifier.
 *
 * Checks:
 * 1. Trend alignment (EMA stack confirms direction)
 * 2. Momentum confirmation (RSI not in contradiction)
 * 3. Volatility regime (ATR within tradeable range)
 * 4. Volume confirmation (not a ghost move on dead volume)
 * 5. Multi-timeframe consistency (if higher-TF data available)
 * 6. Regime coherence (features regime matches signal direction)
 *
 * Each check returns a reason string. Signal passes if enough checks pass.
 */

export type TruthCoreInput = {
  direction: 'long' | 'short';
  entry: number;
  stopLoss: number;
  score: number;
  features: FeatureVector | null;
  candles: Candle[];
  higherTfCandles?: Candle[];
  regime?: RegimeResult;
};

export type TruthCoreCheck = {
  name: string;
  passed: boolean;
  reason: string;
  weight: number;
};

export type TruthCoreResult = {
  passed: boolean;
  confidence: number;
  checks: TruthCoreCheck[];
  reasons: string[];
};

const MIN_CONFIDENCE = 0.55;

function checkTrendAlignment(candles: Candle[], direction: 'long' | 'short'): TruthCoreCheck {
  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const idx = closes.length - 1;
  const e20 = ema20[idx];
  const e50 = ema50[idx];
  const e200 = ema200[idx];

  if (e20 == null || e50 == null || e200 == null) {
    return { name: 'trend_alignment', passed: false, reason: 'Insufficient data for EMA stack', weight: 0.2 };
  }

  const close = closes[idx]!;

  if (direction === 'long') {
    const bullish = close > e20 && e20 > e50;
    return {
      name: 'trend_alignment',
      passed: bullish,
      reason: bullish
        ? `Long confirmed: price ${close.toFixed(2)} > EMA20 ${e20.toFixed(2)} > EMA50 ${e50.toFixed(2)}`
        : `Long contradicted: EMA stack not bullish`,
      weight: 0.2,
    };
  } else {
    const bearish = close < e20 && e20 < e50;
    return {
      name: 'trend_alignment',
      passed: bearish,
      reason: bearish
        ? `Short confirmed: price ${close.toFixed(2)} < EMA20 ${e20.toFixed(2)} < EMA50 ${e50.toFixed(2)}`
        : `Short contradicted: EMA stack not bearish`,
      weight: 0.2,
    };
  }
}

function checkMomentum(candles: Candle[], direction: 'long' | 'short'): TruthCoreCheck {
  const closes = candles.map(c => c.close);
  const rsiVals = rsi(closes, 14);
  const rsiVal = rsiVals[closes.length - 1];

  if (rsiVal == null) {
    return { name: 'momentum', passed: false, reason: 'RSI not available', weight: 0.15 };
  }

  if (direction === 'long') {
    // Long: RSI should not be overbought (>80) — signal may be exhausted
    const ok = rsiVal < 80;
    return {
      name: 'momentum',
      passed: ok,
      reason: ok
        ? `RSI ${rsiVal.toFixed(1)} not overbought — momentum supports long`
        : `RSI ${rsiVal.toFixed(1)} overbought — long signal may be exhausted`,
      weight: 0.15,
    };
  } else {
    // Short: RSI should not be oversold (<20)
    const ok = rsiVal > 20;
    return {
      name: 'momentum',
      passed: ok,
      reason: ok
        ? `RSI ${rsiVal.toFixed(1)} not oversold — momentum supports short`
        : `RSI ${rsiVal.toFixed(1)} oversold — short signal may be exhausted`,
      weight: 0.15,
    };
  }
}

function checkVolatility(candles: Candle[], entry: number, stopLoss: number): TruthCoreCheck {
  const atrVals = atr(candles, 14);
  const atrVal = atrVals[candles.length - 1];

  if (atrVal == null) {
    return { name: 'volatility', passed: false, reason: 'ATR not available', weight: 0.15 };
  }

  const riskDistance = Math.abs(entry - stopLoss);
  const atrRatio = riskDistance / atrVal;

  // Risk distance should be between 0.5 and 3 ATR (reasonable SL placement)
  const ok = atrRatio >= 0.5 && atrRatio <= 3.0;
  return {
    name: 'volatility',
    passed: ok,
    reason: ok
      ? `SL distance ${riskDistance.toFixed(2)} = ${atrRatio.toFixed(2)} ATR — within tradeable range`
      : `SL distance ${riskDistance.toFixed(2)} = ${atrRatio.toFixed(2)} ATR — ${atrRatio < 0.5 ? 'too tight (noise stop)' : 'too wide (excessive risk)'}`,
    weight: 0.15,
  };
}

function checkVolume(candles: Candle[]): TruthCoreCheck {
  const volumes = candles.map(c => c.volume);
  const idx = volumes.length - 1;

  if (idx < 20) {
    return { name: 'volume', passed: false, reason: 'Insufficient volume history', weight: 0.15 };
  }

  const recentAvg = volumes.slice(idx - 4, idx + 1).reduce((a, b) => a + b, 0) / 5;
  const historicalAvg = volumes.slice(idx - 19, idx + 1).reduce((a, b) => a + b, 0) / 20;

  if (historicalAvg <= 0) {
    return { name: 'volume', passed: false, reason: 'Zero historical volume', weight: 0.15 };
  }

  const ratio = recentAvg / historicalAvg;
  const ok = ratio >= 0.5; // At least half of average volume

  return {
    name: 'volume',
    passed: ok,
    reason: ok
      ? `Volume ratio ${ratio.toFixed(2)}x vs 20-bar avg — sufficient liquidity`
      : `Volume ratio ${ratio.toFixed(2)}x vs 20-bar avg — ghost move on thin volume`,
    weight: 0.15,
  };
}

function checkMacdConfirmation(candles: Candle[], direction: 'long' | 'short'): TruthCoreCheck {
  const closes = candles.map(c => c.close);
  const macdResult = macd(closes);
  const idx = closes.length - 1;

  const hist = macdResult.histogram[idx];
  const prevHist = macdResult.histogram[idx - 1];

  if (hist == null || prevHist == null) {
    return { name: 'macd', passed: false, reason: 'MACD not available', weight: 0.15 };
  }

  if (direction === 'long') {
    // Histogram rising or positive
    const ok = hist > prevHist || hist > 0;
    return {
      name: 'macd',
      passed: ok,
      reason: ok
        ? `MACD histogram ${hist > 0 ? 'positive' : 'rising'} — bullish momentum`
        : `MACD histogram falling and negative — bearish momentum contradicts long`,
      weight: 0.15,
    };
  } else {
    const ok = hist < prevHist || hist < 0;
    return {
      name: 'macd',
      passed: ok,
      reason: ok
        ? `MACD histogram ${hist < 0 ? 'negative' : 'falling'} — bearish momentum`
        : `MACD histogram rising and positive — bullish momentum contradicts short`,
      weight: 0.15,
    };
  }
}

function checkRegimeCoherence(features: FeatureVector | null, direction: 'long' | 'short', regime?: RegimeResult): TruthCoreCheck {
  // Prefer the multi-window regime detector when available
  if (regime) {
    if (direction === 'long') {
      const ok = regime.regime !== 'bear' && regime.regime !== 'crisis';
      return {
        name: 'regime',
        passed: ok,
        reason: ok
          ? `Regime ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf) compatible with long`
          : `Regime ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf) contradicts long`,
        weight: 0.1,
      };
    } else {
      const ok = regime.regime !== 'bull';
      return {
        name: 'regime',
        passed: ok,
        reason: ok
          ? `Regime ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf) compatible with short`
          : `Regime ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf) contradicts short`,
        weight: 0.1,
      };
    }
  }

  // Fallback to simple feature-based regime
  if (!features) {
    return { name: 'regime', passed: true, reason: 'No features available — skipped', weight: 0.1 };
  }

  if (direction === 'long') {
    const ok = features.regime >= -0.5;
    return {
      name: 'regime',
      passed: ok,
      reason: ok
        ? `Regime ${features.regime.toFixed(1)} not strongly bearish — compatible with long`
        : `Regime ${features.regime.toFixed(1)} strongly bearish — long signal in wrong regime`,
      weight: 0.1,
    };
  } else {
    const ok = features.regime <= 0.5;
    return {
      name: 'regime',
      passed: ok,
      reason: ok
        ? `Regime ${features.regime.toFixed(1)} not strongly bullish — compatible with short`
        : `Regime ${features.regime.toFixed(1)} strongly bullish — short signal in wrong regime`,
      weight: 0.1,
    };
  }
}

function checkHigherTf(higherTfCandles: Candle[] | undefined, direction: 'long' | 'short'): TruthCoreCheck {
  if (!higherTfCandles || higherTfCandles.length < 50) {
    return { name: 'higher_tf', passed: true, reason: 'No higher-TF data — skipped', weight: 0.1 };
  }

  const closes = higherTfCandles.map(c => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const idx = closes.length - 1;
  const e20 = ema20[idx];
  const e50 = ema50[idx];

  if (e20 == null || e50 == null) {
    return { name: 'higher_tf', passed: true, reason: 'Higher-TF EMAs not yet defined — skipped', weight: 0.1 };
  }

  if (direction === 'long') {
    const ok = e20 >= e50;
    return {
      name: 'higher_tf',
      passed: ok,
      reason: ok
        ? `Higher-TF EMA20 > EMA50 — confirms long`
        : `Higher-TF EMA20 < EMA50 — counter-trend long`,
      weight: 0.1,
    };
  } else {
    const ok = e20 <= e50;
    return {
      name: 'higher_tf',
      passed: ok,
      reason: ok
        ? `Higher-TF EMA20 < EMA50 — confirms short`
        : `Higher-TF EMA20 > EMA50 — counter-trend short`,
      weight: 0.1,
    };
  }
}

/**
 * Run all Truth Core checks on a signal.
 *
 * A signal passes if the weighted sum of passing checks exceeds
 * MIN_CONFIDENCE (0.55).
 * The confidence is the weighted passing ratio.
 */
export function runTruthCore(input: TruthCoreInput): TruthCoreResult {
  const checks: TruthCoreCheck[] = [
    checkTrendAlignment(input.candles, input.direction),
    checkMomentum(input.candles, input.direction),
    checkVolatility(input.candles, input.entry, input.stopLoss),
    checkVolume(input.candles),
    checkMacdConfirmation(input.candles, input.direction),
    checkRegimeCoherence(input.features, input.direction, input.regime),
    checkHigherTf(input.higherTfCandles, input.direction),
  ];

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const passingWeight = checks.filter(c => c.passed).reduce((sum, c) => sum + c.weight, 0);
  const confidence = totalWeight > 0 ? passingWeight / totalWeight : 0;

  const passed = confidence >= MIN_CONFIDENCE;

  return {
    passed,
    confidence,
    checks,
    reasons: checks.filter(c => !c.passed).map(c => c.reason),
  };
}
