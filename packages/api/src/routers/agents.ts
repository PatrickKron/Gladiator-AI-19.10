import { sql } from 'drizzle-orm';
import { derivativesFresh, getMacroSnapshot } from '@gladiator/market-data';
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

    // Echte Datenlage prüfen (Phase-1-Rest): Makro-Serien + Derivate-Frische.
    const macro = await getMacroSnapshot(ctx.db);
    const macroConnected = macro.fresh && macro.grs !== null;
    const derivConnected = await derivativesFresh(ctx.db);

    const active: { agent: string; deterministic: boolean }[] = [
      { agent: 'technik', deterministic: true },
      { agent: 'risk', deterministic: true },
      { agent: 'devil', deterministic: true },
      { agent: 'portfolio', deterministic: true },
    ];
    const disabled: { agent: string; reason: string }[] = [];

    if (llmConfigured && macroConnected) active.push({ agent: 'makro', deterministic: false });
    else {
      disabled.push({
        agent: 'makro',
        reason: !llmConfigured
          ? `kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt)${macroConnected ? ' — Makro-Daten (VIX/DXY/US10Y) sind bereits verbunden' : ''}`
          : 'Makro-Serien (VIX/DXY/US10Y) noch nicht synchronisiert — läuft mit dem nächsten macro-sync',
      });
    }
    if (llmConfigured && derivConnected) active.push({ agent: 'shadow', deterministic: false });
    else {
      disabled.push({
        agent: 'shadow',
        reason: !llmConfigured
          ? `kein LLM-Provider konfiguriert (ANTHROPIC_API_KEY fehlt)${derivConnected ? ' — Funding/OI-Daten sind bereits verbunden' : ''}`
          : 'Funding/OI-Daten noch nicht synchronisiert — läuft mit dem nächsten derivatives-sync',
      });
    }

    return {
      active,
      disabled,
      data: { macroConnected, derivativesConnected: derivConnected },
      llm: {
        configured: llmConfigured,
        provider: llmConfigured ? 'anthropic (claude-opus-4-8)' : null,
        dailyBudgetUsd,
      },
      stats: stats.rows as { agent: string; vote: 'confirm' | 'reject' | 'caution'; n: number; avg_confidence: number }[],
    };
  }),
});
