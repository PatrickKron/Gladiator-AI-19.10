import { describe, expect, it } from 'vitest';
import { computeChartHeatmap, type HeatmapCandle } from './chart-heatmap.js';

function makeCandles(count: number, opts?: { zeroVolume?: boolean; clusterAround?: number }): HeatmapCandle[] {
  const out: HeatmapCandle[] = [];
  const center = opts?.clusterAround ?? 100;
  for (let i = 0; i < count; i++) {
    const isCluster = i % 3 !== 0;
    const base = isCluster ? center + Math.sin(i) * 0.5 : center + (i % 2 === 0 ? 8 : -8);
    out.push({
      time: 1_700_000_000 + i * 3600,
      open: base - 0.3,
      high: base + 1.0,
      low: base - 1.0,
      close: base + 0.4,
      volume: opts?.zeroVolume ? 0 : isCluster ? 500 : 80,
    });
  }
  return out;
}

describe('computeChartHeatmap (Chart-Heatmap-Indikator für alle Asset-Klassen)', () => {
  it('berechnet Volumen-Profil mit POC und Value Area für Assets mit echtem Volumen (Krypto/Aktien)', () => {
    const candles = makeCandles(60, { clusterAround: 100 });
    const profile = computeChartHeatmap(candles, 20);
    expect(profile).not.toBeNull();
    expect(profile!.mode).toBe('volume');
    expect(profile!.buckets).toHaveLength(20);
    // POC muss nahe am Cluster-Zentrum (100) liegen
    expect(Math.abs(profile!.pocPrice - 100)).toBeLessThan(2.5);
    expect(profile!.valPrice).toBeLessThanOrEqual(profile!.pocPrice);
    expect(profile!.vahPrice).toBeGreaterThanOrEqual(profile!.pocPrice);
    const pocBuckets = profile!.buckets.filter((b) => b.isPoc);
    expect(pocBuckets).toHaveLength(1);
    expect(pocBuckets[0]!.intensity).toBeCloseTo(1, 6);
  });

  it('fällt bei 0-Volumen-Kerzen (z. B. Spot-Forex) ehrlich auf den Liquiditäts-Modus zurück', () => {
    const candles = makeCandles(60, { zeroVolume: true, clusterAround: 1.085 });
    const profile = computeChartHeatmap(candles, 16);
    expect(profile).not.toBeNull();
    expect(profile!.mode).toBe('liquidity');
    expect(profile!.buckets).toHaveLength(16);
    expect(Math.abs(profile!.pocPrice - 1.085)).toBeLessThan(2.5);
  });

  it('liefert null bei zu wenigen Kerzen oder flachem Preis', () => {
    expect(computeChartHeatmap([], 20)).toBeNull();
    expect(
      computeChartHeatmap(
        [
          { time: 1, open: 10, high: 10, low: 10, close: 10, volume: 10 },
          { time: 2, open: 10, high: 10, low: 10, close: 10, volume: 10 },
        ],
        20,
      ),
    ).toBeNull();
  });
});

