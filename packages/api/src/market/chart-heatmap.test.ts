import { describe, expect, it } from 'vitest';
import { aggregateOrderbookWalls } from './chart-heatmap.js';

describe('aggregateOrderbookWalls (echte Level-2 Orderbuch-Wände für die Chart-Heatmap)', () => {
  it('bündelt Bids und Asks in Preis-Bänder und erkennt die größte Bid- und Ask-Wand', () => {
    const bids: [number, number][] = [
      [67_900, 1.5],
      [67_800, 2.0],
      [67_000, 25.0], // Massive Bid-Wand (~1.675 Mio. USD)
      [66_500, 1.0],
    ];
    const asks: [number, number][] = [
      [68_100, 1.2],
      [68_500, 3.0],
      [69_000, 30.0], // Massive Ask-Wand (~2.07 Mio. USD)
      [69_500, 1.0],
    ];

    const res = aggregateOrderbookWalls(bids, asks, 16);
    expect(res.midPrice).toBe(68_000);
    expect(res.totalBidUsd).toBeGreaterThan(1_800_000);
    expect(res.totalAskUsd).toBeGreaterThan(2_200_000);
    expect(res.topBidWall).not.toBeNull();
    expect(res.topAskWall).not.toBeNull();
    expect(res.topBidWall!.price).toBeGreaterThanOrEqual(66_900);
    expect(res.topBidWall!.price).toBeLessThanOrEqual(67_200);
    expect(res.topAskWall!.price).toBeGreaterThanOrEqual(68_800);
    expect(res.topAskWall!.price).toBeLessThanOrEqual(69_200);

    const maxWall = res.walls.find((w) => w.intensity === 1);
    expect(maxWall).toBeDefined();
    expect(maxWall!.dominantSide).toBe('ask');
  });

  it('liefert leeres Ergebnis bei leerem Orderbuch', () => {
    const res = aggregateOrderbookWalls([], []);
    expect(res.midPrice).toBeNull();
    expect(res.walls).toEqual([]);
    expect(res.topBidWall).toBeNull();
    expect(res.topAskWall).toBeNull();
  });
});
