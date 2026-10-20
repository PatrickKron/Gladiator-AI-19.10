import { describe, expect, it } from 'vitest';
import { signalSchema, type Signal } from './signal.js';

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
  confluence: ['BOS', 'EMA200-Trend', 'Retest@EMA50', 'RSI-Band', 'Volume'],
  session: 'london',
  status: 'new',
};

describe('kanonisches Signal-Schema', () => {
  it('akzeptiert ein gültiges Long-Signal', () => {
    expect(signalSchema.parse(validLong)).toMatchObject({ symbol: 'BTC/USDT' });
  });

  it('akzeptiert ein gültiges Short-Signal', () => {
    const short: Signal = {
      ...validLong,
      direction: 'short',
      stopLoss: 101_500,
      takeProfits: [98_500, 97_000],
    };
    expect(() => signalSchema.parse(short)).not.toThrow();
  });

  it('lehnt Score außerhalb 0..10 ab (kein hartkodierter Fantasie-Score)', () => {
    expect(() => signalSchema.parse({ ...validLong, score: 10.5 })).toThrow();
    expect(() => signalSchema.parse({ ...validLong, score: -1 })).toThrow();
  });

  it('lehnt Long-Signal mit SL über Entry ab', () => {
    expect(() => signalSchema.parse({ ...validLong, stopLoss: 100_500 })).toThrow();
  });

  it('lehnt Long-Signal mit TP unter Entry ab', () => {
    expect(() => signalSchema.parse({ ...validLong, takeProfits: [99_000] })).toThrow();
  });

  it('lehnt Short-Signal mit TP über Entry ab', () => {
    expect(() =>
      signalSchema.parse({ ...validLong, direction: 'short', stopLoss: 101_000, takeProfits: [102_000] }),
    ).toThrow();
  });

  it('lehnt leere takeProfits ab', () => {
    expect(() => signalSchema.parse({ ...validLong, takeProfits: [] })).toThrow();
  });

  it('lehnt unbekannte Enums ab', () => {
    expect(() => signalSchema.parse({ ...validLong, venueType: 'otc' })).toThrow();
    expect(() => signalSchema.parse({ ...validLong, session: 'tokyo' })).toThrow();
  });

  it('Reentry-/Leverage-Upgrade-Plan (05_ §9): flaches Modell inkl. Herkunft und Vorschlag', () => {
    const parsed = signalSchema.parse({
      ...validLong,
      reentry: {
        enabled: false, minPullbackPct: 1.5, maxPullbackPct: 2.5, zoneLow: 97_500, zoneHigh: 98_500,
        maxReentries: 1, generation: 1, parentSignalId: validLong.id, rootSignalId: validLong.id,
      },
      leverageUpgrade: {
        triggerPct: 5, multiplier: 1.5, maxLeverage: 10,
        suggestion: { suggested: 3, from: 2, movePct: 5.2, reason: 'x', at: '2026-07-02T13:00:00.000Z', positionId: validLong.id, price: 105_200 },
      },
    });
    expect(parsed.reentry?.generation).toBe(1);
    expect(parsed.leverageUpgrade?.suggestion?.suggested).toBe(3);
  });

  it('Alt-Format ohne Zusatzfelder bleibt gültig (abwärtskompatibel)', () => {
    expect(() =>
      signalSchema.parse({ ...validLong, reentry: { enabled: true, minPullbackPct: 1.5, maxPullbackPct: 2 }, leverageUpgrade: { triggerPct: 2, maxLeverage: 20 } }),
    ).not.toThrow();
  });

  it('lehnt negative Reentry-Generation ab', () => {
    expect(() =>
      signalSchema.parse({ ...validLong, reentry: { enabled: true, minPullbackPct: 1.5, maxPullbackPct: 2, generation: -1 } }),
    ).toThrow();
  });
});
