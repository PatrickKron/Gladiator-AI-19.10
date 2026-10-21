import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isChartLayout, layoutGridClass, loadChartLayout, normalizeCells, saveChartLayout } from './chart-layout.js';

// Node hat kein localStorage — kleiner In-Memory-Ersatz mit derselben Schnittstelle.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

describe('Mehrfach-Charts: Layout und Zellen', () => {
  beforeEach(() => localStorage.clear());

  it('normalizeCells liefert genau layout − 1 Zusatz-Zellen (auffüllen, abschneiden, Ungültiges verwerfen)', () => {
    expect(normalizeCells([], 1, 'BTC/USDT')).toEqual([]);
    expect(normalizeCells([], 2, 'BTC/USDT')).toEqual([{ symbol: 'BTC/USDT', tf: '4h', venue: 'binance' }]);
    expect(normalizeCells([], 4, 'BTC/USDT')).toEqual([
      { symbol: 'BTC/USDT', tf: '4h', venue: 'binance' },
      { symbol: 'BTC/USDT', tf: '1d', venue: 'binance' },
      { symbol: 'BTC/USDT', tf: '15m', venue: 'binance' },
    ]);
    // vorhandene bleiben vorn, Ungültiges (leeres Symbol, fremder TF) fällt weg, unbekannte Quelle → Binance
    const cells = normalizeCells(
      [
        { symbol: 'ETH/USDT', tf: '1h', venue: 'binance' },
        { symbol: '', tf: '1h', venue: 'binance' },
        { symbol: 'SOL/USDT', tf: '7m' as never, venue: 'binance' },
        { symbol: 'AAPL', tf: '1d', venue: 'nasdaq' as never },
      ],
      4,
      'BTC/USDT',
    );
    expect(cells).toEqual([
      { symbol: 'ETH/USDT', tf: '1h', venue: 'binance' },
      { symbol: 'AAPL', tf: '1d', venue: 'binance' },
      { symbol: 'BTC/USDT', tf: '15m', venue: 'binance' },
    ]);
    expect(normalizeCells(cells, 2, 'BTC/USDT')).toEqual([{ symbol: 'ETH/USDT', tf: '1h', venue: 'binance' }]);
    expect(normalizeCells([{ symbol: 'AAPL', tf: '1d', venue: 'twelvedata' }], 2, 'BTC/USDT')).toEqual([{ symbol: 'AAPL', tf: '1d', venue: 'twelvedata' }]);
  });

  it('speichert und lädt Layout + Zellen; kaputte Werte → Standard', () => {
    expect(loadChartLayout()).toEqual({ layout: 1, cells: [] });
    saveChartLayout(4, [{ symbol: 'ETH/USDT', tf: '4h', venue: 'binance' }]);
    expect(loadChartLayout()).toEqual({ layout: 4, cells: [{ symbol: 'ETH/USDT', tf: '4h', venue: 'binance' }] });
    localStorage.setItem('gladiator.chartLayout', '{"layout":3,"cells":"x"}');
    expect(loadChartLayout()).toEqual({ layout: 1, cells: [] });
    localStorage.setItem('gladiator.chartLayout', 'kein json');
    expect(loadChartLayout()).toEqual({ layout: 1, cells: [] });
  });

  it('Layout-Wächter und Grid-Klassen', () => {
    expect(isChartLayout(2)).toBe(true);
    expect(isChartLayout(3)).toBe(false);
    expect(layoutGridClass(1)).toBe('grid-cols-1');
    expect(layoutGridClass(4)).toContain('2xl:grid-cols-2');
  });
});
