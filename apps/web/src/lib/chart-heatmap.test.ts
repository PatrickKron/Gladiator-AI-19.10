import { describe, expect, it } from 'vitest';
import { compute2dHeatmap, computeChartHeatmap, type HeatmapCandle } from './chart-heatmap.js';

describe('computeChartHeatmap & compute2dHeatmap', () => {
  it('nutzt Modus "volume", wenn echte Volumina vorhanden sind, und erkennt POC sowie Value Area', () => {
    const candles: HeatmapCandle[] = [
      { time: 1, open: 100, high: 102, low: 99, close: 101, volume: 100 },
      { time: 2, open: 101, high: 103, low: 100, close: 102, volume: 500 },
      { time: 3, open: 100.5, high: 102.5, low: 100, close: 101.5, volume: 800 },
      { time: 4, open: 101, high: 102, low: 100.5, close: 101.2, volume: 600 },
      { time: 5, open: 102, high: 110, low: 101.5, close: 109, volume: 50 },
      { time: 6, open: 109, high: 112, low: 108, close: 111, volume: 40 },
    ];

    const res = computeChartHeatmap(candles, 12);
    expect(res).not.toBeNull();
    expect(res!.mode).toBe('volume');
    expect(res!.minPrice).toBe(99);
    expect(res!.maxPrice).toBe(112);
    expect(res!.pocPrice).toBeGreaterThanOrEqual(100);
    expect(res!.pocPrice).toBeLessThanOrEqual(103);
    expect(res!.valPrice).toBeLessThanOrEqual(res!.pocPrice);
    expect(res!.vahPrice).toBeGreaterThanOrEqual(res!.pocPrice);

    const pocBuckets = res!.buckets.filter((b) => b.isPoc);
    expect(pocBuckets).toHaveLength(1);
    expect(pocBuckets[0]!.intensity).toBeCloseTo(1, 5);
  });

  it('fällt bei 0-Volumen-Kerzen (z. B. Spot-Forex) ehrlich auf Modus "liquidity" zurück', () => {
    const forexCandles: HeatmapCandle[] = [
      { time: 1, open: 1.081, high: 1.083, low: 1.08, close: 1.082, volume: 0 },
      { time: 2, open: 1.082, high: 1.0835, low: 1.0815, close: 1.0825, volume: 0 },
      { time: 3, open: 1.0825, high: 1.0832, low: 1.0818, close: 1.0822, volume: 0 },
      { time: 4, open: 1.0822, high: 1.083, low: 1.0819, close: 1.0826, volume: 0 },
      { time: 5, open: 1.0826, high: 1.09, low: 1.0825, close: 1.089, volume: 0 },
    ];

    const res = computeChartHeatmap(forexCandles, 10);
    expect(res).not.toBeNull();
    expect(res!.mode).toBe('liquidity');
    expect(res!.pocPrice).toBeGreaterThanOrEqual(1.081);
    expect(res!.pocPrice).toBeLessThanOrEqual(1.0845);
  });

  it('compute2dHeatmap erzeugt 2D Zeit×Preis Liquidations-Zellen und erkennt Magnet-Zonen oben/unten', () => {
    const candles: HeatmapCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: 1000 + i * 60,
        open: 100 + Math.sin(i * 0.4) * 2,
        high: 101.5 + Math.sin(i * 0.4) * 2,
        low: 98.5 + Math.sin(i * 0.4) * 2,
        close: 100.3 + Math.sin(i * 0.4) * 2,
        volume: 200 + (i % 5) * 80,
      });
    }

    const hm = compute2dHeatmap(candles, 24);
    expect(hm).not.toBeNull();
    expect(hm!.mode).toBe('volume');
    expect(hm!.cells.length).toBeGreaterThan(10);
    expect(hm!.magnetAbove).not.toBeNull();
    expect(hm!.magnetBelow).not.toBeNull();
    expect(hm!.magnetAbove!.price).toBeGreaterThan(candles[candles.length - 1]!.close);
    expect(hm!.magnetBelow!.price).toBeLessThan(candles[candles.length - 1]!.close);
  });

  it('liefert null bei zu wenigen Kerzen oder flacher Preisspanne', () => {
    expect(computeChartHeatmap([])).toBeNull();
    expect(compute2dHeatmap([])).toBeNull();
    expect(
      computeChartHeatmap([
        { time: 1, open: 10, high: 10, low: 10, close: 10, volume: 10 },
        { time: 2, open: 10, high: 10, low: 10, close: 10, volume: 10 },
        { time: 3, open: 10, high: 10, low: 10, close: 10, volume: 10 },
        { time: 4, open: 10, high: 10, low: 10, close: 10, volume: 10 },
        { time: 5, open: 10, high: 10, low: 10, close: 10, volume: 10 },
      ]),
    ).toBeNull();
  });
});
