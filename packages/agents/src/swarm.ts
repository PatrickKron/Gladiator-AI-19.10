import type { RiskVerdict } from '@gladiator/risk';
import { reviewDevil, type DevilEvidence } from './devil.js';
import { decideHedge, reviewHedge, reviewInstitutional, type IntelligenceContext } from './intelligence.js';
import { reviewLlmAgent } from './llm-agents.js';
import { aggregateVerdicts } from './portfolio.js';
import type { CostGuard, LlmProvider } from './provider.js';
import { reviewRisk } from './risk-agent.js';
import { reviewTechnik } from './technik.js';
import type { AgentVerdict, DisabledAgent, SignalFacts } from './types.js';

/**
 * Schwarm-Orchestrierung (08_ §1): führt alle LAUFFÄHIGEN Agenten aus und
 * markiert nicht lauffähige ehrlich als deaktiviert. Der Portfolio-Manager
 * aggregiert am Ende. Reihenfolge im Ergebnis: Einzel-Agenten …, portfolio.
 */

export type SwarmInput = {
  facts: SignalFacts;
  /** Vorschau der echten Risk-Engine (vom Aufrufer mit echtem Kontostand berechnet). */
  riskVerdict: RiskVerdict;
  /** Auf das Signal zutreffende Historien-Buckets (echte study_trades). */
  devilEvidence: DevilEvidence;
  llm: {
    provider: LlmProvider | null;
    guard: CostGuard | null;
    /** FRED/Kalender/VIX-DXY verbunden? (Phase-1-Rest) */
    macroDataConnected: boolean;
    /** Funding/OI/Liquidations verbunden? */
    onchainDataConnected: boolean;
    /** Echte Kontextdaten, wenn verbunden. */
    macroContext?: Record<string, unknown>;
    onchainContext?: Record<string, unknown>;
  };
  /**
   * KI-Intelligence-Kontext (CPI/COT/Buffett/Regime/Shadow) — deterministisch,
   * vom Aufrufer aus echten market-data-Quellen befüllt. Fehlt er, werden der
   * Institutional- und der Hedge-Agent ehrlich als deaktiviert markiert.
   */
  intelligence?: IntelligenceContext;
};

export type SwarmResult = {
  verdicts: AgentVerdict[];
  disabled: DisabledAgent[];
};

export async function runSwarm(input: SwarmInput): Promise<SwarmResult> {
  const verdicts: AgentVerdict[] = [];
  const disabled: DisabledAgent[] = [];

  // Deterministische Agenten — laufen immer (echte Signal-/Konto-/Historien-Daten).
  verdicts.push(reviewTechnik(input.facts));
  verdicts.push(reviewRisk(input.riskVerdict));
  verdicts.push(reviewDevil(input.facts, input.devilEvidence));

  // Institutional & Valuation (COT + Buffett) + Hedge — deterministisch, nur
  // mit echtem Intelligence-Kontext; sonst ehrlich deaktiviert (kein Fake).
  if (input.intelligence) {
    verdicts.push(reviewInstitutional(input.intelligence));
    verdicts.push(reviewHedge(decideHedge(input.intelligence)));
  } else {
    disabled.push({ agent: 'institutional', reason: 'COT-/Bewertungs-Daten nicht verbunden' });
    disabled.push({ agent: 'hedge', reason: 'Intelligence-Kontext (CPI/COT/Buffett/Regime) nicht verbunden' });
  }

  // LLM-Agenten — nur mit Provider UND verbundenen Datenquellen (08_ §2).
  const { provider, guard } = input.llm;
  const llmAgents: {
    agent: 'makro' | 'shadow';
    connected: boolean;
    context: Record<string, unknown> | undefined;
    dataReason: string;
  }[] = [
    {
      agent: 'makro',
      connected: input.llm.macroDataConnected,
      context: input.llm.macroContext,
      dataReason: 'Makro-Datenquellen (FRED/Wirtschaftskalender/VIX-DXY) nicht verbunden',
    },
    {
      agent: 'shadow',
      connected: input.llm.onchainDataConnected,
      context: input.llm.onchainContext,
      dataReason: 'Funding-/OI-/On-Chain-Daten nicht verbunden',
    },
  ];

  for (const a of llmAgents) {
    if (!provider || !provider.configured) {
      disabled.push({ agent: a.agent, reason: 'kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt)' });
      continue;
    }
    if (!a.connected || !a.context) {
      disabled.push({ agent: a.agent, reason: a.dataReason });
      continue;
    }
    try {
      verdicts.push(await reviewLlmAgent(a.agent, input.facts, a.context, provider, guard));
    } catch (err) {
      // Fehler ⇒ deaktiviert + Grund — NIEMALS ein erfundenes Verdict.
      disabled.push({ agent: a.agent, reason: `LLM-Aufruf fehlgeschlagen: ${String(err)}` });
    }
  }

  verdicts.push(aggregateVerdicts(verdicts.slice(), disabled));
  return { verdicts, disabled };
}
