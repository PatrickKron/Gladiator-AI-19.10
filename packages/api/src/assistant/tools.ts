import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type { LlmTool } from '@gladiator/agents';
import { parseInstructionDsl, DSL_TIMEFRAMES } from '@gladiator/strategy-engine';
import { conditionsSchema, SCREEN_PRESETS } from '@gladiator/indicators';
import { runLabBacktest } from '@gladiator/backtest';
import { SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { scanUniverse } from '@gladiator/jobs';
import { runDraftBacktest, saveWorkshopVersion, ownedSession } from '../workshop/draft-service.js';
import { runScreen } from '../routers/screener.js';
import { loadVersionValidity } from '../routers/strategies.js';

const { strategies, strategyVersions, workshopSessions, auditLog } = schema;

/**
 * Werkzeuge des Gladiator-Chats (Patricks Mängelliste 2026-10-22, Punkt 4).
 * Jedes Werkzeug ruft DIESELBEN Funktionen wie die Seiten (eine Wahrheit) und liefert
 * nur, was wirklich gerechnet wurde. Was scharf schaltet (Version → Paper), gibt der
 * Chat als Bestätigungs-Karte zurück — ausgeführt wird es erst nach Patricks Klick.
 */

export type ToolCtx = { db: Db; userId: string; ip: string | null };

/** Karten für die Oberfläche — neben dem Text die sichtbare Spur eines Werkzeugs. */
export type AssistantCard =
  | { kind: 'link'; label: string; hash: string }
  | { kind: 'proposal'; sessionId: string; name: string; symbol: string; timeframe: string; direction: string; hash: string }
  | { kind: 'backtest'; label: string; symbol: string; timeframe: string; candles: number; trades: number; netReturnPct: number | null; profitFactor: number | null; maxDrawdownPct: number | null; winRate: number | null; hash: string }
  | { kind: 'version'; strategyId: string; versionId: string; version: number; status: string; hash: string }
  | { kind: 'screen'; timeframe: string; scanned: number; matched: string[]; hash: string }
  | { kind: 'confirm'; action: 'promote_version'; args: { versionId: string }; label: string; status: 'pending' | 'done' | 'declined' | 'failed'; note?: string };

export type ToolOutcome = { result: unknown; cards?: AssistantCard[] };

const TF = [...new Set([...DSL_TIMEFRAMES, ...SUPPORTED_TIMEFRAMES])];

export const ASSISTANT_TOOLS: LlmTool[] = [
  {
    name: 'app_overview',
    description:
      'Überblick aus der echten Datenbank: registrierte Strategien mit letzter Version und Status, Workshop-Entwürfe, Scan-Universum, Screen-Vorlagen. Immer zuerst aufrufen, wenn du Strategien, Versionen oder Sitzungen brauchst — rate keine IDs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'propose_strategy',
    description:
      'Legt eine Strategie als Workshop-Entwurf an (oder aktualisiert einen bestehenden Entwurf per sessionId). dsl = vollständige Instruction-DSL (Schema im Systemprompt). Validiert; bei Fehlern kommt die Fehlerliste zurück. Startet NICHTS.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Kurzer Name des Entwurfs (3–120 Zeichen)' },
        dsl: { type: 'object', description: 'Vollständige Instruction-DSL' },
        sessionId: { type: 'string', description: 'Bestehende Workshop-Sitzung aktualisieren (optional)' },
      },
      required: ['name', 'dsl'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_backtest',
    description:
      'Draft-Backtest eines Workshop-Entwurfs auf echten Kerzen, netto nach Gebühren/Slippage/Funding. from/to als ISO-Datum. Liefert die echten Kennzahlen — nenne nur diese Zahlen.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        from: { type: 'string', description: 'ISO-Datum, z. B. 2025-01-01' },
        to: { type: 'string', description: 'ISO-Datum, z. B. 2026-10-01' },
        symbol: { type: 'string', description: 'Optional: anderes Symbol (BTC/USDT)' },
        timeframe: { type: 'string', enum: TF, description: 'Optional: anderer Zeitrahmen' },
        riskPctPerTrade: { type: 'number', minimum: 0.1, maximum: 5 },
        label: { type: 'string' },
      },
      required: ['sessionId', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_version',
    description: 'Speichert den Entwurf einer Workshop-Sitzung als neue Version (Status draft) einer registrierten DSL-Strategie. Danach kann die Version im Labor offiziell backgetestet und (mit Bestätigung) auf Paper gesetzt werden.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'lab_backtest',
    description:
      'Offizieller Labor-Backtest einer registrierten DSL-Strategie (strategyId aus app_overview), netto, persistiert an der neuesten Version — Voraussetzung für das Promotion-Gate. from/to ISO-Datum.',
    inputSchema: {
      type: 'object',
      properties: { strategyId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, riskPctPerTrade: { type: 'number', minimum: 0.1, maximum: 5 } },
      required: ['strategyId', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'promote_version',
    description:
      'Bittet den Nutzer um Bestätigung, eine Version (Status draft) auf Paper zu setzen — die Strategie handelt dann selbstständig auf dem Übungskonto. Prüft vorher das Validitäts-Gate und sagt ehrlich, ob es bestanden ist. Führt NICHT selbst aus.',
    inputSchema: { type: 'object', properties: { versionId: { type: 'string' } }, required: ['versionId'], additionalProperties: false },
  },
  {
    name: 'run_screen',
    description:
      'Markt-Screener über alle Symbole mit echten Kerzen: Bedingungen wie im Screener (presetId aus app_overview ODER conditions-Liste im Screener-Format). Liefert die Treffer.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', enum: [...SUPPORTED_TIMEFRAMES] },
        presetId: { type: 'string' },
        conditions: { type: 'array', items: { type: 'object' } },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Optional: nur diese Symbole' },
      },
      required: ['timeframe'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Bietet dem Nutzer einen Link in die App an (Hash-Route, z. B. #/charts?symbol=BTC/USDT&tf=1h, #/strategien?tab=workshop, #/labor, #/screener, #/einstellungen?tab=keys).',
    inputSchema: { type: 'object', properties: { hash: { type: 'string' }, label: { type: 'string' } }, required: ['hash', 'label'], additionalProperties: false },
  },
];

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} fehlt oder ist kein Text.`);
  return v;
};
const isoDate = (v: unknown, name: string): Date => {
  const d = new Date(str(v, name));
  if (Number.isNaN(d.getTime())) throw new Error(`${name} ist kein Datum.`);
  return d;
};

function metricsCard(label: string, symbol: string, timeframe: string, candles: number, m: Record<string, unknown>, hash: string): AssistantCard {
  const num = (k: string): number | null => (typeof m[k] === 'number' && Number.isFinite(m[k] as number) ? Math.round((m[k] as number) * 100) / 100 : null);
  return { kind: 'backtest', label, symbol, timeframe, candles, trades: Number(m.tradeCount ?? 0), netReturnPct: num('netReturnPct'), profitFactor: num('profitFactor'), maxDrawdownPct: num('maxDrawdownPct'), winRate: num('winRate'), hash };
}

/** Führt ein Werkzeug aus. Fehler werden als Text ans Modell zurückgereicht (nie verschluckt). */
export async function executeTool(ctx: ToolCtx, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case 'app_overview': {
      const rows = await ctx.db
        .select({ id: strategies.id, slug: strategies.slug, name: strategies.name, kind: strategies.kind })
        .from(strategies)
        .orderBy(strategies.name);
      const versions = await ctx.db
        .select({ id: strategyVersions.id, strategyId: strategyVersions.strategyId, version: strategyVersions.version, status: strategyVersions.status, createdAt: strategyVersions.createdAt })
        .from(strategyVersions)
        .orderBy(desc(strategyVersions.version));
      const latest = new Map<string, (typeof versions)[number]>();
      for (const v of versions) if (!latest.has(v.strategyId)) latest.set(v.strategyId, v);
      const sessions = await ctx.db
        .select({ id: workshopSessions.id, name: workshopSessions.name, hasDraft: sql<boolean>`draft_dsl IS NOT NULL`, strategyId: workshopSessions.strategyId, updatedAt: workshopSessions.updatedAt })
        .from(workshopSessions)
        .where(eq(workshopSessions.userId, ctx.userId))
        .orderBy(desc(workshopSessions.updatedAt))
        .limit(20);
      const universe = await scanUniverse(ctx.db);
      return {
        result: {
          strategies: rows.map((r) => ({ ...r, latestVersion: latest.get(r.id) ? { id: latest.get(r.id)!.id, version: latest.get(r.id)!.version, status: latest.get(r.id)!.status } : null })),
          workshopSessions: sessions,
          scanUniverse: universe,
          screenPresets: SCREEN_PRESETS.map((p) => ({ id: p.id, timeframe: 'timeframe' in p ? (p as { timeframe?: string }).timeframe : undefined })),
          today: new Date().toISOString().slice(0, 10),
        },
      };
    }
    case 'propose_strategy': {
      const name = str(input.name, 'name').slice(0, 120);
      const parsed = parseInstructionDsl(input.dsl);
      if (!parsed.ok) return { result: { ok: false, errors: parsed.errors } };
      let sessionId: string;
      if (typeof input.sessionId === 'string' && input.sessionId) {
        const session = await ownedSession(ctx.db, ctx.userId, input.sessionId);
        await ctx.db.update(workshopSessions).set({ draftDsl: parsed.dsl, name, updatedAt: new Date() }).where(eq(workshopSessions.id, session.id));
        sessionId = session.id;
      } else {
        const [row] = await ctx.db.insert(workshopSessions).values({ userId: ctx.userId, name, draftDsl: parsed.dsl, instructions: 'Entwurf aus dem Gladiator-Chat.' }).returning();
        sessionId = row!.id;
        await ctx.db.insert(auditLog).values({ actor: 'user', userId: ctx.userId, action: 'workshop.session.created', entityType: 'workshop_session', entityId: sessionId, details: { name, via: 'assistant' }, ip: ctx.ip });
      }
      const hash = `#/strategien?tab=workshop&session=${sessionId}`;
      return {
        result: { ok: true, sessionId, dsl: parsed.dsl, hash },
        cards: [{ kind: 'proposal', sessionId, name, symbol: parsed.dsl.symbol, timeframe: parsed.dsl.timeframe, direction: parsed.dsl.direction, hash }],
      };
    }
    case 'run_backtest': {
      const sessionId = str(input.sessionId, 'sessionId');
      const out = await runDraftBacktest(ctx.db, ctx.userId, {
        id: sessionId,
        from: isoDate(input.from, 'from'),
        to: isoDate(input.to, 'to'),
        riskPctPerTrade: typeof input.riskPctPerTrade === 'number' ? input.riskPctPerTrade : 1,
        ...(typeof input.symbol === 'string' ? { symbol: input.symbol.toUpperCase() } : {}),
        ...(typeof input.timeframe === 'string' ? { timeframe: input.timeframe as never } : {}),
        ...(typeof input.label === 'string' ? { label: input.label } : {}),
      });
      const hash = `#/strategien?tab=workshop&session=${sessionId}`;
      return {
        result: { symbol: out.symbol, timeframe: out.timeframe, candles: out.candles, metrics: out.metrics, lastTrades: out.trades.slice(-5) },
        cards: [metricsCard(out.label ?? 'Draft-Backtest', out.symbol, out.timeframe, out.candles, out.metrics as Record<string, unknown>, hash)],
      };
    }
    case 'save_version': {
      const out = await saveWorkshopVersion(ctx.db, ctx.userId, str(input.sessionId, 'sessionId'), ctx.ip);
      const hash = '#/strategien';
      return { result: out, cards: [{ kind: 'version', ...out, hash }] };
    }
    case 'lab_backtest': {
      const strategyId = str(input.strategyId, 'strategyId');
      const [latest] = await ctx.db.select().from(strategyVersions).where(eq(strategyVersions.strategyId, strategyId)).orderBy(desc(strategyVersions.version)).limit(1);
      if (!latest) throw new Error('Strategie hat keine Version.');
      const dsl = parseInstructionDsl(latest.params);
      if (!dsl.ok) throw new Error(`DSL der Version ungültig: ${dsl.errors.join('; ')}`);
      const out = await runLabBacktest(ctx.db, {
        strategyId,
        symbol: dsl.dsl.symbol,
        timeframe: dsl.dsl.timeframe,
        setupType: dsl.dsl.setupType,
        from: isoDate(input.from, 'from'),
        to: isoDate(input.to, 'to'),
        riskPctPerTrade: typeof input.riskPctPerTrade === 'number' ? input.riskPctPerTrade : 1,
      });
      const validity = await loadVersionValidity(ctx.db, latest.id);
      return {
        result: { versionId: latest.id, candles: out.candles, metrics: out.result.metrics, validity: validity.verdict, dataQuality: out.dataQuality.warnings },
        cards: [metricsCard(`Labor-Backtest v${latest.version}`, dsl.dsl.symbol, dsl.dsl.timeframe, out.candles, out.result.metrics as unknown as Record<string, unknown>, '#/labor')],
      };
    }
    case 'promote_version': {
      const versionId = str(input.versionId, 'versionId');
      const [version] = await ctx.db.select().from(strategyVersions).where(eq(strategyVersions.id, versionId)).limit(1);
      if (!version) throw new Error('Version nicht gefunden.');
      const validity = await loadVersionValidity(ctx.db, versionId);
      const gate = !validity.hasBacktest ? 'kein Labor-Backtest' : validity.verdict!.passed ? 'bestanden' : `nicht bestanden: ${validity.verdict!.reasons.join(' · ')}`;
      return {
        result: { versionId, status: version.status, gate, needsConfirmation: true, note: 'Der Nutzer muss die Karte bestätigen; du kannst nichts scharf schalten.' },
        cards: [{ kind: 'confirm', action: 'promote_version', args: { versionId }, label: `Version ${version.version} auf Paper setzen (Gate: ${gate})`, status: 'pending' }],
      };
    }
    case 'run_screen': {
      const timeframe = str(input.timeframe, 'timeframe');
      let conditions: unknown = input.conditions;
      if (typeof input.presetId === 'string') {
        const preset = SCREEN_PRESETS.find((p) => p.id === input.presetId);
        if (!preset) throw new Error(`Vorlage ${input.presetId} unbekannt.`);
        conditions = preset.conditions;
      }
      const parsed = conditionsSchema.safeParse(conditions);
      if (!parsed.success) throw new Error(`Bedingungen ungültig: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      const out = await runScreen(ctx.db, { timeframe, conditions: parsed.data, ...(Array.isArray(input.symbols) ? { symbols: input.symbols.map(String) } : {}) });
      const matched = out.rows.filter((r) => r.matches).map((r) => r.symbol);
      return {
        result: { timeframe, scanned: out.scanned, matched, errors: out.rows.filter((r) => r.error).map((r) => `${r.symbol}: ${r.error}`).slice(0, 10) },
        cards: [{ kind: 'screen', timeframe, scanned: out.scanned, matched, hash: '#/screener' }],
      };
    }
    case 'navigate': {
      const hash = str(input.hash, 'hash');
      if (!hash.startsWith('#/')) throw new Error('hash muss mit #/ beginnen.');
      return { result: { ok: true }, cards: [{ kind: 'link', label: str(input.label, 'label').slice(0, 80), hash }] };
    }
    default:
      throw new Error(`Unbekanntes Werkzeug: ${name}`);
  }
}
