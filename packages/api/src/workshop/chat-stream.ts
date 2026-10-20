import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { envAnthropicProvider, type LlmProvider } from '@gladiator/agents';
import { verifyAccessToken } from '../auth/tokens.js';
import { performWorkshopChat, WorkshopNotFoundError } from './chat-service.js';

/**
 * Workshop-Dialog als Stream (Server-Sent Events über POST + fetch):
 *   event: delta  data: {"text":"…"}        — Text-Stücke, sobald das LLM sie liefert
 *   event: done   data: {…WorkshopChatResult} — gespeicherte Antwort inkl. DSL-Vorschlag
 *   event: error  data: {"message":"…"}
 * Auth wie tRPC (Bearer-Access-Token). Fehler VOR dem Stream kommen als JSON + Statuscode.
 */

const bodySchema = z.object({ message: z.string().min(1).max(8000) });
const idSchema = z.string().uuid();

/** Eine SSE-Nachricht (rein, testbar). */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function workshopChatStreamHandler(db: Db, getProvider: () => LlmProvider = envAnthropicProvider) {
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
      res.status(412).json({ error: 'Kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt) — in Profil → API-Keys hinterlegen.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const result = await performWorkshopChat(db, auth.userId, id.data, body.data.message, provider, (text) => {
        res.write(sseEvent('delta', { text }));
      });
      res.write(sseEvent('done', result));
    } catch (err) {
      const message =
        err instanceof WorkshopNotFoundError ? err.message : err instanceof Error ? err.message : 'LLM-Dialog fehlgeschlagen.';
      if (!(err instanceof WorkshopNotFoundError)) console.error('[workshop-stream]', err);
      res.write(sseEvent('error', { message }));
    } finally {
      res.end();
    }
  };
}
