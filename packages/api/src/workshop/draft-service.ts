import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { evaluateDslAt, parseInstructionDsl, type InstructionDsl } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type CostModel } from '@gladiator/backtest';
import { BARS_PER_YEAR, getOhlcv } from '@gladiator/market-data';

const { workshopSessions, workshopBacktests, strategies, strategyVersions, auditLog } = schema;

/**
 * Workshop-Entwurf: Draft-Backtest und „Als Version speichern“ als Funktionen,
 * die Seite (tRPC) UND Gladiator-Chat (Werkzeug) gleich benutzen — eine Wahrheit.
 */

/** Equity-Kurve fürs UI auf max. N Punkte eindampfen (wie Labor). */
export function downsample<T>(points: T[], maxPoints = 400): T[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

export async function ownedSession(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(workshopSessions)
    .where(and(eq(workshopSessions.id, id), eq(workshopSessions.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workshop-Sitzung nicht gefunden.' });
  return row;
}

/** Entwurf einer Sitzung als validierte DSL — oder ehrlicher Fehler. */
export function requireDraft(session: { draftDsl: unknown }): InstructionDsl {
  if (!session.draftDsl) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Konfigurations-Entwurf vorhanden — erst Analyse/Dialog nutzen oder Konfiguration anlegen.' });
  }
  const parsed = parseInstructionDsl(session.draftDsl);
  if (!parsed.ok) {
    throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: `Entwurf ungültig: ${parsed.errors.join('; ')}` });
  }
  return parsed.dsl;
}

export type DraftBacktestInput = {
  id: string;
  label?: string;
  symbol?: string;
  timeframe?: InstructionDsl['timeframe'];
  from: Date;
  to: Date;
  riskPctPerTrade: number;
  costModel?: CostModel;
};

/**
 * Draft-Backtest: aktueller Entwurf gegen ECHTE Kerzen, netto (Kostenmodell Pflicht).
 * Asset/Timeframe pro Lauf übersteuerbar. Persistiert in workshop_backtests.
 */
export async function runDraftBacktest(db: Db, userId: string, input: DraftBacktestInput) {
  const session = await ownedSession(db, userId, input.id);
  const base = requireDraft(session);
  const dsl: InstructionDsl = {
    ...base,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    ...(input.timeframe ? { timeframe: input.timeframe } : {}),
  };
  const from = input.from;
  const to = input.to;
  if (!(from < to)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Zeitraum ungültig (from < to nötig).' });
  const costModel: CostModel = input.costModel ?? DEFAULT_COSTS;

  const [row] = await db
    .insert(workshopBacktests)
    .values({
      sessionId: session.id,
      label: input.label ?? null,
      dsl,
      symbol: dsl.symbol,
      timeframe: dsl.timeframe,
      fromTs: from,
      toTs: to,
      riskPctPerTrade: String(input.riskPctPerTrade),
      costModel,
      status: 'running',
    })
    .returning();

  try {
    const candles = await getOhlcv(db, { symbol: dsl.symbol, timeframe: dsl.timeframe, since: from, until: to });
    if (candles.length < 250) {
      throw new Error(`Zu wenig echte Kerzen im Zeitraum (${candles.length}) für ${dsl.symbol}@${dsl.timeframe} — Backtest wäre nicht belastbar.`);
    }
    const result = runBacktest(candles, {
      evaluate: (cs, i) => {
        const setup = evaluateDslAt(cs, i, dsl);
        return setup ? [setup] : [];
      },
      initialEquity: 10_000,
      riskPctPerTrade: input.riskPctPerTrade,
      costModel,
      barsPerYear: BARS_PER_YEAR[dsl.timeframe]!,
      tpWeights: [0.5, 0.3, 0.2],
      setupType: dsl.setupType,
    });

    const equityCurve = downsample(result.equityCurve).map((p) => ({
      ts: p.ts.toISOString(),
      equity: Math.round(p.equity * 100) / 100,
    }));
    const trades = result.trades.slice(-200).map((t) => ({
      entryTs: t.entryTs.toISOString(),
      exitTs: t.exitTs.toISOString(),
      direction: t.direction,
      entry: t.entry,
      stopLoss: t.stopLoss,
      takeProfits: t.takeProfits,
      exitPrice: t.exitPrice,
      netPnl: Math.round(t.netPnl * 100) / 100,
      rMultiple: Math.round(t.rMultiple * 100) / 100,
      fees: Math.round(t.fees * 100) / 100,
      funding: Math.round(t.funding * 100) / 100,
      exitReason: t.exitReason,
      session: t.session,
    }));

    await db
      .update(workshopBacktests)
      .set({ candles: candles.length, metrics: result.metrics, equityCurve, trades, status: 'done', finishedAt: new Date() })
      .where(eq(workshopBacktests.id, row!.id));

    return {
      backtestId: row!.id,
      label: input.label ?? null,
      symbol: dsl.symbol,
      timeframe: dsl.timeframe,
      candles: candles.length,
      costModel,
      metrics: result.metrics,
      equityCurve,
      trades,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backtest fehlgeschlagen.';
    await db
      .update(workshopBacktests)
      .set({ status: 'error', error: message, finishedAt: new Date() })
      .where(eq(workshopBacktests.id, row!.id));
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
}

/** Entwurf als Version (draft) einer DSL-Strategie speichern — Paper erst über das Promotion-Gate. */
export async function saveWorkshopVersion(db: Db, userId: string, sessionId: string, ip: string | null) {
  const session = await ownedSession(db, userId, sessionId);
  const dsl = requireDraft(session);

  const [existing] = await db.select().from(strategies).where(eq(strategies.slug, dsl.id)).limit(1);
  let strategyId: string;
  if (existing) {
    if (existing.kind !== 'dsl') {
      throw new TRPCError({ code: 'CONFLICT', message: `Slug "${dsl.id}" gehört zu einer ${existing.kind}-Strategie — id im Entwurf ändern.` });
    }
    if (session.strategyId && session.strategyId !== existing.id) {
      throw new TRPCError({ code: 'CONFLICT', message: `Sitzung ist bereits mit einer anderen Strategie verknüpft — id im Entwurf zurückändern oder neue Sitzung nutzen.` });
    }
    strategyId = existing.id;
  } else {
    const [row] = await db
      .insert(strategies)
      .values({
        slug: dsl.id,
        name: `Workshop: ${session.name}`,
        kind: 'dsl',
        description: `Strategie-Workshop (${dsl.symbol}@${dsl.timeframe}, ${dsl.direction}).`,
        createdBy: userId,
      })
      .returning();
    strategyId = row!.id;
  }

  const versions = await db
    .select({ version: strategyVersions.version })
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId))
    .orderBy(desc(strategyVersions.version))
    .limit(1);
  const nextVersion = (versions[0]?.version ?? 0) + 1;

  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId, version: nextVersion, params: dsl, status: 'draft' })
    .returning();

  await db.update(workshopSessions).set({ strategyId, updatedAt: new Date() }).where(eq(workshopSessions.id, session.id));

  await db.insert(auditLog).values({
    actor: 'user',
    userId,
    action: 'workshop.version.saved',
    entityType: 'strategy_version',
    entityId: version!.id,
    details: { slug: dsl.id, version: nextVersion, sessionId: session.id, dsl },
    ip,
  });

  return { strategyId, versionId: version!.id, version: nextVersion, status: 'draft' as const };
}
