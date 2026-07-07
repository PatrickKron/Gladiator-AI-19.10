import { describe, expect, it } from 'vitest';
import { parseLabConfig } from './lab-config.js';

describe('parseLabConfig', () => {
  it('parst eine vollständige, gültige Konfiguration', () => {
    const json = JSON.stringify({ symbol: 'BTC/USDT', timeframe: '1h', setupType: 'swing', riskPct: 1 });
    expect(parseLabConfig(json)).toEqual({ symbol: 'BTC/USDT', timeframe: '1h', setupType: 'swing', riskPct: 1 });
  });
  it('null bei null/leer', () => {
    expect(parseLabConfig(null)).toBeNull();
    expect(parseLabConfig('')).toBeNull();
  });
  it('null bei kaputtem JSON', () => {
    expect(parseLabConfig('{nope')).toBeNull();
  });
  it('null bei fehlenden/falsch-typisierten Feldern', () => {
    expect(parseLabConfig(JSON.stringify({ symbol: 'BTC/USDT', timeframe: '1h', setupType: 'swing' }))).toBeNull();
    expect(parseLabConfig(JSON.stringify({ symbol: 'BTC/USDT', timeframe: '1h', setupType: 'swing', riskPct: 'x' }))).toBeNull();
  });
});
