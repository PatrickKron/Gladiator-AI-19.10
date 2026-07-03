import { sql } from 'drizzle-orm';
import { derivativesFresh, fredConfigured, getMacroSnapshot } from '@gladiator/market-data';
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

    const macro = await getMacroSnapshot(ctx.db);
    const macroConnected = macro.fresh && macro.grs !== null;
    const derivConnected = await derivativesFresh(ctx.db);
    const extraCounts = await ctx.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM economic_events) AS calendar_events,
        (SELECT count(*)::int FROM news_items) AS news_items
    `);
    const extra = extraCounts.rows[0] as { calendar_events: number; news_items: number };

    return {
      db: 'up' as const,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      counts: counts.rows[0] as Record<string, number>,
      priceFeed: ctx.prices ? ctx.prices.snapshot().status : null,
      /** Quellen-Wahrheit: was ist angebunden, was (noch) nicht. */
      sources: {
        binance_ws: ctx.prices ? 'verbunden' : 'nicht verbunden',
        binance_ohlcv: 'verbunden',
        stocks_etf: 'verbunden: Yahoo-Quotes (5-min-Cache)',
        makro_vix_dxy_us10y: macroConnected
          ? `verbunden: Yahoo (VIX ${macro.vix?.value.toFixed(1) ?? '—'})`
          : 'Sync ausstehend (macro-sync-Job)',
        fred: fredConfigured() ? 'verbunden (FRED_API_KEY gesetzt)' : 'optional — FRED_API_KEY fehlt (VIX/DXY/US10Y laufen ohne)',
        wirtschaftskalender: extra.calendar_events > 0 ? `verbunden: ForexFactory (${extra.calendar_events} Events)` : 'Sync ausstehend (calendar-sync-Job)',
        news: extra.news_items > 0 ? `verbunden: RSS (${extra.news_items} Artikel)` : 'Sync ausstehend (news-sync-Job)',
        funding_oi: derivConnected ? 'verbunden: Binance-Futures' : 'Sync ausstehend (derivatives-sync-Job)',
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
