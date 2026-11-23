import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEDGING_CONFIG,
  DEFAULT_HEDGING_STRATEGIES,
  evaluateAssetHedging,
  evaluateHedging,
  parseHedgingConfig,
  resolveHedgingForAsset,
} from './hedging.js';

describe('Hedging-Konfiguration & Auswertung', () => {
  it('liefert sichere Defaults inkl. eingebauter Strategien bei leerem/kaputtem Input', () => {
    expect(parseHedgingConfig(null)).toEqual(DEFAULT_HEDGING_CONFIG);
    expect(parseHedgingConfig({ triggerVix: 999 })).toEqual(DEFAULT_HEDGING_CONFIG);
    expect(DEFAULT_HEDGING_CONFIG.strategies.length).toBe(DEFAULT_HEDGING_STRATEGIES.length);
    expect(DEFAULT_HEDGING_CONFIG.assetAssignments).toEqual({});
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

  it('ordnet verschiedenen Assets verschiedene Hedging-Strategien zu und löst SAME sauber auf', () => {
    const cfg = parseHedgingConfig({
      enabled: true,
      assetAssignments: {
        'BTC/USDT': 'crypto-crash-shield',
        'SOL/USDT': 'altcoin-btc-beta',
        'RHM.DE': 'equity-index-shield',
        'XAU/USD': 'none',
      },
      defaultStrategyId: 'stablecoin-buffer',
    });

    const btc = resolveHedgingForAsset(cfg, 'btc/usdt');
    expect(btc.mode).toBe('assigned');
    expect(btc.strategyId).toBe('crypto-crash-shield');
    expect(btc.hedgeSymbol).toBe('BTC/USDT'); // SAME → BTC/USDT
    expect(btc.effectiveConfig.maxHedgeRatioPct).toBe(60);

    const sol = evaluateAssetHedging(cfg, 'SOL/USDT', {
      drawdownPct: 5,
      vix: 26,
      grsLabel: 'risk-off',
      netExposureUsd: 10_000,
    });
    expect(sol.strategyId).toBe('altcoin-btc-beta');
    expect(sol.hedgeSymbol).toBe('BTC/USDT');
    expect(sol.evaluation.state).toBe('active');
    expect(sol.evaluation.recommendedHedgePct).toBe(45);
    expect(sol.evaluation.recommendedHedgeUsd).toBe(4_500);

    const rhm = resolveHedgingForAsset(cfg, 'RHM.DE');
    expect(rhm.strategyId).toBe('equity-index-shield');
    expect(rhm.hedgeSymbol).toBe('SPY');

    const gold = evaluateAssetHedging(cfg, 'XAU/USD', {
      drawdownPct: 12,
      vix: 40,
      grsLabel: 'risk-off',
      netExposureUsd: 5_000,
    });
    expect(gold.mode).toBe('none');
    expect(gold.evaluation.state).toBe('disabled');

    const eth = resolveHedgingForAsset(cfg, 'ETH/USDT');
    expect(eth.mode).toBe('default_strategy');
    expect(eth.strategyId).toBe('stablecoin-buffer');
    expect(eth.hedgeSymbol).toBe('USDT');
  });
});
