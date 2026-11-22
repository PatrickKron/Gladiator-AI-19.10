import { describe, expect, it } from 'vitest';
import { exposureFit, safeCappedNotional } from './exposure-fit.js';

/**
 * Warum blockt das Exposure-Limit? 1 % Risiko bei Stop s % ⇒ Position = 1/s des
 * Kontos; bei 20 % Limit passt das erst ab Stop ≥ 5 %. Die Funktion rechnet das
 * offen vor und nennt den größten erlaubten Betrag samt dann tatsächlichem Risiko.
 */
describe('exposureFit', () => {
  const base = { equity: 10_000, riskPct: 1, entry: 100, maxExposurePct: 20, existingExposurePct: 0 };

  it('Stop 2 %: Position wäre 50 % des Kontos → passt nicht, max. 2000 USD = 0,4 % Risiko', () => {
    const f = exposureFit({ ...base, stopLoss: 98 });
    expect(f.stopPct).toBeCloseTo(2, 9);
    expect(f.impliedExposurePct).toBeCloseTo(50, 9);
    expect(f.fits).toBe(false);
    expect(f.maxNotional).toBeCloseTo(2000, 9);
    expect(f.riskPctAtMax).toBeCloseTo(0.4, 9);
    expect(f.minStopPctForFullRisk).toBeCloseTo(5, 9);
  });

  it('Stop 5 % oder weiter: passt genau bzw. locker', () => {
    expect(exposureFit({ ...base, stopLoss: 95 }).fits).toBe(true);
    expect(exposureFit({ ...base, stopLoss: 90 }).fits).toBe(true);
  });

  it('bestehende Position auf dem Symbol verkleinert den Spielraum', () => {
    const f = exposureFit({ ...base, stopLoss: 95, existingExposurePct: 15 });
    expect(f.fits).toBe(false);
    expect(f.maxNotional).toBeCloseTo(500, 9);
  });

  it('Short spiegelbildlich, Limit schon ausgeschöpft → maxNotional 0', () => {
    const f = exposureFit({ ...base, stopLoss: 102, existingExposurePct: 25 });
    expect(f.stopPct).toBeCloseTo(2, 9);
    expect(f.maxNotional).toBe(0);
    expect(f.riskPctAtMax).toBe(0);
    expect(f.minStopPctForFullRisk).toBeNull();
  });

  it('ungültige Eingaben (Stop = Entry, kein Konto) → fits false ohne NaN', () => {
    const a = exposureFit({ ...base, stopLoss: 100 });
    const b = exposureFit({ ...base, equity: 0, stopLoss: 98 });
    for (const f of [a, b]) {
      expect(f.fits).toBe(false);
      expect(Number.isFinite(f.maxNotional)).toBe(true);
    }
  });
});

describe('safeCappedNotional', () => {
  const base = {
    equity: 10_000,
    availableMargin: 10_000,
    leverage: 1,
    riskPct: 1,
    entry: 64_000,
    maxExposurePct: 20,
    existingExposurePct: 0,
    minNotional: 10,
  };

  it('deckelt enge Krypto-Stops (0,5 %) konservativ auf das 20-%-Exposure-Limit mit kleinerem Risiko', () => {
    const res = safeCappedNotional({ ...base, stopLoss: 63_680 }); // 0,5 % SL → roh 20.000 $ (200 %)
    expect(res.capped).toBe(true);
    expect(res.notional).not.toBeNull();
    expect(res.notional!).toBeLessThanOrEqual(2_000);
    expect(res.notional!).toBeGreaterThan(1_990);
    expect(res.effectiveRiskPct).toBeCloseTo(0.1, 2);
  });

  it('verändert normale weite Stops (≥ 5 %) nicht', () => {
    const res = safeCappedNotional({ ...base, stopLoss: 60_800 }); // 5 % SL → 2.000 $ passt
    expect(res.capped).toBe(false);
    expect(res.notional).toBeCloseTo(2_000, 2);
    expect(res.effectiveRiskPct).toBe(1);
  });

  it('liefert null wenn Exposure-Budget bereits ausgeschöpft ist (Gate blockt weiter hart)', () => {
    const res = safeCappedNotional({ ...base, stopLoss: 63_680, existingExposurePct: 20 });
    expect(res.capped).toBe(false);
    expect(res.notional).toBeNull();
  });
});
