import { describe, expect, it } from 'vitest';
import type { RiskVerdict } from '@gladiator/risk';
import type { LlmProvider } from './provider.js';
import { runSwarm, type SwarmInput } from './swarm.js';
import type { SignalFacts } from './types.js';

const facts: SignalFacts = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  source: 'engine',
  entry: 100,
  stopLoss: 95,
  takeProfits: [110, 115],
  score: 8,
  confluence: ['BOS', 'Retest'],
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};

const greenRisk: RiskVerdict = {
  allowed: true,
  reasons: [],
  checks: [{ name: 'alle', passed: true, detail: 'ok' }],
  sizing: { qty: 0.01, notional: 1000, marginRequired: 1000, riskAmount: 100 },
};

function input(overrides?: Partial<SwarmInput>): SwarmInput {
  return {
    facts,
    riskVerdict: greenRisk,
    devilEvidence: { buckets: [], totalTrades: 50 },
    llm: { provider: null, guard: null, macroDataConnected: false, onchainDataConnected: false },
    ...overrides,
  };
}

describe('Agenten-Schwarm (runSwarm)', () => {
  it('ohne LLM-Provider: Makro & Shadow DEAKTIVIERT + sichtbar markiert, Rest läuft', async () => {
    const { verdicts, disabled } = await runSwarm(input());
    const agents = verdicts.map((v) => v.agent);
    expect(agents).toContain('technik');
    expect(agents).toContain('risk');
    expect(agents).toContain('devil');
    expect(agents).toContain('portfolio');
    expect(agents).not.toContain('makro');
    expect(agents).not.toContain('shadow');
    expect(disabled.map((d) => d.agent).sort()).toEqual(['makro', 'shadow']);
    expect(disabled.every((d) => /Provider|verbunden/i.test(d.reason))).toBe(true);
  });

  it('mit Provider, aber ohne Makro-/On-Chain-Daten: weiterhin deaktiviert (Datenquelle ehrlich benannt)', async () => {
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async () => ({ text: '{}', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
    };
    const { disabled } = await runSwarm(input({ llm: { provider: fake, guard: null, macroDataConnected: false, onchainDataConnected: false } }));
    const makro = disabled.find((d) => d.agent === 'makro')!;
    const shadow = disabled.find((d) => d.agent === 'shadow')!;
    expect(makro.reason).toMatch(/Daten|FRED|Kalender/i);
    expect(shadow.reason).toMatch(/Daten|Funding|On-Chain/i);
  });

  it('Portfolio-Urteil ist immer das letzte Verdict', async () => {
    const { verdicts } = await runSwarm(input());
    expect(verdicts[verdicts.length - 1]!.agent).toBe('portfolio');
  });

  it('rotes Risk-Gate schlägt bis ins Portfolio durch (reject)', async () => {
    const redRisk: RiskVerdict = {
      allowed: false,
      reasons: ['Kill-Switch ist aktiv'],
      checks: [{ name: 'kill-switch', passed: false, detail: 'Kill-Switch ist aktiv' }],
      sizing: null,
    };
    const { verdicts } = await runSwarm(input({ riskVerdict: redRisk }));
    const portfolio = verdicts.find((v) => v.agent === 'portfolio')!;
    expect(portfolio.vote).toBe('reject');
  });
});
