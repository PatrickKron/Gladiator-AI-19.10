import type { Candle } from './types.js';
import { atr, sma } from './indicators.js';

/**
 * Erweiterte Indikatoren (Patrick: „eigene Indikatoren im Chart wie TradingView").
 * Alle rein, ausgerichtet auf die Kerzenlänge; Positionen ohne ausreichende
 * Historie/Volumen sind null — kein Raten. Style wie indicators.ts.
 */

const typicalPrice = (c: Candle) => (c.high + c.low + c.close) / 3;

/**
 * VWAP. Ohne `period`: kumulativ ab Serienbeginn (klassisches Session-VWAP,
 * hier über die geladene Serie). Mit `period`: rollend über die letzten n Bars.
 * Fenster ohne Volumen → null (kein erfundener Kurs).
 */
export function vwap(candles: Candle[], period?: number): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period == null) {
    let pv = 0;
    let vol = 0;
    for (let i = 0; i < n; i++) {
      pv += typicalPrice(candles[i]!) * candles[i]!.volume;
      vol += candles[i]!.volume;
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }
  for (let i = period - 1; i < n; i++) {
    let pv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pv += typicalPrice(candles[j]!) * candles[j]!.volume;
      vol += candles[j]!.volume;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/**
 * Stochastik-Oszillator. Raw %K = 100·(Close − Tief_n)/(Hoch_n − Tief_n);
 * %K geglättet (smoothK-SMA, „slow" bei smoothK>1); %D = SMA(%K, dPeriod).
 * Flaches Fenster (Hoch=Tief) → 50 (neutral, weder über- noch unterkauft).
 */
export function stochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
  smoothK = 1,
): { k: (number | null)[]; d: (number | null)[] } {
  const n = candles.length;
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j]!.high > hi) hi = candles[j]!.high;
      if (candles[j]!.low < lo) lo = candles[j]!.low;
    }
    const range = hi - lo;
    rawK[i] = range === 0 ? 50 : (100 * (candles[i]!.close - lo)) / range;
  }
  const k = smoothK > 1 ? smaNullable(rawK, smoothK) : rawK;
  const d = smaNullable(k, dPeriod);
  return { k, d };
}

/** SMA über eine Serie mit null-Lücken: erst ab dem ersten definierten Wert. */
function smaNullable(values: (number | null)[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const first = values.findIndex((v) => v != null);
  if (first === -1) return out;
  const defined = values.slice(first).map((v) => v ?? 0);
  const s = sma(defined, period);
  for (let i = 0; i < s.length; i++) out[first + i] = s[i] ?? null;
  return out;
}

/**
 * ADX / DMI nach Wilder. Liefert +DI, −DI, ADX (alle 0..100), ausgerichtet.
 * +DI/−DI ab Index `period`, ADX ab `2·period − 1`; davor null.
 */
export function adx(
  candles: Candle[],
  period = 14,
): { plusDi: (number | null)[]; minusDi: (number | null)[]; adx: (number | null)[] } {
  const n = candles.length;
  const plusDi: (number | null)[] = new Array(n).fill(null);
  const minusDi: (number | null)[] = new Array(n).fill(null);
  const adxOut: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return { plusDi, minusDi, adx: adxOut };

  const tr = new Array(n).fill(0);
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close),
    );
  }

  // Wilder-Glättung (Startsumme über die ersten `period` Werte ab Index 1)
  let sTr = 0;
  let sPlus = 0;
  let sMinus = 0;
  for (let i = 1; i <= period; i++) {
    sTr += tr[i];
    sPlus += plusDm[i];
    sMinus += minusDm[i];
  }
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      sTr = sTr - sTr / period + tr[i];
      sPlus = sPlus - sPlus / period + plusDm[i];
      sMinus = sMinus - sMinus / period + minusDm[i];
    }
    const pdi = sTr === 0 ? 0 : (100 * sPlus) / sTr;
    const mdi = sTr === 0 ? 0 : (100 * sMinus) / sTr;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }

  // ADX = Wilder-Glättung von DX; erste ADX = Mittel der ersten `period` DX-Werte
  const firstDx = period;
  const firstAdx = firstDx + period - 1;
  if (firstAdx < n) {
    let acc = 0;
    for (let i = firstDx; i <= firstAdx; i++) acc += dx[i]!;
    let a = acc / period;
    adxOut[firstAdx] = a;
    for (let i = firstAdx + 1; i < n; i++) {
      a = (a * (period - 1) + dx[i]!) / period;
      adxOut[i] = a;
    }
  }
  return { plusDi, minusDi, adx: adxOut };
}

export type SupertrendPoint = { value: number; direction: 'up' | 'down' };

/**
 * Supertrend (ATR-basiert): Trend-Band unter (up) bzw. über (down) dem Preis,
 * Standard-Regeln für finale Bänder + Richtungswechsel. null vor ATR-Warmup.
 */
export function supertrend(candles: Candle[], period = 10, mult = 3): (SupertrendPoint | null)[] {
  const n = candles.length;
  const out: (SupertrendPoint | null)[] = new Array(n).fill(null);
  const a = atr(candles, period);

  let finalUpper = 0;
  let finalLower = 0;
  let prevDir: 'up' | 'down' = 'up';
  let started = false;

  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const hl2 = (candles[i]!.high + candles[i]!.low) / 2;
    const basicUpper = hl2 + mult * a[i]!;
    const basicLower = hl2 - mult * a[i]!;

    if (!started) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      prevDir = candles[i]!.close >= hl2 ? 'up' : 'down';
      out[i] = { value: prevDir === 'up' ? finalLower : finalUpper, direction: prevDir };
      started = true;
      continue;
    }

    const prevClose = candles[i - 1]!.close;
    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

    let dir: 'up' | 'down';
    if (prevDir === 'up') dir = candles[i]!.close < finalLower ? 'down' : 'up';
    else dir = candles[i]!.close > finalUpper ? 'up' : 'down';

    out[i] = { value: dir === 'up' ? finalLower : finalUpper, direction: dir };
    prevDir = dir;
  }
  return out;
}

/** On-Balance Volume: kumuliertes Volumen, +bei Anstieg, −bei Rückgang. */
export function obv(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    out[i] = cur > prev ? out[i - 1] + candles[i]!.volume : cur < prev ? out[i - 1] - candles[i]!.volume : out[i - 1];
  }
  return out;
}
