import { describe, expect, it } from 'vitest';
import { CostGuard, type LlmCompletion, type LlmProvider } from '@gladiator/agents';
import {
  analyzePine,
  buildChatMessages,
  buildPineAnalysisMessages,
  parseChatReply,
  parsePineAnalysis,
  runChatTurn,
} from './llm.js';

/** Fake-Provider: liefert einen fixen Text, zählt Aufrufe — kein Netzwerk. */
function fakeProvider(text: string): LlmProvider & { calls: { system: string; prompt: string }[] } {
  const calls: { system: string; prompt: string }[] = [];
  return {
    id: 'fake',
    configured: true,
    calls,
    async complete(opts): Promise<LlmCompletion> {
      calls.push({ system: opts.system, prompt: opts.prompt });
      return { text, usage: { inputTokens: 10, outputTokens: 10 }, costUsd: 0.001 };
    },
  };
}

const VALID_DSL = {
  id: 'pine-rsi-dip',
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  when: { all: [{ indicator: 'RSI', lt: 30 }, { adx: { gt: 20 } }] },
  entry: 'market',
  stopLoss: { type: 'ATR', mult: 2 },
  takeProfits: [{ rr: 2 }],
  risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
};

const VALID_ANALYSIS = {
  strategyType: 'mean_reversion',
  direction: 'long',
  timeframeHint: '1h',
  indicators: [{ name: 'RSI', params: 'period=14', role: 'Einstieg' }],
  entryConditions: ['RSI unter 30'],
  exitConditions: ['Take-Profit bei 2R'],
  parameters: [{ name: 'rsiLength', value: '14' }],
  notTranslatable: ['Trailing-Stop des Scripts'],
  summary: 'Kauft überverkaufte Dips per RSI.',
  dslDraft: VALID_DSL,
};

describe('Workshop-LLM: Pine-Analyse (Prompt-Bau + Parse, rein)', () => {
  it('Prompt enthält das Script und das System-Prompt das DSL-Schema', () => {
    const m = buildPineAnalysisMessages('//@version=5\nstrategy("Test")');
    expect(m.prompt).toContain('strategy("Test")');
    expect(m.system).toContain('maCross');
    expect(m.system).toContain('notTranslatable');
  });

  it('überlanges Script wird gekappt (Token-Schutz)', () => {
    const m = buildPineAnalysisMessages('x'.repeat(50_000));
    expect(m.prompt.length).toBeLessThan(30_000);
    expect(m.prompt).toContain('(gekürzt)');
  });

  it('valide Antwort → Analyse + validierter dslDraft', () => {
    const r = parsePineAnalysis(`Hier die Analyse:\n${JSON.stringify(VALID_ANALYSIS)}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.analysis.strategyType).toBe('mean_reversion');
      expect(r.analysis.notTranslatable).toContain('Trailing-Stop des Scripts');
      expect(r.dslDraft?.id).toBe('pine-rsi-dip');
      expect(r.dslErrors).toEqual([]);
    }
  });

  it('ungültiger dslDraft → Analyse bleibt ok, Fehler transparent, KEIN Draft', () => {
    const r = parsePineAnalysis(JSON.stringify({ ...VALID_ANALYSIS, dslDraft: { id: 'x' } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dslDraft).toBeNull();
      expect(r.dslErrors.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['kein JSON', 'Leider kann ich das nicht analysieren.'],
    ['kaputtes JSON', '{ "strategyType": '],
    ['Schema-Verstoß', JSON.stringify({ strategyType: 'quantum', direction: 'long' })],
  ])('%s → ok:false mit Fehlerliste', (_label, text) => {
    const r = parsePineAnalysis(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('analyzePine: Ende-zu-Ende mit Fake-Provider inkl. Kosten', async () => {
    const provider = fakeProvider(JSON.stringify(VALID_ANALYSIS));
    const guard = new CostGuard({ dailyBudgetUsd: 5 });
    const r = await analyzePine(provider, guard, 'strategy("Test")');
    expect(r.ok).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.001, 6);
    expect(provider.calls).toHaveLength(1);
    expect(guard.spentUsd()).toBeCloseTo(0.001, 6);
  });
});

describe('Workshop-LLM: Dialog (Prompt-Bau + Parse, rein)', () => {
  const ctx = {
    pineSource: 'strategy("Test")',
    analysis: { summary: 'RSI-Dip-Kauf' },
    draftDsl: VALID_DSL,
    instructions: 'Konservativ handeln.',
    history: [
      { role: 'user', content: 'Was machen wir bei Seitwärtsmarkt?' },
      { role: 'assistant', content: 'ADX-Filter ergänzen.' },
    ],
    userMessage: 'Gut, ADX über 20 bitte.',
  };

  it('Prompt enthält Kontext, Entwurf, Anweisungen, Verlauf und neue Nachricht', () => {
    const m = buildChatMessages(ctx);
    expect(m.prompt).toContain('strategy("Test")');
    expect(m.prompt).toContain('RSI-Dip-Kauf');
    expect(m.prompt).toContain('pine-rsi-dip');
    expect(m.prompt).toContain('Konservativ handeln.');
    expect(m.prompt).toContain('NUTZER: Was machen wir bei Seitwärtsmarkt?');
    expect(m.prompt).toContain('ADX über 20 bitte');
    expect(m.system).toContain('```json');
  });

  it('Verlauf wird auf die letzten 24 Nachrichten begrenzt', () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `Nachricht-${i}` }));
    const m = buildChatMessages({ ...ctx, history: long });
    expect(m.prompt).not.toContain('Nachricht-0');
    expect(m.prompt).toContain('Nachricht-59');
  });

  it('Antwort ohne Codeblock → nur Text, kein Vorschlag', () => {
    const r = parseChatReply('Lass uns zuerst über Volatilität sprechen.');
    expect(r.proposedDsl).toBeNull();
    expect(r.dslErrors).toEqual([]);
  });

  it('Antwort mit validem JSON-Block → validierter Vorschlag', () => {
    const r = parseChatReply(`Einverstanden — hier der Stand:\n\`\`\`json\n${JSON.stringify(VALID_DSL)}\n\`\`\``);
    expect(r.proposedDsl?.id).toBe('pine-rsi-dip');
    expect(r.content).toContain('Einverstanden');
  });

  it('Antwort mit ungültigem Vorschlag → Fehler transparent, kein Vorschlag', () => {
    const r = parseChatReply('Vorschlag:\n```json\n{"id":"nur-fragment"}\n```');
    expect(r.proposedDsl).toBeNull();
    expect(r.dslErrors.length).toBeGreaterThan(0);
  });

  it('runChatTurn: Ende-zu-Ende mit Fake-Provider', async () => {
    const provider = fakeProvider(`Passt.\n\`\`\`json\n${JSON.stringify(VALID_DSL)}\n\`\`\``);
    const guard = new CostGuard({ dailyBudgetUsd: 5 });
    const r = await runChatTurn(provider, guard, ctx);
    expect(r.proposedDsl?.id).toBe('pine-rsi-dip');
    expect(r.costUsd).toBeCloseTo(0.001, 6);
  });

  it('Budget erschöpft → guardedComplete wirft (kein stiller Fake)', async () => {
    const provider = fakeProvider('egal');
    const guard = new CostGuard({ dailyBudgetUsd: 0 });
    await expect(runChatTurn(provider, guard, ctx)).rejects.toThrow(/Tagesbudget/);
  });
});
