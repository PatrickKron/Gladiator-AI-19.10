import { eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  binanceBookSource,
  buildAccountState,
  demoAccountOverview,
  fetchConnectionBalances,
  listConnections,
} from '@gladiator/exchange';
import { getEurUsdRate, valueBalancesUsd } from '@gladiator/market-data';

const { users, accountValueSnapshots } = schema;

/**
 * Vermögens-Snapshot (stündlich, Worker): schreibt je User eine Zeile
 * account_value_snapshots — Grundlage für den Zeitverlauf in „Vermögen".
 * Ehrliche Nulls: was gerade nicht ermittelbar ist (Börse down, kein
 * EUR-Kurs), bleibt null und wird NIE erfunden. Der Verlauf beginnt mit
 * dem ersten Snapshot — Vergangenheit wird nicht rückgerechnet.
 */
export type SnapshotResult = { users: number; written: number; errors: string[] };

export async function snapshotAccountValues(db: Db): Promise<SnapshotResult> {
  const allUsers = await db.select({ id: users.id }).from(users);
  const errors: string[] = [];
  let written = 0;

  for (const u of allUsers) {
    try {
      // Übungskonto: Demo (manuell) + Paper (Agenten) — beides USD.
      let demoEquity: number | null = null;
      try {
        const demo = await demoAccountOverview(db, binanceBookSource(), u.id);
        demoEquity = demo.markIncomplete ? null : demo.equity;
      } catch (err) {
        errors.push(`demo ${u.id}: ${String(err)}`);
      }
      let paperEquity: number | null = null;
      try {
        paperEquity = (await buildAccountState(db, u.id)).equity;
      } catch (err) {
        errors.push(`paper ${u.id}: ${String(err)}`);
      }

      // Echtes Geld: verbundene Börsen, echte Bestände, echte Kurse.
      let realEquityUsd: number | null = null;
      const breakdown: Record<string, unknown> = {};
      const connections = await listConnections(db, u.id);
      if (connections.length > 0) {
        let sum = 0;
        let anyValued = false;
        for (const conn of connections) {
          try {
            const balances = await fetchConnectionBalances(db, u.id, conn.id);
            const amounts: Record<string, number> = {};
            for (const b of balances) amounts[b.currency] = b.total;
            const valued = await valueBalancesUsd(amounts);
            sum += valued.totalUsd;
            anyValued = true;
            breakdown[conn.exchangeId] = { totalUsd: valued.totalUsd, unvalued: valued.unvalued };
          } catch (err) {
            breakdown[conn.exchangeId] = { error: String(err) };
            errors.push(`real ${conn.exchangeId}: ${String(err)}`);
          }
        }
        if (anyValued) realEquityUsd = sum;
      }

      const eurUsd = await getEurUsdRate();
      const totalUsd = (demoEquity ?? 0) + (paperEquity ?? 0) + (realEquityUsd ?? 0);
      const totalEur = eurUsd !== null ? totalUsd / eurUsd : null;

      await db.insert(accountValueSnapshots).values({
        userId: u.id,
        demoEquityUsd: demoEquity === null ? null : String(demoEquity),
        paperEquityUsd: paperEquity === null ? null : String(paperEquity),
        realEquityUsd: realEquityUsd === null ? null : String(realEquityUsd),
        eurUsdRate: eurUsd === null ? null : String(eurUsd),
        totalEur: totalEur === null ? null : String(totalEur),
        breakdown,
      });
      written++;
    } catch (err) {
      errors.push(`user ${u.id}: ${String(err)}`);
    }
  }

  return { users: allUsers.length, written, errors };
}

/** Verlauf für die Vermögens-Ansicht (aufsteigend, max. limit Punkte). */
export async function loadValueHistory(db: Db, userId: string, limit = 500) {
  const rows = await db
    .select()
    .from(accountValueSnapshots)
    .where(eq(accountValueSnapshots.userId, userId))
    .orderBy(accountValueSnapshots.ts)
    .limit(limit);
  return rows.map((r) => ({
    ts: r.ts,
    demoEquityUsd: r.demoEquityUsd === null ? null : Number(r.demoEquityUsd),
    paperEquityUsd: r.paperEquityUsd === null ? null : Number(r.paperEquityUsd),
    realEquityUsd: r.realEquityUsd === null ? null : Number(r.realEquityUsd),
    eurUsdRate: r.eurUsdRate === null ? null : Number(r.eurUsdRate),
    totalEur: r.totalEur === null ? null : Number(r.totalEur),
  }));
}
