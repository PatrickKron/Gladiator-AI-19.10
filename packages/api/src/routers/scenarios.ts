import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  evaluateScenarioPlaybook,
  executeScenarioPlaybook,
  type ScenarioEvaluationReport,
} from '@gladiator/jobs';
import {
  parseScenarioFromText,
  scenarioPlaybookSpecSchema,
  SCENARIO_TEMPLATES,
} from '@gladiator/strategy-engine';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog, exchangeConnections, scenarioPlaybooks, scenarioRuns } = schema;

/**
 * Szenario-Playbooks / Wenn-Dann-Wetten (Welle 24):
 * - Freitext → strukturiertes Szenario (Trigger + BOS/CHoCH-Bestätigung + Aktionen)
 * - CRUD + Scharfstellen (`armed`) / Pausieren (`paused`)
 * - Live-Dry-Run (`evaluate`) gegen echte DB-News, VIX/GRS & geschlossene Kerzen
 * - Sofort-Auslöser (`triggerNow`) im sicheren Paper-/Signal- oder Demo-Auto-Modus
 */
export const scenariosRouter = router({
  /** Kuratierte Schnell-Vorlagen (Pandemie, Bankenkrise, ETF-Long, CPI-Schock). */
  templates: protectedProcedure.query(() => SCENARIO_TEMPLATES),

  /** Parst freien Text deterministisch in Trigger + Bestätigung + Aktionen + Machbarkeit. */
  parseText: protectedProcedure
    .input(z.object({ text: z.string().trim().min(5).max(2000) }))
    .mutation(({ input }) => parseScenarioFromText(input.text)),

  /** Alle Playbooks des Users + letzte Läufe + echte verbundene Börsen/Wallets für die Auswahl. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const [playbooks, runs, connections] = await Promise.all([
      ctx.db
        .select()
        .from(scenarioPlaybooks)
        .where(eq(scenarioPlaybooks.userId, ctx.user.id))
        .orderBy(desc(scenarioPlaybooks.updatedAt))
        .limit(50),
      ctx.db
        .select()
        .from(scenarioRuns)
        .where(eq(scenarioRuns.userId, ctx.user.id))
        .orderBy(desc(scenarioRuns.createdAt))
        .limit(40),
      ctx.db
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
            eq(exchangeConnections.userId, ctx.user.id),
            eq(exchangeConnections.status, 'active'),
            isNull(exchangeConnections.revokedAt),
          ),
        ),
    ]);

    return {
      playbooks,
      runs,
      connections,
    };
  }),

  /** Neues Szenario-Playbook anlegen (Standard-Status: 'draft' oder direkt 'armed'). */
  create: protectedProcedure
    .input(
      scenarioPlaybookSpecSchema.extend({
        armImmediately: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const status = input.armImmediately ? 'armed' : 'draft';
      const [created] = await ctx.db
        .insert(scenarioPlaybooks)
        .values({
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          rawText: input.rawText ?? null,
          status,
          executionMode: input.executionMode,
          trigger: input.trigger,
          confirmation: input.confirmation,
          actions: input.actions,
        })
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'scenario.create',
        entityType: 'scenario_playbook',
        entityId: created!.id,
        details: { name: input.name, status, executionMode: input.executionMode },
      });

      return created!;
    }),

  /** Status umschalten: 'armed' (scharf überwacht), 'paused', 'draft'. */
  setStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(['draft', 'armed', 'paused']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(scenarioPlaybooks)
        .set({ status: input.status, updatedAt: new Date() })
        .where(and(eq(scenarioPlaybooks.id, input.id), eq(scenarioPlaybooks.userId, ctx.user.id)))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Szenario nicht gefunden.' });

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'scenario.status',
        entityType: 'scenario_playbook',
        entityId: updated.id,
        details: { status: input.status },
      });

      return updated;
    }),

  /** Ausführungsmodus wechseln ('signal_only' vs. 'demo_auto'). */
  setExecutionMode: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        executionMode: z.enum(['signal_only', 'demo_auto']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(scenarioPlaybooks)
        .set({ executionMode: input.executionMode, updatedAt: new Date() })
        .where(and(eq(scenarioPlaybooks.id, input.id), eq(scenarioPlaybooks.userId, ctx.user.id)))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Szenario nicht gefunden.' });
      return updated;
    }),

  /** Playbook löschen (nur eigene). */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(scenarioPlaybooks)
        .where(and(eq(scenarioPlaybooks.id, input.id), eq(scenarioPlaybooks.userId, ctx.user.id)))
        .returning({ id: scenarioPlaybooks.id });
      if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Szenario nicht gefunden.' });
      return { ok: true };
    }),

  /**
   * Live-Dry-Run: prüft ein Playbook JETZT gegen echte DB-News, VIX/GRS und echte
   * abgeschlossene Kerzen (BOS/CHoCH), OHNE Orders auszulösen.
   */
  evaluate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<ScenarioEvaluationReport> => {
      const [pb] = await ctx.db
        .select()
        .from(scenarioPlaybooks)
        .where(and(eq(scenarioPlaybooks.id, input.id), eq(scenarioPlaybooks.userId, ctx.user.id)))
        .limit(1);
      if (!pb) throw new TRPCError({ code: 'NOT_FOUND', message: 'Szenario nicht gefunden.' });

      const report = await evaluateScenarioPlaybook(ctx.db, pb);
      await ctx.db
        .update(scenarioPlaybooks)
        .set({
          lastCheckedAt: new Date(report.checkedAt),
          lastEvaluation: report as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(scenarioPlaybooks.id, pb.id));

      await ctx.db.insert(scenarioRuns).values({
        playbookId: pb.id,
        userId: ctx.user.id,
        kind: 'check',
        matched: report.matched,
        summary: report.summary,
        evidence: report as unknown as Record<string, unknown>,
      });

      return report;
    }),

  /**
   * Manueller Sofort-Auslöser („Szenario ist eingetreten!“):
   * Führt das Playbook im konfigurierten Modus (`signal_only` oder `demo_auto`) aus —
   * niemals blinde Live-Orders, niemals Auszahlungen/Transfers.
   */
  triggerNow: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [pb] = await ctx.db
        .select()
        .from(scenarioPlaybooks)
        .where(and(eq(scenarioPlaybooks.id, input.id), eq(scenarioPlaybooks.userId, ctx.user.id)))
        .limit(1);
      if (!pb) throw new TRPCError({ code: 'NOT_FOUND', message: 'Szenario nicht gefunden.' });

      return executeScenarioPlaybook(ctx.db, pb, { manual: true });
    }),
});
