import { describe, expect, it } from 'vitest';
import { assessAsset, buildAssetPrompt, parseAssetVerdict, parseLlmVerdict, reviewLlmAgent } from './llm-agents.js';
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

describe('KI-Urteil je Asset (Makro/Shadow ohne Signal)', () => {
  it('Prompt nennt Rolle, Asset und die echten Fakten', () => {
    const p = buildAssetPrompt('shadow', 'BTC/USDT', { derivatives: { connected: true, fundingRate: 0.0001 } });
    expect(p).toMatch(/Shadow-Agent/);
    expect(p).toMatch(/Asset: BTC\/USDT/);
    expect(p).toMatch(/"fundingRate": 0.0001/);
  });
  it('striktes Parsing: stance/confidence/reason, Müll ⇒ Fehler', () => {
    expect(parseAssetVerdict('makro', 'ok {"stance":"neutral","confidence":0.4,"reason":"VIX 18, kein Event."}')).toEqual({ agent: 'makro', stance: 'neutral', confidence: 0.4, reason: 'VIX 18, kein Event.' });
    expect(() => parseAssetVerdict('makro', '{"stance":"long","confidence":0.4,"reason":"x"}')).toThrow(/stance/);
    expect(() => parseAssetVerdict('makro', '{"stance":"bullish","confidence":2,"reason":"x"}')).toThrow(/confidence/);
    expect(() => parseAssetVerdict('makro', '{"stance":"bullish","confidence":0.5,"reason":" "}')).toThrow(/reason/);
    expect(() => parseAssetVerdict('makro', 'keine antwort')).toThrow(/JSON/);
  });
  it('assessAsset hängt die echten Kosten an und nutzt den Guard', async () => {
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async () => ({ text: '{"stance":"bearish","confidence":0.7,"reason":"Funding 0,08 %/8 h, OI +12 %."}', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.002 }),
    };
    const v = await assessAsset('shadow', 'BTC/USDT', { derivatives: { connected: true } }, fake, null);
    expect(v).toEqual({ agent: 'shadow', stance: 'bearish', confidence: 0.7, reason: 'Funding 0,08 %/8 h, OI +12 %.', costUsd: 0.002 });
  });
});
