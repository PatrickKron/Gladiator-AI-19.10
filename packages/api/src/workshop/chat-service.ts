import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { CostGuard, type LlmProvider } from '@gladiator/agents';
import type { InstructionDsl } from '@gladiator/strategy-engine';
import { detectExchangeMentions, listConnections, listSupportedExchanges } from '@gladiator/exchange';
import { runChatTurn, runChatTurnStreaming } from './llm.js';

const { workshopSessions, workshopMessages } = schema;

/** Ein Tagesbudget für alle Workshop-LLM-Aufrufe (Analyse, Dialog, Streaming). */
export const workshopLlmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

export class WorkshopNotFoundError extends Error {
  constructor() {
    super('Workshop-Sitzung nicht gefunden.');
    this.name = 'WorkshopNotFoundError';
  }
}

export type WorkshopChatResult = {
  messageId: string;
  content: string;
  proposedDsl: InstructionDsl | null;
  dslErrors: string[];
  costUsd: number;
  /** Im Text erwähnte, noch nicht verbundene Börsen (nur Hinweis, nie Auto-Aktion). */
  exchangeHints: { id: string; name: string }[];
};

/**
 * Ein Dialog-Turn (gemeinsam für tRPC `workshop.chat` und den Streaming-Endpunkt):
 * Nutzer-Nachricht speichern, Coach antworten lassen (optional als Deltas),
 * Antwort mit validiertem DSL-Vorschlag speichern. Übernahme bleibt explizit.
 */
export async function performWorkshopChat(
  db: Db,
  userId: string,
  sessionId: string,
  message: string,
  provider: LlmProvider,
  onText?: (delta: string) => void,
): Promise<WorkshopChatResult> {
  const [session] = await db
    .select()
    .from(workshopSessions)
    .where(and(eq(workshopSessions.id, sessionId), eq(workshopSessions.userId, userId)))
    .limit(1);
  if (!session) throw new WorkshopNotFoundError();

  const history = await db
    .select({ role: workshopMessages.role, content: workshopMessages.content })
    .from(workshopMessages)
    .where(eq(workshopMessages.sessionId, session.id))
    .orderBy(asc(workshopMessages.createdAt));

  await db.insert(workshopMessages).values({ sessionId: session.id, role: 'user', content: message });

  const ctx = {
    pineSource: session.pineSource,
    analysis: session.analysis,
    draftDsl: session.draftDsl,
    instructions: session.instructions,
    history,
    userMessage: message,
  };
  const reply = onText
    ? await runChatTurnStreaming(provider, workshopLlmGuard, ctx, onText)
    : await runChatTurn(provider, workshopLlmGuard, ctx);

  const [assistantMsg] = await db
    .insert(workshopMessages)
    .values({
      sessionId: session.id,
      role: 'assistant',
      content: reply.content,
      proposedDsl: reply.proposedDsl,
      costUsd: String(reply.costUsd),
    })
    .returning();
  await db.update(workshopSessions).set({ updatedAt: new Date() }).where(eq(workshopSessions.id, session.id));

  const mentioned = detectExchangeMentions(message, listSupportedExchanges());
  const connectedIds = new Set((await listConnections(db, userId)).map((c) => c.exchangeId));

  return {
    messageId: assistantMsg!.id,
    content: reply.content,
    proposedDsl: reply.proposedDsl,
    dslErrors: reply.dslErrors,
    costUsd: reply.costUsd,
    exchangeHints: mentioned.filter((m) => !connectedIds.has(m.id)),
  };
}
