import { sql } from 'drizzle-orm';
import { protectedProcedure, router } from '../trpc.js';

const startedAt = Date.now();

/**
 * Ehrlicher Systemstatus: echte DB-Zählungen, echte Uptime, echter Quellen-Status.
 * Nicht verbundene Quellen werden als solche gemeldet — nie erfunden (eiserne Regel 1).
 */
export const systemRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const counts = await ctx.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM packages) AS packages,
        (SELECT count(*)::int FROM assets) AS assets,
        (SELECT count(*)::int FROM magazine_articles) AS articles,
        (SELECT count(*)::int FROM ohlcv) AS ohlcv_rows,
        (SELECT count(*)::int FROM signals) AS signals
    `);

    return {
      db: 'up' as const,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      counts: counts.rows[0] as Record<string, number>,
      priceFeed: ctx.prices ? ctx.prices.snapshot().status : null,
      /** Quellen-Wahrheit: was ist angebunden, was (noch) nicht. */
      sources: {
        binance_ws: ctx.prices ? 'verbunden' : 'nicht verbunden',
        binance_ohlcv: 'verbunden',
        stocks_etf: 'nicht verbunden (Phase 1, Rest)',
        fred_makro: 'nicht verbunden (Phase 1, Rest)',
        wirtschaftskalender: 'nicht verbunden (Phase 1, Rest)',
        news: 'nicht verbunden (Phase 1, Rest)',
        strategie_engine: 'verbunden',
        backtesting: 'verbunden (Labor, Phase 3)',
        boersen_trading: ctx.venue
          ? `verbunden: ${ctx.venue.id} (${ctx.venue.kind})`
          : 'kein Venue aktiv',
        agenten: 'aktiv: technik/risk/devil/portfolio (deterministisch, echte Daten)',
        agenten_llm: process.env.ANTHROPIC_API_KEY
          ? 'Provider konfiguriert — makro/shadow warten auf Datenquellen (FRED/Funding)'
          : 'deaktiviert: makro/shadow (kein LLM-Provider — ANTHROPIC_API_KEY fehlt)',
        pine_webhook: process.env.PINE_WEBHOOK_SECRET
          ? 'aktiv (/api/webhook/pine, HMAC-gesichert)'
          : 'deaktiviert (PINE_WEBHOOK_SECRET fehlt)',
        anweisungs_dsl: 'aktiv (Vorschau → Bestätigung → Paper-Scan)',
      },
    };
  }),
});
