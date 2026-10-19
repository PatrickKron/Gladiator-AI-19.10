import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { buildClusterKey, marketStructureOf } from '@gladiator/strategy-engine';

const { auditLog, signals, strategies, studyTrades } = schema;

/**
 * VDB1 aus ECHTEN geschlossenen Paper-Trades (13_ §3/§4 „event-basiert nach
 * jedem Trade-Closure"). Quelle = Paper erkennbar an `executed_trade_id`
 * (Labor-Zeilen haben keinen Trade-Bezug); executed_trades.mode sagt paper/live.
 *
 * Ehrlich unbekannt (und darum NICHT erfunden):
 *  - TP-Schemas B/C/D: der Executor führt nur Schema A (50/30/20) aus; ein
 *    kontrafaktisches Ergebnis bräuchte den Preisverlauf → null.
 *  - MFE: Paper speichert keinen Preisverlauf → null.
 *  - MAE: als Stop-Abstand gespeichert = konservative OBERGRENZE (der Stop
 *    schließt, bevor mehr Verlust entsteht) — der Liquidations-Check im
 *    Hebel-Gitter wird dadurch eher strenger, nie lockerer.
 */
export type PaperStudyInput = {
  executedTradeId: string;
  signal: {
    strategySlug: string;
    symbol: string;
    setupType: string;
    timeframe: string;
    session: string | null;
    emaRegime: 'above' | 'below' | null;
    marketPhase: 'bull' | 'bear' | null;
  };
  direction: 'long' | 'short';
  entry: number;
  qty: number;
  /** Stop beim Eröffnen (vor Break-Even/Trailing) — Basis des Risikos 1R. */
  initialStop: number;
  takeProfitCount: number;
  entryTs: Date;
  exitTs: Date;
  netPnl: number;
  fees: number;
  funding: number;
};

export function paperStudyRow(i: PaperStudyInput): typeof studyTrades.$inferInsert | null {
  const stopDist = Math.abs(i.entry - i.initialStop);
  const riskAmount = stopDist * i.qty;
  if (!(riskAmount > 0) || !(i.entry > 0) || !Number.isFinite(i.netPnl)) return null;
  const r = i.netPnl / riskAmount;
  const s = i.signal;
  return {
    clusterKey: buildClusterKey({
      strategy: s.strategySlug,
      symbol: s.symbol,
      setupType: s.setupType,
      timeframe: s.timeframe,
      session: s.session,
      emaRegime: s.emaRegime,
      marketPhase: s.marketPhase,
    }),
    executedTradeId: i.executedTradeId,
    direction: i.direction,
    entryTs: i.entryTs,
    exitTs: i.exitTs,
    mfeBps: null,
    maeBps: String((stopDist / i.entry) * 10_000),
    rMultiple: String(r),
    session: s.session,
    marketStructure: marketStructureOf(s.emaRegime, s.marketPhase),
    fees: String(i.fees),
    funding: String(i.funding),
    slippage: '0', // Paper-Fills ohne Slippage-Modell (wie executed_trades.slippage)
    netPnl: String(i.netPnl),
    liquidationFlag: false,
    // Nur das tatsächlich ausgeführte Schema A (3 TPs à 50/30/20) ist bekannt.
    pnlRTpA: i.takeProfitCount === 3 ? String(r) : null,
    pnlRTpB: null,
    pnlRTpC: null,
    pnlRTpD: null,
  };
}

/**
 * Schreibt die VDB1-Zeile zum gerade gebuchten Paper-Trade. Signal und
 * ursprünglicher SL/TP kommen aus dem Ausführungs-Audit (`order.executed`
 * an der Position) — dort steht der effektive Stop VOR Break-Even/Trailing.
 * Positionen ohne Signal-Bezug (kein Audit) erzeugen ehrlich keine Zeile.
 * Gibt zurück, ob eine Zeile geschrieben wurde.
 */
export async function recordPaperStudyTrade(
  db: Db,
  pos: { id: string; direction: 'long' | 'short'; entryPrice: string; qty: string; openedAt: Date },
  trade: { id: string; exitTs: Date | null; netPnl: number; fees: number; funding: number },
): Promise<boolean> {
  const [exec] = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'order.executed'), eq(auditLog.entityType, 'position'), eq(auditLog.entityId, pos.id)))
    .orderBy(desc(auditLog.ts))
    .limit(1);
  const d = (exec?.details ?? null) as { signalId?: unknown; stopLoss?: unknown; takeProfits?: unknown } | null;
  if (!d || typeof d.signalId !== 'string' || !Number.isFinite(Number(d.stopLoss))) return false;

  const [sig] = await db
    .select({
      strategySlug: strategies.slug,
      symbol: signals.symbol,
      setupType: signals.setupType,
      timeframe: signals.timeframe,
      session: signals.session,
      emaRegime: signals.emaRegime,
      marketPhase: signals.marketPhase,
    })
    .from(signals)
    .innerJoin(strategies, eq(strategies.id, signals.strategyId))
    .where(eq(signals.id, d.signalId))
    .limit(1);
  if (!sig) return false;

  const row = paperStudyRow({
    executedTradeId: trade.id,
    signal: {
      ...sig,
      emaRegime: sig.emaRegime === 'above' || sig.emaRegime === 'below' ? sig.emaRegime : null,
      marketPhase: sig.marketPhase === 'bull' || sig.marketPhase === 'bear' ? sig.marketPhase : null,
    },
    direction: pos.direction,
    entry: Number(pos.entryPrice),
    qty: Number(pos.qty),
    initialStop: Number(d.stopLoss),
    takeProfitCount: Array.isArray(d.takeProfits) ? d.takeProfits.length : 0,
    entryTs: pos.openedAt,
    exitTs: trade.exitTs ?? new Date(),
    netPnl: trade.netPnl,
    fees: trade.fees,
    funding: trade.funding,
  });
  if (!row) return false;
  await db.insert(studyTrades).values(row);
  return true;
}
