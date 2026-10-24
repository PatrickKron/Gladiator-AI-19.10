import { describe, expect, it } from 'vitest';
import { allocation, rangeChange, rangeFilter, rangeStats, wealthCurve } from './wealth.js';

describe('Vermögen: Aufteilung und Verlauf', () => {
  it('allocation: Anteile nur aus bewertbaren, positiven Teilen', () => {
    const a = allocation([
      { key: 'demo', usd: 90_000 },
      { key: 'paper', usd: 10_000 },
      { key: 'wallet', usd: null },
      { key: 'real', usd: 0 },
    ]);
    expect(a.map((x) => x.key)).toEqual(['demo', 'paper']);
    expect(a[0]!.share).toBeCloseTo(0.9, 6);
    expect(a[1]!.share).toBeCloseTo(0.1, 6);
    expect(allocation([{ key: 'x', usd: null }])).toEqual([]);
  });

  it('wealthCurve: EUR nur wenn jede Zeile einen EUR-Wert hat, sonst USD-Summe', () => {
    const rowsEur = [
      { ts: '2026-10-20T00:00:00Z', totalEur: 100, demoEquityUsd: 90, paperEquityUsd: 20, realEquityUsd: null },
      { ts: '2026-10-21T00:00:00Z', totalEur: 110, demoEquityUsd: 100, paperEquityUsd: 20, realEquityUsd: null },
    ];
    expect(wealthCurve(rowsEur)).toEqual({ unit: '€', points: [{ ts: '2026-10-20T00:00:00Z', equity: 100 }, { ts: '2026-10-21T00:00:00Z', equity: 110 }] });
    const rowsMixed = [rowsEur[0]!, { ...rowsEur[1]!, totalEur: null }];
    const c = wealthCurve(rowsMixed);
    expect(c.unit).toBe('$');
    expect(c.points.map((p) => p.equity)).toEqual([110, 120]);
    expect(wealthCurve([])).toEqual({ points: [], unit: '$' });
  });

  it('rangeFilter und rangeChange', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const pts = [0, 5, 20, 40].map((d) => ({ ts: new Date(now - d * 86_400_000).toISOString(), equity: 100 + d })).reverse();
    expect(rangeFilter(pts, '7d', now)).toHaveLength(2);
    expect(rangeFilter(pts, '30d', now)).toHaveLength(3);
    expect(rangeFilter(pts, 'all', now)).toHaveLength(4);
    expect(rangeChange(pts)).toEqual({ abs: -40, pct: (-40 / 140) * 100 });
    expect(rangeChange([pts[0]!])).toBeNull();
    expect(rangeChange([{ equity: 0 }, { equity: 5 }])).toBeNull();
  });

  it('rangeStats: Min/Max und Zeitraum des sichtbaren Verlaufs (v2 zeigte sie unter dem Chart)', () => {
    const pts = [
      { ts: '2026-10-01T00:00:00.000Z', equity: 120 },
      { ts: '2026-10-05T00:00:00.000Z', equity: 95.5 },
      { ts: '2026-10-09T00:00:00.000Z', equity: 140 },
    ];
    expect(rangeStats(pts)).toEqual({ min: 95.5, max: 140, from: '2026-10-01T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' });
    expect(rangeStats([pts[0]!])).toBeNull();
    expect(rangeStats([])).toBeNull();
  });
});
