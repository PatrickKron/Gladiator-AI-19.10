import { z } from 'zod';
import { and, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { schema } from '@gladiator/db';
import {
  fetchOnchainSnapshot,
  type OnchainSnapshot,
  getBuffettSnapshot,
  getCotSnapshot,
  getCpiSnapshot,
  syncBuffett,
  syncCot,
  syncCpiSeries,
} from '@gladiator/market-data';
import { aggregatePostTrade, evaluateTrade, type BuffettStatus, type CotStatus, type CpiStatus, type HedgeMode, type MarketRegimeName } from '@gladiator/agents';
import { protectedProcedure, router } from '../trpc.js';

const { signalIntelligence, postTradeReviews, executedTrades, signals } = schema;

/** On-Chain (DNA): Tageswerte → 1 h Cache; nur vollständige Antworten werden gemerkt. */
const ONCHAIN_TTL_MS = 3_600_000;
let onchainCache: { at: number; data: OnchainSnapshot } | null = null;
let onchainFetch: typeof fetch | null = null;
/** Tests: Netz für die On-Chain-Quellen ersetzen (null = echtes fetch) und Cache leeren. */
export function setOnchainFetchForTests(f: typeof fetch | null): void {
  onchainFetch = f;
  onchainCache = null;
}

/**
 * KI-Trading-Intelligence-Router („/goal Ergänzung zu Gladiator AI").
 *
 * Liest die deterministisch berechneten Intelligence-Daten (CPI/COT/Buffett,
 * erweitertes Signalobjekt, Post-Trade-Reviews) und bietet MANUELLE
 * Sync-/Lern-Trigger (Mensch im Loop, Eiserne Regel #7). Die eigentliche
 * Anreicherung neuer Signale läuft automatisch im geplanten Review-Job.
 *
 * Fehlt eine Datenquelle, liefert die Query ehrlich „nicht verbunden" statt
 * Fake — die App markiert das sichtbar.
 */
export const intelligenceRouter = router({
  /** CPI-Event-Regime + Überraschung + YoY-Inflation (PDF §5). */
  cpiStatus: protectedProcedure.query(({ ctx }) => getCpiSnapshot(ctx.db)),

  /** COT-Positionierung je Markt oder gezielt für ein App-Symbol (PDF §6). */
  cotSnapshot: protectedProcedure
    .input(z.object({ symbol: z.string().optional() }).optional())
    .query(({ ctx, input }) => getCotSnapshot(ctx.db, input?.symbol)),

  /** Warren-Buffett-Bewertungsstatus (PDF §7). */
  buffettStatus: protectedProcedure.query(({ ctx }) => getBuffettSnapshot(ctx.db)),

  /** DNA-Quadrant: MVRV + aktive Adressen (Coin Metrics Community), Stablecoin-Umlauf (DefiLlama). */
  onchain: protectedProcedure.query(async () => {
    if (onchainCache && Date.now() - onchainCache.at < ONCHAIN_TTL_MS) return onchainCache.data;
    const data = await fetchOnchainSnapshot(onchainFetch ?? fetch);
    const complete = data.assets.every((a) => a.error === null) && data.stablecoins.error === null;
    if (complete) onchainCache = { at: Date.now(), data };
    return data;
  }),

  /** Erweitertes Signalobjekt zu einem Signal (PDF §11). Null, wenn noch nicht angereichert. */
  signalIntelligence: protectedProcedure
    .input(z.object({ signalId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(signalIntelligence)
        .where(eq(signalIntelligence.signalId, input.signalId))
        .limit(1);
      return row ?? null;
    }),

  /**
   * Post-Trade-Reviews (neueste zuerst) + aggregierte Lern-Kennzahlen (PDF §4).
   * Join auf executed_trades, damit die UI den Trade lesbar zeigen kann
   * (Symbol/Richtung/Modus statt UUID).
   */
  postTradeReviews: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          review: postTradeReviews,
          trade: {
            symbol: executedTrades.symbol,
            direction: executedTrades.direction,
            mode: executedTrades.mode,
            exitTs: executedTrades.exitTs,
          },
        })
        .from(postTradeReviews)
        .leftJoin(executedTrades, eq(postTradeReviews.executedTradeId, executedTrades.id))
        .orderBy(desc(postTradeReviews.createdAt))
        .limit(input?.limit ?? 50);
      const aggregate = aggregatePostTrade(
        rows.map(({ review: r }) => ({
          review: {
            hitQuality: r.hitQuality as ReturnType<typeof evaluateTrade>['hitQuality'],
            scoreValidity: Number(r.scoreValidity),
            errorSources: (r.errorSources as string[]) ?? [],
            lessons: (r.lessons as string[]) ?? [],
          },
          rMultiple: r.rMultiple !== null ? Number(r.rMultiple) : null,
        })),
      );
      return { reviews: rows, aggregate };
    }),

  /**
   * Datenstand je Intelligence-Quelle — macht den AUTOMATISCHEN Sync sichtbar
   * (macro-sync-Job alle 30 min, Intelligence-Quellen mit 6-h-Drossel; manuell
   * bleibt möglich). Vorher wirkte der Sync „nur manuell", weil nirgends stand,
   * wie frisch die Daten sind.
   */
  dataStatus: protectedProcedure.query(async ({ ctx }) => {
    const { cotReports, valuationIndicators } = schema;
    const [cotRow] = await ctx.db
      .select({ latest: sql<string | null>`max(${cotReports.reportDate})::text`, n: sql<number>`count(*)::int` })
      .from(cotReports);
    const cpiRes = await ctx.db.execute(
      sql`SELECT max(ts)::text AS latest, count(*)::int AS n FROM macro_series WHERE series_id = 'CPI'`,
    );
    const cpiRow = cpiRes.rows[0] as { latest: string | null; n: number } | undefined;
    const [buffettRow] = await ctx.db
      .select({ latest: sql<string | null>`max(${valuationIndicators.ts})::text`, n: sql<number>`count(*)::int` })
      .from(valuationIndicators);
    return {
      cot: { latest: cotRow?.latest ?? null, rows: cotRow?.n ?? 0 },
      cpi: { latest: cpiRow?.latest ?? null, rows: cpiRow?.n ?? 0 },
      buffett: { latest: buffettRow?.latest ?? null, rows: buffettRow?.n ?? 0 },
      autoSyncEveryHours: 6,
    };
  }),

  // ── Manuelle Sync-Trigger (Mensch im Loop) ──
  syncCpi: protectedProcedure.mutation(({ ctx }) => syncCpiSeries(ctx.db)),
  syncCot: protectedProcedure.mutation(({ ctx }) => syncCot(ctx.db)),
  syncBuffett: protectedProcedure.mutation(({ ctx }) => syncBuffett(ctx.db)),

  /**
   * Post-Trade-Learning-Lauf: bewertet ALLE abgeschlossenen Trades ohne Review
   * und schreibt post_trade_reviews. Idempotent (bereits bewertete werden
   * übersprungen).
   */
  runPostTradeLearning: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(200) }).optional())
    .mutation(async ({ ctx, input }) => {
      const reviewed = await ctx.db.select({ id: postTradeReviews.executedTradeId }).from(postTradeReviews);
      const alreadyReviewed = reviewed.map((r) => r.id);

      const closed = await ctx.db
        .select()
        .from(executedTrades)
        .where(
          and(
            isNotNull(executedTrades.exitTs),
            isNotNull(executedTrades.netPnl),
            alreadyReviewed.length > 0 ? notInArray(executedTrades.id, alreadyReviewed) : undefined,
          ),
        )
        .orderBy(desc(executedTrades.exitTs))
        .limit(input?.limit ?? 200);

      let created = 0;
      for (const t of closed) {
        // Signal- + Intelligence-Kontext zum Entscheidungszeitpunkt.
        const [sig] = t.signalId
          ? await ctx.db.select({ score: signals.score }).from(signals).where(eq(signals.id, t.signalId)).limit(1)
          : [undefined];
        const [intel] = t.signalId
          ? await ctx.db.select().from(signalIntelligence).where(eq(signalIntelligence.signalId, t.signalId)).limit(1)
          : [undefined];

        const cotWithTrade =
          intel != null &&
          ((t.direction === 'long' && intel.cotStatus === 'crowded_long') ||
            (t.direction === 'short' && intel.cotStatus === 'crowded_short') ||
            intel.cotStatus === 'contrarian_alert');

        const review = evaluateTrade(
          {
            direction: t.direction,
            netPnl: Number(t.netPnl),
            rMultiple: t.rMultiple !== null ? Number(t.rMultiple) : null,
            mode: t.mode,
          },
          {
            originalScore: sig ? Number(sig.score) : null,
            cpiStatus: (intel?.cpiStatus as CpiStatus | undefined) ?? undefined,
            cotStatus: (intel?.cotStatus as CotStatus | undefined) ?? undefined,
            cotWithTrade,
            buffettStatus: (intel?.buffettStatus as BuffettStatus | undefined) ?? undefined,
            hedgeMode: (intel?.hedgeMode as HedgeMode | null | undefined) ?? undefined,
            regime: (intel?.marketRegime as MarketRegimeName | null | undefined) ?? undefined,
          },
        );

        await ctx.db
          .insert(postTradeReviews)
          .values({
            executedTradeId: t.id,
            signalId: t.signalId,
            hitQuality: review.hitQuality,
            scoreValidity: String(review.scoreValidity),
            errorSources: review.errorSources,
            lessons: review.lessons,
            rMultiple: t.rMultiple,
            netPnl: t.netPnl,
          })
          .onConflictDoNothing();
        created += 1;
      }
      return { evaluated: closed.length, created };
    }),
});
