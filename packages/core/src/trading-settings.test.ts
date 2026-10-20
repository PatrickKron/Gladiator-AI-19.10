import { describe, expect, it } from 'vitest';
import { RISK_PROFILES, SETTINGS_BOUNDS, matchRiskProfile, type TradingLimits } from './trading-settings.js';

describe('Risiko-Profile (Einstellungen › Trading)', () => {
  it('jedes Profil liegt innerhalb der Server-Grenzen', () => {
    for (const p of RISK_PROFILES) {
      for (const [key, bounds] of Object.entries(SETTINGS_BOUNDS) as [keyof TradingLimits, { min: number; max: number }][]) {
        expect(p.limits[key], `${p.id}.${key}`).toBeGreaterThanOrEqual(bounds.min);
        expect(p.limits[key], `${p.id}.${key}`).toBeLessThanOrEqual(bounds.max);
      }
    }
  });

  it('Profile sind nach Risiko aufsteigend sortiert (Risiko %, Hebel, Exposure)', () => {
    for (let i = 1; i < RISK_PROFILES.length; i++) {
      const a = RISK_PROFILES[i - 1]!.limits;
      const b = RISK_PROFILES[i]!.limits;
      expect(b.riskPctPerTrade).toBeGreaterThanOrEqual(a.riskPctPerTrade);
      expect(b.maxLeverage).toBeGreaterThanOrEqual(a.maxLeverage);
      expect(b.maxExposurePctPerAsset).toBeGreaterThanOrEqual(a.maxExposurePctPerAsset);
    }
  });

  it('„Standard" entspricht den DB-Voreinstellungen (1 %, 10×, 5 Positionen, 20 %, 3/7/15 %)', () => {
    expect(RISK_PROFILES.find((p) => p.id === 'standard')!.limits).toEqual({
      riskPctPerTrade: 1,
      maxLeverage: 10,
      maxOpenPositions: 5,
      maxExposurePctPerAsset: 20,
      dailyLossLimitPct: 3,
      weeklyLossLimitPct: 7,
      maxDrawdownPct: 15,
    });
  });

  it('Exposure darf bis zum Hebel-Maximum reichen (sonst wäre Hebel wirkungslos)', () => {
    expect(SETTINGS_BOUNDS.maxExposurePctPerAsset.max).toBe(SETTINGS_BOUNDS.maxLeverage.max * 100);
  });

  it('matchRiskProfile erkennt ein Profil exakt, sonst null (= eigene Werte)', () => {
    const profi = RISK_PROFILES.find((p) => p.id === 'profi')!;
    expect(matchRiskProfile(profi.limits)).toBe('profi');
    expect(matchRiskProfile({ ...profi.limits, maxLeverage: profi.limits.maxLeverage + 1 })).toBeNull();
  });
});
