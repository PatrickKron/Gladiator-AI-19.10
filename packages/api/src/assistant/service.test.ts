/**
 * Gladiator-Chat: reine Teile (Verlauf → Modell-Nachrichten, Werkzeug-Ergebnis-Text,
 * Werkzeug-Schemata) ohne DB; der Dialog-Turn mit Werkzeugen gegen die ECHTE DB mit einem
 * Fake-Provider (lokal mit DATABASE_URL, sonst übersprungen — Server-CI maßgeblich).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gladiator/db';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '@gladiator/agents';
import type pg from 'pg';
import { appRouter } from '../routers/index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';
import { ASSISTANT_SYSTEM, historyToMessages, runAssistantTurn, toolResultText } from './service.js';
import { ASSISTANT_TOOLS } from './tools.js';

describe('historyToMessages', () => {
  it('user → user, assistant mit Blöcken → Blöcke, tool → user-Turn mit tool_result, leere Werkzeug-Turns fallen weg', () => {
    const rows = [
      { role: 'user', content: 'Hallo', blocks: [] },
      { role: 'assistant', content: 'Hi', blocks: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'app_overview', input: {} }] },
      { role: 'tool', content: '', blocks: [{ type: 'tool_result', toolUseId: 't1', content: '{}' }] },
      { role: 'tool', content: '', blocks: [] },
      { role: 'assistant', content: 'Fertig', blocks: [] },
    ];
    const m = historyToMessages(rows);
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(Array.isArray(m[1]!.content)).toBe(true);
    expect(m[3]!.content).toBe('Fertig');
  });
});

describe('toolResultText / Werkzeuge', () => {
  it('kürzt lange Ergebnisse ehrlich mit Hinweis', () => {
    const txt = toolResultText({ big: 'x'.repeat(10_000) });
    expect(txt.length).toBeLessThan(6100);
    expect(txt.endsWith('(gekürzt)')).toBe(true);
  });
  it('jedes Werkzeug hat Name, Beschreibung und ein Objekt-Schema; Namen sind eindeutig', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ASSISTANT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(names).toEqual(expect.arrayContaining(['propose_strategy', 'run_backtest', 'save_version', 'promote_version', 'run_screen', 'navigate', 'app_overview']));
  });
  it('Systemprompt verbietet erfundene Zahlen und Scharfschalten, enthält die DSL', () => {
    expect(ASSISTANT_SYSTEM).toMatch(/Erfinde NIE Zahlen/);
    expect(ASSISTANT_SYSTEM).toMatch(/schaltest NICHTS scharf/);
    expect(ASSISTANT_SYSTEM).toMatch(/"id"/);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[assistant.test] DATABASE_URL nicht gesetzt — DB-Teil übersprungen (Server-CI maßgeblich).');
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

/** Fake-Provider: erster Aufruf ruft zwei Werkzeuge, zweiter antwortet mit Text — keine echte LLM-Kosten. */
class ScriptedProvider implements LlmProvider {
  readonly id = 'fake';
  readonly configured = true;
  calls: LlmChatRequest[] = [];
  async complete(): Promise<never> {
    throw new Error('nicht genutzt');
  }
  async chat(opts: LlmChatRequest, onText?: (d: string) => void): Promise<LlmChatResult> {
    this.calls.push({ ...opts, messages: [...opts.messages] }); // Kopie: der Dienst befüllt das Array weiter
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (this.calls.length === 1) {
      return {
        text: '',
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'app_overview', input: {} },
          { type: 'tool_use', id: 'c2', name: 'navigate', input: { hash: '#/labor', label: 'Zum Labor' } },
          { type: 'tool_use', id: 'c3', name: 'navigate', input: { hash: 'javascript:alert(1)', label: 'böse' } },
        ],
        toolUses: [
          { id: 'c1', name: 'app_overview', input: {} },
          { id: 'c2', name: 'navigate', input: { hash: '#/labor', label: 'Zum Labor' } },
          { id: 'c3', name: 'navigate', input: { hash: 'javascript:alert(1)', label: 'böse' } },
        ],
        stopReason: 'tool_use',
        usage,
        costUsd: 0.001,
      };
    }
    onText?.('Du hast ');
    onText?.('Strategien.');
    return { text: 'Du hast Strategien.', blocks: [{ type: 'text', text: 'Du hast Strategien.' }], toolUses: [], stopReason: 'end_turn', usage, costUsd: 0.001 };
  }
}

const createCaller = createCallerFactory(appRouter);
const { strategies, strategyVersions, assistantConversations } = schema;

describe.skipIf(!hasDb)('Gladiator-Chat gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let caller: ReturnType<typeof createCaller>;
  const RUN = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: `chat-${RUN}@test.invalid`, password: 'sehr-sicheres-passwort-123', name: 'Chat' });
    userId = res.user.id;
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
  });
  afterAll(async () => {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('Turn mit Werkzeugen: Ergebnisse gehen ans Modell zurück, Karten und Text landen in der Abschluss-Nachricht, Fehler werden ehrlich gemeldet', async () => {
    const conv = await caller.assistant.create();
    const provider = new ScriptedProvider();
    const events: string[] = [];
    const out = await runAssistantTurn(db, userId, conv.id, 'Was habe ich?', { route: '#/' }, provider, (e) => events.push(e.type === 'tool' ? `${e.name}:${e.status}` : e.type));
    expect(out.content).toBe('Du hast Strategien.');
    expect(out.toolCalls).toBe(3);
    expect(out.cards).toEqual([{ kind: 'link', label: 'Zum Labor', hash: '#/labor' }]);
    expect(events).toContain('app_overview:done');
    expect(events).toContain('navigate:error');
    expect(events.filter((e) => e === 'delta').length).toBe(2);
    // Zweiter Modell-Aufruf sah die Werkzeug-Ergebnisse (als user-Turn mit tool_result-Blöcken)
    const second = provider.calls[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result' && b.isError)).toBe(true);
    // Sichtbarer Verlauf: Nutzer + Abschluss (interne Werkzeug-Turns bleiben draußen)
    const visible = await caller.assistant.messages({ id: conv.id });
    expect(visible.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(visible[1]!.cards.length).toBe(1);
    const [c] = await db.select().from(assistantConversations).where(eq(assistantConversations.id, conv.id));
    expect(c!.title).toBe('Was habe ich?');
  });

  it('Bestätigungs-Karte: Freigabe läuft über dasselbe Gate — ohne Backtest fehlgeschlagen, abgelehnt bleibt abgelehnt', async () => {
    const conv = await caller.assistant.create();
    const [s] = await db.insert(strategies).values({ slug: `chat-dsl-${RUN}`, name: 'Chat-Test', kind: 'dsl', description: 't', createdBy: userId }).returning();
    const [v] = await db.insert(strategyVersions).values({ strategyId: s!.id, version: 1, params: {}, status: 'draft' }).returning();
    const promote = {
      calls: 0,
      async chat(): Promise<LlmChatResult> {
        promote.calls++;
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (promote.calls === 1) {
          return { text: '', blocks: [{ type: 'tool_use', id: 'p1', name: 'promote_version', input: { versionId: v!.id } }], toolUses: [{ id: 'p1', name: 'promote_version', input: { versionId: v!.id } }], stopReason: 'tool_use', usage, costUsd: 0 };
        }
        return { text: 'Bitte bestätigen.', blocks: [{ type: 'text', text: 'Bitte bestätigen.' }], toolUses: [], stopReason: 'end_turn', usage, costUsd: 0 };
      },
    };
    const provider: LlmProvider = { id: 'fake2', configured: true, complete: async () => { throw new Error('x'); }, chat: () => promote.chat() };
    const out = await runAssistantTurn(db, userId, conv.id, 'Schalte v1 scharf', {}, provider);
    expect(out.cards[0]).toMatchObject({ kind: 'confirm', action: 'promote_version', status: 'pending' });
    expect((out.cards[0] as { label: string }).label).toMatch(/kein Labor-Backtest/);

    const accepted = await caller.assistant.confirm({ messageId: out.messageId, cardIndex: 0, accept: true });
    expect(accepted.status).toBe('failed');
    expect(accepted.note).toMatch(/Kein Backtest/);
    const [after] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, v!.id));
    expect(after!.status).toBe('draft');
    await expect(caller.assistant.confirm({ messageId: out.messageId, cardIndex: 0, accept: false })).rejects.toThrow(/bereits failed/);

    await db.delete(strategies).where(eq(strategies.id, s!.id));
  });
});
