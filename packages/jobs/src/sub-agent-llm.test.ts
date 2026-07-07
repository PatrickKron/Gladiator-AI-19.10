import { describe, expect, it } from 'vitest';
import { CostGuard, type LlmCompletion, type LlmProvider } from '@gladiator/agents';
import type { SubAgentEntryDecision, SubAgentSnapshot } from '@gladiator/strategy-engine';
import {
  buildAnalysisMessages,
  fillPromptPlaceholders,
  parseAnalysisDecision,
  runAnalysisGate,
} from './sub-agent-llm.js';

function snap(overrides: Partial<SubAgentSnapshot> = {}): SubAgentSnapshot {
  return {
    symbol: 'BTC/USDT',
    price: 65000,
    changePct24h: -3.2,
    recentHigh: 70000,
    vix: 18.5,
    grsLabel: 'risk-on',
    dxyChangePct20d: -1.2,
    fundingRate: 0.0003,
    minutesToNextHighImpact: 45,
    recentNews: [
      { title: 'Bitcoin ETF inflows hit record', ageMin: 10 },
      { title: 'Fed hints at rate pause', ageMin: 35 },
    ],
    now: new Date('2026-07-07T12:00:00Z'),
    ...overrides,
  };
}

const decision: SubAgentEntryDecision = {
  direction: 'long',
  setupType: 'swing',
  entry: 65000,
  stopLoss: 61750,
  takeProfits: [71500],
  reasons: ['Dip 7.14 % vom Hoch (≥ 5 %)'],
};

/** Fake-Provider für deterministische Tests (kein echter API-Call). */
function fakeProvider(reply: string | (() => never), configured = true): LlmProvider {
  return {
    id: 'fake',
    configured,
    async complete(): Promise<LlmCompletion> {
      if (typeof reply !== 'string') reply();
      return { text: reply as string, usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.001 };
    },
  };
}

describe('fillPromptPlaceholders', () => {
  it('ersetzt bekannte Tokens mit echten Snapshot-Werten', () => {
    const out = fillPromptPlaceholders('VIX={vix}, DXY {dxy_change}%, US10Y {us10y}, {symbol} {side}', snap(), 'BTC/USDT', 'long');
    expect(out).toContain('VIX=18.5');
    expect(out).toContain('DXY -1.2%');
    expect(out).toContain('BTC/USDT long');
  });

  it('setzt fehlende Werte ehrlich auf n/a (kein Fake)', () => {
    const out = fillPromptPlaceholders('VIX={vix}', snap({ vix: null }), 'BTC/USDT', 'long');
    expect(out).toContain('VIX=n/a');
  });
});

describe('buildAnalysisMessages', () => {
  it('enthält den User-Prompt, echten Kontext (Preis/Makro/News) und die EXECUTE/SKIP-Anweisung', () => {
    const { system, user } = buildAnalysisMessages('Ist die Lage bullish?', snap(), 'BTC/USDT', decision);
    expect(system.toUpperCase()).toContain('EXECUTE');
    expect(user).toContain('Ist die Lage bullish?');
    expect(user).toContain('65000'); // Preis/Entry
    expect(user).toContain('18.5'); // VIX
    expect(user).toContain('Bitcoin ETF inflows hit record'); // News-Headline
    expect(user.toUpperCase()).toContain('SKIP');
  });
});

describe('parseAnalysisDecision', () => {
  it('erkennt EXECUTE in der ersten Zeile', () => {
    expect(parseAnalysisDecision('EXECUTE\nNachrichtenlage klar bullish.').decision).toBe('execute');
  });
  it('erkennt SKIP', () => {
    expect(parseAnalysisDecision('SKIP — zu nah an High-Impact-Event.').decision).toBe('skip');
  });
  it('ist konservativ (SKIP) bei unklarer/leerer Antwort', () => {
    expect(parseAnalysisDecision('Schwer zu sagen, könnte beides sein.').decision).toBe('skip');
    expect(parseAnalysisDecision('').decision).toBe('skip');
  });
  it('nimmt bei EXECUTE+SKIP im Text die erste Zeile als maßgeblich', () => {
    expect(parseAnalysisDecision('EXECUTE\nKein Grund zu skippen.').decision).toBe('execute');
  });
});

describe('runAnalysisGate', () => {
  const guard = () => new CostGuard({ dailyBudgetUsd: 5 });

  it('ohne konfigurierten Provider: übersprungen → regelbasierte Entscheidung gilt', async () => {
    const r = await runAnalysisGate(fakeProvider('', false), guard(), 'p', snap(), 'BTC/USDT', decision);
    expect(r.evaluated).toBe(false);
  });

  it('null-Provider: ebenfalls übersprungen', async () => {
    const r = await runAnalysisGate(null, guard(), 'p', snap(), 'BTC/USDT', decision);
    expect(r.evaluated).toBe(false);
  });

  it('EXECUTE-Antwort → evaluated execute mit Begründung', async () => {
    const r = await runAnalysisGate(fakeProvider('EXECUTE\nBullische Nachrichten.'), guard(), 'p', snap(), 'BTC/USDT', decision);
    expect(r.evaluated).toBe(true);
    if (r.evaluated) {
      expect(r.decision).toBe('execute');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('SKIP-Antwort → evaluated skip (Veto)', async () => {
    const r = await runAnalysisGate(fakeProvider('SKIP\nRisiko zu hoch.'), guard(), 'p', snap(), 'BTC/USDT', decision);
    expect(r.evaluated && r.decision === 'skip').toBe(true);
  });

  it('LLM-Fehler bei gesetztem Key → konservativ skip (kein Trade auf fehlgeschlagener Analyse)', async () => {
    const throwing = fakeProvider(() => {
      throw new Error('network down');
    });
    const r = await runAnalysisGate(throwing, guard(), 'p', snap(), 'BTC/USDT', decision);
    expect(r.evaluated && r.decision === 'skip').toBe(true);
    if (r.evaluated) expect(r.reason.toLowerCase()).toContain('fehlgeschlagen');
  });
});
