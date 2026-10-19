import { describe, expect, it } from 'vitest';
import { paperStudyRow, type PaperStudyInput } from './study-record.js';

const base: PaperStudyInput = {
  executedTradeId: '00000000-0000-0000-0000-000000000001',
  signal: {
    strategySlug: 'smc-core',
    symbol: 'BTC/USDT',
    setupType: 'swing',
    timeframe: '1h',
    session: 'newyork',
    emaRegime: 'below',
    marketPhase: 'bear',
  },
  direction: 'short',
  entry: 100,
  qty: 2,
  initialStop: 104, // 4 % Stop-Abstand → Risiko 8 $
  takeProfitCount: 3,
  entryTs: new Date('2026-10-18T10:00:00Z'),
  exitTs: new Date('2026-10-18T14:00:00Z'),
  netPnl: 12,
  fees: 0.16,
  funding: 0.01,
};

describe('paperStudyRow — VDB1 aus einem geschlossenen Paper-Trade (13_ §3)', () => {
  it('voller Cluster-Key aus dem Signal (gemeinsamer Builder), Quelle über executed_trade_id', () => {
    const r = paperStudyRow(base)!;
    expect(r.clusterKey).toBe('smc-core|BTC/USDT|swing|1h|newyork|downtrend');
    expect(r.executedTradeId).toBe(base.executedTradeId);
    expect(r.session).toBe('newyork');
    expect(r.marketStructure).toBe('downtrend');
  });

  it('R netto auf das URSPRÜNGLICHE Risiko; ausgeführtes Schema A = Ist-Ergebnis, B/C/D ehrlich null', () => {
    const r = paperStudyRow(base)!;
    expect(Number(r.rMultiple)).toBeCloseTo(1.5, 9); // 12 / (4 × 2)
    expect(Number(r.pnlRTpA)).toBeCloseTo(1.5, 9);
    expect(r.pnlRTpB).toBeNull();
    expect(r.pnlRTpC).toBeNull();
    expect(r.pnlRTpD).toBeNull();
    expect(r.netPnl).toBe('12');
    expect(r.fees).toBe('0.16');
    expect(r.funding).toBe('0.01');
    expect(r.slippage).toBe('0');
  });

  it('MAE = Stop-Abstand als konservative Obergrenze (Preisverlauf wird im Paper nicht erfasst), MFE unbekannt', () => {
    const r = paperStudyRow(base)!;
    expect(Number(r.maeBps)).toBeCloseTo(400, 9);
    expect(r.mfeBps).toBeNull();
    expect(r.liquidationFlag).toBe(false);
  });

  it('weniger als 3 TPs = nicht Schema A → kein Schema-Wert (nie falsch zuordnen)', () => {
    const r = paperStudyRow({ ...base, takeProfitCount: 1 })!;
    expect(r.pnlRTpA).toBeNull();
    expect(Number(r.rMultiple)).toBeCloseTo(1.5, 9);
  });

  it('kein Risiko bestimmbar (Stop = Entry) → keine Zeile statt erfundenem R', () => {
    expect(paperStudyRow({ ...base, initialStop: 100 })).toBeNull();
  });
});
