import { guardedComplete, type CostGuard, type LlmProvider } from './provider.js';
import type { AgentVerdict, SignalFacts } from './types.js';

/**
 * LLM-gestützte Agenten (Makro, Shadow) — laufen NUR, wenn (a) ein Provider
 * konfiguriert ist und (b) die jeweiligen ECHTEN Datenquellen verbunden sind.
 * Das LLM bewertet ausschließlich mitgelieferte, echte Daten — es darf sich
 * nichts ausdenken (Instruktion im System-Prompt + striktes JSON-Format).
 */

const SYSTEM = `Du bist ein Trading-Analyse-Agent im Gladiator-System.
Du bekommst ein Handelssignal und ECHTE Kontextdaten. Beurteile NUR anhand
der mitgelieferten Daten — erfinde keine Fakten. Antworte AUSSCHLIESSLICH mit
einem JSON-Objekt: {"vote":"confirm"|"reject"|"caution","confidence":0..1,"reason":"..."}.
Die reason nennt konkret die Datenpunkte, auf die du dich stützt (Deutsch, max. 3 Sätze).`;

export function buildAgentPrompt(agent: 'makro' | 'shadow', facts: SignalFacts, context: Record<string, unknown>): string {
  const role =
    agent === 'makro'
      ? 'Makro-Agent: Bewerte Makro-/Regime-Kontext und Event-Nähe (Kalender, Zinsen, VIX/DXY).'
      : 'Shadow-Agent: Prüfe auf Manipulations-/Liquiditätsrisiken (Funding, Open Interest, Liquidationen).';
  return `${role}\n\nSignal:\n${JSON.stringify(facts, null, 2)}\n\nEchte Kontextdaten:\n${JSON.stringify(context, null, 2)}`;
}

/** Parst und validiert das LLM-Urteil strikt — ungültig ⇒ Fehler (kein Fake-Verdict). */
export function parseLlmVerdict(agent: string, text: string): AgentVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`${agent}: LLM-Antwort enthält kein JSON.`);
  const parsed: unknown = JSON.parse(match[0]);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${agent}: LLM-JSON ist kein Objekt.`);
  const o = parsed as Record<string, unknown>;
  if (o.vote !== 'confirm' && o.vote !== 'reject' && o.vote !== 'caution') {
    throw new Error(`${agent}: ungültiges vote "${String(o.vote)}".`);
  }
  const confidence = Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${agent}: confidence außerhalb [0,1].`);
  }
  if (typeof o.reason !== 'string' || o.reason.length === 0) {
    throw new Error(`${agent}: reason fehlt.`);
  }
  return { agent, vote: o.vote, confidence, reason: o.reason };
}

export async function reviewLlmAgent(
  agent: 'makro' | 'shadow',
  facts: SignalFacts,
  context: Record<string, unknown>,
  provider: LlmProvider,
  guard: CostGuard | null,
): Promise<AgentVerdict> {
  const prompt = buildAgentPrompt(agent, facts, context);
  const completion = guard
    ? await guardedComplete(provider, guard, { system: SYSTEM, prompt, maxTokens: 1024 })
    : await provider.complete({ system: SYSTEM, prompt, maxTokens: 1024 });
  const verdict = parseLlmVerdict(agent, completion.text);
  verdict.refs = { context, costUsd: completion.costUsd, usage: completion.usage };
  return verdict;
}

/**
 * KI-Urteil je ASSET (Mängelliste 6, zweite Stufe): dieselben Rollen (Makro, Shadow) ohne
 * Signal — Haltung zum Asset aus den echten Fakten der Asset-Analyse. Striktes JSON wie oben;
 * Müll-Antworten werden verworfen, nie zu einem Urteil gemacht.
 */
export type AssetStance = 'bullish' | 'bearish' | 'neutral';
export type AssetVerdict = { agent: 'makro' | 'shadow'; stance: AssetStance; confidence: number; reason: string; costUsd: number };

const SYSTEM_ASSET = `Du bist ein Trading-Analyse-Agent im Gladiator-System.
Du bekommst ein Asset und ECHTE Kontextdaten (Makro, Positionierung, Kalender, News-Titel).
Beurteile NUR anhand der mitgelieferten Daten — erfinde keine Fakten, keine Kurse, keine Ereignisse.
Felder mit connected:false oder null sind NICHT verbunden: nenne das, stütze dich nicht darauf.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:
{"stance":"bullish"|"bearish"|"neutral","confidence":0..1,"reason":"..."}.
Die reason nennt konkret die Datenpunkte (Deutsch, max. 3 Sätze).`;

export function buildAssetPrompt(agent: 'makro' | 'shadow', symbol: string, facts: Record<string, unknown>): string {
  const role =
    agent === 'makro'
      ? 'Makro-Agent (Oracle): Bewerte Makro-/Regime-Kontext (GRS, VIX, DXY, US10Y), Event-Nähe (Kalender) und die Schlagzeilen für dieses Asset.'
      : 'Shadow-Agent: Bewerte Positionierung und Liquiditätsrisiken (Funding, Open Interest, COT-Lage) für dieses Asset.';
  return `${role}\n\nAsset: ${symbol}\n\nEchte Kontextdaten:\n${JSON.stringify(facts, null, 2)}`;
}

export function parseAssetVerdict(agent: 'makro' | 'shadow', text: string): Omit<AssetVerdict, 'costUsd'> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`${agent}: LLM-Antwort enthält kein JSON.`);
  const parsed: unknown = JSON.parse(match[0]);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${agent}: LLM-JSON ist kein Objekt.`);
  const o = parsed as Record<string, unknown>;
  if (o.stance !== 'bullish' && o.stance !== 'bearish' && o.stance !== 'neutral') throw new Error(`${agent}: ungültige stance "${String(o.stance)}".`);
  const confidence = Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${agent}: confidence außerhalb [0,1].`);
  if (typeof o.reason !== 'string' || o.reason.trim().length === 0) throw new Error(`${agent}: reason fehlt.`);
  return { agent, stance: o.stance, confidence, reason: o.reason.trim() };
}

export async function assessAsset(agent: 'makro' | 'shadow', symbol: string, facts: Record<string, unknown>, provider: LlmProvider, guard: CostGuard | null): Promise<AssetVerdict> {
  const prompt = buildAssetPrompt(agent, symbol, facts);
  const completion = guard ? await guardedComplete(provider, guard, { system: SYSTEM_ASSET, prompt, maxTokens: 800 }) : await provider.complete({ system: SYSTEM_ASSET, prompt, maxTokens: 800 });
  return { ...parseAssetVerdict(agent, completion.text), costUsd: completion.costUsd };
}
