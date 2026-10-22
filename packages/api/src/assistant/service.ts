import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { CostGuard, guardedChat, type LlmChatMessage, type LlmContentBlock, type LlmProvider } from '@gladiator/agents';
import { DSL_LIMITS_DOC, DSL_SCHEMA_DOC } from '@gladiator/strategy-engine';
import { ASSISTANT_TOOLS, executeTool, type AssistantCard, type ToolCtx } from './tools.js';

const { assistantConversations, assistantMessages } = schema;

/** Ein Tagesbudget für den Gladiator-Chat (getrennt vom Workshop-Budget, damit eines das andere nicht leert). */
export const assistantLlmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Unterhaltung nicht gefunden.');
    this.name = 'ConversationNotFoundError';
  }
}

export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error'; detail?: string }
  | { type: 'card'; card: AssistantCard };

export type AssistantTurnResult = { messageId: string; content: string; cards: AssistantCard[]; costUsd: number; toolCalls: number };

/** Was die Oberfläche über den Nutzer-Kontext mitschickt (wo er gerade ist). */
export type AssistantClientContext = { route?: string; symbol?: string; locale?: string };

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 40;

export const ASSISTANT_SYSTEM = [
  'Du bist der Gladiator-Chat: der Assistent einer selbst gehosteten Trading-App (Krypto-Spot/Perps, Übungskonto, Strategien, Backtests, Screener, Agenten).',
  'Du handelst für GENAU EINEN Nutzer mit vollem Zugriff — es gibt keine Rollen.',
  '',
  'Was du kannst (nur über Werkzeuge, nie „im Kopf“):',
  '- Strategien als Instruction-DSL entwerfen (propose_strategy → Workshop-Entwurf), auf echten Kerzen backtesten (run_backtest),',
  '  als Version speichern (save_version), offiziell im Labor backtesten (lab_backtest) und zur Nutzung vorschlagen (promote_version → Bestätigung durch den Nutzer).',
  '- Den Markt screenen (run_screen), ein Asset mit Oracle/Shadow/Sentinel analysieren (asset_analysis), Seiten der App verlinken (navigate), den echten Zustand lesen (app_overview).',
  '- Agenten-Schwarm erklären und seinen echten Zustand zeigen (agents_status), jüngste Signale mit den Urteilen der Prüf-Agenten lesen (recent_signals), das Übungskonto lesen (demo_account).',
  '- Trading-Limits lesen (trading_settings) und Änderungen vorschlagen (update_trading_settings → Bestätigung), den Kill-Switch schalten lassen (kill_switch → Bestätigung).',
  '',
  'REGELN (hart):',
  '- Erfinde NIE Zahlen, Kennzahlen, Kurse oder Ergebnisse. Jede Zahl stammt aus einem Werkzeug-Ergebnis dieses Gesprächs. Ohne Ergebnis: sag, dass du es noch nicht gerechnet hast.',
  '- Du schaltest NICHTS scharf. Version → Paper, Limit-Änderungen und Kill-Switch laufen nur über Bestätigungs-Karten (promote_version, update_trading_settings, kill_switch), die der Nutzer klickt. Orders, Live-Handel, Auszahlungen, Transfers: nicht dein Werkzeug — sag das und verlinke das Ticket.',
  '- Limits lockern nur, wenn der Nutzer es ausdrücklich will; nenne vorher kurz das Risiko. Kill-Switch EIN schlägst du von dir aus vor, wenn der Nutzer von Panik, Verlustserie oder „alles stoppen“ spricht.',
  '- Wenn ein Werkzeug einen Fehler meldet, gib den Fehler wieder und schlage den nächsten sinnvollen Schritt vor.',
  '- Wenn der Nutzer eine Strategie beschreibt: fasse sie in 2–4 Sätzen zusammen, baue die DSL und lege sie per propose_strategy an. Frag nur nach, wenn etwas Wesentliches fehlt (Symbol, Zeitrahmen, Richtung) — eine Frage pro Antwort.',
  '- Backtest ohne Zeitraum-Angabe: die letzten 12 Monate bis heute (Datum aus app_overview).',
  '- Antworte in der Sprache des Nutzers, kompakt (meist unter 150 Wörtern), ohne Floskeln. Karten (Backtest, Vorschlag, Link) zeigt die Oberfläche automatisch — wiederhole deren Zahlen nur, wenn du sie einordnest.',
  '',
  'Die Strategie-DSL (Zielformat für propose_strategy.dsl):',
  DSL_SCHEMA_DOC,
  '',
  DSL_LIMITS_DOC,
].join('\n');

function contextPreamble(ctx: AssistantClientContext): string {
  const parts: string[] = [];
  if (ctx.route) parts.push(`Aktuelle Seite: ${ctx.route}`);
  if (ctx.symbol) parts.push(`Gewähltes Asset: ${ctx.symbol}`);
  if (ctx.locale) parts.push(`Sprache der Oberfläche: ${ctx.locale}`);
  parts.push(`Heute: ${new Date().toISOString().slice(0, 10)}`);
  return `[Kontext der Oberfläche — keine Nutzeranrede]\n${parts.join('\n')}`;
}

/** Verlauf aus der DB in Modell-Nachrichten (rein, testbar). */
export function historyToMessages(rows: { role: string; content: string; blocks: unknown[] }[]): LlmChatMessage[] {
  const out: LlmChatMessage[] = [];
  for (const r of rows) {
    const blocks = r.blocks as LlmContentBlock[];
    if (r.role === 'user') out.push({ role: 'user', content: r.content });
    else if (r.role === 'assistant') out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : r.content || '…' });
    else if (r.role === 'tool' && blocks.length > 0) out.push({ role: 'user', content: blocks });
  }
  // Das Modell verlangt abwechselnde Rollen mit user zuerst — tool-Turns sind user-Turns.
  return out.slice(-MAX_HISTORY);
}

/** Werkzeug-Ergebnis als Text fürs Modell (gekürzt, damit der Verlauf nicht explodiert). */
export function toolResultText(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > 6000 ? `${s.slice(0, 6000)} … (gekürzt)` : s;
}

/**
 * Ein Dialog-Turn: Nutzer-Nachricht speichern, Modell antworten lassen, Werkzeuge ausführen
 * (bis zu MAX_TOOL_ROUNDS Runden), alles persistieren. Streaming über onEvent.
 */
export async function runAssistantTurn(
  db: Db,
  userId: string,
  conversationId: string,
  message: string,
  clientCtx: AssistantClientContext,
  provider: LlmProvider,
  onEvent: (e: AssistantEvent) => void = () => {},
  ip: string | null = null,
): Promise<AssistantTurnResult> {
  const [conv] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.userId, userId)))
    .limit(1);
  if (!conv) throw new ConversationNotFoundError();

  const history = await db
    .select({ role: assistantMessages.role, content: assistantMessages.content, blocks: assistantMessages.blocks })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conv.id))
    .orderBy(asc(assistantMessages.createdAt));

  await db.insert(assistantMessages).values({ conversationId: conv.id, role: 'user', content: message, blocks: [] });
  const messages = historyToMessages(history);
  messages.push({ role: 'user', content: `${contextPreamble(clientCtx)}\n\n${message}` });

  const toolCtx: ToolCtx = { db, userId, ip };
  const cards: AssistantCard[] = [];
  const textParts: string[] = [];
  let costUsd = 0;
  let toolCalls = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await guardedChat(provider, assistantLlmGuard, { system: ASSISTANT_SYSTEM, messages, tools: ASSISTANT_TOOLS, maxTokens: 4096 }, (t) => onEvent({ type: 'delta', text: t }));
    costUsd += res.costUsd;
    if (res.text) textParts.push(res.text);
    // Assistant-Turn (Text + tool_use) persistieren und in den Verlauf hängen
    await db.insert(assistantMessages).values({ conversationId: conv.id, role: 'assistant', content: res.text, blocks: res.blocks, costUsd: String(res.costUsd) });
    messages.push({ role: 'assistant', content: res.blocks.length > 0 ? res.blocks : res.text || '…' });

    if (res.stopReason !== 'tool_use' || res.toolUses.length === 0) break;
    if (round === MAX_TOOL_ROUNDS) {
      textParts.push('(Werkzeug-Runden erschöpft — bitte den nächsten Schritt ausdrücklich anstoßen.)');
      break;
    }

    const results: LlmContentBlock[] = [];
    const roundCards: AssistantCard[] = [];
    for (const call of res.toolUses) {
      toolCalls++;
      onEvent({ type: 'tool', name: call.name, status: 'start' });
      try {
        const out = await executeTool(toolCtx, call.name, call.input);
        results.push({ type: 'tool_result', toolUseId: call.id, content: toolResultText(out.result) });
        for (const c of out.cards ?? []) {
          roundCards.push(c);
          onEvent({ type: 'card', card: c });
        }
        onEvent({ type: 'tool', name: call.name, status: 'done' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ type: 'tool_result', toolUseId: call.id, content: `FEHLER: ${msg}`, isError: true });
        onEvent({ type: 'tool', name: call.name, status: 'error', detail: msg });
      }
    }
    cards.push(...roundCards);
    await db.insert(assistantMessages).values({ conversationId: conv.id, role: 'tool', content: '', blocks: results, cards: roundCards });
    messages.push({ role: 'user', content: results });
  }

  const content = textParts.join('\n\n').trim();
  // Die sichtbare Abschluss-Nachricht: Text + alle Karten des Turns (eine Zeile für die Oberfläche)
  const [finalRow] = await db
    .insert(assistantMessages)
    .values({ conversationId: conv.id, role: 'assistant', content, blocks: [], cards, costUsd: String(0) })
    .returning();
  await db.update(assistantConversations).set({ updatedAt: new Date(), ...(history.length === 0 ? { title: message.slice(0, 80) } : {}) }).where(eq(assistantConversations.id, conv.id));
  return { messageId: finalRow!.id, content, cards, costUsd, toolCalls };
}
