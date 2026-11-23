import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { demoBookSource, getOrCreateDemoAccount, placeDemoOrder } from '@gladiator/exchange';
import { getMacroSnapshot, getOhlcv } from '@gladiator/market-data';
import {
  evaluateScenarioConfirmation,
  evaluateScenarioTrigger,
  scenarioActionSchema,
  scenarioConfirmationSchema,
  scenarioTriggerSchema,
  sessionOf,
  type ConfirmationEvalResult,
  type ScenarioAction,
  type ScenarioConfirmation,
  type ScenarioTrigger,
  type TriggerEvalResult,
} from '@gladiator/strategy-engine';
import { z } from 'zod';
import { registeredAssets } from './asset-register.js';
import { notifySafe } from './notify.js';
import { scanUniverse } from './universe.js';

const {
  auditLog,
  exchangeConnections,
  newsItems,
  scenarioPlaybooks,
  scenarioRuns,
  signals,
  strategies,
  tradingSettings,
} = schema;

export type ScenarioPlaybookRow = typeof scenarioPlaybooks.$inferSelect;

export type ScenarioEvaluationReport = {
  checkedAt: string;
  matched: boolean;
  trigger: TriggerEvalResult;
  confirmation: ConfirmationEvalResult;
  summary: string;
};

export type ScenarioActionOutcome = {
  type: ScenarioAction['type'];
  status: 'signal_created' | 'demo_executed' | 'checklist_created' | 'hedge_updated' | 'skipped';
  detail: string;
  symbol?: string;
  signalId?: string;
  demoOrderId?: string;
  venue?: string;
  leverageApplied?: number;
};

export type ScenarioExecutionReport = {
  playbookId: string;
  mode: 'signal_only' | 'demo_auto';
  manual: boolean;
  actionsTaken: ScenarioActionOutcome[];
  summary: string;
};

const SCENARIO_STRATEGY_SLUG = 'scenario-playbooks';
const MAX_GROUP_SYMBOLS = 8;

/** Sorgt für eine stabile Strategie-Zeile, damit Szenario-Signale sauber zugeordnet sind. */
export async function ensureScenarioStrategy(db: Db): Promise<string> {
  const [existing] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(eq(strategies.slug, SCENARIO_STRATEGY_SLUG))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(strategies)
    .values({
      slug: SCENARIO_STRATEGY_SLUG,
      name: 'Szenario-Playbooks',
      kind: 'builtin',
      description: 'Wenn-Dann-Szenarien (News/Makro + BOS/CHoCH-Bestätigung → Signale/Demo-Reaktion).',
    })
    .onConflictDoNothing()
    .returning({ id: strategies.id });
  if (created) return created.id;

  const [raced] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(eq(strategies.slug, SCENARIO_STRATEGY_SLUG))
    .limit(1);
  return raced!.id;
}

function parsePlaybookParts(row: ScenarioPlaybookRow): {
  trigger: ScenarioTrigger;
  confirmation: ScenarioConfirmation;
  actions: ScenarioAction[];
} {
  const trigger = scenarioTriggerSchema.parse(row.trigger);
  const confirmation = scenarioConfirmationSchema.parse(row.confirmation);
  const actions = z.array(scenarioActionSchema).parse(row.actions);
  return { trigger, confirmation, actions };
}

function primaryConfirmationSymbol(confirmation: ScenarioConfirmation, actions: ScenarioAction[]): string {
  if (confirmation.symbol) return confirmation.symbol;
  for (const a of actions) {
    if (a.type === 'trade' && a.targetScope === 'symbol' && a.symbols[0]) return a.symbols[0];
  }
  return 'BTC/USDT';
}

function inferVenue(symbol: string): string {
  return symbol.endsWith('/USDT') || symbol.endsWith('/USDC') ? 'binance' : 'yahoo';
}

function inferAssetClass(symbol: string): 'crypto' | 'stock' | 'forex' | 'commodity' {
  if (symbol.endsWith('/USDT') || symbol.endsWith('/USDC') || symbol.endsWith('-USD')) return 'crypto';
  if (symbol.startsWith('XAU') || symbol.startsWith('XAG')) return 'commodity';
  if (symbol.endsWith('=X') || /^[A-Z]{3}\/[A-Z]{3}$/.test(symbol)) return 'forex';
  return 'stock';
}

/**
 * Prüft ein Szenario-Playbook live gegen echte DB-News, echte Makro-Werte (VIX/GRS)
 * und echte abgeschlossene OHLCV-Kerzen (BOS/CHoCH/Kursbruch).
 */
export async function evaluateScenarioPlaybook(
  db: Db,
  playbook: ScenarioPlaybookRow,
  now = new Date(),
): Promise<ScenarioEvaluationReport> {
  const { trigger, confirmation, actions } = parsePlaybookParts(playbook);
  const lookbackStart = new Date(now.getTime() - trigger.lookbackHours * 3_600_000);

  const [newsRows, macro] = await Promise.all([
    db
      .select({
        title: newsItems.title,
        summary: newsItems.summary,
        source: newsItems.source,
        url: newsItems.url,
        publishedAt: newsItems.publishedAt,
      })
      .from(newsItems)
      .where(gte(newsItems.publishedAt, lookbackStart))
      .orderBy(desc(newsItems.publishedAt))
      .limit(200),
    getMacroSnapshot(db).catch(() => null),
  ]);

  const vix = macro?.vix?.value ?? null;
  const grs = macro?.grs?.score ?? null;

  const triggerRes = evaluateScenarioTrigger(trigger, {
    now,
    news: newsRows,
    vix,
    grs,
  });

  const confSymbol = primaryConfirmationSymbol(confirmation, actions);
  const confVenue = inferVenue(confSymbol);
  const candles =
    confirmation.kind === 'none'
      ? []
      : await getOhlcv(db, {
          venue: confVenue,
          symbol: confSymbol,
          timeframe: confirmation.timeframe,
          limit: 120,
        }).catch(() => []);

  const confRes = evaluateScenarioConfirmation(confirmation, candles, confSymbol);
  const matched = triggerRes.matched && confRes.matched;

  const summary = matched
    ? `AUSGELÖST: ${triggerRes.reason} ${confRes.reason}`
    : !triggerRes.matched
      ? triggerRes.reason
      : `Auslöser aktiv, warte auf technische Bestätigung: ${confRes.reason}`;

  return {
    checkedAt: now.toISOString(),
    matched,
    trigger: triggerRes,
    confirmation: confRes,
    summary,
  };
}

async function resolveScopeSymbols(
  db: Db,
  scope: 'symbol' | 'all_crypto' | 'top_crypto' | 'all_stocks',
  explicit: string[],
): Promise<string[]> {
  if (scope === 'symbol') return explicit.slice(0, MAX_GROUP_SYMBOLS);
  if (scope === 'top_crypto') return ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  if (scope === 'all_crypto') {
    const uni = await scanUniverse(db).catch(() => ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    return uni.filter((s) => s.endsWith('/USDT') || s.endsWith('/USDC')).slice(0, MAX_GROUP_SYMBOLS);
  }
  // all_stocks
  const rows = await registeredAssets(db).catch(() => []);
  const stocks = rows
    .filter((r) => r.venue !== 'binance')
    .map((r) => r.symbol);
  return stocks.slice(0, MAX_GROUP_SYMBOLS);
}

/**
 * Führt die Aktionen eines ausgelösten (oder manuell gestarteten) Szenarios sicher aus:
 * - Risk-Engine-Deckel (`trading_settings.maxLeverage`) wird IMMER erzwungen.
 * - `signal_only` (Default): legt bestätigungspflichtige Signale in `#/signals` an.
 * - `demo_auto`: platziert echte Demo-Orders im Demo-Konto (NIE Live-Orders!).
 * - `sell_spot_holdings`: erzeugt ehrliche Bestätigungs-/Alarm-Checkliste je verbundener Börse/Wallet
 *   (Read-Only Wallets nie als automatisch verkaufbar vortäuschen; nie Auszahlungen/Transfers).
 */
export async function executeScenarioPlaybook(
  db: Db,
  playbook: ScenarioPlaybookRow,
  opts: { manual?: boolean; evidence?: unknown } = {},
): Promise<ScenarioExecutionReport> {
  const { confirmation, actions } = parsePlaybookParts(playbook);
  const mode: 'signal_only' | 'demo_auto' = playbook.executionMode === 'demo_auto' ? 'demo_auto' : 'signal_only';
  const manual = Boolean(opts.manual);

  const [settingsRow] = await db
    .select()
    .from(tradingSettings)
    .where(eq(tradingSettings.userId, playbook.userId))
    .limit(1);
  const maxLeverage = Math.max(1, Number(settingsRow?.maxLeverage ?? 10));

  const strategyId = await ensureScenarioStrategy(db);
  const actionsTaken: ScenarioActionOutcome[] = [];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 3_600_000);

  for (const action of actions) {
    if (action.type === 'trade') {
      const targetSymbols = await resolveScopeSymbols(db, action.targetScope, action.symbols);
      if (targetSymbols.length === 0) {
        actionsTaken.push({
          type: 'trade',
          status: 'skipped',
          detail: `Keine aktiven Assets für Gruppe „${action.targetScope}“ gefunden.`,
        });
        continue;
      }

      const appliedLev = Math.min(action.leverage, maxLeverage);
      const demoAcc = mode === 'demo_auto' ? await getOrCreateDemoAccount(db, playbook.userId) : null;
      const demoBalance = demoAcc ? Number(demoAcc.balance) : 0;

      for (const sym of targetSymbols) {
        const venue = inferVenue(sym);
        const recent = await getOhlcv(db, {
          venue,
          symbol: sym,
          timeframe: confirmation.timeframe,
          limit: 5,
        }).catch(() => []);
        const last = recent[recent.length - 1];
        if (!last || !Number.isFinite(last.close) || last.close <= 0) {
          actionsTaken.push({
            type: 'trade',
            status: 'skipped',
            symbol: sym,
            detail: `${sym}: Keine echten aktuellen Kerzen in der DB — übersprungen (kein Schätzwert).`,
          });
          continue;
        }

        const entry = last.close;
        const slDist = entry * (action.stopLossPct / 100);
        const tpDist = entry * (action.takeProfitPct / 100);
        const isLong = action.direction === 'long';
        const stopLoss = isLong ? entry - slDist : entry + slDist;
        const tp1 = isLong ? entry + tpDist * 0.4 : entry - tpDist * 0.4;
        const tp2 = isLong ? entry + tpDist * 0.7 : entry - tpDist * 0.7;
        const tp3 = isLong ? entry + tpDist : entry - tpDist;

        let demoOrderId: string | undefined;
        if (mode === 'demo_auto' && demoBalance > 50 && venue === 'binance') {
          const riskUsd = demoBalance * (action.riskPct / 100);
          const rawQty = riskUsd / Math.max(slDist, entry * 0.005);
          const maxNotionalQty = (demoBalance * 0.15 * appliedLev) / entry;
          const qty = Math.min(rawQty, maxNotionalQty);
          const placed = await placeDemoOrder(db, demoBookSource(), playbook.userId, {
            symbol: sym,
            direction: action.direction,
            type: 'market',
            qty,
            stopLoss,
            takeProfit: tp2,
            leverage: appliedLev,
            maxLeverage,
            venue: 'binance',
          }).catch(() => ({ placed: false as const, reason: 'demo_error' }));

          if (placed.placed) {
            demoOrderId = placed.orderId;
            actionsTaken.push({
              type: 'trade',
              status: 'demo_executed',
              symbol: sym,
              demoOrderId,
              leverageApplied: appliedLev,
              detail: `Demo-Order platziert: ${sym} ${action.direction.toUpperCase()} @ ${entry.toFixed(4)} (${appliedLev}x, SL ${stopLoss.toFixed(4)}, TP ${tp2.toFixed(4)}).`,
            });
            continue;
          }
        }

        // Signal in `#/signals` anlegen (Mensch-im-Loop mit 1-Klick „▶ Ausführen“)
        const [sig] = await db
          .insert(signals)
          .values({
            source: 'engine',
            strategyId,
            symbol: sym,
            venue,
            timeframe: confirmation.timeframe,
            assetClass: inferAssetClass(sym),
            venueType: 'cex',
            direction: action.direction,
            setupType: confirmation.timeframe === '15m' ? 'scalp' : confirmation.timeframe === '1d' ? 'position' : 'swing',
            entry: String(entry),
            stopLoss: String(stopLoss),
            takeProfits: [String(tp1), String(tp2), String(tp3)],
            leverageSuggested: String(appliedLev),
            score: '8.0',
            riskClass: appliedLev >= 5 ? 'high' : 'medium',
            confluence: [
              `Szenario: ${playbook.name.slice(0, 48)}`,
              confirmation.kind !== 'none' ? `Bestätigung: ${confirmation.kind.toUpperCase()} (${confirmation.timeframe})` : 'Direkt-Auslöser',
              manual ? 'Manuell ausgelöst' : 'Auto-Szenario-Wächter',
            ],
            session: sessionOf(now),
            emaRegime: isLong ? 'above' : 'below',
            marketPhase: isLong ? 'bull' : 'bear',
            status: 'new',
            expiresAt,
          })
          .returning({ id: signals.id });

        actionsTaken.push({
          type: 'trade',
          status: 'signal_created',
          symbol: sym,
          signalId: sig?.id,
          leverageApplied: appliedLev,
          detail: `Signal erstellt: ${sym} ${action.direction.toUpperCase()} @ ${entry.toFixed(4)} (${appliedLev}x vorgeschlagen${appliedLev < action.leverage ? `, gekappt von ${action.leverage}x durch maxLeverage` : ''}) — bereit zum Ausführen unter #/signals.`,
        });
      }
    } else if (action.type === 'sell_spot_holdings') {
      const conns = await db
        .select({
          id: exchangeConnections.id,
          exchangeId: exchangeConnections.exchangeId,
          exchangeName: exchangeConnections.exchangeName,
          label: exchangeConnections.label,
          mode: exchangeConnections.mode,
          status: exchangeConnections.status,
        })
        .from(exchangeConnections)
        .where(
          and(
            eq(exchangeConnections.userId, playbook.userId),
            eq(exchangeConnections.status, 'active'),
            isNull(exchangeConnections.revokedAt),
          ),
        );

      const hint = action.venueHint.toLowerCase();
      const matchedConns = action.connectionId
        ? conns.filter((c) => c.id === action.connectionId)
        : hint === 'all'
          ? conns
          : conns.filter(
              (c) =>
                c.exchangeId.toLowerCase().includes(hint) ||
                c.exchangeName.toLowerCase().includes(hint) ||
                (c.label ?? '').toLowerCase().includes(hint),
            );

      const assetText = action.assets.includes('ALL') ? 'gesamten Spot-Bestand' : action.assets.join(', ');

      if (matchedConns.length === 0) {
        actionsTaken.push({
          type: 'sell_spot_holdings',
          status: 'checklist_created',
          venue: action.venueHint,
          detail: `Verkaufs-Alarm (${action.sellPct} % ${assetText} auf „${action.venueHint}“): Keine aktive Börsen-/Wallet-Verbindung unter diesem Namen gefunden — bitte manuell in deiner Wallet/Börse verkaufen oder unter #/einstellungen verbinden.`,
        });
      } else {
        for (const c of matchedConns) {
          const title = c.label ? `${c.exchangeName} (${c.label})` : c.exchangeName;
          const modeHint =
            c.mode === 'read_only'
              ? 'Nur lesend verbunden (kein Signierschlüssel) → bitte manuell in der Wallet/Börse verkaufen.'
              : 'Trading-Verbindung aktiv → aus Sicherheitsgründen kein blinder Live-Abverkauf ohne Bestätigung; bitte im Depot/Börse bestätigen.';
          actionsTaken.push({
            type: 'sell_spot_holdings',
            status: 'checklist_created',
            venue: title,
            detail: `Verkaufs-Checkliste: ${action.sellPct} % ${assetText} auf ${title} abbauen. ${modeHint}`,
          });
        }
      }
    } else if (action.type === 'activate_hedge') {
      const existingCfg =
        settingsRow?.hedgingConfig && typeof settingsRow.hedgingConfig === 'object'
          ? (settingsRow.hedgingConfig as Record<string, unknown>)
          : {};
      const nextCfg = {
        ...existingCfg,
        enabled: true,
        hedgeRatioPct: action.hedgeRatioPct,
      };
      if (settingsRow) {
        await db
          .update(tradingSettings)
          .set({ hedgingConfig: nextCfg, updatedAt: now })
          .where(eq(tradingSettings.id, settingsRow.id));
      } else {
        await db.insert(tradingSettings).values({
          userId: playbook.userId,
          hedgingConfig: nextCfg,
        });
      }
      actionsTaken.push({
        type: 'activate_hedge',
        status: 'hedge_updated',
        detail: `Portfolio-Hedging automatisch aktiviert & Hedge-Quote auf ${action.hedgeRatioPct} % gesetzt.`,
      });
    }
  }

  const summary = `${manual ? 'Manuell' : 'Automatisch'} ausgeführt (${mode === 'demo_auto' ? 'Demo-Auto' : 'Signale + Checkliste'}): ${actionsTaken.length} Aktion(en) verarbeitet.`;

  await db
    .update(scenarioPlaybooks)
    .set({
      status: 'triggered',
      triggeredAt: now,
      triggerEvidence: (opts.evidence ?? { manual }) as Record<string, unknown>,
      updatedAt: now,
    })
    .where(eq(scenarioPlaybooks.id, playbook.id));

  await db.insert(scenarioRuns).values({
    playbookId: playbook.id,
    userId: playbook.userId,
    kind: manual ? 'manual_trigger' : 'trigger',
    matched: true,
    summary,
    evidence: (opts.evidence ?? { manual }) as Record<string, unknown>,
    actionsTaken,
  });

  await db.insert(auditLog).values({
    actor: manual ? 'user' : 'system',
    userId: playbook.userId,
    action: manual ? 'scenario.manual_trigger' : 'scenario.auto_trigger',
    entityType: 'scenario_playbook',
    entityId: playbook.id,
    details: { name: playbook.name, mode, actionsCount: actionsTaken.length },
  });

  await notifySafe(db, {
    kind: 'signal',
    severity: 'warn',
    userId: playbook.userId,
    title: `🎯 Szenario ausgelöst: ${playbook.name}`,
    body: `${summary} ${actionsTaken.slice(0, 3).map((a) => a.detail).join(' | ')}`,
    link: '#/strategien?tab=szenarien',
  }).catch(() => undefined);

  return {
    playbookId: playbook.id,
    mode,
    manual,
    actionsTaken,
    summary,
  };
}

export type ScenarioWatchResult = {
  checked: number;
  triggered: number;
};

/** Periodischer Worker-Job (alle 5 Min.): überwacht alle scharfgeschalteten (`armed`) Szenarien. */
export async function runScenarioWatch(db: Db): Promise<ScenarioWatchResult> {
  const armed = await db
    .select()
    .from(scenarioPlaybooks)
    .where(eq(scenarioPlaybooks.status, 'armed'))
    .limit(100);

  let triggered = 0;
  for (const pb of armed) {
    try {
      const report = await evaluateScenarioPlaybook(db, pb);
      await db
        .update(scenarioPlaybooks)
        .set({
          lastCheckedAt: new Date(report.checkedAt),
          lastEvaluation: report as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(scenarioPlaybooks.id, pb.id));

      if (report.matched) {
        await executeScenarioPlaybook(db, pb, { manual: false, evidence: report });
        triggered++;
      }
    } catch (err) {
      console.warn(`[scenario-watch] Playbook ${pb.id} Fehler:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: armed.length, triggered };
}
