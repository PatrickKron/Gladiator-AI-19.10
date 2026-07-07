import type { Candle } from '@gladiator/strategy-engine';

export type LabelInput = {
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  entryBarIndex: number;
  maxHoldingBars: number;
};

export type Label = {
  outcome: 0 | 1;
  returnPct: number;
  holdingBars: number;
  exitReason: 'tp' | 'sl' | 'timeout';
  exitPrice: number;
};

/**
 * Meta-Labeling: Determines if a signal was profitable by simulating
 * the trade forward through actual OHLCV data.
 *
 * Returns the binary label (0=loss, 1=profit) plus the return percentage
 * and holding period. Uses bar-by-bar simulation: checks SL first (worst
 * case), then TP1 (first take-profit), then timeout at maxHoldingBars.
 *
 * Look-ahead-free: only uses bars AFTER entryBarIndex.
 */
export function labelSignal(candles: Candle[], input: LabelInput): Label | null {
  const { direction, entryPrice, stopLoss, takeProfits, entryBarIndex, maxHoldingBars } = input;

  if (entryBarIndex < 0 || entryBarIndex >= candles.length - 1) return null;
  if (entryPrice <= 0 || stopLoss <= 0) return null;
  if (takeProfits.length === 0) return null;

  const tp1 = takeProfits[0]!;
  const endBar = Math.min(entryBarIndex + maxHoldingBars, candles.length - 1);

  for (let i = entryBarIndex + 1; i <= endBar; i++) {
    const bar = candles[i]!;
    const holding = i - entryBarIndex;

    if (direction === 'long') {
      // Check SL first (conservative: assume worst case hit first within bar)
      if (bar.low <= stopLoss) {
        const ret = (stopLoss - entryPrice) / entryPrice * 100;
        return { outcome: 0, returnPct: ret, holdingBars: holding, exitReason: 'sl', exitPrice: stopLoss };
      }
      // Check TP1
      if (bar.high >= tp1) {
        const ret = (tp1 - entryPrice) / entryPrice * 100;
        return { outcome: 1, returnPct: ret, holdingBars: holding, exitReason: 'tp', exitPrice: tp1 };
      }
    } else {
      // Short: SL is above entry, TP is below
      if (bar.high >= stopLoss) {
        const ret = (entryPrice - stopLoss) / entryPrice * 100;
        return { outcome: 0, returnPct: ret, holdingBars: holding, exitReason: 'sl', exitPrice: stopLoss };
      }
      if (bar.low <= tp1) {
        const ret = (entryPrice - tp1) / entryPrice * 100;
        return { outcome: 1, returnPct: ret, holdingBars: holding, exitReason: 'tp', exitPrice: tp1 };
      }
    }
  }

  // Timeout: mark at close of last bar
  const exitBar = candles[endBar]!;
  const exitPrice = exitBar.close;
  const ret = direction === 'long'
    ? (exitPrice - entryPrice) / entryPrice * 100
    : (entryPrice - exitPrice) / entryPrice * 100;

  return {
    outcome: ret > 0 ? 1 : 0,
    returnPct: ret,
    holdingBars: endBar - entryBarIndex,
    exitReason: 'timeout',
    exitPrice,
  };
}

/**
 * Batch-label multiple signals against the same candle series.
 * Filters out signals that can't be labeled (insufficient future bars).
 */
export function batchLabel(
  candles: Candle[],
  inputs: LabelInput[],
): (Label | null)[] {
  return inputs.map(input => labelSignal(candles, input));
}
