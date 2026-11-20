import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  buildAccountState,
  closePositionManually,
  ensureLiveModeStillValid,
  isCandleCloseSource,
  isSupportedExchange,
  listConnections,
  loadActiveGates,
  loadRiskContext,
  loadRiskSettings,
  PAPER_START_EQUITY,
  resolveLiveVenueById,
  resolveLiveVenueForSymbol,
  resolvePrimaryApprovedLiveVenue,
  updateProtection,
  venueForPosition,
  venueForSource,
  candleCloseSourceOf,
} from '@gladiator/exchange';
import { evaluateRisk } from '@gladiator/risk';
import { resolveCandleVenue } from '@gladiator/market-data';
import { CANDLE_VENUES } from '@gladiator/jobs';
import { protectedProcedure, router } from '../trpc.js';
import { buildTradesCsv } from '../export/trades-csv.js';

const { positions, orders, executedTrades, venueApprovals, auditLog, priceAlerts, tradeNotes } = schema;

/** Fest verdrahtete Testnet-Venues + jede unterstützte CCXT-Börse ist freigabefähig. */
const APPROVABLE_VENUES = ['binance-testnet', 'hyperliquid-testnet'] as const;

function isApprovableVenueId(venueId: string): boolean {
  return (APPROVABLE_VENUES as readonly string[]).includes(venueId) || isSupportedExchange(venueId);
}

/** Trading-Seite (09_ §3.9): Konto, offene Positionen, Schutz-Orders, Historie — alles echt. */
export const tradingRouter = router({
  account: protectedProcedure.query(async ({ ctx }) => {
    const settings = await loadRiskSettings(ctx.db, ctx.user.id);
    let liveEquityUsd: number | null = null;
    let activeVenueInfo: { id: string; kind: string; ok: boolean; detail: string } | null = null;

    if (settings.mode === 'live') {
      const primary = await resolvePrimaryApprovedLiveVenue(ctx.db, ctx.user.id);
      if (primary) {
        const val = await primary.venue.validate().catch((err: unknown) => ({
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        }));
        liveEquityUsd = await primary.venue.equityUsd().catch(() => null);
        activeVenueInfo = {
          id: primary.venue.id,
          kind: 'live',
          ok: val.ok,
          detail: `${primary.exchangeName} (${primary.exchangeId}): ${val.detail}`,
        };
      }
    }

    const state = await buildAccountState(ctx.db, ctx.user.id, new Date(), {
      mode: settings.mode,
      liveEquityUsd,
    });
    const venueStatus = ctx.venue ? await ctx.venue.validate() : { ok: false, detail: 'Kein Venue aktiv.' };
    return {
      mode: settings.mode,
      startEquity: PAPER_START_EQUITY,
      equity: state.equity,
      dailyPnlPct: state.dailyPnlPct,
      weeklyPnlPct: state.weeklyPnlPct,
      openPositions: state.openPositions,
      consecutiveLosses: state.consecutiveLosses,
      venue: activeVenueInfo ?? { id: ctx.venue?.id ?? 'none', kind: ctx.venue?.kind ?? 'none', ...venueStatus },
    };
  }),

  /** Venue-Liste (09_ §3.9): was ist konfiguriert, was aktiv — inkl. verbundener CCXT-Trading-Börsen. */
  venues: protectedProcedure.query(async ({ ctx }) => {
    const active = ctx.venue?.id ?? 'none';
    const settings = await loadRiskSettings(ctx.db, ctx.user.id);
    const connections = await listConnections(ctx.db, ctx.user.id);
    const activeApprovals = await ctx.db
      .select({ venueId: venueApprovals.venueId })
      .from(venueApprovals)
      .where(isNull(venueApprovals.revokedAt));
    const approvedSet = new Set(activeApprovals.map((a) => a.venueId));

    const base = [
      { id: 'paper-internal', kind: 'paper' as const, configured: true, active: settings.mode === 'paper' && active === 'paper-internal' },
      {
        id: 'binance-testnet',
        kind: 'testnet' as const,
        configured: Boolean(process.env.BINANCE_TESTNET_KEY && process.env.BINANCE_TESTNET_SECRET),
        active: active === 'binance-testnet',
      },
      {
        id: 'hyperliquid-testnet',
        kind: 'testnet' as const,
        configured: Boolean(process.env.HYPERLIQUID_TESTNET_WALLET && process.env.HYPERLIQUID_TESTNET_AGENT_KEY),
        active: active === 'hyperliquid-testnet',
      },
    ];
    const liveVenues = connections
      .filter((c) => c.mode === 'trading')
      .map((c) => ({
        id: `live:${c.id}`,
        kind: 'live' as const,
        configured: c.status === 'active',
        active:
          settings.mode === 'live' &&
          c.status === 'active' &&
          (approvedSet.has(c.exchangeId) || approvedSet.has(`live:${c.id}`)),
      }));
    return [...base, ...liveVenues];
  }),

  positions: protectedProcedure.query(async ({ ctx }) => {
    const settings = await loadRiskSettings(ctx.db, ctx.user.id);
    const rows = await ctx.db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, ctx.user.id), eq(positions.mode, settings.mode)))
      .orderBy(desc(positions.openedAt));
    if (rows.length === 0) return [];

    // Orders dieser Positionen (offene Schutz-Orders + gefüllte Ausstiege) in EINER Abfrage;
    // Zuordnung je Position wie im Executor: gleiches Symbol/Venue/Modus, erstellt ab Eröffnung.
    const userOrders = await ctx.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, ctx.user.id),
          eq(orders.mode, settings.mode),
          inArray(orders.status, ['open', 'filled']),
          eq(orders.reduceOnly, true),
        ),
      );

    // Unrealisierter PnL gegen den ECHTEN Live-Preis (kein Cache-Fake)
    const out = [];
    for (const p of rows) {
      let mark: number | null = null;
      try {
        // Schlusskurs-Positionen (Yahoo/Twelve Data, A2) gegen ihren frischen Kerzenschluss; Live-Positionen gegen ihre Börse.
        const posVenue =
          p.venue.startsWith('live:') && ctx.venue?.id !== p.venue
            ? await resolveLiveVenueById(ctx.db, p.venue)
            : ctx.venue
              ? venueForPosition(ctx.venue, p.venue)
              : null;
        mark = posVenue ? await posVenue.markPrice(p.symbol) : null;
      } catch {
        mark = null; // ehrlich: Preis gerade nicht verfügbar
      }
      const own = userOrders.filter((o) => o.symbol === p.symbol && o.venue === p.venue && o.createdAt >= p.openedAt);
      const exitedQty = own.filter((o) => o.status === 'filled').reduce((n, o) => n + Number(o.qty), 0);
      const entry = Number(p.entryPrice);
      const qty = Number(p.qty);
      // Nach Teil-Gewinnmitnahmen (TP1/TP2) ist nur noch die Restmenge offen.
      const openQty = Math.max(0, qty - exitedQty);
      const sign = p.direction === 'long' ? 1 : -1;
      const prot = own.filter((o) => o.status === 'open');
      const sl = prot.find((o) => o.type === 'stop_market');
      out.push({
        id: p.id,
        symbol: p.symbol,
        venue: p.venue,
        mode: p.mode,
        /** Kursquelle der Position (A3): Schlusskurs-Positionen `paper-close:<quelle>`, sonst Binance. */
        candleVenue: candleCloseSourceOf(p.venue) ?? 'binance',
        direction: p.direction,
        qty,
        openQty,
        entryPrice: entry,
        openedAt: p.openedAt.toISOString(),
        markPrice: mark,
        unrealizedPnl: mark === null ? null : (mark - entry) * openQty * sign,
        stopLoss: sl ? { orderId: sl.id, price: Number(sl.price) } : null,
        takeProfits: prot
          .filter((o) => o.type === 'take_profit_market')
          .map((o) => ({ orderId: o.id, price: Number(o.price), qty: Number(o.qty) }))
          .sort((a, b) => (a.price - b.price) * sign),
        /** Trailing-Stop-Abstand in % (null = aus). */
        trailPct: p.trailPct === null ? null : Number(p.trailPct),
        /** Herkunft: von einem eigenen Agenten eröffnet (sonst aus einem bestätigten Signal). */
        subAgentId: p.subAgentId,
      });
    }
    return out;
  }),

  /**
   * Position manuell (teil-)schließen (Mensch im Loop): echte reduceOnly-Gegen-Order
   * an der aktiven Venue (ohne qty: die ganze Restmenge), Netto-Abrechnung,
   * Schutz-Orders storniert bzw. auf den Rest angepasst, Audit. Fehler als Code (`position:<reason>`) → UI übersetzt.
   */
  closePosition: protectedProcedure
    .input(z.object({ positionId: z.string().uuid(), qty: z.number().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.venue) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'position:no_venue' });
      const r = await closePositionManually(ctx.db, ctx.venue, ctx.user.id, input.positionId, ctx.ip, { qty: input.qty });
      if (!r.closed && !r.partial) {
        throw new TRPCError({ code: r.reason === 'not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED', message: `position:${r.reason}` });
      }
      return r;
    }),

  /** SL/TP ändern und Trailing-Stop schalten — neue Schutz-Order zuerst, dann Storno; Stop weiten nur mit confirmWiden. */
  updateProtection: protectedProcedure
    .input(
      z.object({
        positionId: z.string().uuid(),
        stopLoss: z.number().positive().optional(),
        takeProfits: z.array(z.object({ orderId: z.string().uuid(), price: z.number().positive() })).max(3).optional(),
        confirmWiden: z.boolean().optional(),
        /** Trailing-Stop in % (0,1–50), null = aus. */
        trailPct: z.number().min(0.1).max(50).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.venue) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'position:no_venue' });
      const { positionId, ...change } = input;
      const r = await updateProtection(ctx.db, ctx.venue, ctx.user.id, positionId, change, ctx.ip);
      if (!r.ok) {
        throw new TRPCError({ code: r.reason === 'not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED', message: `position:${r.reason}` });
      }
      return r;
    }),

  protectionOrders: protectedProcedure.query(async ({ ctx }) => {
    const settings = await loadRiskSettings(ctx.db, ctx.user.id);
    return ctx.db
      .select({
        id: orders.id,
        symbol: orders.symbol,
        type: orders.type,
        side: orders.side,
        qty: orders.qty,
        price: orders.price,
        status: orders.status,
        clientOrderId: orders.clientOrderId,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.userId, ctx.user.id),
          eq(orders.mode, settings.mode),
          eq(orders.status, 'open'),
          inArray(orders.type, ['stop_market', 'take_profit_market']),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(50);
  }),

  history: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(25),
          mode: z.enum(['active', 'paper', 'live', 'all']).default('active'),
        })
        .default({ limit: 25, mode: 'active' }),
    )
    .query(async ({ ctx, input }) => {
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const effectiveMode = input.mode === 'active' ? settings.mode : input.mode;
      const rows = await ctx.db
        .select()
        .from(executedTrades)
        .where(
          and(
            eq(executedTrades.userId, ctx.user.id),
            effectiveMode === 'all' ? undefined : eq(executedTrades.mode, effectiveMode),
          ),
        )
        .orderBy(desc(executedTrades.exitTs), desc(executedTrades.createdAt))
        .limit(input.limit);
      return rows.map((r) => ({ ...r, candleVenue: candleCloseSourceOf(r.venue) ?? 'binance' }));
    }),

  /**
   * Steuer-/Trade-Export (10_ §6, §23 EStG): geschlossene Trades des Users als
   * CSV (Semikolon, Punkt als Dezimaltrenner, Zeiten UTC). Jahresfilter nach
   * Veräußerungsjahr (Europe/Berlin). Paper-Trades sind simuliert — der Hinweis
   * steht als erste Zeile in der Datei; steuerrelevant werden erst Live-Trades.
   */
  exportTrades: protectedProcedure
    .input(z.object({ year: z.number().int().min(2000).max(2100).optional(), format: z.literal('csv') }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(executedTrades)
        .where(and(eq(executedTrades.userId, ctx.user.id), isNotNull(executedTrades.exitTs)));
      const csv = buildTradesCsv(
        rows.map((r) => ({
          symbol: r.symbol,
          direction: r.direction,
          venue: r.venue,
          entryTs: r.entryTs,
          exitTs: r.exitTs,
          qty: r.qty,
          entryPrice: r.entryPrice,
          exitPrice: r.exitPrice,
          grossPnl: r.grossPnl,
          // Gebühren = Maker/Taker-Fees; Slippage steckt bereits in den Ausführungspreisen.
          fee: r.makerTakerFee,
          funding: r.fundingPaid,
          netPnl: r.netPnl,
          mode: r.mode,
        })),
        { year: input.year },
      );
      return csv;
    }),

  /**
   * Live-Freigaben pro Börse (11_ Phase 7 / 10_ §5 / OFFENER_PLAN §2) — NUR Patrick,
   * Mensch im Loop. Enthält die fest verdrahteten Testnet-Venues plus alle
   * verbundenen CCXT-Börsen des Users.
   */
  approvals: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(venueApprovals).orderBy(desc(venueApprovals.approvedAt));
    const connections = await listConnections(ctx.db, ctx.user.id);
    const venueIds = [
      ...new Set([
        ...APPROVABLE_VENUES,
        ...connections.map((c) => c.exchangeId),
        ...rows.map((r) => r.venueId),
      ]),
    ];
    return venueIds.map((venueId) => {
      const active = rows.find((r) => r.venueId === venueId && r.revokedAt === null);
      const last = rows.find((r) => r.venueId === venueId);
      return {
        venueId,
        approved: Boolean(active),
        approvedAt: active?.approvedAt ?? null,
        note: active?.note ?? null,
        lastRevokedAt: !active ? (last?.revokedAt ?? null) : null,
      };
    });
  }),

  approveVenue: protectedProcedure
    .input(
      z.object({
        venueId: z.string().trim().min(2).max(60),
        /** Exakte Bestätigungsphrase — verhindert versehentliche Klicks. */
        confirmation: z.string(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const venueId = input.venueId.toLowerCase();
      if (!isApprovableVenueId(venueId)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Venue "${venueId}" ist keine unterstützte Börse.`,
        });
      }
      const expected = `LIVE-FREIGABE ${venueId}`;
      if (input.confirmation !== expected) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Bestätigungsphrase falsch — exakt "${expected}" eingeben.`,
        });
      }
      const [existing] = await ctx.db
        .select()
        .from(venueApprovals)
        .where(and(eq(venueApprovals.venueId, venueId), isNull(venueApprovals.revokedAt)))
        .limit(1);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Für dieses Venue existiert bereits eine aktive Freigabe.' });
      }
      const [row] = await ctx.db
        .insert(venueApprovals)
        .values({ venueId, approvedBy: ctx.user.id, note: input.note ?? null })
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'venue.live_approval.granted',
        entityType: 'venue_approval',
        entityId: row!.id,
        details: { venueId, note: input.note ?? null },
        ip: ctx.ip,
      });
      return row!;
    }),

  /**
   * Position-Sizing-Rechner (Patrick-Luecke 7) — EINE Wahrheit: exakt dieselbe
   * evaluateRisk-Funktion wie die echte Order, mit echtem Kontostand, echten
   * Marktregeln und echtem Risk-Kontext (No-Trade/VIX).
   */
  sizePreview: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1),
        venue: z.enum(CANDLE_VENUES).optional(),
        direction: z.enum(['long', 'short']),
        entry: z.number().positive(),
        stopLoss: z.number().positive(),
        leverage: z.number().min(1).max(125).default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.venue) return { available: false as const, detail: 'Kein Trading-Venue aktiv.' };
      const symbol = input.symbol.toUpperCase();
      const sourceVenue = input.venue ?? (await resolveCandleVenue(ctx.db, symbol));
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const wantLive = settings.mode === 'live' && !isCandleCloseSource(sourceVenue);
      let liveEquityUsd: number | null = null;
      const gates = await loadActiveGates(ctx.db);
      let rules;
      try {
        if (wantLive) {
          const resolved = await resolveLiveVenueForSymbol(ctx.db, ctx.user.id, symbol);
          if (resolved.ok) {
            rules = await resolved.venue.marketRules(symbol);
            liveEquityUsd = await resolved.venue.equityUsd().catch(() => null);
          } else {
            const execVenue = venueForSource(ctx.venue, sourceVenue);
            rules = await execVenue.marketRules(symbol);
          }
        } else {
          const execVenue = venueForSource(ctx.venue, sourceVenue);
          rules = await execVenue.marketRules(symbol);
        }
      } catch (err) {
        return {
          available: false as const,
          detail: err instanceof Error && err.message.includes('Kursquelle')
            ? err.message
            : `Keine Marktregeln fuer ${symbol} (${sourceVenue}).`,
        };
      }
      const state = await buildAccountState(ctx.db, ctx.user.id, new Date(), {
        mode: wantLive ? 'live' : 'paper',
        liveEquityUsd,
      });
      const verdict = evaluateRisk(
        {
          symbol,
          direction: input.direction,
          entry: input.entry,
          stopLoss: input.stopLoss,
          leverage: input.leverage,
          session: 'london', // Vorschau: Session/Regime neutral — die echte Order prueft die Gates erneut
          emaRegime: 'above',
          marketPhase: 'bull',
        },
        settings,
        state,
        rules,
        [], // adaptive Regime-Gates in der VORSCHAU nicht raten — echte Order prueft sie
        await loadRiskContext(ctx.db),
      );
      return {
        available: true as const,
        equity: state.equity,
        riskPctPerTrade: settings.riskPctPerTrade,
        sizing: verdict.sizing,
        allowed: verdict.allowed,
        reasons: verdict.reasons,
        gateCount: gates.length,
        note: 'Vorschau ohne adaptive Regime-Gates — die echte Order prueft zusaetzlich Session/EMA-Regime/Marktphase.',
      };
    }),

  /** Performance-Tracking (Luecke 7): echte Kennzahlen aus geschlossenen Trades (filterbar: aktiv/paper/live/alle). */
  performance: protectedProcedure
    .input(z.object({ mode: z.enum(['active', 'paper', 'live', 'all']).default('active') }).optional())
    .query(async ({ ctx, input }) => {
      const settings = await loadRiskSettings(ctx.db, ctx.user.id);
      const reqMode = input?.mode ?? 'active';
      const effectiveMode = reqMode === 'active' ? settings.mode : reqMode;
      const closed = await ctx.db
        .select()
        .from(executedTrades)
        .where(
          and(
            eq(executedTrades.userId, ctx.user.id),
            effectiveMode === 'all' ? undefined : eq(executedTrades.mode, effectiveMode),
            isNotNull(executedTrades.exitTs),
          ),
        )
        .orderBy(asc(executedTrades.exitTs), asc(executedTrades.createdAt));
      if (closed.length === 0) return { trades: 0 as const, mode: effectiveMode };

      const pnls = closed.map((t) => Number(t.netPnl ?? 0));
      const wins = pnls.filter((v) => v > 0);
      const losses = pnls.filter((v) => v < 0);
      const rs = closed.map((t) => (t.rMultiple ? Number(t.rMultiple) : null)).filter((v): v is number => v !== null);
      const grossWin = wins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

      const bySymbol = new Map<string, { trades: number; netPnl: number; wins: number }>();
      for (const t of closed) {
        const e = bySymbol.get(t.symbol) ?? { trades: 0, netPnl: 0, wins: 0 };
        e.trades++;
        e.netPnl += Number(t.netPnl ?? 0);
        if (Number(t.netPnl ?? 0) > 0) e.wins++;
        bySymbol.set(t.symbol, e);
      }

      // Im Paper-Modus startet die Kurve bei PAPER_START_EQUITY; im Live- oder Alle-Modus kumulative Netto-PnL ab 0.
      let equity = effectiveMode === 'paper' ? PAPER_START_EQUITY : 0;
      const curve = closed.map((t) => {
        equity += Number(t.netPnl ?? 0);
        return { ts: (t.exitTs ?? t.createdAt).toISOString(), equity: Math.round(equity * 100) / 100 };
      });

      return {
        mode: effectiveMode,
        trades: closed.length,
        netPnl: pnls.reduce((a, b) => a + b, 0),
        winRate: wins.length / closed.length,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        expectancyR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
        bySymbol: [...bySymbol.entries()].map(([symbol, v]) => ({ symbol, ...v })),
        equityCurve: curve,
      };
    }),

  /** Trade-Journal (Luecke 7): Notiz je geschlossenem Trade. */
  setTradeNote: protectedProcedure
    .input(z.object({ tradeId: z.string().uuid(), note: z.string().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const [trade] = await ctx.db
        .select({ id: executedTrades.id })
        .from(executedTrades)
        .where(and(eq(executedTrades.id, input.tradeId), eq(executedTrades.userId, ctx.user.id)))
        .limit(1);
      if (!trade) throw new TRPCError({ code: 'NOT_FOUND', message: 'Trade nicht gefunden.' });
      if (input.note.trim().length === 0) {
        await ctx.db.delete(tradeNotes).where(eq(tradeNotes.tradeId, input.tradeId));
        return { ok: true };
      }
      await ctx.db
        .insert(tradeNotes)
        .values({ tradeId: input.tradeId, note: input.note.trim(), updatedAt: new Date() })
        .onConflictDoUpdate({ target: tradeNotes.tradeId, set: { note: input.note.trim(), updatedAt: new Date() } });
      return { ok: true };
    }),

  tradeNotes: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ tradeId: tradeNotes.tradeId, note: tradeNotes.note })
      .from(tradeNotes)
      .innerJoin(executedTrades, eq(executedTrades.id, tradeNotes.tradeId))
      .where(eq(executedTrades.userId, ctx.user.id));
    return Object.fromEntries(rows.map((r) => [r.tradeId, r.note]));
  }),

  /** Preis-Alerts (Luecke 7): Monitor prueft minuetlich; Trigger -> Telegram + Audit. */
  alerts: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(priceAlerts).where(eq(priceAlerts.userId, ctx.user.id)).orderBy(desc(priceAlerts.createdAt)).limit(100),
  ),

  createAlert: protectedProcedure
    .input(
      z.object({
        symbol: z.string().trim().min(1).max(32),
        /** Preisquelle (Asset-Register): binance = Markpreis, yahoo/twelvedata = frischer Kerzen-Schluss. Ohne = Binance. */
        venue: z.enum(CANDLE_VENUES).optional(),
        condition: z.enum(['above', 'below']),
        price: z.number().positive(),
        note: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(priceAlerts)
        .values({
          userId: ctx.user.id,
          symbol: input.symbol.toUpperCase(),
          venue: input.venue ?? 'binance',
          condition: input.condition,
          price: String(input.price),
          note: input.note ?? null,
        })
        .returning();
      return row!;
    }),

  deleteAlert: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(priceAlerts).where(and(eq(priceAlerts.id, input.id), eq(priceAlerts.userId, ctx.user.id)));
    return { ok: true };
  }),

  revokeVenue: protectedProcedure
    .input(z.object({ venueId: z.string().trim().min(2).max(60) }))
    .mutation(async ({ ctx, input }) => {
      const venueId = input.venueId.toLowerCase();
      if (!isApprovableVenueId(venueId)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Venue "${venueId}" ist keine unterstützte Börse.` });
      }
      const [existing] = await ctx.db
        .select()
        .from(venueApprovals)
        .where(and(eq(venueApprovals.venueId, venueId), isNull(venueApprovals.revokedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Keine aktive Freigabe für dieses Venue.' });
      const [row] = await ctx.db
        .update(venueApprovals)
        .set({ revokedAt: new Date(), revokedBy: ctx.user.id })
        .where(eq(venueApprovals.id, existing.id))
        .returning();
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'venue.live_approval.revoked',
        entityType: 'venue_approval',
        entityId: existing.id,
        details: { venueId },
        ip: ctx.ip,
      });
      await ensureLiveModeStillValid(ctx.db, ctx.user.id, `venue_revoked:${venueId}`, ctx.ip);
      return row!;
    }),
});
