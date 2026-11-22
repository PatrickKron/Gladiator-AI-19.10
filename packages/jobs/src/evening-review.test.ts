import { describe, expect, it } from 'vitest';
import { summarizeEveningReview } from './evening-review.js';

describe('summarizeEveningReview', () => {
  it('erzeugt eine ehrliche Zusammenfassung bei 0 Trades', () => {
    const res = summarizeEveningReview({
      day: '2026-11-22',
      trades: [],
      openDemoPositions: 2,
      openAgentPositions: 0,
      signalsToday: 3,
    });
    expect(res.totalTrades).toBe(0);
    expect(res.winRatePct).toBeNull();
    expect(res.netPnlUsd).toBe(0);
    expect(res.bestTrade).toBeNull();
    expect(res.lessons.length).toBeGreaterThanOrEqual(2);
  });

  it('berechnet Trefferquote, Netto-PnL, Ø R sowie besten und schwächsten Trade korrekt', () => {
    const res = summarizeEveningReview({
      day: '2026-11-22',
      trades: [
        { id: '1', source: 'demo', symbol: 'BTC/USDT', direction: 'long', netPnl: 120.5, rMultiple: 2.1, reason: 'tp', exitTs: '2026-11-22T14:00:00Z' },
        { id: '2', source: 'agent', symbol: 'ETH/USDT', direction: 'short', netPnl: -45.25, rMultiple: -0.9, reason: 'sl', exitTs: '2026-11-22T16:00:00Z' },
        { id: '3', source: 'demo', symbol: 'SOL/USDT', direction: 'long', netPnl: 85.0, rMultiple: 1.4, reason: 'tp', exitTs: '2026-11-22T18:00:00Z' },
      ],
      openDemoPositions: 1,
      openAgentPositions: 1,
      signalsToday: 5,
    });
    expect(res.totalTrades).toBe(3);
    expect(res.demoTradesCount).toBe(2);
    expect(res.agentTradesCount).toBe(1);
    expect(res.wins).toBe(2);
    expect(res.losses).toBe(1);
    expect(res.winRatePct).toBeCloseTo(66.7, 1);
    expect(res.netPnlUsd).toBeCloseTo(160.25, 2);
    expect(res.avgR).toBeCloseTo(0.87, 2);
    expect(res.bestTrade?.symbol).toBe('BTC/USDT');
    expect(res.worstTrade?.symbol).toBe('ETH/USDT');
  });
});
