import { describe, expect, it } from 'vitest';
import { DEFAULT_TP_WEIGHTS, MAX_LIVE_TAKE_PROFITS, tpFractions } from './tp-weights.js';

describe('tpFractions: Teil-Exit-Anteile je TP (eine Funktion für Backtest UND Live)', () => {
  it('Default-Schema A = 50/30/20, live max. 3 TP-Orders', () => {
    expect(DEFAULT_TP_WEIGHTS).toEqual([0.5, 0.3, 0.2]);
    expect(MAX_LIVE_TAKE_PROFITS).toBe(3);
  });

  it('gleiche Anzahl → unverändert', () => {
    expect(tpFractions([0.5, 0.3, 0.2], 3)).toEqual([0.5, 0.3, 0.2]);
    expect(tpFractions([0.6, 0.4], 2)).toEqual([0.6, 0.4]);
  });

  it('weniger TPs als Gewichte → Restgewicht auf den letzten TP (Summe bleibt 1)', () => {
    expect(tpFractions([0.5, 0.3, 0.2], 2)).toEqual([0.5, 0.5]);
    expect(tpFractions([0.5, 0.3, 0.2], 1)).toEqual([1]);
  });

  it('mehr TPs als Gewichte → überzählige TPs bekommen 0', () => {
    expect(tpFractions([0.5, 0.3, 0.2], 5)).toEqual([0.5, 0.3, 0.2, 0, 0]);
  });

  it('verändert das Eingabe-Array nicht', () => {
    const w = [0.5, 0.3, 0.2];
    tpFractions(w, 1);
    expect(w).toEqual([0.5, 0.3, 0.2]);
  });
});
