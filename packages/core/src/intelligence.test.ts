import { describe, expect, it } from 'vitest';
import { signalSchema, type Signal } from './signal.js';
import { signalIntelligenceSchema, scoreComponentsSchema } from './intelligence.js';

const validLong: Signal = {
  id: '4f9c2d6e-1a2b-4c3d-8e9f-001122334455',
  createdAt: '2026-07-02T12:00:00.000Z',
  source: 'engine',
  strategyId: 'smc-core',
  symbol: 'BTC/USDT',
  timeframe: '1h',
  assetClass: 'crypto',
  venueType: 'cex',
  direction: 'long',
  setupType: 'swing',
  entry: 100_000,
  stopLoss: 98_500,
  takeProfits: [101_500, 103_000, 104_500],
  leverageSuggested: 3,
  score: 8.2,
  riskClass: 'low',
  confluence: ['BOS', 'EMA200-Trend'],
  session: 'london',
  status: 'new',
};

describe('signalIntelligenceSchema (additive KI-Schicht)', () => {
  it('füllt sinnvolle Defaults, wenn nur Pflicht-Minimum übergeben wird', () => {
    const parsed = signalIntelligenceSchema.parse({});
    expect(parsed.assetIsExample).toBe(false);
    expect(parsed.marketRegime).toBeNull();
    expect(parsed.cpiStatus).toBe('none');
    expect(parsed.cotStatus).toBe('not_applicable');
    expect(parsed.buffettStatus).toBe('not_applicable');
    expect(parsed.postTradeReviewRequired).toBe(true);
    expect(parsed.validUntil).toBeNull();
    expect(parsed.shadowWarning).toBe('');
  });

  it('akzeptiert eine vollständige Intelligence-Schicht (PDF §11)', () => {
    const full = {
      assetIsExample: true,
      marketRegime: 'sideways',
      scoreComponents: {
        technical: 0.7,
        macroCpi: 0.3,
        liquidityShadow: 0.5,
        cotPositioning: 0.4,
        valuationBuffett: 0.0,
        riskReward: 0.6,
      },
      riskClass: 'high',
      positionSizeMode: 'reduced',
      hedgeMode: 'partial_hedge',
      cpiStatus: 'pre_event',
      cotStatus: 'crowded_long',
      buffettStatus: 'elevated',
      shadowWarning: 'Liquidationscluster über Entry',
      oracleMacroSummary: 'CPI in 6h, DXY fest',
      devilsAdvocate: 'Trend könnte auslaufen',
      finalDecision: 'hedge',
      explanationForUser: 'CPI-Fenster: Teilabsicherung empfohlen',
      validUntil: '2026-07-02T18:00:00.000Z',
      postTradeReviewRequired: true,
    };
    expect(() => signalIntelligenceSchema.parse(full)).not.toThrow();
  });

  it('lehnt Score-Komponenten außerhalb 0..1 ab', () => {
    expect(() =>
      scoreComponentsSchema.parse({
        technical: 1.2,
        macroCpi: 0,
        liquidityShadow: 0,
        cotPositioning: 0,
        valuationBuffett: 0,
        riskReward: 0,
      }),
    ).toThrow();
  });

  it('lehnt unbekannte Enum-Werte ab', () => {
    expect(() => signalIntelligenceSchema.parse({ hedgeMode: 'nuke' })).toThrow();
    expect(() => signalIntelligenceSchema.parse({ cpiStatus: 'maybe' })).toThrow();
    expect(() => signalIntelligenceSchema.parse({ riskClass: 'insane' })).toThrow();
  });

  it('erlaubt die erweiterte Risikoklasse `extreme` (additiv zu low/medium/high)', () => {
    expect(signalIntelligenceSchema.parse({ riskClass: 'extreme' }).riskClass).toBe('extreme');
  });
});

describe('signalSchema mit intelligence-Feld (additiv, bricht Bestand nicht)', () => {
  it('bleibt ohne intelligence gültig (Rückwärtskompatibilität)', () => {
    const parsed = signalSchema.parse(validLong);
    expect(parsed.intelligence).toBeUndefined();
  });

  it('akzeptiert ein Signal MIT intelligence-Schicht', () => {
    const withIntel: Signal = {
      ...validLong,
      intelligence: signalIntelligenceSchema.parse({
        marketRegime: 'bull',
        hedgeMode: 'no_hedge',
        finalDecision: 'signal',
      }),
    };
    const parsed = signalSchema.parse(withIntel);
    expect(parsed.intelligence?.marketRegime).toBe('bull');
    expect(parsed.intelligence?.finalDecision).toBe('signal');
  });
});
