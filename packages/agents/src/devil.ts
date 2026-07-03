import type { AgentVerdict, SignalFacts } from './types.js';

/**
 * Devil's Advocate (Erbe: Devils Analyst) — argumentiert GEGEN den Trade,
 * gestützt auf ECHTE Historie ähnlicher Setups (study_trades aus dem Labor).
 * Kein LLM nötig: die Gegenevidenz sind gemessene Erwartungswerte.
 */

export type DevilBucket = {
  /** z. B. "Longs unter EMA200", "Session off", "Confluence FVG-Ziel fehlt" */
  label: string;
  trades: number;
  expectancyR: number;
  winRate: number;
};

export type DevilEvidence = {
  /** Nur Buckets, die auf DIESES Signal zutreffen (vom Aufrufer vorgefiltert). */
  buckets: DevilBucket[];
  /** Gesamtzahl analysierter historischer Trades (Kontext für „genug Historie?"). */
  totalTrades: number;
};

/** Mindest-Stichprobe, unter der ein Bucket als Rauschen gilt. */
const MIN_TRADES = 10;
const REJECT_EXPECTANCY = -0.15;
const REJECT_TRADES = 20;
const CAUTION_EXPECTANCY = -0.05;

export function reviewDevil(f: SignalFacts, evidence: DevilEvidence): AgentVerdict {
  const solid = evidence.buckets.filter((b) => b.trades >= MIN_TRADES);
  const negative = solid.filter((b) => b.expectancyR <= CAUTION_EXPECTANCY);
  const strongNegative = negative.filter((b) => b.expectancyR <= REJECT_EXPECTANCY && b.trades >= REJECT_TRADES);

  if (strongNegative.length > 0) {
    const worst = strongNegative.reduce((a, b) => (b.expectancyR < a.expectancyR ? b : a));
    return {
      agent: 'devil',
      vote: 'reject',
      confidence: Math.min(0.95, 0.5 + worst.trades / 100),
      reason: `Gegen den Trade spricht die Historie: ${worst.label} → ${worst.expectancyR.toFixed(2)}R Erwartungswert über ${worst.trades} Trades (WR ${(worst.winRate * 100).toFixed(0)} %).`,
      refs: { buckets: evidence.buckets, totalTrades: evidence.totalTrades },
    };
  }

  if (negative.length > 0) {
    const worst = negative.reduce((a, b) => (b.expectancyR < a.expectancyR ? b : a));
    return {
      agent: 'devil',
      vote: 'caution',
      confidence: Math.min(0.8, 0.4 + worst.trades / 100),
      reason: `Schwäche gefunden: ${worst.label} → ${worst.expectancyR.toFixed(2)}R über ${worst.trades} Trades. Kein K.-o., aber Vorsicht.`,
      refs: { buckets: evidence.buckets, totalTrades: evidence.totalTrades },
    };
  }

  if (evidence.totalTrades < MIN_TRADES || solid.length === 0) {
    return {
      agent: 'devil',
      vote: 'caution',
      confidence: 0.3,
      reason: `Zu wenig Historie ähnlicher Setups (${evidence.totalTrades} Trades gesamt, ${solid.length} belastbare Vergleichsgruppen) — Gegenprüfung nicht möglich, Vorsicht.`,
      refs: { buckets: evidence.buckets, totalTrades: evidence.totalTrades },
    };
  }

  const best = solid.reduce((a, b) => (b.expectancyR > a.expectancyR ? b : a));
  return {
    agent: 'devil',
    vote: 'confirm',
    confidence: Math.min(0.85, 0.4 + best.trades / 100),
    reason: `Keine substanzielle Gegenevidenz gefunden — beste Vergleichsgruppe: ${best.label} mit ${best.expectancyR.toFixed(2)}R über ${best.trades} Trades.`,
    refs: { buckets: evidence.buckets, totalTrades: evidence.totalTrades },
  };
}
