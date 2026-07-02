import { describe, expect, it } from 'vitest';
import { signalSchema, type Signal } from './signal.js';

const validLong: Signal = {
  id: '4f9c2d6e-1a2b-4c3d-8e9f-001122334455',
  createdAt: '2026-07-02T12:00:00.000Z',
  source: 'engine',
  strategyId: 'smc-core',
  symbol: 'BTC/USDT',
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
  tier: 'pro',
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
});
