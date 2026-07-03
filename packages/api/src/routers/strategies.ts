import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { parseInstructionDsl, type InstructionDsl } from '@gladiator/strategy-engine';
import { AnthropicProvider, CostGuard, guardedComplete } from '@gladiator/agents';
import { protectedProcedure, router } from '../trpc.js';

const { strategies, strategyVersions, auditLog } = schema;

/**
 * Strategie-Verwaltung (07_): drei Wege, EIN kanonisches Signal-System.
 * - Pine: Registrierung liefert die strategyId für den TradingView-Alert.
 * - DSL: Anweisung → (optional LLM-)Entwurf → VORSCHAU → Patrick bestätigt
 *   per dslRegister. Das LLM schaltet NIE selbst scharf (07_ §3).
 */

const llmProvider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
const llmGuard = new CostGuard({ dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) });

const DSL_SYSTEM_PROMPT = `Du übersetzt natürlichsprachige Trading-Anweisungen in die Gladiator-Strategie-DSL (JSON).
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt nach diesem Schema:
{
  "id": "kebab-case-slug",
  "symbol": "BTC/USDT",
  "timeframe": "15m"|"1h"|"4h"|"1d",
  "venueType": "cex"|"dex",
  "direction": "long"|"short",
  "setupType": "scalp"|"swing"|"position",
  "when": { "session": "asia"|"london"|"overlap"|"newyork"|"off" (optional), "all": [ {"signal":"BOS"|"CHoCH"} | {"indicator":"RSI","lt":n,"gt":n} | {"trend":"EMA200_up"|"EMA200_down"} ] },
  "entry": "market" | "retest@EMA<n>",
  "stopLoss": {"type":"ATR","mult":n} | {"type":"pct","pct":n},
  "takeProfits": [{"rr":n}, ...],
  "risk": {"maxLeveragePerTrade":n,"riskPctPerTrade":n}
}
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
