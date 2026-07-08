import { guardedComplete, type CostGuard, type LlmProvider } from '@gladiator/agents';

/**
 * Nutzer-Erklärung des Signalobjekts (PDF §11/§14): Die Entscheidung selbst
 * ist deterministisch — das LLM darf sie nur ERKLÄREN, nie verändern.
 * Ohne ANTHROPIC_API_KEY (oder bei Budget-/API-Fehlern) bleibt die
 * deterministische Reason-Code-Fassung die Antwort: graceful, nie ein Fehler.
 * Die LLM-Fassung wird der Code-Fassung vorangestellt, damit die auditierbaren
 * Reason-Codes im UI und in der DB immer erhalten bleiben.
 */

export type ExplanationFacts = {
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  finalDecision: string;
  hedgeMode: string;
  hedgeReason: string;
  riskClass: string;
  regime: string | null;
  cpiStatus: string;
  cotStatus: string;
  buffettStatus: string;
  shadowWarning: string;
  devilsAdvocate: string;
};

/** Bisheriges deterministisches Format — unverändert (Basis-Wahrheit, auditierbar). */
export function deterministicExplanation(f: ExplanationFacts): string {
  const parts = [`Entscheidung: ${f.finalDecision}.`, `Hedge: ${f.hedgeReason}`];
  if (f.cpiStatus !== 'none') parts.push(`CPI-Phase: ${f.cpiStatus}.`);
  if (f.cotStatus !== 'not_applicable' && f.cotStatus !== 'neutral') parts.push(`COT: ${f.cotStatus}.`);
  if (f.buffettStatus !== 'not_applicable' && f.buffettStatus !== 'neutral') parts.push(`Bewertung: ${f.buffettStatus}.`);
  return parts.join(' ');
}

/** Unterstützte UI-Sprachen (users.locale); alles andere fällt auf Deutsch zurück. */
const LANGUAGE_NAMES: Record<string, string> = {
  de: 'Deutsch',
  en: 'English',
  it: 'Italiano',
  es: 'Español',
  fr: 'Français',
};

export function buildExplanationMessages(f: ExplanationFacts, locale: string | undefined): { system: string; prompt: string } {
  const language = LANGUAGE_NAMES[locale ?? 'de'] ?? LANGUAGE_NAMES.de!;
  const system = [
    'Du bist der Erklär-Agent von Gladiator AI. Die Trading-Entscheidung wurde bereits DETERMINISTISCH getroffen — du erklärst sie nur.',
    'Fasse in 2–4 kurzen Sätzen für einen Privatanleger zusammen, warum die Entscheidung so ausfiel.',
    'Erfinde keine neuen Fakten, keine Zahlen, keine Kursziele. Keine Anlageberatung, keine Empfehlung über die Entscheidung hinaus.',
    `Antworte ausschließlich auf ${language}. Nur der Erklärtext — kein Markdown, keine Überschrift, keine Anrede.`,
  ].join('\n');
  const prompt = JSON.stringify(
    {
      symbol: f.symbol,
      timeframe: f.timeframe,
      direction: f.direction,
      finalDecision: f.finalDecision,
      hedgeMode: f.hedgeMode,
      hedgeReason: f.hedgeReason,
      riskClass: f.riskClass,
      marketRegime: f.regime,
      cpiStatus: f.cpiStatus,
      cotStatus: f.cotStatus,
      buffettStatus: f.buffettStatus,
      shadowWarning: f.shadowWarning || null,
      devilsAdvocate: f.devilsAdvocate || null,
    },
    null,
    2,
  );
  return { system, prompt };
}

/** LLM-Ausgabe defensiv säubern: Fences weg, Whitespace normalisieren, Länge deckeln. */
export function sanitizeExplanation(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

export async function explainForUser(
  provider: LlmProvider,
  guard: CostGuard,
  facts: ExplanationFacts,
  locale: string | undefined,
): Promise<string> {
  const base = deterministicExplanation(facts);
  if (!provider.configured) return base;
  try {
    const { system, prompt } = buildExplanationMessages(facts, locale);
    const res = await guardedComplete(provider, guard, { system, prompt, maxTokens: 400 });
    const summary = sanitizeExplanation(res.text);
    return summary ? `${summary}\n${base}` : base;
  } catch {
    // Budget erschöpft / API-Fehler: Erklärung ist Komfort, nie ein Blocker.
    return base;
  }
}
