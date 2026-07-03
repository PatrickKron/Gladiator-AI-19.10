import { sql } from 'drizzle-orm';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Agenten-Übersicht (Phase 5/6): Welche Agenten laufen, welche sind ehrlich
 * deaktiviert (und warum), plus echte Urteils-Statistik aus signal_reviews.
 */
export const agentsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const llmConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
    const dailyBudgetUsd = Number(process.env.LLM_DAILY_BUDGET_USD ?? 5);

    // Echte Urteils-Statistik: je Agent Anzahl je Vote + Ø-Konfidenz (letzte 500 Reviews).
    const stats = await ctx.db.execute(sql`
      SELECT agent, vote, count(*)::int AS n, avg(confidence::float)::float AS avg_confidence
      FROM (
        SELECT agent, vote, confidence FROM signal_reviews ORDER BY created_at DESC LIMIT 500
      ) recent
      GROUP BY agent, vote
      ORDER BY agent, vote
    `);

    return {
      active: [
        { agent: 'technik', deterministic: true },
        { agent: 'risk', deterministic: true },
        { agent: 'devil', deterministic: true },
        { agent: 'portfolio', deterministic: true },
      ],
      disabled: [
        {
          agent: 'makro',
          reason: llmConfigured
            ? 'Makro-Datenquellen (FRED/Wirtschaftskalender/VIX-DXY) nicht verbunden (Phase-1-Rest)'
            : 'kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt)',
        },
        {
          agent: 'shadow',
          reason: llmConfigured
            ? 'Funding-/OI-/On-Chain-Daten nicht verbunden (Phase-1-Rest)'
            : 'kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt)',
        },
      ],
      llm: {
        configured: llmConfigured,
        provider: llmConfigured ? 'anthropic (claude-opus-4-8)' : null,
        dailyBudgetUsd,
      },
      stats: stats.rows as { agent: string; vote: 'confirm' | 'reject' | 'caution'; n: number; avg_confidence: number }[],
    };
  }),
});
