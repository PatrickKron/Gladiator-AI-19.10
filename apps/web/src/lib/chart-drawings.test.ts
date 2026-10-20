import { describe, expect, it } from 'vitest';
import {
  applyDrawingClick,
  distanceToSegment,
  logicalToTime,
  pickDrawing,
  pointFromChart,
  shapeDistance,
  timeToLogical,
  translatePoints,
  type PixelShape,
} from './chart-drawings.js';

const H = 3600;
const T = [1000 * H, 1001 * H, 1002 * H, 1003 * H]; // 4 Stundenkerzen

describe('timeToLogical / logicalToTime (Zeit ↔ Kerzen-Index)', () => {
  it('exakte Kerzenzeiten → ganzzahlige Indizes', () => {
    T.forEach((t, i) => expect(timeToLogical(T, t)).toBe(i));
  });
  it('interpoliert zwischen Kerzen (z. B. 1h-Anker im 4h-Chart)', () => {
    expect(timeToLogical(T, T[1]! + H / 2)).toBe(1.5);
    const four = [0, 4 * H, 8 * H].map((x) => x + 1000 * H);
    expect(timeToLogical(four, 1000 * H + H)).toBe(0.25);
  });
  it('extrapoliert links/rechts mit dem Rand-Abstand', () => {
    expect(timeToLogical(T, T[0]! - 2 * H)).toBe(-2);
    expect(timeToLogical(T, T[3]! + 3 * H)).toBe(6);
  });
  it('leere Daten → null; eine Kerze nur exakt', () => {
    expect(timeToLogical([], 5)).toBeNull();
    expect(timeToLogical([7], 7)).toBe(0);
    expect(timeToLogical([7], 8)).toBeNull();
  });
  it('logicalToTime ist die Umkehrung (gerundet auf Sekunden)', () => {
    for (const l of [-2, 0, 0.5, 1.25, 3, 5.5]) {
      const t = logicalToTime(T, l)!;
      expect(timeToLogical(T, t)).toBeCloseTo(l, 6);
    }
    expect(Number.isInteger(logicalToTime(T, 1.3333)!)).toBe(true);
    expect(logicalToTime([], 1)).toBeNull();
  });
  it('Rundreise über Timeframe-Wechsel: 1h-Anker bleibt nach 4h→1h identisch', () => {
    const h1 = Array.from({ length: 48 }, (_, i) => 1000 * H + i * H);
    const h4 = h1.filter((_, i) => i % 4 === 0);
    const anchor = h1[13]!;
    const onH4 = timeToLogical(h4, anchor)!; // 3.25
    expect(onH4).toBe(3.25);
    expect(logicalToTime(h4, onH4)).toBe(anchor);
  });
});

describe('pointFromChart', () => {
  it('liefert Zeit + gerundeten Preis; ungültige Eingaben → null', () => {
    expect(pointFromChart(T, 1, 64250.123456789)).toEqual({ time: T[1], price: 64250.123 });
    expect(pointFromChart(T, null, 5)).toBeNull();
    expect(pointFromChart(T, 1, null)).toBeNull();
    expect(pointFromChart(T, 1, -3)).toBeNull();
    expect(pointFromChart([], 1, 5)).toBeNull();
  });
});

describe('applyDrawingClick (Platzier-Logik)', () => {
  const a = { time: T[0]!, price: 100 };
  const b = { time: T[2]!, price: 120 };
  it('hline: ein Klick erzeugt sofort', () => {
    expect(applyDrawingClick('hline', null, a)).toEqual({ pending: null, create: { kind: 'hline', points: [a] } });
  });
  it('trend/fib: erster Klick merkt Anker, zweiter erzeugt', () => {
    for (const kind of ['trend', 'fib'] as const) {
      const s1 = applyDrawingClick(kind, null, a);
      expect(s1).toEqual({ pending: a, create: null });
      expect(applyDrawingClick(kind, s1.pending, b)).toEqual({ pending: null, create: { kind, points: [a, b] } });
    }
  });
  it('ungültiger zweiter Klick (gleiche Zeit bei Trend / gleicher Preis bei Fib) wird ignoriert', () => {
    expect(applyDrawingClick('trend', a, { time: a.time, price: 130 })).toEqual({ pending: a, create: null });
    expect(applyDrawingClick('fib', a, { time: T[3]!, price: a.price })).toEqual({ pending: a, create: null });
  });
  it('kein Zeichenwerkzeug → nichts', () => {
    expect(applyDrawingClick('none', null, a)).toEqual({ pending: null, create: null });
    expect(applyDrawingClick('delete', null, a)).toEqual({ pending: null, create: null });
  });
});

describe('Geometrie / Treffer-Test (Löschen per Klick)', () => {
  it('distanceToSegment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });
  it('shapeDistance je Form', () => {
    expect(shapeDistance({ kind: 'hline', y: 50 }, { x: 999, y: 47 })).toBe(3);
    expect(shapeDistance({ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, { x: 5, y: 5 })).toBe(0);
    expect(shapeDistance({ kind: 'fib', x1: 0, x2: 100, ys: [10, 50, 90] }, { x: 40, y: 52 })).toBe(2);
    expect(shapeDistance({ kind: 'fib', x1: 0, x2: 100, ys: [10] }, { x: 103, y: 14 })).toBe(5);
  });
  it('pickDrawing: nächste Zeichnung innerhalb der Toleranz, sonst null', () => {
    const shapes: { id: string; shape: PixelShape }[] = [
      { id: 'h', shape: { kind: 'hline', y: 100 } },
      { id: 't', shape: { kind: 'segment', a: { x: 0, y: 0 }, b: { x: 200, y: 200 } } },
    ];
    expect(pickDrawing(shapes, { x: 99, y: 99 }, 6)).toBe('t');
    expect(pickDrawing(shapes, { x: 300, y: 103 }, 6)).toBe('h');
    expect(pickDrawing(shapes, { x: 300, y: 150 }, 6)).toBeNull();
  });
});

describe('translatePoints (Zeichnung verschieben)', () => {
  const times = [1000, 2000, 3000, 4000];
  it('verschiebt Zeit über den Kerzen-Index und Preis additiv', () => {
    const moved = translatePoints(times, [{ time: 1000, price: 100 }, { time: 2500, price: 110 }], 1, 5);
    expect(moved).toEqual([
      { time: 2000, price: 105 },
      { time: 3500, price: 115 },
    ]);
  });
  it('über das Datenende hinaus wird linear fortgeschrieben', () => {
    expect(translatePoints(times, [{ time: 4000, price: 100 }], 2, 0)).toEqual([{ time: 6000, price: 100 }]);
  });
  it('Preis ≤ 0 nach dem Verschieben → null (ungültig, nichts speichern)', () => {
    expect(translatePoints(times, [{ time: 1000, price: 3 }], 0, -5)).toBeNull();
  });
  it('ohne Kerzen → null', () => {
    expect(translatePoints([], [{ time: 1000, price: 3 }], 1, 0)).toBeNull();
  });
});
