import type { Candle } from '@gladiator/strategy-engine';

export const REGIMES = ['bull', 'bear', 'sideways', 'high_vol', 'crisis'] as const;
export type Regime = typeof REGIMES[number];

export type RegimeComponent = {
  name: string;
  score: number;   // -1 to +1 (bearish to bullish) or 0 to 1 (intensity)
  detail: string;
};

export type RegimeResult = {
  regime: Regime;
  confidence: number;  // 0 to 1
  components: RegimeComponent[];
};

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length === 0) return 0.5;
  let count = 0;
  for (const v of sorted) {
    if (v < value) count++;
  }
  return count / sorted.length;
}

/**
 * Trend component: direction and strength from rolling returns.
 * Uses 20-bar and 50-bar rolling returns to determine trend direction.
 * Score: +1 strong bull, -1 strong bear, 0 flat.
 */
function trendComponent(closes: number[]): RegimeComponent {
  const n = closes.length;
  if (n < 50) return { name: 'trend', score: 0, detail: 'Insufficient data' };

  const ret20 = (closes[n - 1]! - closes[n - 21]!) / closes[n - 21]!;
  const ret50 = (closes[n - 1]! - closes[n - 51]!) / closes[n - 51]!;

  // EMA slope: compare EMA(20) now vs 10 bars ago
  const ema20Now = mean(closes.slice(n - 20));
  const ema20Prev = mean(closes.slice(n - 30, n - 10));
  const slopeNorm = closes[n - 1]! > 0 ? (ema20Now - ema20Prev) / closes[n - 1]! : 0;

  // Combine: 50% weight on 20-bar return, 30% on 50-bar, 20% on slope
  const rawScore = 0.5 * Math.tanh(ret20 * 20) + 0.3 * Math.tanh(ret50 * 10) + 0.2 * Math.tanh(slopeNorm * 100);
  const score = Math.max(-1, Math.min(1, rawScore));

  const dir = score > 0.2 ? 'bullish' : score < -0.2 ? 'bearish' : 'neutral';
  return {
    name: 'trend',
    score,
    detail: `${dir} (ret20=${(ret20 * 100).toFixed(2)}%, ret50=${(ret50 * 100).toFixed(2)}%)`,
  };
}

/**
 * Volatility component: current vol vs historical percentile.
 * High percentile = high-vol regime. Uses 20-bar rolling std of returns.
 */
function volatilityComponent(closes: number[]): RegimeComponent {
  const n = closes.length;
  if (n < 200) return { name: 'volatility', score: 0, detail: 'Insufficient data' };

  // Compute daily returns
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    returns.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  }

  // Rolling 20-bar std
  const rollingVols: number[] = [];
  for (let i = 19; i < returns.length; i++) {
    rollingVols.push(stdDev(returns.slice(i - 19, i + 1)));
  }

  if (rollingVols.length < 2) return { name: 'volatility', score: 0, detail: 'Insufficient vol history' };

  const currentVol = rollingVols[rollingVols.length - 1]!;
  const sorted = [...rollingVols].sort((a, b) => a - b);
  const pctile = percentileRank(currentVol, sorted);

  // Score: 0 = low vol, 1 = extreme vol
  const score = pctile;

  return {
    name: 'volatility',
    score,
    detail: `vol=${(currentVol * 100).toFixed(3)}% (${(pctile * 100).toFixed(0)}th pctile)`,
  };
}

/**
 * Volume anomaly component: detect unusual volume spikes.
 * Compares recent 5-bar avg volume to 50-bar avg.
 */
function volumeComponent(candles: Candle[]): RegimeComponent {
  const n = candles.length;
  if (n < 50) return { name: 'volume', score: 0, detail: 'Insufficient data' };

  const volumes = candles.map(c => c.volume);
  const avg50 = mean(volumes.slice(n - 50));
  const avg5 = mean(volumes.slice(n - 5));

  if (avg50 <= 0) return { name: 'volume', score: 0, detail: 'Zero volume' };

  const ratio = avg5 / avg50;
  // Score: 0 = normal, 1 = extreme volume spike
  // ratio of 2x = 0.5, 4x = 0.75, 8x = 0.875 (tanh-like saturation)
  const score = Math.min(1, Math.max(0, 1 - 1 / ratio));

  return {
    name: 'volume',
    score,
    detail: `vol_ratio=${ratio.toFixed(2)}x vs 50-bar avg`,
  };
}

/**
 * Drawdown component: current drawdown from rolling ATH.
 * Deep drawdown signals bear/crisis regime.
 */
function drawdownComponent(closes: number[]): RegimeComponent {
  const n = closes.length;
  if (n < 20) return { name: 'drawdown', score: 0, detail: 'Insufficient data' };

  // Rolling ATH over entire lookback
  let ath = -Infinity;
  for (const c of closes) {
    if (c > ath) ath = c;
  }

  const current = closes[n - 1]!;
  const drawdown = ath > 0 ? (ath - current) / ath : 0;

  // Score: 0 = at ATH, 1 = severe drawdown (>30%)
  const score = Math.min(1, drawdown / 0.30);

  return {
    name: 'drawdown',
    score,
    detail: `dd=${(drawdown * 100).toFixed(2)}% from ATH ${ath.toFixed(2)}`,
  };
}

/**
 * Mean-reversion component: how far price is from long-term mean.
 * Helps distinguish sideways (near mean) from trending.
 */
function meanReversionComponent(closes: number[]): RegimeComponent {
  const n = closes.length;
  if (n < 200) return { name: 'mean_reversion', score: 0, detail: 'Insufficient data' };

  const sma200 = mean(closes.slice(n - 200));
  const current = closes[n - 1]!;
  const deviation = sma200 > 0 ? (current - sma200) / sma200 : 0;

  // Score: 0 = at mean, +1 = far above, -1 = far below
  const score = Math.max(-1, Math.min(1, Math.tanh(deviation * 5)));

  return {
    name: 'mean_reversion',
    score,
    detail: `dist_sma200=${(deviation * 100).toFixed(2)}%`,
  };
}

/**
 * Classify market regime from candle data.
 * Minimum 200 candles for reliable classification.
 *
 * Regime classification logic:
 * 1. Crisis: drawdown > 20% AND vol > 80th percentile
 * 2. High-Vol: vol > 75th percentile (not crisis)
 * 3. Bull: trend > 0.3 AND not high-vol
 * 4. Bear: trend < -0.3 AND not high-vol
 * 5. Sideways: everything else
 */
export function detectRegime(candles: Candle[]): RegimeResult {
  if (candles.length < 50) {
    return {
      regime: 'sideways',
      confidence: 0,
      components: [{ name: 'error', score: 0, detail: `Need ≥50 candles, have ${candles.length}` }],
    };
  }

  const closes = candles.map(c => c.close);

  const trend = trendComponent(closes);
  const vol = volatilityComponent(closes);
  const volume = volumeComponent(candles);
  const dd = drawdownComponent(closes);
  const mr = meanReversionComponent(closes);

  const components = [trend, vol, volume, dd, mr];

  // Classification with priority ordering
  let regime: Regime;
  let confidence: number;

  const isCrisis = dd.score > 0.66 && vol.score > 0.80;
  const isHighVol = vol.score > 0.75;
  const isBullish = trend.score > 0.3;
  const isBearish = trend.score < -0.3;

  if (isCrisis) {
    regime = 'crisis';
    // Confidence based on how extreme both drawdown and volatility are
    confidence = Math.min(1, (dd.score + vol.score) / 2);
  } else if (isHighVol) {
    regime = 'high_vol';
    confidence = Math.min(1, vol.score);
  } else if (isBullish) {
    regime = 'bull';
    // Confidence: higher trend score + lower vol = more confident bull
    confidence = Math.min(1, Math.abs(trend.score) * (1 - vol.score * 0.5));
  } else if (isBearish) {
    regime = 'bear';
    confidence = Math.min(1, Math.abs(trend.score) * (1 - vol.score * 0.5));
  } else {
    regime = 'sideways';
    // Sideways confidence: low trend + low vol = confident sideways
    const flatness = 1 - Math.abs(trend.score);
    const calmness = 1 - vol.score;
    confidence = Math.min(1, (flatness + calmness) / 2);
  }

  return { regime, confidence, components };
}

/**
 * Detect regime for multiple lookback windows and aggregate.
 * Uses 200-bar primary, with 50-bar and 100-bar as confirmation.
 */
export function detectRegimeMultiWindow(candles: Candle[]): RegimeResult {
  if (candles.length < 200) return detectRegime(candles);

  const full = detectRegime(candles);
  const mid = detectRegime(candles.slice(-100));
  const short = detectRegime(candles.slice(-50));

  // If all three agree, boost confidence
  if (full.regime === mid.regime && mid.regime === short.regime) {
    return {
      ...full,
      confidence: Math.min(1, full.confidence * 1.2),
    };
  }

  // If short-term diverges from long-term, reduce confidence (transition zone)
  if (full.regime !== short.regime) {
    return {
      ...full,
      confidence: full.confidence * 0.7,
      components: [
        ...full.components,
        { name: 'multi_window', score: 0, detail: `Short-term regime (${short.regime}) diverges from primary (${full.regime})` },
      ],
    };
  }

  return full;
}

/**
 * Map regime to strategy weight adjustments.
 * Returns multipliers per strategy type that agents should use.
 */
export function regimeStrategyWeights(regime: Regime): Record<string, number> {
  switch (regime) {
    case 'bull':
      return {
        momentum: 1.3,
        mean_reversion: 0.7,
        breakout: 1.2,
        volatility_regime: 0.8,
        trend_following: 1.4,
      };
    case 'bear':
      return {
        momentum: 1.1,
        mean_reversion: 0.8,
        breakout: 0.9,
        volatility_regime: 1.0,
        trend_following: 1.2,
      };
    case 'sideways':
      return {
        momentum: 0.6,
        mean_reversion: 1.4,
        breakout: 0.7,
        volatility_regime: 0.8,
        trend_following: 0.5,
      };
    case 'high_vol':
      return {
        momentum: 0.8,
        mean_reversion: 0.9,
        breakout: 1.3,
        volatility_regime: 1.5,
        trend_following: 0.7,
      };
    case 'crisis':
      return {
        momentum: 0.5,
        mean_reversion: 0.4,
        breakout: 0.6,
        volatility_regime: 1.5,
        trend_following: 0.5,
      };
  }
}
