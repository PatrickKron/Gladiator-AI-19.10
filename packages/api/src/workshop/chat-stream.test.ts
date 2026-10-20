/**
 * Workshop-Streaming (SSE): Deltas kommen in Reihenfolge, „done" trägt die
 * gespeicherte Antwort, Nachrichten landen in der DB. Provider = Test-Double
 * (echte LLM-Calls gehören nicht in die CI); DB-Teil nur mit DATABASE_URL.
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { LlmProvider } from '@gladiator/agents';
import type pg from 'pg';
import { signAccessToken } from '../auth/tokens.js';
import { sseEvent, workshopChatStreamHandler } from './chat-stream.js';

// Testkontrolliertes Secret wie in auth.test.ts (KEIN Laufzeit-Fallback — der Boot bricht ohne weiterhin ab).
if (process.env.DATABASE_URL && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

describe('sseEvent', () => {
  it('formatiert Event + JSON-Daten mit Leerzeile als Abschluss', () => {
    expect(sseEvent('delta', { text: 'Hi\nda' })).toBe('event: delta\ndata: {"text":"Hi\\nda"}\n\n');
  });
});

function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)?.[1] ?? '';
      const data = JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null');
      return { event, data };
    });
}

const streaming: LlmProvider = {
  id: 'fake',
  configured: true,
  complete: async () => {
    throw new Error('nicht erwartet');
  },
  stream: async (_o, onText) => {
    const text = 'Klingt gut. Nimm ADX>20 gegen Seitwärtsmärkte.';
    for (const part of ['Klingt gut. ', 'Nimm ADX>20 ', 'gegen Seitwärtsmärkte.']) onText(part);
    return { text, usage: { inputTokens: 10, outputTokens: 10 }, costUsd: 0.001 };
  },
};

describe.skipIf(!process.env.DATABASE_URL)('POST /api/workshop/:id/chat-stream (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let sessionId: string;
  let token: string;

  const appWith = (provider: LlmProvider) => {
    const app = express();
    app.post('/api/workshop/:id/chat-stream', express.json(), workshopChatStreamHandler(db, () => provider));
    return app;
  };

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const email = `stream-${crypto.randomUUID()}@test.local`;
    const [u] = await db.insert(schema.users).values({ email }).returning();
    userId = u!.id;
    const [s] = await db.insert(schema.workshopSessions).values({ userId, name: 'Stream' }).returning();
    sessionId = s!.id;
    token = signAccessToken({ userId, email });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('streamt Deltas, dann done mit der gespeicherten Antwort', async () => {
    const res = await request(appWith(streaming))
      .post(`/api/workshop/${sessionId}/chat-stream`)
      .set('authorization', `Bearer ${token}`)
      .send({ message: 'Was gegen Seitwärtsphasen?' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.text);
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text)).toEqual([
      'Klingt gut. ',
      'Nimm ADX>20 ',
      'gegen Seitwärtsmärkte.',
    ]);
    const done = events.find((e) => e.event === 'done')?.data as { content: string; messageId: string };
    expect(done.content).toBe('Klingt gut. Nimm ADX>20 gegen Seitwärtsmärkte.');
    const rows = await db.execute(sql`SELECT role, content FROM workshop_messages WHERE session_id = ${sessionId} ORDER BY created_at`);
    expect(rows.rows.map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  it('ohne Token 401, ohne Provider 412, fremde Sitzung → error-Event', async () => {
    expect((await request(appWith(streaming)).post(`/api/workshop/${sessionId}/chat-stream`).send({ message: 'x' })).status).toBe(401);
    const unconfigured: LlmProvider = { ...streaming, configured: false };
    expect(
      (await request(appWith(unconfigured)).post(`/api/workshop/${sessionId}/chat-stream`).set('authorization', `Bearer ${token}`).send({ message: 'x' }))
        .status,
    ).toBe(412);
    const res = await request(appWith(streaming))
      .post(`/api/workshop/${crypto.randomUUID()}/chat-stream`)
      .set('authorization', `Bearer ${token}`)
      .send({ message: 'x' });
    expect(parseSse(res.text)).toEqual([{ event: 'error', data: { message: 'Workshop-Sitzung nicht gefunden.' } }]);
  });
});
