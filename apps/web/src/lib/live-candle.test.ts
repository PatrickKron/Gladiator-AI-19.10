import { describe, expect, it } from 'vitest';
import { applyTick, liveBarSeconds } from './live-candle.js';

const H = 3600;
const last = { time: 1_000 * H, open: 100, high: 105, low: 95, close: 101 };

describe('applyTick: echte Ticks bewegen die letzte Kerze', () => {
  it('Tick innerhalb der Kerze → Close, High/Low erweitern', () => {
    expect(applyTick(last, 107, (1_000 * H + 600) * 1000, H)).toEqual({ ...last, high: 107, close: 107 });
    expect(applyTick(last, 90, (1_000 * H + 600) * 1000, H)).toEqual({ ...last, low: 90, close: 90 });
    expect(applyTick(last, 102, (1_000 * H + 600) * 1000, H)).toEqual({ ...last, close: 102 });
  });

  it('Tick nach Kerzenende → neue Kerze am richtigen Raster (Open = Tick)', () => {
    expect(applyTick(last, 103, (1_001 * H + 5) * 1000, H)).toEqual({ time: 1_001 * H, open: 103, high: 103, low: 103, close: 103 });
    // Lücke über mehrere Kerzen: Raster bleibt korrekt
    expect(applyTick(last, 103, (1_003 * H + 5) * 1000, H)?.time).toBe(1_003 * H);
  });

  it('veralteter Tick (vor der letzten Kerze) oder ungültiger Preis → ignoriert', () => {
    expect(applyTick(last, 103, (999 * H) * 1000, H)).toBeNull();
    expect(applyTick(last, NaN, (1_000 * H + 1) * 1000, H)).toBeNull();
    expect(applyTick(last, 0, (1_000 * H + 1) * 1000, H)).toBeNull();
  });

  it('Wochen/Monate: nur die laufende Kerze aktualisieren, keine neue erfinden (Kalender-Grenzen)', () => {
    const w = liveBarSeconds('1w');
    expect(w).toBeNull();
    expect(applyTick(last, 103, (1_500 * H) * 1000, null)).toEqual({ ...last, close: 103 });
  });

  it('feste Timeframes in Sekunden', () => {
    expect(liveBarSeconds('5m')).toBe(300);
    expect(liveBarSeconds('4h')).toBe(4 * H);
    expect(liveBarSeconds('1d')).toBe(24 * H);
  });
});
