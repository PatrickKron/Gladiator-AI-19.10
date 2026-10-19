import type { schema } from '@gladiator/db';
import { buildClusterKey, marketStructureOf } from '@gladiator/strategy-engine';
import type { BacktestTrade } from './engine.js';

/**
 * VDB1-Zeile (13_ §3) aus einem echten Labor-Backtest-Trade. Cluster-Key über
 * denselben Builder wie geschlossene Paper-Trades (`buildClusterKey`), mit
 * Session und Marktstruktur JE TRADE (vorher pauschal `all|all`).
 * MAE/MFE in echten Basispunkten des Entry-Preises — die Batch-Optimierung
 * braucht Preis-% für den Liquidations-Check (Alt-Zeilen hatten R×100).
 */
export type LabStudyContext = { strategy: string; symbol: string; setupType: string; timeframe: string };

export function labStudyRow(t: BacktestTrade, ctx: LabStudyContext): typeof schema.studyTrades.$inferInsert {
  const stopDistPct = t.entry > 0 ? Math.abs(t.entry - t.stopLoss) / t.entry : 0;
  return {
    clusterKey: buildClusterKey({ ...ctx, session: t.session, emaRegime: t.emaRegime, marketPhase: t.marketPhase }),
    executedTradeId: null,
    direction: t.direction,
    entryTs: t.entryTs,
    exitTs: t.exitTs,
    mfeBps: String(t.mfeR * stopDistPct * 10_000),
    maeBps: String(t.maePct * 10_000),
    rMultiple: String(t.rMultiple),
    session: t.session,
    marketStructure: marketStructureOf(t.emaRegime, t.marketPhase),
    fees: String(t.fees),
    funding: String(t.funding),
    slippage: String(t.slippage),
    netPnl: String(t.netPnl),
    liquidationFlag: false,
    pnlRTpA: String(t.pnlRTpA),
    pnlRTpB: String(t.pnlRTpB),
    pnlRTpC: String(t.pnlRTpC),
    pnlRTpD: String(t.pnlRTpD),
  };
}
