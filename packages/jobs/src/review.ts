import { and, asc, desc, eq, inArray, notExists } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  buildAccountState,
  loadActiveGates,
  loadRiskContext,
  loadRiskSettings,
  type TradingVenue,
} from '@gladiator/exchange';
import {
  buffettScore,
  cotMarketForSymbol,
  cotScore,
  cpiScore,
  derivativesFresh,
  getBuffettSnapshot,
  getCotSnapshot,
  getCpiSnapshot,
  getDerivativesSnapshot,
  getMacroSnapshot,
  upcomingEvents,
} from '@gladiator/market-data';
import { evaluateRisk } from '@gladiator/risk';
import {
  CostGuard,
  decideHedge,
  envAnthropicProvider,
  escalateRiskClass,
  finalDecisionFor,
  positionSizeModeFor,
  runSwarm,
  type BuffettStatus,
  type DevilEvidence,
  type IntelligenceContext,
  type MarketRegimeName,
  type SignalFacts,
} from '@gladiator/agents';
import { formatSignalAlert } from './telegram.js';
import { notifySafe, telegramHtmlToText } from './notify.js';
import { explainForUser } from './explanation.js';

const { signals, signalReviews, studyTrades, users, auditLog, marketRegimes, signalIntelligence } = schema;

/** Deterministische ShadowGPT-Warnung aus echten Derivate-Daten (kein LLM nötig). */
function deriveShadowWarning(d: { fundingRate: number | null; oiChangePct24h: number | null } | undefined): string {
  if (!d) return '';
  const parts: string[] = [];
  if (d.fundingRate !== null && Math.abs(d.fundingRate) >= 0.0005) {
    parts.push(`Funding extrem (${(d.fundingRate * 100).toFixed(3)} %) — überhitzte Positionierung.`);
  }
  if (d.oiChangePct24h !== null && Math.abs(d.oiChangePct24h) >= 15) {
    parts.push(`Open Interest ${d.oiChangePct24h > 0 ? '+' : ''}${d.oiChangePct24h.toFixed(0)} % in 24 h — Squeeze-/Liquidationsrisiko.`);
  }
  return parts.join(' ');
}

/**
 * Schwarm-Review (08_ §1): jedes neue Signal wird VOR der Bestätigung von den
 * Agenten bewertet; die Urteile landen in signal_reviews (transparent im UI).
 * Deaktivierte Agenten (kein Provider / keine Datenquelle) stehen sichtbar
 * im Portfolio-Verdict — es werden NIE Fake-Urteile eingefügt.
 */

/** Ein Kosten-Wächter je Prozess: Budget gilt über alle Job-Läufe des Tages (In-Memory; Neustart setzt zurück — dokumentiert). */
const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

/** Devil-Evidenz: echte study_trades-Buckets, die auf das Signal zutreffen. */
export async function buildDevilEvidence(db: Db, facts: SignalFacts): Promise<DevilEvidence> {
  const rows = await db
    .select({
      clusterKey: studyTrades.clusterKey,
      direction: studyTrades.direction,
      session: studyTrades.session,
      rMultiple: studyTrades.rMultiple,
      netPnl: studyTrades.netPnl,
    })
    .from(studyTrades)
    .orderBy(desc(studyTrades.exitTs))
    .limit(5000);

  // clusterKey: smc-core|{symbol}|{setupType}|{timeframe}|…
  const matching = rows.filter((r) => {
    const parts = r.clusterKey.split('|');
    return parts[1] === facts.symbol && parts[3] === facts.timeframe;
  });

  const bucketOf = (label: string, trades: typeof matching) => {
    const wins = trades.filter((t) => Number(t.netPnl) > 0).length;
    return {
      label,
      trades: trades.length,
      expectancyR: trades.length > 0 ? trades.reduce((a, t) => a + Number(t.rMultiple), 0) / trades.length : 0,
      winRate: trades.length > 0 ? wins / trades.length : 0,
    };
  };

  const sameDirection = matching.filter((t) => t.direction === facts.direction);
  const sameSession = matching.filter((t) => t.session === facts.session);
  const directionAndSession = sameDirection.filter((t) => t.session === facts.session);

  const buckets = [
    bucketOf(`${facts.direction === 'long' ? 'Longs' : 'Shorts'} ${facts.symbol}@${facts.timeframe}`, sameDirection),
    bucketOf(`Session ${facts.session} bei ${facts.symbol}@${facts.timeframe}`, sameSession),
    bucketOf(
      `${facts.direction === 'long' ? 'Longs' : 'Shorts'} in Session ${facts.session} (${facts.symbol}@${facts.timeframe})`,
      directionAndSession,
    ),
  ].filter((b) => b.trades > 0);

  return { buckets, totalTrades: matching.length };
}

export type ReviewResult = { reviewed: number; skipped: number; errors: string[] };

/** `opts.signalIds`: nur diese Signale prüfen (Tests — parallel angelegte Signale anderer Testdateien stören sonst). */
export async function reviewNewSignals(db: Db, venue: TradingVenue, opts: { signalIds?: string[] } = {}): Promise<ReviewResult> {
  const result: ReviewResult = { reviewed: 0, skipped: 0, errors: [] };

  // Ein User-Typ (Patrick): ältester Account ist der Kontext für die Risk-Vorschau.
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) {
    result.errors.push('kein User vorhanden — Review ohne Risk-Kontext nicht möglich.');
    return result;
  }

  const pending = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.status, 'new'),
        // A1: Marktregeln/Risk-Vorschau kennt nur Binance-Paare — Signale anderer Kursquellen
        // prüft der Schwarm erst mit dem Preis-Resolver (A2); sie blockieren das 50er-Fenster nicht.
        eq(signals.venue, 'binance'),
        notExists(db.select().from(signalReviews).where(eq(signalReviews.signalId, signals.id))),
        opts.signalIds ? inArray(signals.id, opts.signalIds) : undefined,
      ),
    )
    .orderBy(desc(signals.createdAt))
    .limit(50);

  if (pending.length === 0) return result;

  const settings = await loadRiskSettings(db, user.id);
  const state = await buildAccountState(db, user.id);
  const gates = await loadActiveGates(db);
  const riskContext = await loadRiskContext(db);
  const noTrade = riskContext.noTrade;

  // ── Echte Kontexte für die LLM-Agenten (Phase-1-Rest) ──
  // Makro: VIX/DXY/US10Y + GRS + kommende High-Impact-Events (48 h).
  const macro = await getMacroSnapshot(db);
  const events = await upcomingEvents(db, { days: 2 });
  const highImpact = events
    .filter((e) => (e.importance ?? 0) >= 3)
    .slice(0, 10)
    .map((e) => ({ title: e.title, currency: e.currency, scheduledAt: e.scheduledAt.toISOString() }));
  const macroDataConnected = macro.fresh && macro.grs !== null;
  const macroContext = macroDataConnected
    ? {
        vix: macro.vix?.value,
        dxy: macro.dxy?.value,
        us10yPct: macro.us10y?.value,
        grs: macro.grs ? { score: Math.round(macro.grs.score), label: macro.grs.label, inputs: macro.grs.inputs } : null,
        upcomingHighImpactEvents: highImpact,
        activeNoTradeWindow: noTrade?.reason ?? null,
      }
    : undefined;

  // Shadow: Funding/OI-Snapshot (Binance-Futures, öffentlich).
  const onchainDataConnected = await derivativesFresh(db);
  const derivatives = onchainDataConnected ? await getDerivativesSnapshot(db) : [];

  // ── KI-Intelligence-Kontext (CPI/COT/Buffett) — einmal je Lauf ──
  // Reine, deterministische Snapshots aus echten Quellen; nicht verbunden ⇒ neutral.
  const cpi = await getCpiSnapshot(db).catch(() => null);
  const buffett = await getBuffettSnapshot(db).catch(() => null);

  for (const s of pending) {
    try {
      const facts: SignalFacts = {
        symbol: s.symbol,
        timeframe: s.timeframe,
        direction: s.direction,
        setupType: s.setupType,
        source: s.source,
        entry: Number(s.entry),
        stopLoss: Number(s.stopLoss),
        takeProfits: s.takeProfits.map(Number),
        score: Number(s.score),
        confluence: s.confluence,
        session: s.session,
        emaRegime: s.emaRegime as 'above' | 'below',
        marketPhase: s.marketPhase as 'bull' | 'bear',
      };

      const rules = await venue.marketRules(s.symbol);
      const riskVerdict = evaluateRisk(
        {
          symbol: s.symbol,
          timeframe: s.timeframe,
          direction: s.direction,
          entry: facts.entry,
          stopLoss: facts.stopLoss,
          leverage: 1,
          session: s.session,
          emaRegime: facts.emaRegime,
          marketPhase: facts.marketPhase,
        },
        settings,
        state,
        rules,
        gates,
        riskContext,
      );

      const devilEvidence = await buildDevilEvidence(db, facts);
      const symbolDerivatives = derivatives.find((d) => d.symbol === s.symbol);

      // ── Intelligence-Kontext dieses Signals (deterministisch, echte Daten) ──
      // Regime aus dem ml-Cache (marketRegimes), sonst aus der EMA-Marktphase.
      const [regimeRow] = await db
        .select({ regime: marketRegimes.regime })
        .from(marketRegimes)
        .where(and(eq(marketRegimes.symbol, s.symbol), eq(marketRegimes.timeframe, s.timeframe)))
        .orderBy(desc(marketRegimes.ts))
        .limit(1);
      const regime: MarketRegimeName | null =
        (regimeRow?.regime as MarketRegimeName | undefined) ?? (facts.marketPhase === 'bull' ? 'bull' : 'bear');

      // COT nur, wenn ein passender Futures-Report existiert (sonst not_applicable).
      const cotEntry = cotMarketForSymbol(s.symbol) ? (await getCotSnapshot(db, s.symbol).catch(() => []))[0] : undefined;
      const cotStatus = cotEntry?.positioning.status ?? 'not_applicable';
      const cotNetRatio = cotEntry?.positioning.netRatio ?? 0;

      // Buffett-Bewertung nur für Aktien/ETFs/Indizes relevant (PDF §7).
      const buffettStatus: BuffettStatus =
        ['stock', 'etf', 'index'].includes(s.assetClass) && buffett ? buffett.status : 'not_applicable';

      const shadowWarning = deriveShadowWarning(symbolDerivatives);

      const intelligence: IntelligenceContext = {
        direction: s.direction,
        baseRiskClass: s.riskClass,
        regime,
        cpiStatus: cpi?.phase ?? 'none',
        cotStatus,
        cotNetRatio,
        buffettStatus,
        shadowWarning,
        noTradeActive: Boolean(noTrade),
      };

      const { verdicts, disabled } = await runSwarm({
        facts,
        riskVerdict,
        devilEvidence,
        intelligence,
        llm: {
          provider: envAnthropicProvider(),
          guard: llmGuard,
          macroDataConnected,
          onchainDataConnected: onchainDataConnected && symbolDerivatives !== undefined,
          macroContext,
          onchainContext: symbolDerivatives
            ? {
                symbol: symbolDerivatives.symbol,
                fundingRate: symbolDerivatives.fundingRate,
                openInterest: symbolDerivatives.openInterest,
                oiChangePct24h: symbolDerivatives.oiChangePct24h,
                allSymbols: derivatives,
              }
            : undefined,
        },
      });

      for (const v of verdicts) {
        await db.insert(signalReviews).values({
          signalId: s.id,
          agent: v.agent,
          vote: v.vote,
          confidence: String(v.confidence),
          reason: v.reason,
          refs: v.refs ?? null,
        });
      }

      const portfolio = verdicts[verdicts.length - 1]!;

      // ── Erweitertes Signalobjekt (PDF §11) additiv persistieren ──
      const hedge = decideHedge(intelligence);
      const riskClass = escalateRiskClass(s.riskClass, intelligence);
      const positionSizeMode = positionSizeModeFor(hedge.mode, riskClass);
      const finalDecision = finalDecisionFor(hedge.mode, portfolio.vote);
      const technikVerdict = verdicts.find((v) => v.agent === 'technik');
      const devilVerdict = verdicts.find((v) => v.agent === 'devil');
      const makroVerdict = verdicts.find((v) => v.agent === 'makro');
      const rr1 = Number((technikVerdict?.refs as { rr1?: number } | undefined)?.rr1 ?? 0);
      const scoreComponents = {
        technical: technikVerdict ? technikVerdict.confidence : Math.min(1, facts.score / 10),
        macroCpi: cpiScore(intelligence.cpiStatus, cpi?.surprise ?? null, s.direction),
        liquidityShadow: shadowWarning ? 0.3 : onchainDataConnected ? 0.6 : 0.5,
        cotPositioning: cotEntry ? cotScore(cotEntry.positioning, s.direction) : 0.5,
        valuationBuffett: buffettScore(buffettStatus, s.direction),
        riskReward: riskVerdict.allowed ? Math.min(1, rr1 / 2) : 0.1,
      };
      const oracleMacroSummary =
        makroVerdict?.reason ??
        (macroContext ? `GRS ${macroContext.grs ? (macroContext.grs as { label?: string }).label ?? '—' : '—'}, VIX ${macroContext.vix ?? '—'}` : '');
      // Erklärung: deterministische Reason-Codes; MIT Key zusätzlich LLM-Kurzfassung
      // in der Sprache des Nutzers (users.locale) — fällt still auf die Codes zurück.
      const explanationForUser = await explainForUser(
        envAnthropicProvider(),
        llmGuard,
        {
          symbol: s.symbol,
          timeframe: s.timeframe,
          direction: s.direction,
          finalDecision,
          hedgeMode: hedge.mode,
          hedgeReason: hedge.reason,
          riskClass,
          regime,
          cpiStatus: intelligence.cpiStatus,
          cotStatus,
          buffettStatus,
          shadowWarning,
          devilsAdvocate: devilVerdict?.reason ?? '',
        },
        user.locale,
      );

      await db
        .insert(signalIntelligence)
        .values({
          signalId: s.id,
          assetIsExample: s.symbol === 'BTC/USDT',
          marketRegime: regime,
          scoreComponents,
          riskClass,
          positionSizeMode,
          hedgeMode: hedge.mode,
          cpiStatus: intelligence.cpiStatus,
          cotStatus,
          buffettStatus,
          shadowWarning,
          oracleMacroSummary,
          devilsAdvocate: devilVerdict?.reason ?? '',
          finalDecision,
          explanationForUser,
          postTradeReviewRequired: true,
        })
        .onConflictDoUpdate({
          target: signalIntelligence.signalId,
          set: {
            marketRegime: regime,
            scoreComponents,
            riskClass,
            positionSizeMode,
            hedgeMode: hedge.mode,
            cpiStatus: intelligence.cpiStatus,
            cotStatus,
            buffettStatus,
            shadowWarning,
            oracleMacroSummary,
            devilsAdvocate: devilVerdict?.reason ?? '',
            finalDecision,
            explanationForUser,
          },
        });

      // Benachrichtigung (App + Push + optional Telegram): echtes Signal + Schwarm-Urteil; Fehler crashen nie den Review.
      const signalHtml = formatSignalAlert({
          symbol: facts.symbol,
          timeframe: facts.timeframe,
          direction: facts.direction,
          setupType: facts.setupType,
          source: facts.source,
          entry: facts.entry,
          stopLoss: facts.stopLoss,
          takeProfits: facts.takeProfits,
          score: facts.score,
          portfolioVote: portfolio.vote,
          portfolioConfidence: portfolio.confidence,
          disabledAgents: disabled.map((d) => d.agent),
        });
      await notifySafe(db, {
        kind: 'signal',
        title: `${facts.symbol} ${facts.direction === 'long' ? 'Long' : 'Short'} · ${facts.timeframe} · Score ${facts.score.toFixed(1)}`,
        body: telegramHtmlToText(signalHtml),
        link: '#/signals',
        telegramHtml: signalHtml,
      });

      await db.insert(auditLog).values({
        actor: 'system',
        userId: user.id,
        action: 'signal.review.completed',
        entityType: 'signal',
        entityId: s.id,
        details: {
          portfolioVote: portfolio.vote,
          portfolioConfidence: portfolio.confidence,
          agents: verdicts.map((v) => ({ agent: v.agent, vote: v.vote })),
          disabled,
        },
      });

      result.reviewed++;
    } catch (err) {
      result.errors.push(`Signal ${s.id}: ${String(err)}`);
    }
  }

  return result;
}
