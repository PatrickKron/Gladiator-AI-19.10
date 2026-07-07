import { guardedComplete, type CostGuard, type LlmProvider } from '@gladiator/agents';
import type { SubAgentEntryDecision, SubAgentSnapshot } from '@gladiator/strategy-engine';

/**
 * Optionaler LLM-Analyse-Layer für Sub-Agenten (Trading-Werkstatt).
 *
 * Das LLM ist ein ZUSÄTZLICHES Veto-Gate NACH der regelbasierten Engine: Nur
 * wenn die Regeln bereits erfüllt sind UND der Agent einen `analysisPrompt` hat,
 * wird eine LLM-Bewertung gemacht, bevor ein Signal entsteht. Der regelbasierte
 * Pfad funktioniert unverändert ohne LLM (Regel 9). Fehlt der ANTHROPIC_API_KEY,
 * wird der Schritt übersprungen und die regelbasierte Entscheidung gilt.
 *
 * Alle Prompt-Bau- und Parse-Funktionen sind rein und unit-getestet; der Call
 * selbst läuft über den vorhandenen Provider-Router + Kosten-Wächter.
 */

const SYSTEM_PROMPT = [
  'Du bist ein disziplinierter, nüchterner Trading-Analyst.',
  'Die regelbasierten Einstiegsbedingungen eines Agenten sind BEREITS erfüllt.',
  'Deine Aufgabe: prüfe anhand des echten Kontexts (Preis, Makro, News, Kalender), ob der Trade jetzt ausgeführt werden soll.',
  'Antworte in der ERSTEN Zeile GENAU mit einem Wort: EXECUTE oder SKIP.',
  'Danach 1–3 Sätze Begründung. Im Zweifel oder bei dünner Faktenlage: SKIP.',
  'Erfinde keine Fakten; nutze nur den gelieferten Kontext.',
].join(' ');

const INSTRUCTION = 'Entscheide jetzt. Erste Zeile GENAU "EXECUTE" oder "SKIP", danach eine kurze Begründung (1–3 Sätze).';

function fmt(n: number | null, digits = 2): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

/** Ersetzt {tokens} im Nutzer-Prompt mit echten Snapshot-Werten (fehlend → n/a). */
export function fillPromptPlaceholders(prompt: string, s: SubAgentSnapshot, symbol: string, side: 'long' | 'short'): string {
  const map: Record<string, string> = {
    '{vix}': fmt(s.vix, 1),
    '{dxy_change}': fmt(s.dxyChangePct20d, 1),
    '{us10y}': 'n/a', // US10Y ist im Snapshot nicht separat geführt (nur im GRS enthalten)
    '{grs}': s.grsLabel ?? 'n/a',
    '{price}': fmt(s.price),
    '{change24h}': fmt(s.changePct24h, 1),
    '{funding}': s.fundingRate === null ? 'n/a' : String(s.fundingRate),
    '{symbol}': symbol,
    '{side}': side,
  };
  let out = prompt;
  for (const [token, value] of Object.entries(map)) out = out.split(token).join(value);
  return out;
}

/** Baut den maschinenlesbaren Kontext-Block aus echten Snapshot-Daten. */
export function buildAnalysisContext(s: SubAgentSnapshot, symbol: string, decision: SubAgentEntryDecision): string {
  const lines = [
    '=== Aktueller Kontext (echte Daten) ===',
    `Symbol: ${symbol}`,
    `Regel-Entscheidung: ${decision.direction.toUpperCase()} @ ${fmt(decision.entry)} ` +
      `(SL ${fmt(decision.stopLoss)}, TP ${decision.takeProfits.map((t) => fmt(t)).join('/')})`,
    `Regel-Gründe: ${decision.reasons.join('; ') || '—'}`,
    `Preis: ${fmt(s.price)} | 24h: ${fmt(s.changePct24h, 1)}% | jüngstes Hoch: ${fmt(s.recentHigh)}`,
    `Makro: VIX ${fmt(s.vix, 1)} | Regime ${s.grsLabel ?? 'n/a'} | DXY-20T ${fmt(s.dxyChangePct20d, 1)}%`,
    `Funding-Rate: ${s.fundingRate === null ? 'n/a' : s.fundingRate}`,
    `Nächstes High-Impact-Event in: ${s.minutesToNextHighImpact === null ? 'keins in Reichweite' : `${Math.round(s.minutesToNextHighImpact)} min`}`,
  ];
  if (s.recentNews.length > 0) {
    lines.push('News-Headlines (jüngste zuerst):');
    for (const n of s.recentNews.slice(0, 8)) lines.push(`- [vor ${Math.round(n.ageMin)} min] ${n.title}`);
  } else {
    lines.push('News-Headlines: keine frischen Meldungen vorhanden.');
  }
  return lines.join('\n');
}

/** Setzt System- und User-Message für den LLM-Call zusammen. */
export function buildAnalysisMessages(
  userPrompt: string,
  s: SubAgentSnapshot,
  symbol: string,
  decision: SubAgentEntryDecision,
): { system: string; user: string } {
  const filled = fillPromptPlaceholders(userPrompt, s, symbol, decision.direction);
  const user = `${filled}\n\n${buildAnalysisContext(s, symbol, decision)}\n\n${INSTRUCTION}`;
  return { system: SYSTEM_PROMPT, user };
}

function classify(text: string): 'execute' | 'skip' | 'unclear' {
  const u = text.toUpperCase();
  const exec = /\bEXECUTE\b/.test(u);
  const skip = /\bSKIP\b/.test(u);
  if (exec && !skip) return 'execute';
  if (skip && !exec) return 'skip';
  return 'unclear';
}

/**
 * Extrahiert die Entscheidung. Maßgeblich ist die erste Zeile; sonst der ganze
 * Text; bleibt es unklar (oder beide/keins) → KONSERVATIV 'skip' (kein Trade auf
 * mehrdeutiger Analyse).
 */
export function parseAnalysisDecision(text: string): { decision: 'execute' | 'skip'; reason: string } {
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0] ?? '';
  const first = classify(firstLine);
  const whole = classify(trimmed);
  const decision = first !== 'unclear' ? first : whole !== 'unclear' ? whole : 'skip';
  return { decision, reason: trimmed.slice(0, 600) };
}

export type LlmGateOutcome =
  | { evaluated: false; reason: string }
  | { evaluated: true; decision: 'execute' | 'skip'; reason: string; model: string };

/**
 * Führt das optionale LLM-Veto-Gate aus.
 * - Kein/ nicht konfigurierter Provider → `evaluated:false` (regelbasiert weiter).
 * - Provider da → EXECUTE/SKIP mit Begründung.
 * - Provider da, aber Call/Budget scheitert → konservativ SKIP diesen Tick.
 */
export async function runAnalysisGate(
  provider: LlmProvider | null,
  guard: CostGuard,
  userPrompt: string,
  s: SubAgentSnapshot,
  symbol: string,
  decision: SubAgentEntryDecision,
): Promise<LlmGateOutcome> {
  if (!provider || !provider.configured) {
    return { evaluated: false, reason: 'kein ANTHROPIC_API_KEY — LLM-Analyse übersprungen, regelbasierte Entscheidung gilt' };
  }
  const { system, user } = buildAnalysisMessages(userPrompt, s, symbol, decision);
  try {
    const res = await guardedComplete(provider, guard, { system, prompt: user, maxTokens: 512 });
    const parsed = parseAnalysisDecision(res.text);
    return { evaluated: true, decision: parsed.decision, reason: parsed.reason, model: provider.id };
  } catch (err) {
    return { evaluated: true, decision: 'skip', reason: `LLM-Analyse fehlgeschlagen: ${String(err)}`, model: provider.id };
  }
}
