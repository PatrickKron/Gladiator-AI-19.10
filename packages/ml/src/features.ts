import { ema, rsi, atr, macd, bollinger, sma, type Candle } from '@gladiator/strategy-engine';

export type FeatureVector = {
  // Returns
  return1: number;
  return5: number;
  return10: number;
  return20: number;

  // Volatility
  volatility5: number;
  volatility20: number;
  atr14: number;
  atrPct: number;
  bollingerWidth: number;
  bollingerPosition: number;

  // Momentum
  rsi14: number;
  macdLine: number;
  macdHistogram: number;
  momentum10: number;
  momentum20: number;
  roc5: number;

  // Trend
  ema20Dist: number;
  ema50Dist: number;
  ema200Dist: number;
  emaCross2050: number;
  trendStrength: number;

  // Volume
  volumeRatio5: number;
  volumeRatio20: number;
  volumeTrend: number;

  // Market regime
  regime: number;
};

export const FEATURE_NAMES: (keyof FeatureVector)[] = [
  'return1', 'return5', 'return10', 'return20',
  'volatility5', 'volatility20', 'atr14', 'atrPct', 'bollingerWidth', 'bollingerPosition',
  'rsi14', 'macdLine', 'macdHistogram', 'momentum10', 'momentum20', 'roc5',
  'ema20Dist', 'ema50Dist', 'ema200Dist', 'emaCross2050', 'trendStrength',
  'volumeRatio5', 'volumeRatio20', 'volumeTrend',
  'regime',
];

const MIN_CANDLES = 220;

function logReturn(current: number, previous: number): number {
  if (previous <= 0 || current <= 0) return 0;
  return Math.log(current / previous);
}

function rollingStd(values: number[], end: number, period: number): number {
  if (end < period - 1) return 0;
  const slice = values.slice(end - period + 1, end + 1);
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, x) => a + (x - m) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function detectRegime(closes: number[], ema50Vals: (number | null)[], ema200Vals: (number | null)[], idx: number): number {
  const e50 = ema50Vals[idx];
  const e200 = ema200Vals[idx];
  const close = closes[idx]!;
  if (e50 == null || e200 == null) return 0;
  if (close > e50 && e50 > e200) return 1;   // Strong bull
  if (close > e200 && close < e50) return 0.5; // Weakening bull
  if (close < e50 && e50 < e200) return -1;  // Strong bear
  if (close < e200 && close > e50) return -0.5; // Weakening bear
  return 0; // Ranging
}

export function computeFeatures(candles: Candle[]): FeatureVector | null {
  if (candles.length < MIN_CANDLES) return null;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const idx = closes.length - 1;

  // Pre-compute indicators (reusing strategy-engine)
  const ema20Vals = ema(closes, 20);
  const ema50Vals = ema(closes, 50);
  const ema200Vals = ema(closes, 200);
  const rsiVals = rsi(closes, 14);
  const atrVals = atr(candles, 14);
  const macdResult = macd(closes);
  const bollResult = bollinger(closes, 20, 2);
  const sma5Vol = sma(volumes, 5);
  const sma20Vol = sma(volumes, 20);

  // Log returns
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(logReturn(closes[i]!, closes[i - 1]!));
  }

  const e20 = ema20Vals[idx];
  const e50 = ema50Vals[idx];
  const e200 = ema200Vals[idx];
  const close = closes[idx]!;
  const atrVal = atrVals[idx];

  if (e20 == null || e50 == null || e200 == null || atrVal == null) return null;
  if (rsiVals[idx] == null) return null;

  const bMid = bollResult.middle[idx];
  const bUp = bollResult.upper[idx];
  const bLow = bollResult.lower[idx];

  return {
    return1: logReturn(close, closes[idx - 1]!),
    return5: logReturn(close, closes[idx - 5]!),
    return10: logReturn(close, closes[idx - 10]!),
    return20: logReturn(close, closes[idx - 20]!),

    volatility5: rollingStd(returns, returns.length - 1, 5),
    volatility20: rollingStd(returns, returns.length - 1, 20),
    atr14: atrVal,
    atrPct: close > 0 ? atrVal / close : 0,
    bollingerWidth: bUp != null && bLow != null && bMid != null && bMid > 0
      ? (bUp - bLow) / bMid
      : 0,
    bollingerPosition: bUp != null && bLow != null && bUp !== bLow
      ? (close - bLow) / (bUp - bLow)
      : 0.5,

    rsi14: rsiVals[idx]!,
    macdLine: macdResult.macd[idx] ?? 0,
    macdHistogram: macdResult.histogram[idx] ?? 0,
    momentum10: close - closes[idx - 10]!,
    momentum20: close - closes[idx - 20]!,
    roc5: closes[idx - 5]! > 0 ? (close - closes[idx - 5]!) / closes[idx - 5]! * 100 : 0,

    ema20Dist: (close - e20) / e20,
    ema50Dist: (close - e50) / e50,
    ema200Dist: (close - e200) / e200,
    emaCross2050: e20 > e50 ? 1 : e20 < e50 ? -1 : 0,
    trendStrength: Math.abs((e20 - e200) / e200),

    volumeRatio5: sma5Vol[idx] != null && sma20Vol[idx] != null && sma20Vol[idx]! > 0
      ? sma5Vol[idx]! / sma20Vol[idx]!
      : 1,
    volumeRatio20: sma20Vol[idx] != null && volumes[idx]! > 0 && sma20Vol[idx]! > 0
      ? volumes[idx]! / sma20Vol[idx]!
      : 1,
    volumeTrend: sma5Vol[idx] != null && sma20Vol[idx] != null && sma20Vol[idx]! > 0
      ? (sma5Vol[idx]! - sma20Vol[idx]!) / sma20Vol[idx]!
      : 0,

    regime: detectRegime(closes, ema50Vals, ema200Vals, idx),
  };
}

export function featureVectorToArray(fv: FeatureVector): number[] {
  return FEATURE_NAMES.map(k => fv[k]);
}

export function arrayToFeatureVector(arr: number[]): FeatureVector {
  const fv = {} as FeatureVector;
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    (fv as Record<string, number>)[FEATURE_NAMES[i]!] = arr[i] ?? 0;
  }
  return fv;
}
