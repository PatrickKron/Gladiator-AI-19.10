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
import { ASSISTANT_TOOLS, parseLimitChanges } from './tools.js';
import { setDemoBookSourceForTests } from '../routers/demo.js';
import type { DemoBookSource, MarketRules, OrderBookSnapshot } from '@gladiator/exchange';

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
    expect(names).toEqual(
      expect.arrayContaining(['propose_strategy', 'run_backtest', 'save_version', 'promote_version', 'run_screen', 'navigate', 'app_overview', 'agents_status', 'trading_settings', 'update_trading_settings', 'kill_switch', 'demo_account', 'recent_signals', 'demo_order']),
    );
  });
  it('Limit-Änderungen: nur bekannte Schlüssel, Zahlen innerhalb der Grenzen aus @gladiator/core', () => {
    expect(parseLimitChanges({ riskPctPerTrade: 2, maxLeverage: 10 })).toEqual({ riskPctPerTrade: 2, maxLeverage: 10 });
    expect(() => parseLimitChanges({ riskPctPerTrade: 50 })).toThrow(/außerhalb der Grenzen/);
    expect(() => parseLimitChanges({ foo: 1 })).toThrow(/Unbekannte Einstellung/);
    expect(() => parseLimitChanges({ maxOpenPositions: 2.5 })).toThrow(/ganzzahlig/);
    expect(() => parseLimitChanges({})).toThrow(/Keine Änderung/);
    expect(() => parseLimitChanges({ maxLeverage: 'viel' })).toThrow(/Zahl/);
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

  /** Fake-Provider, der GENAU die angegebenen Werkzeuge ruft und dann mit Text endet. */
  function scripted(calls: { id: string; name: string; input: Record<string, unknown> }[]): LlmProvider {
    let n = 0;
    const usage = { inputTokens: 1, outputTokens: 1 };
    return {
      id: 'fake3',
      configured: true,
      complete: async () => {
        throw new Error('x');
      },
      chat: async () => {
        n++;
        if (n === 1) return { text: '', blocks: calls.map((c) => ({ type: 'tool_use' as const, ...c })), toolUses: calls, stopReason: 'tool_use', usage, costUsd: 0 };
        return { text: 'Ok.', blocks: [{ type: 'text', text: 'Ok.' }], toolUses: [], stopReason: 'end_turn', usage, costUsd: 0 };
      },
    };
  }

  it('Lese-Werkzeuge liefern echten App-Zustand: Agenten, Limits mit Grenzen, Übungskonto, Signale', async () => {
    const conv = await caller.assistant.create();
    const events: string[] = [];
    const out = await runAssistantTurn(
      db,
      userId,
      conv.id,
      'Zeig mir alles',
      {},
      scripted([
        { id: 'a', name: 'agents_status', input: {} },
        { id: 'b', name: 'trading_settings', input: {} },
        { id: 'c', name: 'demo_account', input: {} },
        { id: 'd', name: 'recent_signals', input: { limit: 3 } },
      ]),
      (e) => events.push(e.type === 'tool' ? `${e.name}:${e.status}` : e.type),
    );
    expect(events).toEqual(expect.arrayContaining(['agents_status:done', 'trading_settings:done', 'demo_account:done', 'recent_signals:done']));
    expect(events.some((e) => e.endsWith(':error'))).toBe(false);
    expect(out.cards.map((c) => c.kind)).toEqual(['link', 'link', 'link', 'link']);
    // Die Limits im Werkzeug-Ergebnis sind die Werte der Seite
    const page = await caller.settings.get();
    const row = (await db.select().from(schema.assistantMessages).where(eq(schema.assistantMessages.conversationId, conv.id))).find((m) => m.role === 'tool')!;
    const results = row.blocks as { toolUseId: string; content: string }[];
    const settings = JSON.parse(results.find((r) => r.toolUseId === 'b')!.content) as { riskPctPerTrade: number; bounds: Record<string, unknown> };
    expect(settings.riskPctPerTrade).toBe(page.riskPctPerTrade);
    expect(settings.bounds.maxLeverage).toEqual({ min: 1, max: 125 });
    const agents = JSON.parse(results.find((r) => r.toolUseId === 'a')!.content) as { active: { agent: string }[] };
    expect(agents.active.map((a) => a.agent)).toEqual(expect.arrayContaining(['technik', 'risk']));
    const demo = JSON.parse(results.find((r) => r.toolUseId === 'c')!.content) as { account: { balance?: unknown }; positions: unknown[] };
    expect(Array.isArray(demo.positions)).toBe(true);
  });

  it('Limit-Änderung und Kill-Switch laufen NUR über Bestätigungs-Karten; außerhalb der Grenzen ist ein Werkzeug-Fehler', async () => {
    const conv = await caller.assistant.create();
    const before = await caller.settings.get();
    const out = await runAssistantTurn(
      db,
      userId,
      conv.id,
      'Risiko auf 2 % und alles stoppen',
      {},
      scripted([
        { id: 'u', name: 'update_trading_settings', input: { riskPctPerTrade: 2 } },
        { id: 'k', name: 'kill_switch', input: { active: true } },
        { id: 'x', name: 'update_trading_settings', input: { riskPctPerTrade: 99 } },
      ]),
    );
    expect(out.cards.map((c) => (c.kind === 'confirm' ? c.action : c.kind))).toEqual(['update_settings', 'kill_switch']);
    expect((out.cards[0] as { label: string }).label).toMatch(/Risiko je Trade % .* → 2/);
    // Noch nichts passiert
    const mid = await caller.settings.get();
    expect(mid.riskPctPerTrade).toBe(before.riskPctPerTrade);
    expect(mid.killSwitchActive).toBe(false);
    // Ablehnen → bleibt; Bestätigen → gespeichert über dieselbe Funktion wie die Seite
    const declined = await caller.assistant.confirm({ messageId: out.messageId, cardIndex: 1, accept: false });
    expect(declined.status).toBe('declined');
    const accepted = await caller.assistant.confirm({ messageId: out.messageId, cardIndex: 0, accept: true });
    expect(accepted.status).toBe('done');
    expect(accepted.note).toMatch(/riskPctPerTrade = 2/);
    const after = await caller.settings.get();
    expect(after.riskPctPerTrade).toBe(2);
    expect(after.maxLeverage).toBe(before.maxLeverage);
    expect(after.killSwitchActive).toBe(false);
    // Kill-Switch: eigene Karte, bestätigt → aktiv, Audit vorhanden
    const out2 = await runAssistantTurn(db, userId, conv.id, 'Stopp', {}, scripted([{ id: 'k2', name: 'kill_switch', input: { active: true } }]));
    const done = await caller.assistant.confirm({ messageId: out2.messageId, cardIndex: 0, accept: true });
    expect(done.status).toBe('done');
    expect((await caller.settings.get()).killSwitchActive).toBe(true);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    expect(audits.some((a) => a.action === 'risk.kill_switch.on')).toBe(true);
    expect(audits.some((a) => a.action === 'settings.update')).toBe(true);
    // Bereits aktiv → Werkzeug meldet unverändert, keine Karte
    const out3 = await runAssistantTurn(db, userId, conv.id, 'Stopp nochmal', {}, scripted([{ id: 'k3', name: 'kill_switch', input: { active: true } }]));
    expect(out3.cards).toEqual([]);
    await caller.settings.setKillSwitch({ active: false });
  });

  it('Demo-Order: Vorschau aus dem echten Buch, Karte erst nach Bestätigung ausgeführt, Ablehnung der Engine ist ein Werkzeug-Fehler', async () => {
    class FakeBookSource implements DemoBookSource {
      async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
        return { symbol, ts: 0, bids: [{ price: 50_000, qty: 10 }], asks: [{ price: 50_100, qty: 10 }] };
      }
      async marketRules(): Promise<MarketRules> {
        return { tickSize: 0.01, lotSize: 0.000001, minNotional: 5 };
      }
    }
    setDemoBookSourceForTests(new FakeBookSource());
    try {
      const conv = await caller.assistant.create();
      const events: string[] = [];
      const out = await runAssistantTurn(
        db,
        userId,
        conv.id,
        'Kauf BTC für 500',
        {},
        scripted([
          { id: 'o1', name: 'demo_order', input: { symbol: 'BTC/USDT', direction: 'long', notionalUsd: 500, stopLoss: 48_000 } },
          { id: 'o2', name: 'demo_order', input: { symbol: 'BTC/USDT', direction: 'long', qty: 0.00000001 } },
          { id: 'o3', name: 'demo_order', input: { symbol: 'BTC/USDT', direction: 'long', notionalUsd: 500, leverage: 10_000 } },
        ]),
        (e) => events.push(e.type === 'tool' ? `${e.name}:${e.status}` : e.type),
      );
      expect(events.filter((e) => e === 'demo_order:error').length).toBe(2);
      expect(out.cards).toHaveLength(1);
      const card = out.cards[0] as { kind: string; action: string; label: string; args: { qty: number; stopLoss?: number } };
      expect(card).toMatchObject({ kind: 'confirm', action: 'demo_order' });
      expect(card.label).toMatch(/LONG .* BTC\/USDT Markt ≈ 50100/);
      expect(card.args.qty).toBeCloseTo(500 / 50_050, 4);
      expect(card.args.stopLoss).toBe(48_000);
      expect((await caller.demo.positions()).length).toBe(0);
      const done = await caller.assistant.confirm({ messageId: out.messageId, cardIndex: 0, accept: true });
      expect(done.status).toBe('done');
      expect(done.note).toMatch(/Übungskonto/);
      const pos = await caller.demo.positions();
      expect(pos).toHaveLength(1);
      expect(pos[0]).toMatchObject({ symbol: 'BTC/USDT', direction: 'long', stopLoss: 48_000 });
      await caller.demo.reset();
    } finally {
      setDemoBookSourceForTests(null);
    }
  });
});
