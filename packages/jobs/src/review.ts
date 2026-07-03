import { asc, desc, eq, notExists, and } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  buildAccountState,
  loadActiveGates,
  loadRiskSettings,
  type TradingVenue,
} from '@gladiator/exchange';
import { evaluateRisk } from '@gladiator/risk';
import {
  AnthropicProvider,
  CostGuard,
  runSwarm,
  type DevilEvidence,
  type SignalFacts,
} from '@gladiator/agents';

const { signals, signalReviews, studyTrades, users, auditLog } = schema;

/**
 * Schwarm-Review (08_ §1): jedes neue Signal wird VOR der Bestätigung von den
 * Agenten bewertet; die Urteile landen in signal_reviews (transparent im UI).
 * Deaktivierte Agenten (kein Provider / keine Datenquelle) stehen sichtbar
 * im Portfolio-Verdict — es werden NIE Fake-Urteile eingefügt.
 */

/** Ein Kosten-Wächter je Prozess: Budget gilt über alle Job-Läufe des Tages (In-Memory; Neustart setzt zurück — dokumentiert). */
const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });
const llmProvider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);

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

export async function reviewNewSignals(db: Db, venue: TradingVenue): Promise<ReviewResult> {
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
        notExists(db.select().from(signalReviews).where(eq(signalReviews.signalId, signals.id))),
      ),
    )
    .limit(50);

  if (pending.length === 0) return result;

  const settings = await loadRiskSettings(db, user.id);
  const state = await buildAccountState(db, user.id);
  const gates = await loadActiveGates(db);

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
      );

      const devilEvidence = await buildDevilEvidence(db, facts);

      const { verdicts, disabled } = await runSwarm({
        facts,
        riskVerdict,
        devilEvidence,
        llm: {
          provider: llmProvider,
          guard: llmGuard,
          // EHRLICH: diese Datenquellen sind noch nicht angebunden (Phase-1-Rest).
          macroDataConnected: false,
          onchainDataConnected: false,
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
