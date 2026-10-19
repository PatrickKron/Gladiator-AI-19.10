import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { CostGuard, envAnthropicProvider } from '@gladiator/agents';
import { parseInstructionDsl, evaluateDslAt, type InstructionDsl } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type CostModel } from '@gladiator/backtest';
import { getOhlcv, BARS_PER_YEAR, SUPPORTED_TIMEFRAMES } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';
import { analyzePine, runChatTurn } from '../workshop/llm.js';

const { workshopSessions, workshopMessages, workshopBacktests, strategies, strategyVersions, auditLog } = schema;

/**
 * Strategie-Workshop (Session 2): Pine-Script → KI-Analyse → interaktiver
 * Dialog → Agent-Konfiguration (Instruction-DSL) → Draft-Backtests →
 * Version (draft) → Paper-Deploy über das BESTEHENDE Promotion-Gate.
 *
 * Draft-Backtests laufen inline gegen echte Kerzen und landen in
 * workshop_backtests (Parameter-Set-Vergleich) — NICHT in den VDB-Tabellen.
 * Der offizielle Weg zu Paper bleibt: saveVersion → lab.runBacktest
 * (persistiert an der Version) → strategies.promote (Validitäts-Gate).
 * Das LLM schaltet NIE scharf: jeder Vorschlag wird erst nach Zod-Validierung
 * UND expliziter Übernahme (applyProposal/updateDraft) zum Entwurf.
 */

const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

const timeframeSchema = z.enum(SUPPORTED_TIMEFRAMES);

const costSchema = z.object({
  takerFeeRate: z.number().min(0).max(0.01),
  makerFeeRate: z.number().min(0).max(0.01),
  slippageBps: z.number().min(0).max(100),
  fundingRatePer8h: z.number().min(-0.01).max(0.01),
});

/** Equity-Kurve fürs UI auf max. N Punkte eindampfen (wie Labor). */
function downsample<T>(points: T[], maxPoints = 400): T[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

async function ownedSession(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(workshopSessions)
    .where(and(eq(workshopSessions.id, id), eq(workshopSessions.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workshop-Sitzung nicht gefunden.' });
  return row;
}

function requireLlm() {
  const provider = envAnthropicProvider();
  if (!provider.configured) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt) — in Profil → API-Keys hinterlegen.',
    });
  }
  return provider;
}

/** Entwurf einer Sitzung als validierte DSL — oder ehrlicher Fehler. */
function requireDraft(session: { draftDsl: unknown }): InstructionDsl {
  if (!session.draftDsl) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Konfigurations-Entwurf vorhanden — erst Analyse/Dialog nutzen oder Konfiguration anlegen.' });
  }
  const parsed = parseInstructionDsl(session.draftDsl);
  if (!parsed.ok) {
    throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: `Entwurf ungültig: ${parsed.errors.join('; ')}` });
  }
  return parsed.dsl;
}

export const workshopRouter = router({
  /** Alle Workshop-Sitzungen des Nutzers (neueste zuerst). */
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: workshopSessions.id,
        name: workshopSessions.name,
        strategyId: workshopSessions.strategyId,
        pineSource: workshopSessions.pineSource,
        draftDsl: workshopSessions.draftDsl,
        createdAt: workshopSessions.createdAt,
        updatedAt: workshopSessions.updatedAt,
      })
      .from(workshopSessions)
      .where(eq(workshopSessions.userId, ctx.user.id))
      .orderBy(desc(workshopSessions.updatedAt));
  }),

  /** Eine Sitzung inkl. Dialog-Verlauf. */
  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    const messages = await ctx.db
      .select()
      .from(workshopMessages)
      .where(eq(workshopMessages.sessionId, session.id))
      .orderBy(asc(workshopMessages.createdAt));
    return { session, messages };
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(3).max(120), pineSource: z.string().max(100_000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(workshopSessions)
        .values({ userId: ctx.user.id, name: input.name, pineSource: input.pineSource ?? null })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'workshop.session.created',
        entityType: 'workshop_session',
        entityId: row!.id,
        details: { name: input.name, hasPine: Boolean(input.pineSource) },
        ip: ctx.ip,
      });
      return row!;
    }),

  /** Stammdaten pflegen (Name, Pine-Quelle, textuelle Anweisungen). */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(3).max(120).optional(),
        pineSource: z.string().max(100_000).nullish(),
        instructions: z.string().max(20_000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const [row] = await ctx.db
        .update(workshopSessions)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.pineSource !== undefined ? { pineSource: input.pineSource } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workshopSessions.id, session.id))
        .returning();
      return row!;
    }),

  remove: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    await ctx.db.delete(workshopSessions).where(eq(workshopSessions.id, session.id));
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'workshop.session.removed',
      entityType: 'workshop_session',
      entityId: session.id,
      details: { name: session.name },
      ip: ctx.ip,
    });
    return { removed: true };
  }),

  /**
   * Pine-Analyse (LLM): erkennt Indikatoren, Entry/Exit, Strategie-Typ,
   * Parameter — plus optionale erste DSL-Skizze. Ergebnis wird gespeichert;
   * ein valider dslDraft wird NUR übernommen, wenn noch kein Entwurf existiert.
   */
  analyze: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    if (!session.pineSource || session.pineSource.trim().length < 10) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Kein Pine-Script in der Sitzung — erst einfügen.' });
    }
    const provider = requireLlm();
    const result = await analyzePine(provider, llmGuard, session.pineSource);
    if (!result.ok) {
      // Ehrlich zurückgeben (kein Throw): UI zeigt die Fehler, Nutzer kann erneut analysieren.
      return { ok: false as const, errors: result.errors, raw: result.raw, costUsd: result.costUsd ?? null };
    }
    const takeDraft = result.dslDraft !== null && !session.draftDsl;
    await ctx.db
      .update(workshopSessions)
      .set({
        analysis: result.analysis,
        ...(takeDraft ? { draftDsl: result.dslDraft } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workshopSessions.id, session.id));
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'workshop.pine.analyzed',
      entityType: 'workshop_session',
      entityId: session.id,
      details: { strategyType: result.analysis.strategyType, draftTaken: takeDraft, costUsd: result.costUsd },
      ip: ctx.ip,
    });
    return {
      ok: true as const,
      analysis: result.analysis,
      dslDraft: result.dslDraft,
      dslErrors: result.dslErrors,
      draftTaken: takeDraft,
      costUsd: result.costUsd ?? null,
    };
  }),

  /**
   * Ein Dialog-Turn: Nutzer-Nachricht wird gespeichert, der Coach antwortet
   * mit Text + optionalem validierten DSL-Vorschlag (Übernahme erst per
   * applyProposal — Mensch im Loop).
   */
  chat: protectedProcedure
    .input(z.object({ id: z.string().uuid(), message: z.string().min(1).max(8000) }))
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const provider = requireLlm();

      const history = await ctx.db
        .select({ role: workshopMessages.role, content: workshopMessages.content })
        .from(workshopMessages)
        .where(eq(workshopMessages.sessionId, session.id))
        .orderBy(asc(workshopMessages.createdAt));

      await ctx.db.insert(workshopMessages).values({ sessionId: session.id, role: 'user', content: input.message });

      let reply;
      try {
        reply = await runChatTurn(provider, llmGuard, {
          pineSource: session.pineSource,
          analysis: session.analysis,
          draftDsl: session.draftDsl,
          instructions: session.instructions,
          history,
          userMessage: input.message,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'LLM-Dialog fehlgeschlagen.',
        });
      }

      const [assistantMsg] = await ctx.db
        .insert(workshopMessages)
        .values({
          sessionId: session.id,
          role: 'assistant',
          content: reply.content,
          proposedDsl: reply.proposedDsl,
          costUsd: String(reply.costUsd),
        })
        .returning();
      await ctx.db.update(workshopSessions).set({ updatedAt: new Date() }).where(eq(workshopSessions.id, session.id));

      return {
        messageId: assistantMsg!.id,
        content: reply.content,
        proposedDsl: reply.proposedDsl,
        dslErrors: reply.dslErrors,
        costUsd: reply.costUsd,
      };
    }),

  /** Vorschlag aus einer Coach-Nachricht als Entwurf übernehmen (explizit, Mensch im Loop). */
  applyProposal: protectedProcedure
    .input(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const [msg] = await ctx.db
        .select()
        .from(workshopMessages)
        .where(and(eq(workshopMessages.id, input.messageId), eq(workshopMessages.sessionId, session.id)))
        .limit(1);
      if (!msg?.proposedDsl) throw new TRPCError({ code: 'NOT_FOUND', message: 'Kein Vorschlag in dieser Nachricht.' });
      const parsed = parseInstructionDsl(msg.proposedDsl);
      if (!parsed.ok) throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: `Vorschlag ungültig: ${parsed.errors.join('; ')}` });
      await ctx.db
        .update(workshopSessions)
        .set({ draftDsl: parsed.dsl, updatedAt: new Date() })
        .where(eq(workshopSessions.id, session.id));
      return { dsl: parsed.dsl };
    }),

  /** Entwurf direkt bearbeiten (alle Felder im Frontend editierbar) — validiert. */
  updateDraft: protectedProcedure
    .input(z.object({ id: z.string().uuid(), dsl: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const parsed = parseInstructionDsl(input.dsl);
      if (!parsed.ok) {
        return { ok: false as const, errors: parsed.errors };
      }
      await ctx.db
        .update(workshopSessions)
        .set({ draftDsl: parsed.dsl, updatedAt: new Date() })
        .where(eq(workshopSessions.id, session.id));
      return { ok: true as const, dsl: parsed.dsl, errors: [] as string[] };
    }),

  /**
   * Draft-Backtest: aktueller Entwurf gegen ECHTE Kerzen, netto (Kostenmodell
   * Pflicht). Asset/Timeframe pro Lauf übersteuerbar — Grundlage für den
   * Parameter-Set-Vergleich. Persistiert in workshop_backtests.
   */
  runBacktest: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().max(120).optional(),
        symbol: z.string().min(3).optional(),
        timeframe: timeframeSchema.optional(),
        from: z.string().datetime(),
        to: z.string().datetime(),
        riskPctPerTrade: z.number().min(0.1).max(5).default(1),
        costModel: costSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const base = requireDraft(session);
      const dsl: InstructionDsl = {
        ...base,
        ...(input.symbol ? { symbol: input.symbol } : {}),
        ...(input.timeframe ? { timeframe: input.timeframe } : {}),
      };
      const from = new Date(input.from);
      const to = new Date(input.to);
      if (!(from < to)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Zeitraum ungültig (from < to nötig).' });
      const costModel: CostModel = input.costModel ?? DEFAULT_COSTS;

      const [row] = await ctx.db
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
        const candles = await getOhlcv(ctx.db, { symbol: dsl.symbol, timeframe: dsl.timeframe, since: from, until: to });
        if (candles.length < 250) {
          throw new Error(
            `Zu wenig echte Kerzen im Zeitraum (${candles.length}) für ${dsl.symbol}@${dsl.timeframe} — Backtest wäre nicht belastbar.`,
          );
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

        await ctx.db
          .update(workshopBacktests)
          .set({
            candles: candles.length,
            metrics: result.metrics,
            equityCurve,
            trades,
            status: 'done',
            finishedAt: new Date(),
          })
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
        await ctx.db
          .update(workshopBacktests)
          .set({ status: 'error', error: message, finishedAt: new Date() })
          .where(eq(workshopBacktests.id, row!.id));
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
    }),

  /** Alle Draft-Backtests der Sitzung (Parameter-Set-Vergleich, neueste zuerst). */
  backtests: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    return ctx.db
      .select({
        id: workshopBacktests.id,
        label: workshopBacktests.label,
        dsl: workshopBacktests.dsl,
        symbol: workshopBacktests.symbol,
        timeframe: workshopBacktests.timeframe,
        fromTs: workshopBacktests.fromTs,
        toTs: workshopBacktests.toTs,
        riskPctPerTrade: workshopBacktests.riskPctPerTrade,
        candles: workshopBacktests.candles,
        metrics: workshopBacktests.metrics,
        equityCurve: workshopBacktests.equityCurve,
        status: workshopBacktests.status,
        error: workshopBacktests.error,
        createdAt: workshopBacktests.createdAt,
      })
      .from(workshopBacktests)
      .where(eq(workshopBacktests.sessionId, session.id))
      .orderBy(desc(workshopBacktests.createdAt));
  }),

  /** Trades eines Draft-Backtests (Detailansicht). */
  backtestTrades: protectedProcedure
    .input(z.object({ id: z.string().uuid(), backtestId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      const [row] = await ctx.db
        .select({ trades: workshopBacktests.trades })
        .from(workshopBacktests)
        .where(and(eq(workshopBacktests.id, input.backtestId), eq(workshopBacktests.sessionId, session.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Backtest nicht gefunden.' });
      return row.trades ?? [];
    }),

  /**
   * Entwurf als Strategie-Version speichern: strategies (kind 'dsl', Slug =
   * dsl.id) + strategy_versions status 'draft'. Paper wird sie erst über das
   * BESTEHENDE Gate: lab.runBacktest (an der Version) → strategies.promote.
   */
  saveVersion: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    const dsl = requireDraft(session);

    const [existing] = await ctx.db.select().from(strategies).where(eq(strategies.slug, dsl.id)).limit(1);
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
      const [row] = await ctx.db
        .insert(strategies)
        .values({
          slug: dsl.id,
          name: `Workshop: ${session.name}`,
          kind: 'dsl',
          description: `Strategie-Workshop (${dsl.symbol}@${dsl.timeframe}, ${dsl.direction}).`,
          createdBy: ctx.user.id,
        })
        .returning();
      strategyId = row!.id;
    }

    const versions = await ctx.db
      .select({ version: strategyVersions.version })
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(desc(strategyVersions.version))
      .limit(1);
    const nextVersion = (versions[0]?.version ?? 0) + 1;

    const [version] = await ctx.db
      .insert(strategyVersions)
      .values({ strategyId, version: nextVersion, params: dsl, status: 'draft' })
      .returning();

    await ctx.db
      .update(workshopSessions)
      .set({ strategyId, updatedAt: new Date() })
      .where(eq(workshopSessions.id, session.id));

    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'workshop.version.saved',
      entityType: 'strategy_version',
      entityId: version!.id,
      details: { slug: dsl.id, version: nextVersion, sessionId: session.id, dsl },
      ip: ctx.ip,
    });

    return { strategyId, versionId: version!.id, version: nextVersion, status: 'draft' as const };
  }),

  /** Versionshistorie der verknüpften Strategie. */
  versions: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const session = await ownedSession(ctx.db, ctx.user.id, input.id);
    if (!session.strategyId) return [];
    return ctx.db
      .select({
        id: strategyVersions.id,
        version: strategyVersions.version,
        status: strategyVersions.status,
        params: strategyVersions.params,
        promotedAt: strategyVersions.promotedAt,
        createdAt: strategyVersions.createdAt,
      })
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, session.strategyId))
      .orderBy(desc(strategyVersions.version));
  }),

  /** Frühere Version in den Entwurf zurückholen (Versionshistorie → zurück). */
  restoreVersion: protectedProcedure
    .input(z.object({ id: z.string().uuid(), versionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const session = await ownedSession(ctx.db, ctx.user.id, input.id);
      if (!session.strategyId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Sitzung hat keine gespeicherte Strategie.' });
      const [version] = await ctx.db
        .select()
        .from(strategyVersions)
        .where(and(eq(strategyVersions.id, input.versionId), eq(strategyVersions.strategyId, session.strategyId)))
        .limit(1);
      if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: 'Version nicht gefunden.' });
      const parsed = parseInstructionDsl(version.params);
      if (!parsed.ok) throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: `Version-Parameter ungültig: ${parsed.errors.join('; ')}` });
      await ctx.db
        .update(workshopSessions)
        .set({ draftDsl: parsed.dsl, updatedAt: new Date() })
        .where(eq(workshopSessions.id, session.id));
      return { dsl: parsed.dsl, version: version.version };
    }),
});
