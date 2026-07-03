import { describe, expect, it } from 'vitest';
import { detectStructure } from './structure.js';
import type { Candle } from './types.js';

function c(high: number, low: number, close?: number): Candle {
  return { ts: new Date(0), open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, volume: 100 };
}

const OPTS = { leftBars: 2, rightBars: 2 };

describe('Marktstruktur: BOS & CHoCH (05_ §3, Pine-Referenz)', () => {
  it('BOS bullish: Schlusskurs bricht über das letzte bestätigte Swing-Hoch', () => {
    const candles = [
      c(10, 9), c(11, 10), c(14, 12), c(11, 10), c(10, 9), // Swing-Hoch 14 @2, bestätigt @4
      c(12, 10), c(15, 13, 14.5),                           // @6: close 14.5 > 14 → BOS
    ];
    const events = detectStructure(candles, OPTS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'BOS',
      direction: 'bullish',
      index: 6,
      brokenLevel: 14,
      swingIndex: 2,
    });
  });

  it('LOOK-AHEAD-SCHUTZ: unbestätigter Swing darf nicht gebrochen werden', () => {
    const candles = [
      c(10, 9), c(11, 10), c(14, 12),
      c(15, 13, 14.5), // @3: über 14 — aber Pivot @2 ist erst @4 bestätigt → KEIN Event
      c(11, 10), c(10, 9),
    ];
    const events = detectStructure(candles, OPTS);
    expect(events.filter((e) => e.index === 3)).toHaveLength(0);
  });

  it('CHoCH bearish: erster Bruch GEGEN einen Bull-Trend', () => {
    const candles = [
      c(10, 9), c(11, 10), c(14, 12), c(11, 10), c(10, 9),  // Swing-Hoch 14 @2
      c(15, 13, 14.5),                                       // @5: BOS bullish → Trend bull
      c(16, 14), c(13, 8), c(14, 12), c(15, 13),             // Swing-Tief 8 @7, bestätigt @9
      c(12, 7, 7.5),                                         // @10: close 7.5 < 8 → CHoCH bearish
    ];
    const events = detectStructure(candles, OPTS);
    expect(events.map((e) => e.kind)).toEqual(['BOS', 'CHoCH']);
    expect(events[1]).toMatchObject({ kind: 'CHoCH', direction: 'bearish', index: 10, brokenLevel: 8 });
  });

  it('CHoCH bullish: erster Bruch GEGEN einen Bear-Trend', () => {
    const candles = [
      c(12, 11), c(11, 10), c(10, 7), c(11, 10), c(12, 11), // Swing-Tief 7 @2
      c(8, 6, 6.5),                                          // @5: BOS bearish → Trend bear
      c(7, 5), c(12, 9), c(8, 6), c(7, 5),                   // Swing-Hoch 12 @7, bestätigt @9
      c(13, 11, 12.5),                                       // @10: close 12.5 > 12 → CHoCH bullish
    ];
    const events = detectStructure(candles, OPTS);
    expect(events.map((e) => [e.kind, e.direction])).toEqual([
      ['BOS', 'bearish'],
      ['CHoCH', 'bullish'],
    ]);
  });

  it('jedes Swing-Level löst höchstens EIN Ereignis aus (kein Dauerfeuer)', () => {
    const candles = [
      c(10, 9), c(11, 10), c(14, 12), c(11, 10), c(10, 9),
      c(15, 13, 14.5), c(16, 14, 15.5), c(17, 15, 16.5), // drei Closes über 14 → nur 1 Event
    ];
    const events = detectStructure(candles, OPTS);
    expect(events).toHaveLength(1);
  });

  it('Docht über dem Level ohne Schlusskurs-Bruch zählt NICHT', () => {
    const candles = [
      c(10, 9), c(11, 10), c(14, 12), c(11, 10), c(10, 9),
      c(14.8, 12, 13), // Docht bis 14.8, close 13 → kein Bruch
    ];
    expect(detectStructure(candles, OPTS)).toHaveLength(0);
  });
});
