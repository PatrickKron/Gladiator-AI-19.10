import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { envAnthropicProvider, type LlmProvider } from '@gladiator/agents';
import { verifyAccessToken } from '../auth/tokens.js';
import { sseEvent } from '../workshop/chat-stream.js';
import { ConversationNotFoundError, runAssistantTurn } from './service.js';

/**
 * Gladiator-Chat als Stream (SSE über POST + fetch):
 *   event: delta  {"text"}  · event: tool {"name","status","detail"} · event: card {"card"}
 *   event: done   {messageId, content, cards, costUsd, toolCalls} · event: error {"message"}
 * Auth wie tRPC (Bearer-Access-Token). Fehler VOR dem Stream kommen als JSON + Statuscode.
 */

const bodySchema = z.object({
  message: z.string().min(1).max(8000),
  context: z.object({ route: z.string().max(200).optional(), symbol: z.string().max(40).optional(), locale: z.string().max(8).optional() }).optional(),
});
const idSchema = z.string().uuid();

export function assistantStreamHandler(db: Db, getProvider: () => LlmProvider = envAnthropicProvider) {
  return async (req: Request, res: Response): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const auth = token ? verifyAccessToken(token) : null;
    if (!auth) {
      res.status(401).json({ error: 'Nicht angemeldet.' });
      return;
    }
    const id = idSchema.safeParse(req.params.id);
    const body = bodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: 'Ungültige Anfrage.' });
      return;
    }
    const provider = getProvider();
    if (!provider.configured) {
      res.status(412).json({ error: 'Kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt) — in Einstellungen → API-Keys hinterlegen.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const result = await runAssistantTurn(db, auth.userId, id.data, body.data.message, body.data.context ?? {}, provider, (e) => {
        if (e.type === 'delta') res.write(sseEvent('delta', { text: e.text }));
        else if (e.type === 'tool') res.write(sseEvent('tool', e));
        else res.write(sseEvent('card', { card: e.card }));
      }, req.ip ?? null);
      res.write(sseEvent('done', result));
    } catch (err) {
      const message = err instanceof ConversationNotFoundError ? err.message : err instanceof Error ? err.message : 'Chat fehlgeschlagen.';
      if (!(err instanceof ConversationNotFoundError)) console.error('[assistant-stream]', err);
      res.write(sseEvent('error', { message }));
    } finally {
      res.end();
    }
  };
}
