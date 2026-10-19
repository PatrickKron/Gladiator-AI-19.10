import { describe, expect, it } from 'vitest';
import { lifecycleChips } from './signal-lifecycle.js';

const plan = { enabled: true, minPullbackPct: 1.5, maxPullbackPct: 2.5, zoneLow: 97.5, zoneHigh: 98.5, maxReentries: 1, generation: 0 };
const lev = { triggerPct: 5, multiplier: 1.5, maxLeverage: 10 };

describe('lifecycleChips (05_ §9 kompakt auf der Signal-Karte)', () => {
  it('offenes Signal: Reentry-Zone + Hebel-Trigger', () => {
    const chips = lifecycleChips({ status: 'new', reentry: plan, leverageUpgrade: lev, autoKill: null });
    expect(chips.map((c) => c.key)).toEqual(['signals.lcReentryZone', 'signals.lcLeverageTrigger']);
    expect(chips[0]!.params).toMatchObject({ low: 97.5, high: 98.5 });
    expect(chips[1]!.hintParams).toMatchObject({ pct: 5, mult: 1.5, max: 10 });
  });

  it('deaktivierter Plan → ehrlicher „kein Reentry"-Chip', () => {
    const chips = lifecycleChips({ status: 'new', reentry: { ...plan, enabled: false }, leverageUpgrade: null, autoKill: null });
    expect(chips.map((c) => c.key)).toEqual(['signals.lcReentryOff']);
  });

  it('Reentry-Kind wird als solches markiert', () => {
    const chips = lifecycleChips({ status: 'new', reentry: { ...plan, enabled: false, generation: 1, parentSignalId: 'x' }, leverageUpgrade: null, autoKill: null });
    expect(chips[0]).toMatchObject({ key: 'signals.lcReentryChild', params: { n: 1 } });
  });

  it('Hebel-Vorschlag hat Vorrang vor dem Trigger-Hinweis', () => {
    const chips = lifecycleChips({
      status: 'filled',
      reentry: null,
      leverageUpgrade: { ...lev, suggestion: { suggested: 1.5, from: 1, movePct: 11, reason: 'x', at: '2026-10-19T10:00:00Z', positionId: 'p', price: 111 } },
      autoKill: null,
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ key: 'signals.lcLeverageSuggestion', params: { from: 1, to: 1.5 }, tone: 'warn' });
  });

  it('Auto-Kill: Grund übersetzt, Pläne eines entwerteten Signals ausgeblendet', () => {
    const chips = lifecycleChips({ status: 'expired', reentry: plan, leverageUpgrade: lev, autoKill: { reason: 'score_below_threshold', score: 7.5, rescored: 5, at: 'x' } });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ key: 'signals.lcKilled', reasonKey: 'signals.lcKillScore', tone: 'neg' });
    expect(chips[0]!.params).toMatchObject({ from: 7.5, to: 5 });
  });

  it('unbekannter Kill-Grund fällt auf generischen Text zurück', () => {
    const chips = lifecycleChips({ status: 'expired', reentry: null, leverageUpgrade: null, autoKill: { reason: 'neu', score: null, rescored: null, at: 'x' } });
    expect(chips[0]!.reasonKey).toBe('signals.lcKillOther');
  });

  it('ohne Daten → keine Chips', () => {
    expect(lifecycleChips({ status: 'new', reentry: null, leverageUpgrade: null, autoKill: null })).toEqual([]);
  });
});
