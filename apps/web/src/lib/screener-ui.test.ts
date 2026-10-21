import { describe, expect, it } from 'vitest';
import { conditionLabel, defaultCondition, defaultOperand, fmtNum, numericInputs, operandLabel, plotChoices, CONDITION_KINDS, OPERAND_KINDS } from './screener-ui.js';

const t = (k: string) => k;
const entries = {
  rsi: { shortName: 'RSI', inputs: [{ id: 'length', type: 'int' as const, defval: 14, title: 'RSI Length' }, { id: 'src', type: 'source' as const, defval: 'close' }], defaultInputs: { length: 14, src: 'close' } },
  ema: { shortName: 'EMA', inputs: [{ id: 'length', type: 'int' as const, defval: 9 }, { id: 'hidden', type: 'float' as const, defval: 1, display: 'none' as const }], defaultInputs: { length: 9, hidden: 1 } },
  'engulfing-bullish': { shortName: 'Engulfing (bull)', inputs: [], defaultInputs: {} },
};
const entryOf = (id: string) => entries[id as keyof typeof entries];

describe('Screener-Helfer', () => {
  it('Standard-Bedingungen und -Operanden sind für jede Art definiert', () => {
    for (const k of CONDITION_KINDS) expect(defaultCondition(k).kind).toBe(k);
    for (const k of OPERAND_KINDS) expect(defaultOperand(k).kind).toBe(k);
  });

  it('Beschriftung: Indikator mit Zahlen-Eingaben, Operatoren als Zeichen, Muster/Struktur/Liquidität/Range', () => {
    expect(operandLabel({ kind: 'indicator', id: 'ema', inputs: { length: 200 } }, entryOf, t)).toBe('EMA 200');
    expect(operandLabel({ kind: 'indicator', id: 'rsi' }, entryOf, t)).toBe('RSI 14'); // Default aus dem Katalog
    expect(operandLabel({ kind: 'indicator', id: 'unbekannt' }, entryOf, t)).toBe('unbekannt');
    expect(operandLabel({ kind: 'volume_avg', bars: 20, mult: 2 }, entryOf, t)).toBe('Ø Vol 20 × 2');
    expect(operandLabel({ kind: 'change', bars: 24 }, entryOf, t)).toBe('Δ% 24');
    expect(conditionLabel({ kind: 'compare', left: { kind: 'indicator', id: 'rsi', plot: 'plot0' }, op: '<', right: { kind: 'number', value: 30 } }, entryOf, t)).toBe('RSI 14 < 30');
    expect(conditionLabel({ kind: 'compare', left: { kind: 'price' }, op: 'crosses_above', right: { kind: 'indicator', id: 'ema', inputs: { length: 50 } } }, entryOf, t)).toBe('screener.op_price ↗ EMA 50');
    expect(conditionLabel({ kind: 'pattern', id: 'engulfing-bullish', withinBars: 3 }, entryOf, t)).toBe('Engulfing (bull) ≤ 3');
    expect(conditionLabel({ kind: 'structure', event: 'CHoCH', direction: 'bullish', withinBars: 12 }, entryOf, t)).toBe('CHoCH screener.dir_bullish ≤ 12');
    expect(conditionLabel({ kind: 'structure', event: 'BOS', withinBars: 5 }, entryOf, t)).toBe('BOS ≤ 5');
    expect(conditionLabel({ kind: 'liquidity', what: 'eqh_open', withinBars: 100 }, entryOf, t)).toBe('screener.liq_eqh_open ≤ 100');
    expect(conditionLabel({ kind: 'range', zone: 'discount' }, entryOf, t)).toBe('screener.zone_discount');
  });

  it('numerische, sichtbare Eingaben; sichtbare Plots; Zahlenformat', () => {
    expect(numericInputs(entries.rsi).map((i) => i.id)).toEqual(['length']);
    expect(numericInputs(entries.ema).map((i) => i.id)).toEqual(['length']); // display none fällt raus
    expect(plotChoices({ plots: [{ id: 'plot0', title: 'RSI', color: '#fff' }, { id: 'plot9', title: 'Hilfs', color: 'transparent', display: 'none' }] })).toEqual([{ id: 'plot0', title: 'RSI' }]);
    // Zahlenformat folgt der UI-Sprache (Standard Deutsch), nie der Browser-Locale
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(0.123456789)).toBe('0,123457');
    expect(fmtNum(12.3456)).toBe('12,35');
    expect(fmtNum(12345.678)).toBe('12.345,7');
  });
});
