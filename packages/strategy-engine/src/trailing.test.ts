import { describe, expect, it } from 'vitest';
import { trailStep } from './trailing.js';

describe('trailStep: Trailing-Stop folgt dem Kurs, nie zurück', () => {
  it('Long: neuer Höchststand zieht den Stop nach (Abstand in %)', () => {
    const r = trailStep({ direction: 'long', pct: 2, peak: 100, price: 110, currentStop: 95 });
    expect(r.peak).toBe(110);
    expect(r.stop).toBeCloseTo(107.8, 10); // 110 × (1 − 2 %)
  });

  it('Long: fallender Kurs bewegt den Stop NICHT zurück', () => {
    const r = trailStep({ direction: 'long', pct: 2, peak: 110, price: 105, currentStop: 107.8 });
    expect(r.peak).toBe(110);
    expect(r.stop).toBeNull(); // keine Änderung
  });

  it('Long: berechneter Stop lockerer als der aktuelle → keine Änderung (nur verschärfen)', () => {
    const r = trailStep({ direction: 'long', pct: 10, peak: 100, price: 101, currentStop: 99 });
    expect(r.peak).toBe(101);
    expect(r.stop).toBeNull(); // 90,9 < 99
  });

  it('Short: neuer Tiefststand zieht den Stop nach unten', () => {
    const r = trailStep({ direction: 'short', pct: 2, peak: 100, price: 90, currentStop: 104 });
    expect(r.peak).toBe(90);
    expect(r.stop).toBeCloseTo(91.8, 10); // 90 × (1 + 2 %)
  });

  it('Short: steigender Kurs bewegt den Stop nicht', () => {
    expect(trailStep({ direction: 'short', pct: 2, peak: 90, price: 95, currentStop: 91.8 }).stop).toBeNull();
  });

  it('ohne bisherigen Peak startet er beim aktuellen Kurs', () => {
    const r = trailStep({ direction: 'long', pct: 5, peak: null, price: 200, currentStop: 150 });
    expect(r.peak).toBe(200);
    expect(r.stop).toBeCloseTo(190, 10);
  });

  it('ungültige Eingaben → nichts tun', () => {
    expect(trailStep({ direction: 'long', pct: 0, peak: 100, price: 110, currentStop: 90 }).stop).toBeNull();
    expect(trailStep({ direction: 'long', pct: 2, peak: 100, price: NaN, currentStop: 90 }).stop).toBeNull();
  });
});
