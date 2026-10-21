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
    expect(normalizeCells([], 2, 'BTC/USDT')).toEqual([{ symbol: 'BTC/USDT', tf: '4h' }]);
    expect(normalizeCells([], 4, 'BTC/USDT')).toEqual([
      { symbol: 'BTC/USDT', tf: '4h' },
      { symbol: 'BTC/USDT', tf: '1d' },
      { symbol: 'BTC/USDT', tf: '15m' },
    ]);
    // vorhandene bleiben vorn, Ungültiges (leeres Symbol, fremder TF) fällt weg
    const cells = normalizeCells([{ symbol: 'ETH/USDT', tf: '1h' }, { symbol: '', tf: '1h' }, { symbol: 'SOL/USDT', tf: '7m' as never }], 4, 'BTC/USDT');
    expect(cells).toEqual([
      { symbol: 'ETH/USDT', tf: '1h' },
      { symbol: 'BTC/USDT', tf: '1d' },
      { symbol: 'BTC/USDT', tf: '15m' },
    ]);
    expect(normalizeCells(cells, 2, 'BTC/USDT')).toEqual([{ symbol: 'ETH/USDT', tf: '1h' }]);
  });

  it('speichert und lädt Layout + Zellen; kaputte Werte → Standard', () => {
    expect(loadChartLayout()).toEqual({ layout: 1, cells: [] });
    saveChartLayout(4, [{ symbol: 'ETH/USDT', tf: '4h' }]);
    expect(loadChartLayout()).toEqual({ layout: 4, cells: [{ symbol: 'ETH/USDT', tf: '4h' }] });
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
