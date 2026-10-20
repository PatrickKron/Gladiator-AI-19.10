import { describe, expect, it } from 'vitest';
import { rapsGrid, type RapsTrade } from './raps.js';

const DAY = 86_400_000;
const NOW = new Date('2026-07-01T00:00:00Z');

function trade(daysAgo: number, rA: number, maePct = 0.02): RapsTrade {
  return {
    exitTs: new Date(NOW.getTime() - daysAgo * DAY),
    // Für Testzwecke: alle Schemas identisch, außer explizit gesetzt
    pnlRTpA: rA,
    pnlRTpB: rA,
    pnlRTpC: rA,
    pnlRTpD: rA,
    maePct,
  };
}

describe('RAPS-Hebel×TP-Gitter (13_ §4/§5)', () => {
  it('wählt bei sauberen Gewinnen höheren Hebel (RAPS steigt mit L, keine Liquidation)', () => {
    const trades = Array.from({ length: 60 }, (_, k) => trade(k, 0.8, 0.01));
    const res = rapsGrid(trades, { now: NOW });
    expect(res.best).not.toBeNull();
    expect(res.best!.leverage).toBe(10); // 10 × 0.01 = 10 % adverse — weit von Liquidation
    expect(res.best!.rapsScore).toBeGreaterThan(0);
    expect(res.isLowSampleSize).toBe(false);
  });

  it('Liquidations-Constraint: hohe Hebel werden ausgeschlossen (L × MAE% ≥ 100 %)', () => {
    // MAE 15 %: L=7 → 105 % ⇒ liquidiert; L=5 → 75 % ok
    const trades = Array.from({ length: 60 }, (_, k) => trade(k, 0.8, 0.15));
    const res = rapsGrid(trades, { now: NOW });
    expect(res.best!.leverage).toBeLessThanOrEqual(5);
    const l10 = res.grid.find((g) => g.leverage === 10 && g.tpSchema === 'A')!;
    expect(l10.liquidationRate).toBeGreaterThan(0);
    expect(l10.excluded).toBe(true);
  });

  it('Zeitgewichtung: jüngere Trades dominieren (alte Gewinne retten eine schlechte Gegenwart nicht)', () => {
    const oldWins = Array.from({ length: 30 }, (_, k) => trade(60 + k, 1.5));
    const newLosses = Array.from({ length: 30 }, (_, k) => trade(k, -1));
    const res = rapsGrid([...oldWins, ...newLosses], { now: NOW, lambdaTimeDecay: 0.05 });
    const cell = res.grid.find((g) => g.leverage === 1 && g.tpSchema === 'A')!;
    expect(cell.muWeighted).toBeLessThan(0); // zeitgewichtet negativ trotz 50 % Gewinnern
  });

  it('bestes TP-Schema wird je Kennzahl unterschieden (D gewinnt wenn Runner besser)', () => {
    const trades = Array.from({ length: 60 }, (_, k) => ({
      ...trade(k, 0.5, 0.01),
      pnlRTpD: 2.0, // Runner deutlich besser
    }));
    const res = rapsGrid(trades, { now: NOW });
    expect(res.best!.tpSchema).toBe('D');
  });

  it('Low-Sample-Schutz (13_ §8): unter MIN_TRADES wird isLowSampleSize gemeldet', () => {
    const trades = Array.from({ length: 10 }, (_, k) => trade(k, 1));
    const res = rapsGrid(trades, { now: NOW, minTrades: 50 });
    expect(res.isLowSampleSize).toBe(true);
    expect(res.best).not.toBeNull(); // Ergebnis existiert, aber als unsicher markiert
  });

  it('keine Trades → ehrlich: kein best, leeres Gitter bewertet nichts', () => {
    const res = rapsGrid([], { now: NOW });
    expect(res.best).toBeNull();
    expect(res.isLowSampleSize).toBe(true);
  });
  it('fehlende Schema-Werte (z. B. Paper: nur Schema A bekannt) → Schema ausgeschlossen, nie geraten', () => {
    const trades: RapsTrade[] = Array.from({ length: 60 }, (_, k) => ({
      ...trade(k, 0.6, 0.01),
      pnlRTpB: k === 3 ? null : 5, // ein einziger fehlender Wert sperrt B
      pnlRTpC: null,
      pnlRTpD: null,
    }));
    const res = rapsGrid(trades, { now: NOW });
    for (const s of ['B', 'C', 'D'] as const) {
      const cells = res.grid.filter((g) => g.tpSchema === s);
      expect(cells.every((c) => c.excluded && c.incomplete)).toBe(true);
    }
    expect(res.best!.tpSchema).toBe('A');
    expect(res.grid.find((g) => g.tpSchema === 'A')!.incomplete).toBe(false);
  });
});
