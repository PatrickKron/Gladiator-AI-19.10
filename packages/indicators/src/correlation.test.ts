import { describe, expect, it } from 'vitest';
import {
  alignPairwise,
  correlationMatrix,
  dailyCloses,
  logReturns,
  pairCorrelation,
  pairReturns,
  pearson,
  utcDateKey,
} from './correlation.js';

const DAY = 86_400_000;
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('utcDateKey / dailyCloses (Kalendertag = UTC-Datum der Kerze)', () => {
  it('UTC-Datum, unabhängig von der Uhrzeit', () => {
    expect(utcDateKey(Date.parse('2026-10-23T00:00:00Z'))).toBe('2026-10-23');
    expect(utcDateKey(Date.parse('2026-10-23T23:59:59Z'))).toBe('2026-10-23');
    // Yahoo-Tageskerze: Zeitstempel = Börsenöffnung (US 13:30 UTC)
    expect(utcDateKey(Date.parse('2026-10-23T13:30:00Z'))).toBe('2026-10-23');
  });

  it('nur abgeschlossene Kerzen (ts + 1 Tag ≤ jetzt), kaputte Schlusskurse fallen weg', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    const m = dailyCloses(
      [
        { ts: d('2026-10-22'), close: 100 },
        { ts: d('2026-10-23'), close: Number.NaN },
        { ts: d('2026-10-24'), close: 0 },
        { ts: new Date(Date.parse('2026-10-24T13:30:00Z')), close: 50 }, // schließt erst 2026-10-25 13:30 → läuft noch
        { ts: d('2026-10-25'), close: 105 }, // laufende Tageskerze → nie verwenden
      ],
      now,
    );
    expect([...m.entries()]).toEqual([['2026-10-22', 100]]);
  });

  it('doppelte Tage: der spätere Zeitstempel gewinnt; Ergebnis aufsteigend sortiert', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    const m = dailyCloses(
      [
        { ts: d('2026-10-24'), close: 3 },
        { ts: new Date(Date.parse('2026-10-22T14:30:00Z')), close: 2 },
        { ts: d('2026-10-22'), close: 1 },
      ],
      now,
    );
    expect([...m.entries()]).toEqual([
      ['2026-10-22', 2],
      ['2026-10-24', 3],
    ]);
  });
});

describe('logReturns', () => {
  it('ln(c_t / c_{t-1}) — handgerechnet', () => {
    const r = logReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12); // 0,0953101798
    expect(r[1]).toBeCloseTo(Math.log(0.9), 12); // −0,1053605157
    expect(logReturns([100])).toEqual([]);
    expect(logReturns([])).toEqual([]);
  });
});

describe('pearson', () => {
  it('perfekt gleich- und gegenläufig', () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 12);
  });

  it('handgerechnete Werte', () => {
    // dx = [-1,0,1], dy = [-1,1,0] → Σdxdy = 1, Σdx² = Σdy² = 2 → r = 0,5
    expect(pearson([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 12);
    // dx = [-1.5,-0.5,0.5,1.5], dy = [-0.5,-1.5,1.5,0.5] → 3 / 5 = 0,6
    expect(pearson([1, 2, 3, 4], [2, 1, 4, 3])).toBeCloseTo(0.6, 12);
  });

  it('ehrlich null: zu kurz, ungleich lang, konstante Reihe (Varianz 0)', () => {
    expect(pearson([1], [2])).toBeNull();
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('alignPairwise / pairReturns (paarweise vollständig)', () => {
  // Krypto handelt 24/7, die Aktie nur Fr + Mo
  const crypto = new Map([
    ['2026-10-23', 100], // Fr
    ['2026-10-24', 101], // Sa
    ['2026-10-25', 102], // So
    ['2026-10-26', 104], // Mo
    ['2026-10-27', 103], // Di
  ]);
  const stock = new Map([
    ['2026-10-23', 50],
    ['2026-10-26', 51],
    ['2026-10-27', 49],
  ]);

  it('nur Tage, an denen BEIDE einen Schlusskurs haben', () => {
    expect(alignPairwise(crypto, stock)).toEqual({
      dates: ['2026-10-23', '2026-10-26', '2026-10-27'],
      a: [100, 104, 103],
      b: [50, 51, 49],
    });
  });

  it('Renditen über aufeinanderfolgende GEMEINSAME Tage (Fr→Mo deckt das Wochenende ab)', () => {
    const r = pairReturns(crypto, stock);
    expect(r.dates).toEqual(['2026-10-26', '2026-10-27']);
    expect(r.x[0]).toBeCloseTo(Math.log(104 / 100), 12);
    expect(r.y[0]).toBeCloseTo(Math.log(51 / 50), 12);
    expect(r.x[1]).toBeCloseTo(Math.log(103 / 104), 12);
    expect(r.y[1]).toBeCloseTo(Math.log(49 / 51), 12);
  });

  it('Fenster: nur Renditen mit Enddatum ≥ fromDate (Basiskurs davor darf genutzt werden)', () => {
    const r = pairReturns(crypto, stock, '2026-10-27');
    expect(r.dates).toEqual(['2026-10-27']);
    expect(r.x[0]).toBeCloseTo(Math.log(103 / 104), 12);
  });
});

describe('pairCorrelation / correlationMatrix', () => {
  /** n+1 Tage ab Start mit gegebenen Schlusskursen. */
  const series = (start: string, closes: number[]) => {
    const t0 = Date.parse(`${start}T00:00:00Z`);
    return new Map(closes.map((c, i) => [utcDateKey(t0 + i * DAY), c] as const));
  };
  // Kurse aus festen Renditen (deterministisch, keine Zufallsdaten)
  const fromReturns = (start: string, rets: number[]) => {
    const closes = [100];
    for (const r of rets) closes.push(closes[closes.length - 1]! * Math.exp(r));
    return series(start, closes);
  };
  const base = [0.01, -0.02, 0.015, 0.003, -0.007, 0.02, -0.011, 0.004, 0.009, -0.016, 0.012, -0.003, 0.006, -0.009, 0.018, -0.012, 0.007, 0.001, -0.004, 0.011, -0.006, 0.013];

  it('identische Renditen → r = 1, gespiegelte → r = −1, n = Anzahl gemeinsamer Renditen', () => {
    const a = fromReturns('2026-01-01', base);
    const b = fromReturns('2026-01-01', base);
    const c = fromReturns('2026-01-01', base.map((x) => -x));
    expect(pairCorrelation(a, b, { minReturns: 20 })).toEqual({ r: expect.closeTo(1, 10), n: 22 });
    expect(pairCorrelation(a, c, { minReturns: 20 }).r).toBeCloseTo(-1, 10);
  });

  it('weniger als minReturns gemeinsame Renditen → r = null (zu wenig gemeinsame Daten), n bleibt sichtbar', () => {
    const a = fromReturns('2026-01-01', base);
    const late = fromReturns('2026-01-10', base); // überlappt nur 14 Tage → 13 Renditen
    expect(pairCorrelation(a, late, { minReturns: 20 })).toEqual({ r: null, n: 13 });
  });

  it('Matrix: symmetrisch, Diagonale 1 bei genug eigenen Daten, null wo zu wenig', () => {
    const a = fromReturns('2026-01-01', base);
    const c = fromReturns('2026-01-01', base.map((x) => -x));
    const thin = fromReturns('2026-01-15', base.slice(0, 5));
    const m = correlationMatrix([a, c, thin], { minReturns: 20 });
    expect(m.r[0]![0]).toBe(1);
    expect(m.r[0]![1]).toBeCloseTo(-1, 10);
    expect(m.r[1]![0]).toBe(m.r[0]![1]);
    expect(m.r[2]![2]).toBeNull(); // eigene Reihe zu kurz
    expect(m.r[0]![2]).toBeNull();
    expect(m.n[0]![0]).toBe(22);
    expect(m.n[2]![2]).toBe(5);
    expect(m.n[0]![2]).toBe(m.n[2]![0]);
  });
});
