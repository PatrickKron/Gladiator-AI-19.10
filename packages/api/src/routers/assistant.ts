import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { envAnthropicProvider } from '@gladiator/agents';
import { protectedProcedure, router } from '../trpc.js';
import { assistantLlmGuard, runAssistantTurn } from '../assistant/service.js';
import type { AssistantCard } from '../assistant/tools.js';
import { promoteVersion } from './strategies.js';

const { assistantConversations, assistantMessages } = schema;

const contextSchema = z.object({ route: z.string().max(200).optional(), symbol: z.string().max(40).optional(), locale: z.string().max(8).optional() }).optional();

/**
 * Gladiator-Chat (Patricks Mängelliste, Punkt 4): Unterhaltungen, Verlauf, ein Turn ohne
 * Streaming (Tests/Fallback; die Oberfläche nutzt /api/assistant/:id/stream) und die
 * Bestätigung von Karten, die etwas scharf schalten (Mensch im Loop).
 */
export const assistantRouter = router({
  status: protectedProcedure.query(() => ({
    configured: envAnthropicProvider().configured,
    budgetUsd: assistantLlmGuard.budgetUsd,
    spentUsd: Math.round(assistantLlmGuard.spentUsd() * 100) / 100,
  })),

  conversations: protectedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: assistantConversations.id, title: assistantConversations.title, updatedAt: assistantConversations.updatedAt })
      .from(assistantConversations)
      .where(eq(assistantConversations.userId, ctx.user.id))
      .orderBy(desc(assistantConversations.updatedAt))
      .limit(30),
  ),

  create: protectedProcedure.mutation(async ({ ctx }) => {
    const [row] = await ctx.db.insert(assistantConversations).values({ userId: ctx.user.id, title: 'Neue Unterhaltung' }).returning();
    return { id: row!.id, title: row!.title };
  }),

  remove: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(assistantConversations).where(and(eq(assistantConversations.id, input.id), eq(assistantConversations.userId, ctx.user.id)));
    return { ok: true };
  }),

  /** Sichtbarer Verlauf: Nutzer-Nachrichten und Abschluss-Antworten mit Karten (Werkzeug-Turns bleiben intern). */
  messages: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [conv] = await ctx.db
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(and(eq(assistantConversations.id, input.id), eq(assistantConversations.userId, ctx.user.id)))
      .limit(1);
    if (!conv) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unterhaltung nicht gefunden.' });
    const rows = await ctx.db
      .select({ id: assistantMessages.id, role: assistantMessages.role, content: assistantMessages.content, cards: assistantMessages.cards, blocks: assistantMessages.blocks, createdAt: assistantMessages.createdAt })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conv.id))
      .orderBy(asc(assistantMessages.createdAt));
    return rows
      .filter((r) => r.role === 'user' || (r.role === 'assistant' && r.blocks.length === 0))
      .map((r) => ({ id: r.id, role: r.role as 'user' | 'assistant', content: r.content, cards: r.cards as AssistantCard[], createdAt: r.createdAt.toISOString() }));
  }),

  /** Ein Turn ohne Streaming (Fallback). */
  send: protectedProcedure
    .input(z.object({ id: z.string().uuid(), message: z.string().min(1).max(8000), context: contextSchema }))
    .mutation(async ({ ctx, input }) => {
      const provider = envAnthropicProvider();
      if (!provider.configured) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt) — in Einstellungen → API-Keys hinterlegen.' });
      }
      try {
        return await runAssistantTurn(ctx.db, ctx.user.id, input.id, input.message, input.context ?? {}, provider, () => {}, ctx.ip);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Chat fehlgeschlagen.' });
      }
    }),

  /**
   * Bestätigungs-Karte ausführen oder ablehnen — der EINZIGE Weg, über den der Chat
   * etwas scharf schaltet, und er läuft über Patricks Klick + dasselbe Gate wie die Seite.
   */
  confirm: protectedProcedure
    .input(z.object({ messageId: z.string().uuid(), cardIndex: z.number().int().min(0), accept: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [msg] = await ctx.db
        .select({ id: assistantMessages.id, conversationId: assistantMessages.conversationId, cards: assistantMessages.cards })
        .from(assistantMessages)
        .where(eq(assistantMessages.id, input.messageId))
        .limit(1);
      if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Nachricht nicht gefunden.' });
      const [conv] = await ctx.db
        .select({ id: assistantConversations.id })
        .from(assistantConversations)
        .where(and(eq(assistantConversations.id, msg.conversationId), eq(assistantConversations.userId, ctx.user.id)))
        .limit(1);
      if (!conv) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unterhaltung nicht gefunden.' });
      const cards = [...(msg.cards as AssistantCard[])];
      const card = cards[input.cardIndex];
      if (!card || card.kind !== 'confirm') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Keine Bestätigungs-Karte an dieser Stelle.' });
      if (card.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: `Karte ist bereits ${card.status}.` });

      let note: string | undefined;
      let status: 'done' | 'declined' | 'failed' = 'declined';
      if (input.accept) {
        try {
          if (card.action === 'promote_version') {
            const v = await promoteVersion(ctx.db, ctx.user.id, card.args.versionId, ctx.ip);
            note = `Version ${v.version} läuft jetzt auf Paper.`;
          }
          status = 'done';
        } catch (err) {
          status = 'failed';
          note = err instanceof Error ? err.message : String(err);
        }
      }
      cards[input.cardIndex] = { ...card, status, ...(note ? { note } : {}) };
      await ctx.db.update(assistantMessages).set({ cards }).where(eq(assistantMessages.id, msg.id));
      // Das Modell erfährt beim nächsten Turn davon (als Nutzer-Notiz im Verlauf).
      await ctx.db.insert(assistantMessages).values({
        conversationId: conv.id,
        role: 'user',
        content: `[Karte „${card.label}“: ${status === 'done' ? 'bestätigt und ausgeführt' : status === 'failed' ? `fehlgeschlagen — ${note}` : 'abgelehnt'}]`,
        blocks: [],
      });
      return { status, note: note ?? null, cards };
    }),
});
