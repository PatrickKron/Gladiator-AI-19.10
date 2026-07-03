/**
 * Rundum-Trade-Analyse (Patrick 2026-07-03): alles, was man über Trades
 * wissen kann — gruppiert nach Session, EMA200-Regime (× Richtung),
 * Marktphase und je Confluence-Faktor (mit vs. ohne). Diese Statistiken
 * sind die Evidenz-Basis der adaptiven Risk-Gates.
 * Buckets ohne Trades erscheinen NICHT (keine erfundenen Nullzeilen).
 */

export type AnalyzableTrade = {
  netPnl: number;
  rMultiple: number;
  direction: 'long' | 'short';
  session: string;
  emaRegime: 'above' | 'below';
  marketPhase: 'bull' | 'bear';
  confluence: string[];
};

export type BucketStats = {
  trades: number;
  netPnl: number;
  winRate: number;
  expectancyR: number;
};

export type ConfluenceStats = {
  withTrades: number;
  withExpectancyR: number;
  withoutTrades: number;
  withoutExpectancyR: number;
  /** Erwartungswert-Unterschied (mit − ohne) in R — misst den Faktor einzeln. */
  deltaR: number;
};

export type TradeAnalysis = {
  bySession: Record<string, BucketStats>;
  byRegime: Record<'above' | 'below', BucketStats | undefined>;
  byDirectionRegime: Record<string, BucketStats>;
  byPhase: Record<'bull' | 'bear', BucketStats | undefined>;
  byConfluence: Record<string, ConfluenceStats>;
};

function bucket(trades: AnalyzableTrade[]): BucketStats {
  const wins = trades.filter((t) => t.netPnl > 0).length;
  return {
    trades: trades.length,
    netPnl: trades.reduce((a, t) => a + t.netPnl, 0),
    winRate: trades.length > 0 ? wins / trades.length : 0,
    expectancyR: trades.length > 0 ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
  };
}

function groupBy<K extends string>(trades: AnalyzableTrade[], key: (t: AnalyzableTrade) => K): Record<K, BucketStats> {
  const groups = new Map<K, AnalyzableTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }
  const out = {} as Record<K, BucketStats>;
  for (const [k, arr] of groups) out[k] = bucket(arr);
  return out;
}

export function analyzeTrades(trades: AnalyzableTrade[]): TradeAnalysis {
  const byConfluence: Record<string, ConfluenceStats> = {};
  const allTags = new Set(trades.flatMap((t) => t.confluence));
  for (const tag of allTags) {
    const withTag = trades.filter((t) => t.confluence.includes(tag));
    const withoutTag = trades.filter((t) => !t.confluence.includes(tag));
    const w = bucket(withTag);
    const wo = bucket(withoutTag);
    byConfluence[tag] = {
      withTrades: w.trades,
      withExpectancyR: w.expectancyR,
      withoutTrades: wo.trades,
      withoutExpectancyR: wo.expectancyR,
      deltaR: w.expectancyR - (wo.trades > 0 ? wo.expectancyR : 0),
    };
  }

  return {
    bySession: groupBy(trades, (t) => t.session),
    byRegime: groupBy(trades, (t) => t.emaRegime) as TradeAnalysis['byRegime'],
    byDirectionRegime: groupBy(trades, (t) => `${t.direction}|${t.emaRegime}`),
    byPhase: groupBy(trades, (t) => t.marketPhase) as TradeAnalysis['byPhase'],
    byConfluence,
  };
}
