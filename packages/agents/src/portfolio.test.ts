import { describe, expect, it } from 'vitest';
import { aggregateVerdicts } from './portfolio.js';
import type { AgentVerdict, DisabledAgent } from './types.js';

const v = (agent: string, vote: AgentVerdict['vote'], confidence: number): AgentVerdict => ({
  agent,
  vote,
  confidence,
  reason: `${agent}: ${vote}`,
});

describe('Portfolio-Manager (Aggregation, transparent)', () => {
  it('einhellige confirms → confirm', () => {
    const out = aggregateVerdicts([v('technik', 'confirm', 0.9), v('risk', 'confirm', 1), v('devil', 'confirm', 0.6)], []);
    expect(out.agent).toBe('portfolio');
    expect(out.vote).toBe('confirm');
    expect(out.confidence).toBeGreaterThan(0.5);
  });

  it('Risk-Agent reject ist HART: final reject, egal was andere sagen', () => {
    const out = aggregateVerdicts([v('technik', 'confirm', 0.95), v('risk', 'reject', 0.95), v('devil', 'confirm', 0.9)], []);
    expect(out.vote).toBe('reject');
    expect(out.reason).toMatch(/Risk/);
  });

  it('gemischte Urteile → caution', () => {
    const out = aggregateVerdicts([v('technik', 'confirm', 0.7), v('devil', 'reject', 0.7)], []);
    expect(out.vote).toBe('caution');
  });

  it('deaktivierte Agenten werden sichtbar benannt (kein stilles Verschlucken)', () => {
    const disabled: DisabledAgent[] = [
      { agent: 'makro', reason: 'kein LLM-Provider' },
      { agent: 'shadow', reason: 'On-Chain-Daten nicht verbunden' },
    ];
    const out = aggregateVerdicts([v('technik', 'confirm', 0.9), v('risk', 'confirm', 1)], disabled);
    expect(out.reason).toMatch(/makro/i);
    expect(out.reason).toMatch(/shadow/i);
    expect(out.refs?.disabled).toEqual(disabled);
  });

  it('keine Urteile → caution mit ehrlicher Begründung', () => {
    const out = aggregateVerdicts([], [{ agent: 'technik', reason: 'x' }]);
    expect(out.vote).toBe('caution');
    expect(out.confidence).toBeLessThanOrEqual(0.3);
  });

  it('Confidence liegt immer in [0,1]', () => {
    const out = aggregateVerdicts([v('a', 'reject', 1), v('b', 'reject', 1)], []);
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(out.vote).toBe('reject');
  });
});
