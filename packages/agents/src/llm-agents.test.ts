import { describe, expect, it } from 'vitest';
import { parseLlmVerdict, reviewLlmAgent } from './llm-agents.js';
import type { LlmProvider } from './provider.js';
import type { SignalFacts } from './types.js';

const facts: SignalFacts = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  source: 'engine',
  entry: 100,
  stopLoss: 95,
  takeProfits: [110],
  score: 8,
  confluence: ['BOS'],
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};

describe('LLM-Agenten: striktes Urteil-Parsing (kein Fake bei Müll-Antworten)', () => {
  it('gültiges JSON wird geparst', () => {
    const v = parseLlmVerdict('makro', 'Hier: {"vote":"caution","confidence":0.6,"reason":"FOMC in 2h."}');
    expect(v.vote).toBe('caution');
    expect(v.confidence).toBe(0.6);
  });

  it.each([
    ['kein JSON', 'bla bla'],
    ['ungültiges vote', '{"vote":"maybe","confidence":0.5,"reason":"x"}'],
    ['confidence > 1', '{"vote":"confirm","confidence":1.5,"reason":"x"}'],
    ['reason fehlt', '{"vote":"confirm","confidence":0.5}'],
  ])('%s ⇒ Fehler statt erfundenem Verdict', (_label, text) => {
    expect(() => parseLlmVerdict('makro', text)).toThrow();
  });

  it('reviewLlmAgent hängt echte Kosten/Kontext als refs an', async () => {
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async () => ({
        text: '{"vote":"confirm","confidence":0.7,"reason":"Funding neutral, OI stabil."}',
        usage: { inputTokens: 500, outputTokens: 60 },
        costUsd: 0.004,
      }),
    };
    const v = await reviewLlmAgent('shadow', facts, { fundingRate: 0.0001 }, fake, null);
    expect(v.agent).toBe('shadow');
    expect(v.vote).toBe('confirm');
    expect(v.refs?.costUsd).toBe(0.004);
  });
});
