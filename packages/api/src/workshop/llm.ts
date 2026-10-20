import { z } from 'zod';
import { guardedComplete, guardedStream, type CostGuard, type LlmProvider } from '@gladiator/agents';
import { DSL_LIMITS_DOC, DSL_SCHEMA_DOC, parseInstructionDsl, type InstructionDsl } from '@gladiator/strategy-engine';

/**
 * Strategie-Workshop: LLM-Schicht für Pine-Analyse und den interaktiven Dialog.
 *
 * Wie sub-agent-llm.ts: alle Prompt-Bau- und Parse-Funktionen sind REIN und
 * unit-getestet; der eigentliche Call läuft über den vorhandenen Provider +
 * Kosten-Wächter (guardedComplete). Das LLM schaltet NIE scharf — es liefert
 * Analysen und DSL-VORSCHLÄGE, die erst nach Zod-Validierung UND Patricks
 * expliziter Übernahme in den Entwurf fließen. Kein Key → ehrlicher Fehler.
 */

// ── Pine-Analyse ────────────────────────────────────────────────────────────

export const pineAnalysisSchema = z.object({
  strategyType: z.enum(['momentum', 'mean_reversion', 'breakout', 'trend_following', 'scalping', 'other']),
  strategyTypeDetail: z.string().max(300).optional(),
  direction: z.enum(['long', 'short', 'both', 'unknown']),
  timeframeHint: z.string().max(40).nullish(),
  indicators: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        params: z.string().max(200).optional(),
        role: z.string().max(300).optional(),
      }),
    )
    .max(30),
  entryConditions: z.array(z.string().min(1).max(500)).max(20),
  exitConditions: z.array(z.string().min(1).max(500)).max(20),
  parameters: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        value: z.string().max(120).optional(),
        description: z.string().max(300).optional(),
      }),
    )
    .max(40),
  /** Was die DSL NICHT abbilden kann — ehrlich benannt, fließt in den Dialog. */
  notTranslatable: z.array(z.string().max(400)).default([]),
  summary: z.string().min(1).max(2000),
  /** Optionale erste DSL-Skizze — wird separat gegen parseInstructionDsl validiert. */
  dslDraft: z.unknown().optional(),
});

export type PineAnalysis = z.infer<typeof pineAnalysisSchema>;

const PINE_ANALYSIS_SYSTEM = [
  'Du bist ein erfahrener Trading-System-Entwickler und analysierst TradingView-Pine-Script.',
  'Erfinde NICHTS: beschreibe nur, was im Code wirklich steht. Unklares gehört nach notTranslatable oder unknown.',
  'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Text davor/danach) mit diesen Feldern:',
  '{',
  '  "strategyType": "momentum"|"mean_reversion"|"breakout"|"trend_following"|"scalping"|"other",',
  '  "strategyTypeDetail": "kurze Einordnung (optional)",',
  '  "direction": "long"|"short"|"both"|"unknown",',
  '  "timeframeHint": "vom Script erwarteter Timeframe, falls erkennbar (optional)",',
  '  "indicators": [{"name":"RSI","params":"period=14","role":"Einstiegs-Filter"}],',
  '  "entryConditions": ["…je Bedingung ein Satz…"],',
  '  "exitConditions": ["…"],',
  '  "parameters": [{"name":"rsiLength","value":"14","description":"RSI-Periode"}],',
  '  "notTranslatable": ["…was die Ziel-DSL nicht abbilden kann…"],',
  '  "summary": "2-5 Sätze: was die Strategie tut",',
  '  "dslDraft": { …optional: erste Übersetzung in die Gladiator-DSL… }',
  '}',
  '',
  'Die Gladiator-DSL für dslDraft (nur Felder aus diesem Schema verwenden):',
  DSL_SCHEMA_DOC,
  '',
  DSL_LIMITS_DOC,
  '',
  'Wenn das Script Dinge nutzt, die die DSL nicht kann (z. B. Trailing, Pyramiding, OR-Logik, beide Richtungen),',
  'liste sie in notTranslatable und lass sie im dslDraft weg — der Nutzer entscheidet im Dialog, wie damit umzugehen ist.',
  'Für direction "both": wähle im dslDraft die Hauptrichtung und nenne die zweite in notTranslatable.',
].join('\n');

/** Baut die Analyse-Messages (rein, testbar). Pine wird hart gekappt (Token-Schutz). */
export function buildPineAnalysisMessages(pineSource: string): { system: string; prompt: string } {
  const source = pineSource.length > 24_000 ? `${pineSource.slice(0, 24_000)}\n… (gekürzt)` : pineSource;
  return {
    system: PINE_ANALYSIS_SYSTEM,
    prompt: `Analysiere dieses Pine-Script:\n\n\`\`\`pine\n${source}\n\`\`\``,
  };
}

export type PineAnalysisResult =
  | { ok: true; analysis: PineAnalysis; dslDraft: InstructionDsl | null; dslErrors: string[] }
  | { ok: false; errors: string[]; raw: string };

/** Parst die LLM-Antwort der Pine-Analyse (rein, testbar). */
export function parsePineAnalysis(text: string): PineAnalysisResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, errors: ['LLM-Antwort enthielt kein JSON.'], raw: text.slice(0, 2000) };
  let candidate: unknown;
  try {
    candidate = JSON.parse(match[0]);
  } catch {
    return { ok: false, errors: ['LLM-JSON nicht parsebar.'], raw: text.slice(0, 2000) };
  }
  const parsed = pineAnalysisSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      raw: text.slice(0, 2000),
    };
  }
  // dslDraft ist ein VORSCHLAG — nur validiert übernehmen, Fehler transparent zurückgeben.
  let dslDraft: InstructionDsl | null = null;
  let dslErrors: string[] = [];
  if (parsed.data.dslDraft !== undefined) {
    const dsl = parseInstructionDsl(parsed.data.dslDraft);
    if (dsl.ok) dslDraft = dsl.dsl;
    else dslErrors = dsl.errors;
  }
  return { ok: true, analysis: parsed.data, dslDraft, dslErrors };
}

/** Führt die Pine-Analyse aus (Provider + Budget-Wächter injiziert — testbar mit Fake). */
export async function analyzePine(
  provider: LlmProvider,
  guard: CostGuard,
  pineSource: string,
): Promise<PineAnalysisResult & { costUsd?: number }> {
  const { system, prompt } = buildPineAnalysisMessages(pineSource);
  const res = await guardedComplete(provider, guard, { system, prompt, maxTokens: 4096 });
  return { ...parsePineAnalysis(res.text), costUsd: res.costUsd };
}

// ── Interaktiver Workshop-Dialog ────────────────────────────────────────────

export type WorkshopChatContext = {
  pineSource: string | null;
  analysis: unknown;
  draftDsl: unknown;
  instructions: string | null;
  history: { role: string; content: string }[];
  userMessage: string;
};

const CHAT_SYSTEM = [
  'Du bist der Strategie-Workshop-Coach von Gladiator AI: ein nüchterner, ehrlicher Trading-System-Entwickler.',
  'Ihr erarbeitet gemeinsam, wie eine Pine-Script-Strategie als regelbasierter Agent umgesetzt wird:',
  'Herangehensweise besprechen, Eventualitäten klären (Seitwärtsmarkt, hohe Volatilität, News-Events),',
  'und euch auf konkrete Regeln einigen. Stelle gezielte Rückfragen, eine pro Antwort.',
  '',
  'Die Ziel-DSL (Agent-Konfiguration):',
  DSL_SCHEMA_DOC,
  '',
  DSL_LIMITS_DOC,
  '',
  'Nützliche DSL-Mittel für Eventualitäten: ADX>x gegen Seitwärtsmärkte, ATR-Stop statt pct bei hoher Volatilität,',
  'when.session für Handelszeiten. News-Event-Gates kann die DSL NICHT — sag das ehrlich.',
  '',
  'REGELN:',
  '- Wenn ihr euch auf eine konkrete Konfiguration (oder Änderung) geeinigt habt, hänge GENAU EINEN',
  '  ```json-Codeblock mit der VOLLSTÄNDIGEN DSL an (kein Fragment). Sonst KEINEN Codeblock.',
  '- Der Nutzer übernimmt Vorschläge explizit per Klick — du schaltest nichts scharf.',
  '- Erfinde keine Zahlen, keine Backtest-Ergebnisse, keine Marktdaten. Du hast NICHTS ausgeführt.',
  '- Sei ehrlich, wenn etwas nicht abbildbar ist, und biete die nächstbeste regelbasierte Annäherung an.',
  '- Antworte in der Sprache des Nutzers. Halte Antworten kompakt (max. ~250 Wörter plus ggf. JSON).',
].join('\n');

const MAX_HISTORY_MESSAGES = 24;

/** Baut System+Prompt für einen Dialog-Turn (rein, testbar). */
export function buildChatMessages(ctx: WorkshopChatContext): { system: string; prompt: string } {
  const parts: string[] = ['=== Workshop-Kontext (echte Sitzungsdaten) ==='];
  if (ctx.pineSource) {
    const src = ctx.pineSource.length > 12_000 ? `${ctx.pineSource.slice(0, 12_000)}\n… (gekürzt)` : ctx.pineSource;
    parts.push(`--- Original-Pine-Script ---\n${src}`);
  }
  if (ctx.analysis) parts.push(`--- Pine-Analyse ---\n${JSON.stringify(ctx.analysis).slice(0, 6000)}`);
  if (ctx.draftDsl) parts.push(`--- Aktueller Konfigurations-Entwurf (DSL) ---\n${JSON.stringify(ctx.draftDsl)}`);
  if (ctx.instructions) parts.push(`--- Anweisungen des Nutzers an den Agenten ---\n${ctx.instructions.slice(0, 4000)}`);

  const history = ctx.history.slice(-MAX_HISTORY_MESSAGES);
  if (history.length > 0) {
    parts.push('--- Bisheriger Dialog ---');
    for (const m of history) parts.push(`${m.role === 'user' ? 'NUTZER' : 'COACH'}: ${m.content.slice(0, 2000)}`);
  }
  parts.push(`--- Neue Nachricht des Nutzers ---\n${ctx.userMessage}`);
  return { system: CHAT_SYSTEM, prompt: parts.join('\n\n') };
}

export type ChatReply = {
  content: string;
  proposedDsl: InstructionDsl | null;
  /** Validierungsfehler, falls das LLM einen ungültigen Vorschlag geliefert hat (transparent). */
  dslErrors: string[];
};

/** Parst die Coach-Antwort: Text + optional EIN validierter DSL-Vorschlag (rein, testbar). */
export function parseChatReply(text: string): ChatReply {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (!fence) return { content: text.trim(), proposedDsl: null, dslErrors: [] };
  let candidate: unknown;
  try {
    candidate = JSON.parse(fence[1]!);
  } catch {
    return { content: text.trim(), proposedDsl: null, dslErrors: ['Vorschlag-JSON nicht parsebar.'] };
  }
  const parsed = parseInstructionDsl(candidate);
  if (!parsed.ok) return { content: text.trim(), proposedDsl: null, dslErrors: parsed.errors };
  return { content: text.trim(), proposedDsl: parsed.dsl, dslErrors: [] };
}

/** Führt einen Dialog-Turn aus (Provider injiziert — testbar mit Fake). */
export async function runChatTurn(
  provider: LlmProvider,
  guard: CostGuard,
  ctx: WorkshopChatContext,
): Promise<ChatReply & { costUsd: number }> {
  const { system, prompt } = buildChatMessages(ctx);
  const res = await guardedComplete(provider, guard, { system, prompt, maxTokens: 2048 });
  return { ...parseChatReply(res.text), costUsd: res.costUsd };
}

/** Wie runChatTurn, aber die Antwort kommt als Text-Deltas (Workshop-Streaming). */
export async function runChatTurnStreaming(
  provider: LlmProvider,
  guard: CostGuard,
  ctx: WorkshopChatContext,
  onText: (delta: string) => void,
): Promise<ChatReply & { costUsd: number }> {
  const { system, prompt } = buildChatMessages(ctx);
  const res = await guardedStream(provider, guard, { system, prompt, maxTokens: 2048 }, onText);
  return { ...parseChatReply(res.text), costUsd: res.costUsd };
}
