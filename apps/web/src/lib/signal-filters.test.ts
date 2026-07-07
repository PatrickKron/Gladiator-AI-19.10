import { describe, expect, it } from 'vitest';
import { advancedFilterCount, decodeFilters, DEFAULT_FILTERS, encodeFilters } from './signal-filters.js';

describe('encodeFilters', () => {
  it('Default → leerer Query', () => {
    expect(encodeFilters(DEFAULT_FILTERS)).toBe('');
  });
  it('nur abweichende Werte + fav', () => {
    const q = encodeFilters({ ...DEFAULT_FILTERS, status: 'all', direction: 'long', favoritesOnly: true });
    const p = new URLSearchParams(q);
    expect(p.get('status')).toBe('all');
    expect(p.get('direction')).toBe('long');
    expect(p.get('fav')).toBe('1');
    expect(p.get('symbol')).toBeNull();
  });
});

describe('decodeFilters', () => {
  it('leerer Hash → Default', () => {
    expect(decodeFilters('#/signals')).toEqual(DEFAULT_FILTERS);
  });
  it('liest Werte + fav', () => {
    const f = decodeFilters('#/signals?status=all&direction=short&fav=1');
    expect(f.status).toBe('all');
    expect(f.direction).toBe('short');
    expect(f.favoritesOnly).toBe(true);
    expect(f.symbol).toBe('all');
  });
  it('Roundtrip encode→decode', () => {
    const orig = { ...DEFAULT_FILTERS, symbol: 'ETH/USDT', timeframe: '4h', favoritesOnly: true };
    expect(decodeFilters('#/signals?' + encodeFilters(orig))).toEqual(orig);
  });
});

describe('advancedFilterCount', () => {
  it('zählt nur erweiterte Nicht-Default-Filter', () => {
    expect(advancedFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(advancedFilterCount({ ...DEFAULT_FILTERS, status: 'all', favoritesOnly: true })).toBe(0);
    expect(advancedFilterCount({ ...DEFAULT_FILTERS, symbol: 'ETH/USDT', direction: 'long' })).toBe(2);
  });
});
