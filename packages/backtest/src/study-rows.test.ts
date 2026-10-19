import { describe, expect, it } from 'vitest';
import type { BacktestTrade } from './engine.js';
import { labStudyRow } from './study-rows.js';

const trade: BacktestTrade = {
  entryTs: new Date('2026-09-01T08:00:00Z'),
  exitTs: new Date('2026-09-02T12:00:00Z'),
  direction: 'long',
  setupType: 'swing',
  entry: 100,
  stopLoss: 95, // 5 % Stop-Abstand
  takeProfits: [110, 120, 130],
  exitPrice: 110,
  qty: 1,
  riskAmount: 5,
  grossPnl: 10,
  fees: 0.08,
  slippage: 0.02,
  funding: 0.01,
  netPnl: 9.89,
  rMultiple: 1.978,
  mfeR: 2.4,
  maeR: 0.6,
  maePct: 0.03,
  barsHeld: 7,
  score: 7.5,
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
  confluence: ['Trend (EMA)'],
  exitReason: 'tp',
  pnlRTpA: 1.9,
  pnlRTpB: 1.7,
  pnlRTpC: 1.95,
  pnlRTpD: 2.2,
};

describe('labStudyRow — VDB1-Zeile aus einem echten Backtest-Trade', () => {
  const ctx = { strategy: 'smc-core', symbol: 'BTC/USDT', setupType: 'swing', timeframe: '4h' };

  it('voller Cluster-Key mit Session + Struktur je Trade (gemeinsamer Builder)', () => {
    const r = labStudyRow(trade, ctx);
    expect(r.clusterKey).toBe('smc-core|BTC/USDT|swing|4h|london|uptrend');
    expect(r.session).toBe('london');
    expect(r.marketStructure).toBe('uptrend');
    expect(r.executedTradeId).toBeNull(); // Quelle Labor
  });

  it('MAE/MFE in echten Basispunkten des Entry-Preises (Liquidations-Check braucht Preis-%)', () => {
    const r = labStudyRow(trade, ctx);
    expect(Number(r.maeBps)).toBeCloseTo(300, 6); // 3 %
    expect(Number(r.mfeBps)).toBeCloseTo(1200, 6); // 2,4 R × 5 % = 12 %
  });

  it('Netto-Kosten und alle vier TP-Schema-Ergebnisse werden übernommen', () => {
    const r = labStudyRow(trade, ctx);
    expect(r).toMatchObject({
      fees: '0.08',
      funding: '0.01',
      slippage: '0.02',
      netPnl: '9.89',
      rMultiple: '1.978',
      pnlRTpA: '1.9',
      pnlRTpB: '1.7',
      pnlRTpC: '1.95',
      pnlRTpD: '2.2',
      liquidationFlag: false,
    });
  });
});
