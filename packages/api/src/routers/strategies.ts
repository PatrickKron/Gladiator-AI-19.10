import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { DSL_SCHEMA_DOC, analyzePineScript, parseInstructionDsl, type InstructionDsl } from '@gladiator/strategy-engine';
import { evaluateBacktestValidity, readHoldout, DEFAULT_VALIDITY_THRESHOLDS, type ValidityVerdict } from '@gladiator/backtest';
import { CostGuard, envAnthropicProvider, guardedComplete } from '@gladiator/agents';
import { protectedProcedure, router } from '../trpc.js';

const { strategies, strategyVersions, backtests, auditLog } = schema;

/**
 * Validitäts-Prüfung einer Version (Vision 5): lädt den neuesten fertigen
 * Netto-Backtest dieser Version und bewertet ihn gegen das Gate. Kein Backtest
 * → hasBacktest:false. Reine Wahrheit aus der DB, kein Raten.
 */
type VersionValidity = {
  hasBacktest: boolean;
  verdict: ValidityVerdict | null;
  backtest:
    | { symbol: string; timeframe: string; createdAt: Date; tradeCount: number; profitFactor: number | null; maxDrawdownPct: number; expectancy: number | null; winRate: number | null }
    | null;
};

async function loadVersionValidity(db: Db, versionId: string): Promise<VersionValidity> {
  const [bt] = await db
    .select({
      symbol: backtests.symbol,
      timeframe: backtests.timeframe,
      createdAt: backtests.createdAt,
      sharpe: backtests.sharpe,
      maxDrawdown: backtests.maxDrawdown,
      winRate: backtests.winRate,
      profitFactor: backtests.profitFactor,
      expectancy: backtests.expectancy,
      netReturn: backtests.netReturn,
      tradeCount: backtests.tradeCount,
      metrics: backtests.metrics,
    })
    .from(backtests)
    .where(and(eq(backtests.strategyVersionId, versionId), eq(backtests.status, 'done')))
    .orderBy(desc(backtests.createdAt))
    .limit(1);

  if (!bt) return { hasBacktest: false, verdict: null, backtest: null };

  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  const metrics = {
    tradeCount: Number(bt.tradeCount),
    winRate: num(bt.winRate),
    profitFactor: num(bt.profitFactor),
    expectancy: num(bt.expectancy),
    maxDrawdownPct: Number(bt.maxDrawdown),
    sharpe: num(bt.sharpe),
    netReturnPct: num(bt.netReturn),
    holdout: readHoldout(bt.metrics),
  };
  const verdict = evaluateBacktestValidity(metrics);
  return {
    hasBacktest: true,
    verdict,
    backtest: {
      symbol: bt.symbol,
      timeframe: bt.timeframe,
      createdAt: bt.createdAt,
      tradeCount: metrics.tradeCount,
      profitFactor: metrics.profitFactor,
      maxDrawdownPct: metrics.maxDrawdownPct,
      expectancy: metrics.expectancy,
      winRate: metrics.winRate,
    },
  };
}

/**
 * Strategie-Verwaltung (07_): drei Wege, EIN kanonisches Signal-System.
 * - Pine: Registrierung liefert die strategyId für den TradingView-Alert.
 * - DSL: Anweisung → (optional LLM-)Entwurf → VORSCHAU → Patrick bestätigt
 *   per dslRegister. Das LLM schaltet NIE selbst scharf (07_ §3).
 */

const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

const DSL_SYSTEM_PROMPT = `Du übersetzt natürlichsprachige Trading-Anweisungen in die Gladiator-Strategie-DSL (JSON).
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt nach diesem Schema:
${DSL_SCHEMA_DOC}
Nutze NUR Felder aus dem Schema. Wenn die Anweisung etwas verlangt, das die DSL nicht ausdrücken kann,
lass es weg — erfinde keine neuen Felder.`;

export const strategiesRouter = router({
  /** Alle Strategien mit letzter Version (Registry-Übersicht). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: strategies.id,
        slug: strategies.slug,
        name: strategies.name,
        kind: strategies.kind,
        description: strategies.description,
        isActive: strategies.isActive,
        createdAt: strategies.createdAt,
      })
      .from(strategies)
      .orderBy(desc(strategies.createdAt));
    return rows;
  }),

  /** Versionen einer Strategie (Params + Status — Grundlage für Backtests & Promotion). */
  versions: protectedProcedure
    .input(z.object({ strategyId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
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
        .where(eq(strategyVersions.strategyId, input.strategyId))
        .orderBy(desc(strategyVersions.version));
    }),

  /**
   * Validität einer Version (Vision 5): besteht der neueste Netto-Backtest das
   * Gate? Read-only — Grundlage für Badge + gaten des Promote-Buttons.
   */
  validity: protectedProcedure
    .input(z.object({ versionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const v = await loadVersionValidity(ctx.db, input.versionId);
      return { ...v, thresholds: DEFAULT_VALIDITY_THRESHOLDS };
    }),

  /**
   * Promotion draft → paper (Mensch im Loop). GATE (Vision 5): NUR mit einem
   * bestandenen Netto-Backtest — eine ungetestete Strategie darf nicht in den
   * Paper-Auto-Loop. Live-Promotion ist hier BEWUSST nicht möglich (Regel 3/7).
   */
  promote: protectedProcedure
    .input(z.object({ versionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [version] = await ctx.db
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, input.versionId))
        .limit(1);
      if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: 'Version nicht gefunden.' });
      if (version.status !== 'draft') {
        throw new TRPCError({ code: 'CONFLICT', message: `Nur draft → paper möglich (Status ist ${version.status}).` });
      }

      // ── Validitäts-Gate: ohne bestandenen Backtest keine Promotion ──
      const validity = await loadVersionValidity(ctx.db, input.versionId);
      if (!validity.hasBacktest) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Kein Backtest — diese Version muss erst im Labor backtestet werden (netto, mind. ${DEFAULT_VALIDITY_THRESHOLDS.minTrades} Trades) bevor sie selbstständig laufen darf.`,
        });
      }
      if (!validity.verdict!.passed) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Backtest nicht valide: ${validity.verdict!.reasons.join(' · ')}`,
        });
      }

      const [updated] = await ctx.db
        .update(strategyVersions)
        .set({ status: 'paper', promotedBy: ctx.user.id, promotedAt: new Date() })
        .where(eq(strategyVersions.id, input.versionId))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.version.promoted',
        entityType: 'strategy_version',
        entityId: input.versionId,
        details: {
          from: 'draft',
          to: 'paper',
          version: version.version,
          gate: 'passed',
          backtest: validity.backtest,
        },
        ip: ctx.ip,
      });
      return updated!;
    }),

  /** Pine-Strategie registrieren → strategyId für den TradingView-Alert (07_ §1/§2). */
  pineRegister: protectedProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(3)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9-]*$/),
        name: z.string().min(3).max(120),
        description: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db.select().from(strategies).where(eq(strategies.slug, input.slug)).limit(1);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: `Slug "${input.slug}" existiert bereits.` });
      }
      const [row] = await ctx.db
        .insert(strategies)
        .values({
          slug: input.slug,
          name: input.name,
          kind: 'pine',
          description: input.description ?? null,
          createdBy: ctx.user.id,
        })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.pine.registered',
        entityType: 'strategy',
        entityId: row!.id,
        details: { slug: input.slug },
        ip: ctx.ip,
      });
      return {
        strategy: row!,
        webhookPath: '/api/webhook/pine',
        hint: 'strategyId in das Alert-JSON aufnehmen; Secret via PINE_WEBHOOK_SECRET (Body-Feld "secret" oder Header x-gladiator-signature).',
      };
    }),

  /**
   * Pine-Script-Analyse (07_ §5): Patrick fügt sein Pine-Script ein und bekommt
   * IMMER die regelbasierte Struktur-Analyse (Fakten aus dem Quelltext, kein
   * Raten). Ist ein Anthropic-Key hinterlegt, erklärt das LLM zusätzlich die
   * Logik, benennt Schwächen und schlägt Verbesserungen vor — sonst steht
   * ehrlich dabei, dass der KI-Teil einen Key braucht (kein Fehler, kein Fake).
   */
  pineAnalyze: protectedProcedure
    .input(z.object({ code: z.string().min(20).max(50_000) }))
    .mutation(async ({ ctx, input }) => {
      const structural = analyzePineScript(input.code);

      const llmProvider = envAnthropicProvider();
      if (!llmProvider.configured) {
        return {
          structural,
          llm: {
            used: false as const,
            analysis: null,
            hint: 'Kein ANTHROPIC_API_KEY hinterlegt — Struktur-Analyse läuft ohne KI. Key in Einstellungen → API-Schlüssel eintragen, dann erklärt und bewertet die KI dein Script zusätzlich.',
          },
        };
      }

      const completion = await guardedComplete(llmProvider, llmGuard, {
        system:
          'Du bist ein erfahrener Trading-Systems-Engineer und Pine-Script-Reviewer. Antworte auf Deutsch, präzise und ehrlich — keine erfundenen Kennzahlen, keine Performance-Versprechen.',
        prompt: `Analysiere dieses TradingView-Pine-Script:

\`\`\`pine
${input.code}
\`\`\`

Gliedere die Antwort exakt so:
1. **Logik in einfachen Worten** — was macht die Strategie, wann kauft/verkauft sie?
2. **Stärken** — was ist solide gelöst?
3. **Schwächen & Risiken** — Repainting, fehlendes Risk-Management, Overfitting-Gefahr, Session-/Regime-Blindheit. Nur belegbare Punkte aus dem Code.
4. **Konkrete Verbesserungen** — priorisiert, jeweils mit kurzer Begründung.
5. **Abbildbarkeit in Gladiator** — welcher Kern der Logik ließe sich in die Anweisungs-DSL übersetzen (verfügbar: BOS/CHoCH-Signal, RSI-Schwellen, EMA200-Trendfilter, Session-Fenster, Entry market/retest@EMA, ATR- oder %-Stop, RR-basierte Take-Profits)? Was geht verloren?`,
        maxTokens: 3000,
      });

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.pine.analyzed',
        entityType: 'strategy',
        details: { title: structural.title, lineCount: structural.lineCount, costUsd: completion.costUsd },
        ip: ctx.ip,
      });

      return {
        structural,
        llm: { used: true as const, analysis: completion.text, hint: null },
      };
    }),

  /**
   * Pine-Script-Verbesserung (07_ §5): KI schlägt eine überarbeitete Fassung
   * vor — als ENTWURF zum Kopieren nach TradingView. Es wird nichts registriert
   * oder ausgeführt; Mensch im Loop bleibt Pflicht. Ohne Key: ehrliche Absage.
   */
  pineImprove: protectedProcedure
    .input(
      z.object({
        code: z.string().min(20).max(50_000),
        goal: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const llmProvider = envAnthropicProvider();
      if (!llmProvider.configured) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Kein ANTHROPIC_API_KEY hinterlegt — die KI-Verbesserung braucht ihn. In Einstellungen → API-Schlüssel eintragen; die Struktur-Analyse funktioniert auch ohne.',
        });
      }

      const completion = await guardedComplete(llmProvider, llmGuard, {
        system:
          'Du bist ein erfahrener Pine-Script-Entwickler (v5/v6). Antworte auf Deutsch. Du verbesserst Scripts konservativ: Risk-Management zuerst, keine Zauber-Parameter, keine erfundenen Kennzahlen. Repainting-Quellen werden entfernt oder explizit dokumentiert.',
        prompt: `Verbessere dieses Pine-Script${input.goal ? ` mit folgendem Ziel: ${input.goal}` : ''}:

\`\`\`pine
${input.code}
\`\`\`

Antworte exakt in dieser Form:
1. Zuerst das vollständige verbesserte Script in EINEM \`\`\`pine-Codeblock (lauffähig, v5 oder höher).
2. Danach unter der Überschrift "Änderungen" eine nummerierte Liste: was geändert wurde und warum (kurz, ehrlich — auch was du bewusst NICHT geändert hast).`,
        maxTokens: 4000,
      });

      const codeMatch = completion.text.match(/```(?:pine(?:script)?)?\s*\n([\s\S]*?)```/);
      const improved = codeMatch?.[1]?.trim() ?? null;
      if (!improved) {
        throw new TRPCError({
          code: 'UNPROCESSABLE_CONTENT',
          message: 'KI-Antwort enthielt keinen Pine-Codeblock — bitte erneut versuchen oder Ziel präzisieren.',
        });
      }
      const notes = completion.text.slice((codeMatch!.index ?? 0) + codeMatch![0]!.length).trim();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.pine.improved',
        entityType: 'strategy',
        details: { goal: input.goal ?? null, inputLines: input.code.split('\n').length, costUsd: completion.costUsd },
        ip: ctx.ip,
      });

      return { improved, notes, costUsd: completion.costUsd };
    }),

  /**
   * DSL-Vorschau: Text (LLM-Übersetzung) ODER direktes DSL-JSON.
   * Ergebnis ist NUR ein Entwurf — registriert wird erst über dslRegister.
   */
  dslPreview: protectedProcedure
    .input(
      z
        .object({
          text: z.string().min(10).max(2000).optional(),
          dsl: z.unknown().optional(),
        })
        .refine((i) => i.text !== undefined || i.dsl !== undefined, { message: 'text oder dsl angeben.' }),
    )
    .mutation(async ({ ctx, input }) => {
      let candidate: unknown = input.dsl;
      let llmUsed = false;

      if (candidate === undefined && input.text !== undefined) {
        const llmProvider = envAnthropicProvider();
        if (!llmProvider.configured) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt) — Anweisung kann nicht übersetzt werden. Alternative: DSL direkt als JSON einreichen.',
          });
        }
        const completion = await guardedComplete(llmProvider, llmGuard, {
          system: DSL_SYSTEM_PROMPT,
          prompt: input.text,
          maxTokens: 2048,
        });
        const match = completion.text.match(/\{[\s\S]*\}/);
        if (!match) {
          throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: 'LLM-Antwort enthielt kein JSON — bitte Anweisung präzisieren.' });
        }
        try {
          candidate = JSON.parse(match[0]);
        } catch {
          throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: 'LLM-JSON nicht parsebar — bitte erneut versuchen.' });
        }
        llmUsed = true;
        await ctx.db.insert(auditLog).values({
          actor: 'user',
          userId: ctx.user.id,
          action: 'strategy.dsl.llm_draft',
          entityType: 'strategy',
          details: { text: input.text, costUsd: completion.costUsd },
          ip: ctx.ip,
        });
      }

      const parsed = parseInstructionDsl(candidate);
      if (!parsed.ok) {
        return { ok: false as const, llmUsed, draft: candidate, errors: parsed.errors };
      }
      return { ok: true as const, llmUsed, dsl: parsed.dsl, errors: [] as string[] };
    }),

  /** DSL registrieren (Patricks Bestätigung — Mensch im Loop). Paper-Status, nie live. */
  dslRegister: protectedProcedure
    .input(z.object({ dsl: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const parsed = parseInstructionDsl(input.dsl);
      if (!parsed.ok) {
        throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: `DSL ungültig: ${parsed.errors.join('; ')}` });
      }
      const dsl: InstructionDsl = parsed.dsl;

      // Bestehende DSL-Strategie mit gleichem Slug → neue Version; sonst neu anlegen.
      const [existing] = await ctx.db.select().from(strategies).where(eq(strategies.slug, dsl.id)).limit(1);
      let strategyId: string;
      if (existing) {
        if (existing.kind !== 'dsl') {
          throw new TRPCError({ code: 'CONFLICT', message: `Slug "${dsl.id}" gehört zu einer ${existing.kind}-Strategie.` });
        }
        strategyId = existing.id;
      } else {
        const [row] = await ctx.db
          .insert(strategies)
          .values({
            slug: dsl.id,
            name: `DSL: ${dsl.id}`,
            kind: 'dsl',
            description: `Anweisungs-Strategie (${dsl.symbol}@${dsl.timeframe}, ${dsl.direction}).`,
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
        .values({
          strategyId,
          version: nextVersion,
          params: dsl,
          status: 'paper', // Paper-Default (Regel 3); Live-Promotion ist ein separater Schritt.
          promotedBy: ctx.user.id,
          promotedAt: new Date(),
        })
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'strategy.dsl.registered',
        entityType: 'strategy',
        entityId: strategyId,
        details: { slug: dsl.id, version: nextVersion, dsl },
        ip: ctx.ip,
      });

      return { strategyId, versionId: version!.id, version: nextVersion, status: 'paper' as const };
    }),
});
