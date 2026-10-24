import { describe, expect, it } from 'vitest';
import { chartHeight, inMainPane, paneLayout, paneStretchFactors, TIME_AXIS_HEIGHT } from './chart-panes.js';

/**
 * Nachbau der Höhenverteilung von lightweight-charts 5 (ChartWidget._adjustSizeImpl):
 * Gesamthöhe minus Zeitachse minus Trenner, Rest proportional zu den Stretch-Faktoren.
 */
function distribute(height: number, factors: number[], axis: number, separator = 1): { top: number; height: number }[] {
  const panesPx = height - axis - separator * (factors.length - 1);
  const sum = factors.reduce((a, b) => a + b, 0);
  let top = 0;
  return factors.map((f) => {
    const h = (f / sum) * panesPx;
    const out = { top, height: h };
    top += h + separator;
    return out;
  });
}

describe('paneLayout', () => {
  it('ohne Unterfenster: nur das Hauptfenster', () => {
    expect(paneLayout([], 340, 120)).toEqual({ main: 340, total: 340, panes: [] });
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

describe('Fensterhöhen: das Kursfenster behält seine Soll-Höhe, Beschriftungen sitzen auf den Fenstern', () => {
  const specs = [
    { key: 'rsi', label: 'RSI 14' },
    { key: 'macd', label: 'MACD 12/26/9' },
  ];

  it('Stretch-Faktoren = Soll-Pixelhöhen je Pane-Index (0 = Kursfenster mit mainHeight, nicht 340)', () => {
    const l = paneLayout(specs, 460, 120);
    expect(paneStretchFactors(l)).toEqual([460, 120, 120]);
    expect(paneStretchFactors(paneLayout([], 460, 120))).toEqual([460]);
  });

  it('Chart-Höhe enthält die Zeitachse — die Bibliothek zieht sie von der Höhe ab', () => {
    const l = paneLayout(specs, 460, 120);
    expect(chartHeight(l)).toBe(l.total + TIME_AXIS_HEIGHT);
    expect(chartHeight(l, 30)).toBe(l.total + 30);
  });

  it.each([460, 340, 280])('mainHeight %i: Fenster liegen pixelgenau auf den Beschriftungen', (main) => {
    const l = paneLayout(specs, main, 120);
    const px = distribute(chartHeight(l), paneStretchFactors(l), TIME_AXIS_HEIGHT);
    expect(px[0]!.height).toBeCloseTo(main, 6);
    for (const p of l.panes) {
      expect(px[p.index]!.top).toBeCloseTo(p.top, 6);
      expect(px[p.index]!.height).toBeCloseTo(p.height, 6);
    }
  });

  it('Regression: fester Faktor 340 bei mainHeight 460 hätte das Kursfenster gestaucht', () => {
    const l = paneLayout(specs, 460, 120);
    const buggy = distribute(l.total, [340, 120, 120], 26);
    expect(buggy[0]!.height).toBeLessThan(440);
    expect(Math.abs(buggy[1]!.top - l.panes[0]!.top)).toBeGreaterThan(10);
  });

  it('inMainPane: nur Punkte im Kursfenster (Zeichnungs-Griffe), nicht in den Unterfenstern', () => {
    const l = paneLayout(specs, 460, 120);
    expect(inMainPane(0, l)).toBe(true);
    expect(inMainPane(400, l)).toBe(true); // mit dem alten festen 340 fälschlich „Unterfenster"
    expect(inMainPane(460, l)).toBe(true);
    expect(inMainPane(470, l)).toBe(false);
    expect(inMainPane(-1, l)).toBe(false);
  });
});
