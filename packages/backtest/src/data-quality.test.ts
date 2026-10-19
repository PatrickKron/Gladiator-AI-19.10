import { describe, expect, it } from 'vitest';
import type { Candle } from '@gladiator/strategy-engine';
import { assertDataQuality, assessDataQuality, fundingSettlements, MAX_GAP_RATIO } from './data-quality.js';

const H = 3_600_000;

/** Ruhige, echte-artige Testkerzen (nur im Test): leichtes Zickzack, Volumen > 0. */
function series(hours: number[], opts?: { volume?: (k: number) => number; close?: (k: number) => number }): Candle[] {
  return hours.map((hr, k) => {
    const close = opts?.close ? opts.close(k) : 100 + (k % 2 === 0 ? 0.1 : -0.1);
    return { ts: new Date(hr * H), open: close, high: close + 0.2, low: close - 0.2, close, volume: opts?.volume ? opts.volume(k) : 50 };
  });
}
const range = (n: number, start = 0) => Array.from({ length: n }, (_, k) => start + k);

describe('assessDataQuality (08_ §3b)', () => {
  it('lückenlose Serie → ok, keine Warnungen, first/last korrekt', () => {
    const q = assessDataQuality(series(range(100)), H);
    expect(q.gaps).toBe(0);
    expect(q.zeroVolumeBars).toBe(0);
    expect(q.spikes).toBe(0);
    expect(q.expectedBars).toBe(100);
    expect(q.firstTs?.getTime()).toBe(0);
    expect(q.lastTs?.getTime()).toBe(99 * H);
    expect(q.ok).toBe(true);
    expect(q.warnings).toEqual([]);
  });

  it('zählt fehlende Kerzen (nicht interpoliert) und warnt auf Deutsch', () => {
    // 0..99 ohne 10,11,12 und 50 → 4 fehlende Bars
    const hours = range(100).filter((h) => ![10, 11, 12, 50].includes(h));
    const q = assessDataQuality(series(hours), H);
    expect(q.gaps).toBe(4);
    expect(q.expectedBars).toBe(100);
    expect(q.ok).toBe(false);
    expect(q.warnings.some((w) => w.includes('4 fehlende Kerzen'))).toBe(true);
  });

  it('zählt 0-Volumen-Kerzen', () => {
    const q = assessDataQuality(series(range(50), { volume: (k) => (k === 3 || k === 7 ? 0 : 10) }), H);
    expect(q.zeroVolumeBars).toBe(2);
    expect(q.ok).toBe(false);
    expect(q.warnings.some((w) => w.includes('0-Volumen'))).toBe(true);
  });

  it('erkennt Spikes (|z| des Log-Returns > 8)', () => {
    // 300 ruhige Bars, an Bar 150 ein Fehltick ×1.5 (und zurück) → 2 extreme Log-Returns
    const q = assessDataQuality(
      series(range(300), { close: (k) => (k === 150 ? 150 : 100 + (k % 2 === 0 ? 0.1 : -0.1)) }),
      H,
    );
    expect(q.spikes).toBe(2);
    expect(q.ok).toBe(false);
    expect(q.warnings.some((w) => w.includes('Spike'))).toBe(true);
  });

  it('normale Volatilität ist kein Spike', () => {
    const q = assessDataQuality(series(range(300), { close: (k) => 100 * Math.exp(0.01 * Math.sin(k)) }), H);
    expect(q.spikes).toBe(0);
  });

  it('leere Serie → nicht ok, ohne Absturz', () => {
    const q = assessDataQuality([], H);
    expect(q.firstTs).toBeNull();
    expect(q.lastTs).toBeNull();
    expect(q.ok).toBe(false);
    expect(q.warnings.length).toBeGreaterThan(0);
  });
});

describe('assertDataQuality (Lab-Gate)', () => {
  it(`Lücken über ${MAX_GAP_RATIO * 100} % der erwarteten Kerzen → klarer deutscher Fehler`, () => {
    // 100 erwartet, 6 fehlen → 6 %
    const hours = range(100).filter((h) => h < 20 || h > 25);
    const q = assessDataQuality(series(hours), H);
    expect(() => assertDataQuality(q)).toThrow(/nicht belastbar/);
  });

  it('wenige Lücken → kein Fehler (nur Warnung)', () => {
    const hours = range(100).filter((h) => h !== 42);
    const q = assessDataQuality(series(hours), H);
    expect(() => assertDataQuality(q)).not.toThrow();
  });
});

describe('fundingSettlements (Snapshots → Settlement-Zeitpunkte)', () => {
  const d = (iso: string) => new Date(iso);

  it('nimmt je 8h-Settlement (00/08/16 UTC) den letzten Snapshot davor; zählt nichts doppelt', () => {
    // Sync alle 30 min schreibt viele Snapshots — Funding wird aber nur 3× täglich fällig
    const snaps = [
      { ts: d('2026-01-01T06:00:00Z'), rate: 0.0001 },
      { ts: d('2026-01-01T07:30:00Z'), rate: 0.0002 },
      { ts: d('2026-01-01T08:00:00Z'), rate: 0.0003 }, // exakt am Settlement → zählt für 08:00
      { ts: d('2026-01-01T12:00:00Z'), rate: 0.0004 },
      { ts: d('2026-01-01T15:30:00Z'), rate: 0.0005 },
    ];
    const res = fundingSettlements(snaps, d('2026-01-01T05:00:00Z'), d('2026-01-01T16:00:00Z'));
    expect(res.series).toEqual([
      { ts: d('2026-01-01T08:00:00Z'), rate: 0.0003 },
      { ts: d('2026-01-01T16:00:00Z'), rate: 0.0005 },
    ]);
    expect(res.coverage).toBe(1);
  });

  it('Settlement ohne Snapshot im vorherigen 8h-Fenster fehlt → Abdeckung < 1', () => {
    const snaps = [{ ts: d('2026-01-01T07:00:00Z'), rate: 0.0001 }];
    const res = fundingSettlements(snaps, d('2026-01-01T00:30:00Z'), d('2026-01-01T23:59:00Z'));
    // Settlements 08:00 und 16:00 im Fenster; nur 08:00 belegt
    expect(res.series).toHaveLength(1);
    expect(res.coverage).toBeCloseTo(0.5, 9);
  });

  it('keine Snapshots → leere Serie, Abdeckung 0', () => {
    const res = fundingSettlements([], d('2026-01-01T00:00:00Z'), d('2026-01-03T00:00:00Z'));
    expect(res.series).toEqual([]);
    expect(res.coverage).toBe(0);
  });
});
