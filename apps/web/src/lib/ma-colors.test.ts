import { describe, expect, it } from 'vitest';
import { isMaIndicator, MA_PALETTE, maStyle, pickMaColor, usedPlotColors } from './ma-colors.js';

describe('eigene Farbe je gleitendem Durchschnitt', () => {
  it('nur EMA und SMA bekommen eine Palettenfarbe', () => {
    expect(isMaIndicator('ema')).toBe(true);
    expect(isMaIndicator('sma')).toBe(true);
    expect(isMaIndicator('rsi')).toBe(false);
    expect(isMaIndicator('bb')).toBe(false);
  });

  it('Palette: feste, eindeutige Farben, beginnend mit den v2-Linienfarben', () => {
    expect(MA_PALETTE.slice(0, 6)).toEqual(['#e14ecf', '#2e7cf6', '#3ddc97', '#e8b84b', '#ff5c6c', '#edf1ff']);
    expect(new Set(MA_PALETTE.map((c) => c.toLowerCase())).size).toBe(MA_PALETTE.length);
  });

  it('nimmt die erste noch freie Farbe des Symbols', () => {
    expect(pickMaColor([])).toBe(MA_PALETTE[0]);
    expect(pickMaColor([MA_PALETTE[0]!])).toBe(MA_PALETTE[1]);
    expect(pickMaColor([MA_PALETTE[1]!, MA_PALETTE[0]!])).toBe(MA_PALETTE[2]);
    // Groß-/Kleinschreibung egal, fremde Farben stören nicht
    expect(pickMaColor([MA_PALETTE[0]!.toUpperCase(), '#123456'])).toBe(MA_PALETTE[1]);
  });

  it('sind alle vergeben: die am seltensten benutzte (bei Gleichstand die erste)', () => {
    expect(pickMaColor([...MA_PALETTE])).toBe(MA_PALETTE[0]);
    expect(pickMaColor([...MA_PALETTE, MA_PALETTE[0]!])).toBe(MA_PALETTE[1]);
  });

  it('mehrere neue MAs hintereinander bekommen verschiedene Farben', () => {
    const used: string[] = [];
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = pickMaColor(used);
      picked.push(c);
      used.push(c);
    }
    expect(new Set(picked).size).toBe(4);
  });

  it('usedPlotColors: alle ausdrücklich gesetzten Plot-Farben der Instanzen', () => {
    expect(
      usedPlotColors([
        { style: { plots: { plot0: { color: '#e14ecf' } } } },
        { style: null },
        { style: { visible: false, plots: { plot0: { lineWidth: 2 }, plot1: { color: '#2e7cf6' } } } },
      ]),
    ).toEqual(['#e14ecf', '#2e7cf6']);
  });

  it('maStyle setzt die Farbe auf den Haupt-Plot (plot0)', () => {
    expect(maStyle('#e14ecf')).toEqual({ plots: { plot0: { color: '#e14ecf' } } });
  });
});
