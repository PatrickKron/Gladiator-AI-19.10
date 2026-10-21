import { describe, expect, it } from 'vitest';
import { replayLevels, summarizeReplayTrades, type ReplayTrade } from './replay-trades.js';

const t = (p: Partial<ReplayTrade>): ReplayTrade => ({
  id: 'x',
  direction: 'long',
  entryTime: 0,
  entry: 100,
  stopLoss: 99,
  takeProfit: 102,
  status: 'closed',
  rMultiple: 1,
  exitReason: 'tp',
  exitTime: 10,
  ...p,
});

describe('replay-trades', () => {
  it('Level aus Prozent: Long Stop unter / Ziel über, Short umgekehrt; nie 0 %', () => {
    expect(replayLevels(100, 'long', 1, 2)).toEqual({ stopLoss: 99, takeProfit: 102 });
    expect(replayLevels(100, 'short', 1, 2)).toEqual({ stopLoss: 101, takeProfit: 98 });
    const tiny = replayLevels(100, 'long', 0, -5);
    expect(tiny.stopLoss).toBeLessThan(100);
    expect(tiny.takeProfit).toBeGreaterThan(100);
  });

  it('Zusammenfassung: geschlossene zählen, offene nur gezählt, ungültige raus', () => {
    const s = summarizeReplayTrades([
      t({ id: 'a', rMultiple: 2 }),
      t({ id: 'b', rMultiple: -1, exitReason: 'sl' }),
      t({ id: 'c', status: 'open', rMultiple: 0.3, exitReason: null, exitTime: null }),
      t({ id: 'd', status: 'invalid', rMultiple: null, exitReason: null, exitTime: null }),
    ]);
    expect(s).toEqual({ total: 3, closed: 2, open: 1, wins: 1, sumR: 1, winRate: 0.5 });
    expect(summarizeReplayTrades([])).toEqual({ total: 0, closed: 0, open: 0, wins: 0, sumR: 0, winRate: null });
  });
});
