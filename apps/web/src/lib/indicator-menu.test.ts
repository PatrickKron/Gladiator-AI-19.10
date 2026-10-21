import { describe, expect, it } from 'vitest';
import { clampNumber, editableInputs, effectivePlotStyle, filterCatalog, firstPlotTime, inputRows, instanceLabel, legendColor, visiblePlotIds, type MenuEntry } from './indicator-menu.js';

const rsi: MenuEntry = {
  id: 'rsi',
  group: 'standard',
  name: 'Relative strength index',
  shortName: 'RSI',
  description: null,
  category: 'Oscillators',
  overlay: false,
  inputs: [
    { id: 'length', type: 'int', defval: 14, title: 'RSI Length', min: 1, group: 'RSI Settings' },
    { id: 'src', type: 'source', defval: 'close', group: 'RSI Settings' },
    { id: 'maType', type: 'string', defval: 'SMA', options: ['None', 'SMA', 'EMA'], group: 'Smoothing', display: 'none' },
    { id: 'maLength', type: 'int', defval: 14, group: 'Smoothing', display: 'none', active: { input: 'maType', ne: 'None' } },
    { id: 'bbMult', type: 'float', defval: 2, min: 0.001, max: 50, group: 'Smoothing', inline: 'bb' },
    { id: 'bbColor', type: 'color', defval: '#fff', group: 'Smoothing', inline: 'bb' },
    { id: 'other', type: 'symbol', defval: '' },
  ],
  defaultInputs: { length: 14, src: 'close', maType: 'SMA', maLength: 14, bbMult: 2, bbColor: '#fff' },
  plots: [
    { id: 'plot0', title: 'RSI', color: '#7E57C2', lineWidth: 1 },
    { id: 'plot6', title: 'Plot', color: 'transparent', lineWidth: 0, display: 'none' },
  ],
  hlines: [],
  fills: [],
  extraTimeframes: [],
};
const macd: MenuEntry = { ...rsi, id: 'macd', name: 'Moving average convergence divergence', shortName: 'MACD', category: 'Momentum', inputs: [{ id: 'fast', type: 'int', defval: 12 }, { id: 'slow', type: 'int', defval: 26 }, { id: 'sig', type: 'int', defval: 9 }] };
const engulf: MenuEntry = { ...rsi, id: 'engulfing-bullish', name: 'Engulfing (bullish)', shortName: 'Engulfing - Bull', group: 'candlestick', category: 'Candlestick Patterns', overlay: true, inputs: [{ id: 'x', type: 'int', defval: 3 }] };

describe('filterCatalog', () => {
  it('sucht in Name/Kürzel/Id/Kategorie, alle Wörter, optional Kategorie', () => {
    const all = [rsi, macd, engulf];
    expect(filterCatalog(all, '', null)).toHaveLength(3);
    expect(filterCatalog(all, 'rsi', null).map((e) => e.id)).toEqual(['rsi']);
    expect(filterCatalog(all, 'moving conv', null).map((e) => e.id)).toEqual(['macd']);
    expect(filterCatalog(all, 'BULL engulf', null).map((e) => e.id)).toEqual(['engulfing-bullish']);
    expect(filterCatalog(all, 'oscill', null).map((e) => e.id)).toEqual(['rsi']);
    expect(filterCatalog(all, '', 'Momentum').map((e) => e.id)).toEqual(['macd']);
    expect(filterCatalog(all, 'rsi', 'Momentum')).toEqual([]);
  });
});

describe('instanceLabel', () => {
  it('Kürzel + aktive sichtbare Zahlen; Muster nur Kürzel', () => {
    expect(instanceLabel(rsi, rsi.defaultInputs)).toBe('RSI 14 2');
    // maLength ist display none (nicht in der Statuszeile), bleibt auch bei aktivem MA draußen
    expect(instanceLabel(rsi, { ...rsi.defaultInputs, maType: 'EMA', maLength: 9 })).toBe('RSI 14 2');
    expect(instanceLabel(macd, { fast: 12, slow: 26, sig: 9 })).toBe('MACD 12 26 9');
    expect(instanceLabel({ ...macd, inputs: [{ id: 'f', type: 'float', defval: 2.5 }] }, { f: 2.5 })).toBe('MACD 2.5');
    expect(instanceLabel(engulf, { x: 3 })).toBe('Engulfing - Bull');
  });
});

describe('editableInputs / inputRows', () => {
  it('symbol-Eingaben fehlen, inaktive sind gesperrt, inline teilt Zeilen, Gruppen wechseln', () => {
    const items = editableInputs(rsi, rsi.defaultInputs);
    expect(items.map((i) => i.decl.id)).toEqual(['length', 'src', 'maType', 'maLength', 'bbMult', 'bbColor']);
    expect(items.find((i) => i.decl.id === 'maLength')?.active).toBe(true); // SMA ≠ None
    expect(editableInputs(rsi, { ...rsi.defaultInputs, maType: 'None' }).find((i) => i.decl.id === 'maLength')?.active).toBe(false);
    const rows = inputRows(items);
    expect(rows.map((r) => [r.group, r.inputs.map((i) => i.decl.id)])).toEqual([
      ['RSI Settings', ['length']],
      ['RSI Settings', ['src']],
      ['Smoothing', ['maType']],
      ['Smoothing', ['maLength']],
      ['Smoothing', ['bbMult', 'bbColor']],
    ]);
  });
});

describe('Stil & Helfer', () => {
  it('effectivePlotStyle, legendColor, firstPlotTime, clampNumber', () => {
    expect(effectivePlotStyle(rsi.plots[0]!, null)).toEqual({ visible: true, color: '#7E57C2', lineWidth: 1 });
    expect(effectivePlotStyle(rsi.plots[1]!, null).visible).toBe(false);
    expect(effectivePlotStyle(rsi.plots[0]!, { plots: { plot0: { color: '#f00', lineWidth: 3 } } })).toEqual({ visible: true, color: '#f00', lineWidth: 3 });
    expect(legendColor(rsi, null)).toBe('#7E57C2');
    expect(legendColor(rsi, { plots: { plot0: { visible: false } } })).toBe('#8b94b8');
    expect(firstPlotTime({ plots: { a: [{ time: 30 }, { time: 40 }], b: [{ time: 20 }] } })).toBe(20);
    expect(firstPlotTime({ plots: {} })).toBeNull();
    expect(firstPlotTime(null)).toBeNull();
    expect(clampNumber('2,7', { type: 'int', min: 1, max: 5 }, 9)).toBe(3);
    expect(clampNumber('99', { type: 'int', min: 1, max: 5 }, 9)).toBe(5);
    expect(clampNumber('abc', { type: 'float' }, 9)).toBe(9);
    expect(clampNumber('0.0001', { type: 'float', min: 0.001 }, 9)).toBe(0.001);
  });
});

describe('Warmup: sichtbare Plots zuerst', () => {
  it('nimmt den ersten sichtbaren Plot mit Werten, sonst das Minimum über alle', () => {
    // RSI: plot0 (RSI) ab Kerze 15, versteckter Hilfs-Plot plot6 ab Kerze 1 — das wäre ein falsches „ab Kerze 1"
    const result = { plots: { plot0: [{ time: 15 }, { time: 16 }], plot1: [{ time: 28 }], plot6: [{ time: 1 }] } };
    const entry = {
      plots: [
        { id: 'plot0', title: 'RSI', color: '#7E57C2' },
        { id: 'plot1', title: 'MA', color: '#f5b642' },
        { id: 'plot6', title: 'Hilfs', color: 'transparent', display: 'none' as const },
      ],
    };
    expect(visiblePlotIds(entry)).toEqual(['plot0', 'plot1']);
    expect(firstPlotTime(result, visiblePlotIds(entry))).toBe(15);
    expect(firstPlotTime(result)).toBe(1);
    // erster sichtbarer Plot ohne Werte → nächster sichtbarer
    expect(firstPlotTime({ plots: { plot0: [], plot1: [{ time: 28 }], plot6: [{ time: 1 }] } }, ['plot0', 'plot1'])).toBe(28);
    // kein sichtbarer Plot mit Werten → Minimum über alle (ehrlich, aber Hilfs-Plot)
    expect(firstPlotTime({ plots: { plot0: [], plot6: [{ time: 3 }] } }, ['plot0'])).toBe(3);
    expect(firstPlotTime(null, ['plot0'])).toBeNull();
  });
});
