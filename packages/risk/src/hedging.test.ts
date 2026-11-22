import { describe, expect, it } from 'vitest';
import { DEFAULT_HEDGING_CONFIG, evaluateHedging, parseHedgingConfig } from './hedging.js';

describe('Hedging-Konfiguration & Auswertung', () => {
  it('liefert sichere Defaults bei leerem/kaputtem Input', () => {
    expect(parseHedgingConfig(null)).toEqual(DEFAULT_HEDGING_CONFIG);
    expect(parseHedgingConfig({ triggerVix: 999 })).toEqual(DEFAULT_HEDGING_CONFIG);
  });

  it('bleibt deaktiviert, wenn enabled=false', () => {
    const res = evaluateHedging(DEFAULT_HEDGING_CONFIG, {
      drawdownPct: 12,
      vix: 35,
      grsLabel: 'risk-off',
      netExposureUsd: 10_000,
    });
    expect(res.state).toBe('disabled');
    expect(res.recommendedHedgePct).toBe(0);
    expect(res.exposureScaleFactor).toBe(1);
  });

  it('bleibt im Standby, wenn alle Werte unterhalb der Schwellen liegen', () => {
    const cfg = parseHedgingConfig({ enabled: true, triggerDrawdownPct: 6, triggerVix: 25, triggerOnRiskOff: true, maxHedgeRatioPct: 50 });
    const res = evaluateHedging(cfg, {
      drawdownPct: 2.1,
      vix: 18.4,
      grsLabel: 'neutral',
      netExposureUsd: 5_000,
    });
    expect(res.state).toBe('standby');
    expect(res.triggeredBy).toEqual([]);
  });

  it('aktiviert Absicherung und skaliert Hedge-Quote bei VIX + Risk-Off + Drawdown', () => {
    const cfg = parseHedgingConfig({
      enabled: true,
      triggerDrawdownPct: 5,
      triggerVix: 24,
      triggerOnRiskOff: true,
      maxHedgeRatioPct: 60,
      autoReduceExposure: true,
      hedgeSymbol: 'BTC/USDT',
    });
    const res = evaluateHedging(cfg, {
      drawdownPct: 7.5,
      vix: 28,
      grsLabel: 'risk-off',
      netExposureUsd: 20_000,
    });
    expect(res.state).toBe('active');
    expect(res.triggeredBy.length).toBe(3);
    expect(res.recommendedHedgePct).toBe(60);
    expect(res.recommendedHedgeUsd).toBe(12_000);
    expect(res.exposureScaleFactor).toBe(0.5);
  });
});
