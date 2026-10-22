import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { buildAssetAnalysis } from '../market/asset-analysis.js';
import { loadAgentsStatus } from '../routers/agents.js';
import { ensureTradingSettings } from '../routers/settings.js';
import { currentDemoBookSource, listDemoPositions } from '../routers/demo.js';
import { demoAccountOverview } from '@gladiator/exchange';
import { SETTINGS_BOUNDS, type TradingLimits } from '@gladiator/core/trading-settings';

const { strategies, strategyVersions, workshopSessions, auditLog, signals, signalReviews } = schema;

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
  | ({ kind: 'confirm'; label: string; status: 'pending' | 'done' | 'declined' | 'failed'; note?: string } & ConfirmRequest);

/**
 * Was eine Bestätigungs-Karte nach Patricks Klick ausführt (assistant.confirm) — jede Aktion
 * läuft über dieselbe Service-Funktion wie die Seite (Gate, Audit, Benachrichtigung inklusive).
 */
export type ConfirmRequest =
  | { action: 'promote_version'; args: { versionId: string } }
  | { action: 'update_settings'; args: Partial<TradingLimits> }
  | { action: 'kill_switch'; args: { active: boolean } };

const LIMIT_LABELS: Record<keyof TradingLimits, string> = {
  riskPctPerTrade: 'Risiko je Trade %',
  maxLeverage: 'max. Hebel',
  maxOpenPositions: 'max. offene Positionen',
  maxExposurePctPerAsset: 'max. Exposure je Asset %',
  dailyLossLimitPct: 'Tagesverlust-Limit %',
  weeklyLossLimitPct: 'Wochenverlust-Limit %',
  maxDrawdownPct: 'max. Drawdown %',
};
const LIMIT_KEYS = Object.keys(SETTINGS_BOUNDS) as (keyof TradingLimits)[];

/** Gewünschte Limit-Änderungen prüfen (nur bekannte Schlüssel, Zahl, innerhalb der Grenzen von @gladiator/core). */
export function parseLimitChanges(input: Record<string, unknown>): Partial<TradingLimits> {
  const out: Partial<TradingLimits> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!LIMIT_KEYS.includes(k as keyof TradingLimits)) throw new Error(`Unbekannte Einstellung: ${k}. Erlaubt: ${LIMIT_KEYS.join(', ')}.`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} muss eine Zahl sein.`);
    const b = SETTINGS_BOUNDS[k as keyof TradingLimits];
    if (v < b.min || v > b.max) throw new Error(`${k} = ${v} liegt außerhalb der Grenzen ${b.min}–${b.max}.`);
    if (k === 'maxOpenPositions' && !Number.isInteger(v)) throw new Error('maxOpenPositions muss ganzzahlig sein.');
    out[k as keyof TradingLimits] = v;
  }
  if (Object.keys(out).length === 0) throw new Error('Keine Änderung angegeben.');
  return out;
}

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
    name: 'asset_analysis',
    description:
      'Oracle (Makro & Regime: GRS, VIX/DXY/US10Y), Shadow (Positionierung: Funding, Open Interest, COT) und Sentinel (No-Trade-Fenster, Kill-Switch, Limits, Exposure) für ein Symbol — nur echte, synchronisierte Daten; connected:false heißt „nicht verbunden“, dann nichts dazu behaupten.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'z. B. BTC/USDT' } }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'agents_status',
    description:
      'Agenten-Schwarm aus der echten App: welche Prüf-Agenten aktiv sind (technik, risk, devil, portfolio — deterministisch; makro, shadow — LLM), welche aus sind und warum (fehlender Schlüssel, Daten nicht synchronisiert), Datenlage, LLM-Budget und die echte Urteils-Statistik (Votes je Agent). Nichts davon ist einstellbar — der Schwarm läuft von selbst.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'trading_settings',
    description:
      'Aktuelle Trading-Limits des Nutzers (Risiko je Trade, max. Hebel, offene Positionen, Exposure je Asset, Tages-/Wochenverlust, max. Drawdown), Kill-Switch und Modus — exakt die Werte, die die Risk-Engine vor jeder Order erzwingt. Mit erlaubten Grenzen je Wert.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_trading_settings',
    description:
      'Bittet den Nutzer um Bestätigung, einzelne Trading-Limits zu ändern (nur die genannten Schlüssel; Grenzen aus trading_settings). Erst nach seiner Bestätigung wird gespeichert — danach gilt es sofort für jede Order. Führt NICHT selbst aus.',
    inputSchema: {
      type: 'object',
      properties: {
        riskPctPerTrade: { type: 'number' },
        maxLeverage: { type: 'number' },
        maxOpenPositions: { type: 'integer' },
        maxExposurePctPerAsset: { type: 'number' },
        dailyLossLimitPct: { type: 'number' },
        weeklyLossLimitPct: { type: 'number' },
        maxDrawdownPct: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kill_switch',
    description:
      'Bittet den Nutzer um Bestätigung, den Kill-Switch zu schalten (active=true: sofortiger Order-Stopp für alle Agenten-Orders; false: wieder frei). Führt NICHT selbst aus — die Karte muss bestätigt werden.',
    inputSchema: { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'], additionalProperties: false },
  },
  {
    name: 'demo_account',
    description:
      'Übungskonto (Demo): Guthaben, Eigenkapital, unrealisierte PnL und alle offenen Positionen mit echtem Mark-Preis (nicht erreichbar → null), Hebel, Stop/Ziel, Liquidationspreis. Nur lesend — Orders setzt der Nutzer im Ticket.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'recent_signals',
    description:
      'Jüngste Signale der Strategie-Engine mit den echten Urteilen der Prüf-Agenten (Vote, Konfidenz, Begründung). Filter: status (new/confirmed/rejected/expired/filled/closed), symbol, limit (max 50).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'array', items: { type: 'string', enum: ['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed'] } },
        symbol: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
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
    case 'asset_analysis': {
      const symbol = str(input.symbol, 'symbol').toUpperCase();
      const a = await buildAssetAnalysis(ctx.db, ctx.userId, symbol);
      return { result: a, cards: [{ kind: 'link', label: `Analyse ${symbol}`, hash: `#/charts?symbol=${encodeURIComponent(symbol)}&tab=kontext` }] };
    }
    case 'agents_status': {
      const status = await loadAgentsStatus(ctx.db);
      return { result: status, cards: [{ kind: 'link', label: 'Agenten-Seite', hash: '#/agenten' }] };
    }
    case 'trading_settings': {
      const row = await ensureTradingSettings(ctx.db, ctx.userId);
      const limits: TradingLimits = {
        riskPctPerTrade: Number(row.riskPctPerTrade),
        maxLeverage: Number(row.maxLeverage),
        maxOpenPositions: row.maxOpenPositions,
        maxExposurePctPerAsset: Number(row.maxExposurePctPerAsset),
        dailyLossLimitPct: Number(row.dailyLossLimitPct),
        weeklyLossLimitPct: Number(row.weeklyLossLimitPct),
        maxDrawdownPct: Number(row.maxDrawdownPct),
      };
      return {
        result: { ...limits, killSwitchActive: row.killSwitchActive, mode: row.mode, updatedAt: row.updatedAt.toISOString(), bounds: SETTINGS_BOUNDS },
        cards: [{ kind: 'link', label: 'Einstellungen → Trading', hash: '#/einstellungen?tab=trading' }],
      };
    }
    case 'update_trading_settings': {
      const changes = parseLimitChanges(input);
      const row = await ensureTradingSettings(ctx.db, ctx.userId);
      const current: Record<string, number> = {
        riskPctPerTrade: Number(row.riskPctPerTrade),
        maxLeverage: Number(row.maxLeverage),
        maxOpenPositions: row.maxOpenPositions,
        maxExposurePctPerAsset: Number(row.maxExposurePctPerAsset),
        dailyLossLimitPct: Number(row.dailyLossLimitPct),
        weeklyLossLimitPct: Number(row.weeklyLossLimitPct),
        maxDrawdownPct: Number(row.maxDrawdownPct),
      };
      const label = `Limits ändern: ${Object.entries(changes)
        .map(([k, v]) => `${LIMIT_LABELS[k as keyof TradingLimits]} ${current[k]} → ${v}`)
        .join(' · ')}`;
      return {
        result: { changes, current, needsConfirmation: true, note: 'Der Nutzer muss die Karte bestätigen; erst dann wird gespeichert.' },
        cards: [{ kind: 'confirm', action: 'update_settings', args: changes, label, status: 'pending' }],
      };
    }
    case 'kill_switch': {
      if (typeof input.active !== 'boolean') throw new Error('active (true/false) fehlt.');
      const row = await ensureTradingSettings(ctx.db, ctx.userId);
      if (row.killSwitchActive === input.active) return { result: { killSwitchActive: row.killSwitchActive, unchanged: true } };
      return {
        result: { killSwitchActive: row.killSwitchActive, requested: input.active, needsConfirmation: true, note: 'Der Nutzer muss die Karte bestätigen.' },
        cards: [{ kind: 'confirm', action: 'kill_switch', args: { active: input.active }, label: input.active ? 'Kill-Switch EINSCHALTEN — sofortiger Order-Stopp' : 'Kill-Switch ausschalten — Agenten-Orders wieder frei', status: 'pending' }],
      };
    }
    case 'demo_account': {
      const source = currentDemoBookSource();
      const [account, positions] = await Promise.all([demoAccountOverview(ctx.db, source, ctx.userId), listDemoPositions(ctx.db, source, ctx.userId)]);
      return { result: { account, positions }, cards: [{ kind: 'link', label: 'Übungskonto', hash: '#/traden?tab=demo' }] };
    }
    case 'recent_signals': {
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 10;
      const statusList = Array.isArray(input.status) && input.status.length > 0 ? input.status.map(String) : ['new', 'confirmed'];
      const rows = await ctx.db
        .select({
          id: signals.id,
          createdAt: signals.createdAt,
          symbol: signals.symbol,
          timeframe: signals.timeframe,
          direction: signals.direction,
          setupType: signals.setupType,
          entry: signals.entry,
          stopLoss: signals.stopLoss,
          takeProfits: signals.takeProfits,
          score: signals.score,
          riskClass: signals.riskClass,
          status: signals.status,
          source: signals.source,
          strategy: strategies.slug,
        })
        .from(signals)
        .innerJoin(strategies, eq(strategies.id, signals.strategyId))
        .where(and(inArray(signals.status, statusList as (typeof signals.$inferSelect)['status'][]), typeof input.symbol === 'string' ? eq(signals.symbol, input.symbol.toUpperCase()) : undefined))
        .orderBy(desc(signals.createdAt))
        .limit(limit);
      const reviews =
        rows.length === 0
          ? []
          : await ctx.db
              .select({ signalId: signalReviews.signalId, agent: signalReviews.agent, vote: signalReviews.vote, confidence: signalReviews.confidence, reason: signalReviews.reason })
              .from(signalReviews)
              .where(inArray(signalReviews.signalId, rows.map((r) => r.id)));
      const out = rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        reviews: reviews.filter((x) => x.signalId === r.id).map(({ signalId: _s, ...x }) => ({ ...x, confidence: Number(x.confidence) })),
      }));
      return { result: { signals: out }, cards: [{ kind: 'link', label: 'Signale', hash: '#/signale' }] };
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
