import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_CATEGORIES, catalogEntry } from './catalog.js';
import { inputActive, sanitizeInput, sanitizeInputs } from './inputs.js';

describe('Katalog', () => {
  it('bietet Standard-Indikatoren und Kerzenmuster, keine Community-Ports; Ids eindeutig', () => {
    const groups = new Set(CATALOG.map((e) => e.group));
    expect([...groups].sort()).toEqual(['candlestick', 'standard']);
    expect(CATALOG.filter((e) => e.group === 'standard').length).toBeGreaterThanOrEqual(110);
    expect(CATALOG.filter((e) => e.group === 'candlestick').length).toBeGreaterThanOrEqual(40);
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    // jede Kategorie des Katalogs ist im Menü eingeordnet
    for (const e of CATALOG) expect(CATALOG_CATEGORIES).toContain(e.category);
    // die Bausteine, die das Menü sicher braucht
    for (const id of ['sma', 'ema', 'rsi', 'macd', 'bb', 'atr', 'supertrend', 'ichimoku', 'vwap', 'engulfing-bullish']) {
      expect(catalogEntry(id), id).toBeDefined();
    }
  });

  it('Einträge sind reine Daten (JSON-tauglich) mit Defaults für jede Eingabe', () => {
    for (const e of CATALOG) {
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
      for (const i of e.inputs) expect(e.defaultInputs, `${e.id}.${i.id}`).toHaveProperty(i.id);
    }
  });
});

describe('sanitizeInputs', () => {
  it('Typ, Grenzen und Optionen; Unbekanntes fällt weg, Ungültiges → Default', () => {
    const rsi = catalogEntry('rsi')!;
    const s = sanitizeInputs(rsi, { length: '21', src: 'hl2', maType: 'Quatsch', calculateDivergence: 'true', fremd: 1, bbMult: -5 });
    expect(s.length).toBe(21);
    expect(s.src).toBe('hl2');
    expect(s.maType).toBe(rsi.defaultInputs.maType);
    expect(s.calculateDivergence).toBe(true);
    expect(s).not.toHaveProperty('fremd');
    // bbMult hat min 0.001 → geklemmt
    expect(s.bbMult).toBe(0.001);
    // Ganzzahl unter dem Minimum → auf min geklemmt; nicht numerisch → Default
    expect(sanitizeInputs(rsi, { length: 0 }).length).toBe(1);
    expect(sanitizeInputs(rsi, { length: 'abc' }).length).toBe(rsi.defaultInputs.length);
    expect(sanitizeInputs(rsi, null)).toEqual(rsi.defaultInputs);
  });

  it('Einzelwerte: Farbe, Quelle, Bool', () => {
    expect(sanitizeInput({ id: 'c', type: 'color', defval: '#fff' }, '#1a2b3c')).toBe('#1a2b3c');
    expect(sanitizeInput({ id: 'c', type: 'color', defval: '#fff' }, 'rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
    expect(sanitizeInput({ id: 'c', type: 'color', defval: '#fff' }, 'red; drop')).toBeNull();
    expect(sanitizeInput({ id: 's', type: 'source', defval: 'close' }, 'volume')).toBe('volume');
    expect(sanitizeInput({ id: 's', type: 'source', defval: 'close' }, 'nope')).toBeNull();
    expect(sanitizeInput({ id: 'b', type: 'bool', defval: false }, 'false')).toBe(false);
    expect(sanitizeInput({ id: 'f', type: 'float', defval: 1, min: 0, max: 10 }, '2,5')).toBe(2.5);
    // Symbol-Eingaben lädt der Server nicht nach
    expect(sanitizeInput({ id: 'y', type: 'symbol', defval: '' }, 'AAPL')).toBeNull();
  });
});

describe('inputActive', () => {
  it('wertet Pine-active-Bedingungen ohne die Bibliothek aus', () => {
    const v = { maType: 'None', show: true, n: 3 };
    expect(inputActive(undefined, v)).toBe(true);
    expect(inputActive(false, v)).toBe(false);
    expect(inputActive('show', v)).toBe(true);
    expect(inputActive({ input: 'maType', ne: 'None' }, v)).toBe(false);
    expect(inputActive({ input: 'maType', eq: 'None' }, v)).toBe(true);
    expect(inputActive({ not: 'show' }, v)).toBe(false);
    expect(inputActive({ any: [{ input: 'n', eq: 1 }, 'show'] }, v)).toBe(true);
    expect(inputActive({ all: [{ input: 'n', eq: 3 }, { not: 'show' }] }, v)).toBe(false);
  });
});
