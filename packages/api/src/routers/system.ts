import { and, desc, eq, gte, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import { latestBriefing, telegramConfigured } from '@gladiator/jobs';
import { derivativesFresh, fredConfigured, getMacroSnapshot } from '@gladiator/market-data';
import { protectedProcedure, router } from '../trpc.js';

const startedAt = Date.now();
const { auditLog } = schema;

/** LIKE-Sonderzeichen im Präfix wörtlich nehmen (kein Wildcard-Leak). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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

    // Kerzen-Frische statt Behauptung: der Scan hält 15m-Kerzen inkrementell
    // aktuell — steht die letzte Kerze länger als 45 min, stimmt etwas nicht.
    const lastCandleRow = await ctx.db.execute(sql`SELECT max(ts) AS ts FROM ohlcv WHERE timeframe = '15m'`);
    const lastCandleTs = (lastCandleRow.rows[0] as { ts: string | null }).ts;
    const candleAgeMin = lastCandleTs ? Math.floor((Date.now() - new Date(lastCandleTs).getTime()) / 60_000) : null;

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
        binance_ohlcv:
          candleAgeMin === null
            ? 'keine Kerzen in der DB (Backfill ausstehend)'
            : candleAgeMin <= 45
              ? `verbunden (letzte 15m-Kerze vor ${candleAgeMin} min)`
              : `VERALTET: letzte 15m-Kerze vor ${candleAgeMin} min — Scan-Backfill prüfen`,
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
        telegram: telegramConfigured()
          ? 'verbunden (Alerts + Briefing)'
          : 'deaktiviert (TELEGRAM_BOT_TOKEN/_CHAT_ID fehlen — NEUEN Bot anlegen, Alt-Token ist kompromittiert)',
        dead_man_switch: process.env.HEALTHCHECKS_URL
          ? 'aktiv (externer Monitor)'
          : 'nur lokaler Watchdog (HEALTHCHECKS_URL für externen Monitor fehlt)',
      },
    };
  }),

  /**
   * Protokoll (10_ §6: unveränderliches Audit-Log als Beleggrundlage): jede
   * sicherheitsrelevante Aktion — Orders, Risk-Checks, SL/TP-Änderungen, Logins.
   * Nur lesend; Einträge des Users plus System-Ereignisse ohne User-Bezug
   * (Einzelnutzer-System, keine Mandanten). Keyset-Pagination über die id
   * (absteigend), `cursor` = id des letzten Eintrags der vorigen Seite.
   */
  auditLog: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().regex(/^\d+$/).optional(),
        actionPrefix: z.string().trim().max(100).optional(),
        entityType: z.string().trim().max(100).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conds: SQL[] = [or(eq(auditLog.userId, ctx.user.id), isNull(auditLog.userId))!];
      if (input.cursor) conds.push(lt(auditLog.id, BigInt(input.cursor)));
      if (input.actionPrefix) conds.push(like(auditLog.action, `${escapeLike(input.actionPrefix)}%`));
      if (input.entityType) conds.push(eq(auditLog.entityType, input.entityType));
      if (input.from) conds.push(gte(auditLog.ts, new Date(input.from)));
      if (input.to) conds.push(lte(auditLog.ts, new Date(input.to)));

      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(and(...conds))
        .orderBy(desc(auditLog.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        // bigint ist nicht JSON-serialisierbar → id als String
        items: page.map((r) => ({
          id: r.id.toString(),
          ts: r.ts.toISOString(),
          actor: r.actor,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          details: r.details as unknown,
          ip: r.ip,
        })),
        nextCursor: rows.length > input.limit ? page[page.length - 1]!.id.toString() : null,
      };
    }),

  /** Neuestes Morning-Briefing (Nacht-Pipeline, 08_ §7). */
  briefing: protectedProcedure.query(async ({ ctx }) => {
    const row = await latestBriefing(ctx.db);
    return row ? { day: row.day, text: row.text, sentAt: row.sentAt, createdAt: row.createdAt } : null;
  }),
});
