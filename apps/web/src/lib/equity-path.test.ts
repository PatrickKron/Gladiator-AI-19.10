import { describe, expect, it } from 'vitest';
import { equityXY } from './equity-path.js';

const box = { width: 100, height: 100, pad: 0 };
const iso = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

describe('equityXY', () => {
  it('x folgt der Zeit, nicht der Punkt-Nummer (lange Trades bleiben lang)', () => {
    // Punkte bei 0 h, 1 h und 10 h → der dritte liegt ganz rechts, der zweite bei 10 %
    const pts = equityXY([{ ts: iso(0), equity: 0 }, { ts: iso(1), equity: 50 }, { ts: iso(10), equity: 100 }], box);
    expect(pts.map(([x]) => x)).toEqual([0, 10, 100]);
    expect(pts.map(([, y]) => y)).toEqual([100, 50, 0]);
  });

  it('Treppe: Wert hält bis zum nächsten Zeitpunkt, dann senkrechter Sprung', () => {
    const pts = equityXY([{ ts: iso(0), equity: 0 }, { ts: iso(5), equity: 100 }, { ts: iso(10), equity: 0 }], { ...box, step: true });
    expect(pts).toEqual([
      [0, 100],
      [50, 100],
      [50, 0],
      [100, 0],
      [100, 100],
    ]);
  });

  it('Gewinn direkt gefolgt von Verlust wird keine Nadel: der Verlust-Trade behält seine Dauer', () => {
    // Trade A endet bei 2 h (+), Trade B läuft bis 9 h (−) → Hochplateau ist 7 h breit
    const pts = equityXY(
      [{ ts: iso(0), equity: 10 }, { ts: iso(2), equity: 20 }, { ts: iso(9), equity: 10 }, { ts: iso(10), equity: 10 }],
      { ...box, step: true },
    );
    const high = pts.filter(([, y]) => y === 0).map(([x]) => x);
    expect(Math.max(...high) - Math.min(...high)).toBe(70);
  });

  it('gleiche oder ungültige Zeitstempel → gleichmäßige Verteilung statt Division durch 0', () => {
    const same = equityXY([{ ts: iso(3), equity: 1 }, { ts: iso(3), equity: 2 }, { ts: iso(3), equity: 3 }], box);
    expect(same.map(([x]) => x)).toEqual([0, 50, 100]);
    const bad = equityXY([{ ts: 'kaputt', equity: 1 }, { ts: iso(1), equity: 2 }], box);
    expect(bad.map(([x]) => x)).toEqual([0, 100]);
  });

  it('flache Kurve liegt in der Mitte statt außerhalb', () => {
    const pts = equityXY([{ ts: iso(0), equity: 5 }, { ts: iso(1), equity: 5 }], { width: 100, height: 100, pad: 10 });
    expect(pts.map(([, y]) => y)).toEqual([50, 50]);
  });

  it('gemeinsamer Zeit- und Wertebereich für mehrere Kurven', () => {
    const pts = equityXY([{ ts: iso(5), equity: 0 }], { ...box, tMin: Date.parse(iso(0)), tMax: Date.parse(iso(10)), min: -10, max: 10 });
    expect(pts).toEqual([[50, 50]]);
  });
});
