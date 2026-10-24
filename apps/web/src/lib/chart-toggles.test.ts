import { describe, expect, it } from 'vitest';
import { CHIP_KEYS, DEFAULT_TOGGLES, parseToggles, TOGGLE_KEYS } from './chart-toggles.js';

describe('Chart-Ansicht: Standard wie in v2, gespeicherte Wahl gewinnt', () => {
  it('ohne gespeicherte Wahl: v2-Standard (EMA, Volumen, BOS/CHoCH, OB/FVG, Signale, RSI an)', () => {
    const t = parseToggles(null);
    expect(t).toEqual(DEFAULT_TOGGLES);
    expect(t.structure).toBe(true);
    expect(t.zones).toBe(true);
    expect(t.rsi).toBe(true);
    expect(t.ema).toBe(true);
    expect(t.volume).toBe(true);
    expect(t.signals).toBe(true);
    // in v2 aus — bleibt aus
    expect(t.bollinger).toBe(false);
    expect(t.macd).toBe(false);
    expect(t.atr).toBe(false);
    expect(t.liquidity).toBe(false);
    expect(t.pd).toBe(false);
  });

  it('eine gespeicherte Wahl wird nie vom Standard überschrieben', () => {
    const stored = { ...DEFAULT_TOGGLES, structure: false, zones: false, rsi: false, macd: true };
    expect(parseToggles(JSON.stringify(stored))).toEqual(stored);
  });

  it('fehlende oder fremde Schlüssel: nur die fehlenden fallen auf den Standard', () => {
    const t = parseToggles(JSON.stringify({ rsi: false, fremd: true, ema: 'ja' }));
    expect(t.rsi).toBe(false);
    expect(t.ema).toBe(DEFAULT_TOGGLES.ema); // kein Boolean → Standard
    expect(t).not.toHaveProperty('fremd');
    expect(t.structure).toBe(true);
  });

  it('kaputtes JSON oder kein Objekt → Standard (nie ein Absturz)', () => {
    expect(parseToggles('{kaputt')).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles('[1,2]')).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles('null')).toEqual(DEFAULT_TOGGLES);
  });

  it('liefert immer eine Kopie (Standard bleibt unverändert)', () => {
    const t = parseToggles(null);
    t.rsi = false;
    expect(DEFAULT_TOGGLES.rsi).toBe(true);
  });

  it('die neun Ein-Klick-Chips der Werkzeugzeile in v2-Reihenfolge', () => {
    expect(CHIP_KEYS).toEqual(['ema', 'bollinger', 'volume', 'structure', 'zones', 'signals', 'rsi', 'macd', 'atr']);
    for (const k of CHIP_KEYS) expect(TOGGLE_KEYS).toContain(k);
  });
});
