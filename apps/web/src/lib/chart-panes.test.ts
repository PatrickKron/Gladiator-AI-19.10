import { describe, expect, it } from 'vitest';
import { paneLayout } from './chart-panes.js';

describe('paneLayout', () => {
  it('ohne Unterfenster: nur das Hauptfenster', () => {
    expect(paneLayout([], 340, 120)).toEqual({ total: 340, panes: [] });
  });

  it('Unterfenster bekommen fortlaufende Pane-Indizes ab 1 und ihre Oberkante (inkl. 1-px-Trenner)', () => {
    const l = paneLayout(
      [
        { key: 'rsi', label: 'RSI 14' },
        { key: 'macd', label: 'MACD 12/26/9' },
      ],
      340,
      120,
    );
    expect(l.total).toBe(340 + 1 + 120 + 1 + 120);
    expect(l.panes).toEqual([
      { key: 'rsi', label: 'RSI 14', index: 1, top: 341, height: 120 },
      { key: 'macd', label: 'MACD 12/26/9', index: 2, top: 462, height: 120 },
    ]);
  });

  it('Reihenfolge bleibt wie übergeben (Standard vor eigenen Indikatoren)', () => {
    const l = paneLayout([{ key: 'atr', label: 'ATR' }, { key: 'custRsi', label: 'RSI 21' }], 300, 100, 0);
    expect(l.panes.map((p) => [p.key, p.index, p.top])).toEqual([
      ['atr', 1, 300],
      ['custRsi', 2, 400],
    ]);
  });
});
