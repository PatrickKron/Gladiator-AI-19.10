import { z } from 'zod';
import {
  demoBookSource,
  buildAccountState,
  demoAccountOverview,
  fetchConnectionBalances,
  listConnections,
} from '@gladiator/exchange';
import { getEurUsdRate, valueBalancesUsd } from '@gladiator/market-data';
import { loadValueHistory, valueSwapWallets } from '@gladiator/jobs';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Vermögens-Ansicht (Phase 2): alle Konten GETRENNT und ehrlich —
 * Übungskonto (Demo manuell + Paper Agenten + Paper-Wallets, alles virtuell)
 * strikt getrennt von echtem Geld (verbundene Börsen + eigene Trading-Wallets). Gesamt in EUR nur mit echtem Kurs,
 * sonst null. „Echtes Geld: 0 €" wenn keine Börse verbunden ist — keine
 * Beschönigung.
 */
export const portfolioRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    // Übungskonto (virtuell)
    let demo: { equity: number; markIncomplete: boolean } | null = null;
    try {
      const d = await demoAccountOverview(ctx.db, demoBookSource(), ctx.user.id);
      demo = { equity: d.equity, markIncomplete: d.markIncomplete };
    } catch {
      demo = null; // Orderbuch gerade nicht erreichbar → ehrlich null
    }
    const paper = await buildAccountState(ctx.db, ctx.user.id);

    // Echtes Geld: verbundene Börsen mit echten Beständen + echten Kursen
    const connections = await listConnections(ctx.db, ctx.user.id);
    const realAccounts: {
      connectionId: string;
      exchangeId: string;
      exchangeName: string;
      label: string | null;
      mode: 'read_only' | 'trading';
      status: string;
      totalUsd: number | null;
      balances: { currency: string; total: number; valuedUsd: number | null }[];
      error: string | null;
    }[] = [];
    let realTotalUsd: number | null = null;
    for (const conn of connections) {
      try {
        const balances = await fetchConnectionBalances(ctx.db, ctx.user.id, conn.id);
        const amounts: Record<string, number> = {};
        for (const b of balances) amounts[b.currency] = b.total;
        const valued = await valueBalancesUsd(amounts);
        realTotalUsd = (realTotalUsd ?? 0) + valued.totalUsd;
        realAccounts.push({
          connectionId: conn.id,
          exchangeId: conn.exchangeId,
          exchangeName: conn.exchangeName,
          label: conn.label,
          mode: conn.mode,
          status: conn.status,
          totalUsd: valued.totalUsd,
          balances: balances.map((b) => ({
            currency: b.currency,
            total: b.total,
            valuedUsd: valued.valuedUsd[b.currency] ?? null,
          })),
          error: null,
        });
      } catch (err) {
        realAccounts.push({
          connectionId: conn.id,
          exchangeId: conn.exchangeId,
          exchangeName: conn.exchangeName,
          label: conn.label,
          mode: conn.mode,
          status: 'error',
          totalUsd: null,
          balances: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Swap-Wallets (Vision-Punkt 5): Paper zählt zum Übungsgeld, eigene Wallets zum echten Geld.
    const wallets = await valueSwapWallets(ctx.db, ctx.user.id);
    const paperWallets = wallets.filter((w) => w.mode === 'paper');
    const liveWallets = wallets.filter((w) => w.mode === 'live');
    const sum = (ws: typeof wallets) => ws.reduce((s, w) => s + (w.totalUsd ?? 0), 0);
    if (liveWallets.length > 0) realTotalUsd = (realTotalUsd ?? 0) + sum(liveWallets);

    const eurUsd = await getEurUsdRate();
    const practiceUsd = (demo?.equity ?? 0) + paper.equity + sum(paperWallets);
    const toEur = (usd: number | null): number | null =>
      usd === null || eurUsd === null ? null : usd / eurUsd;

    return {
      practice: {
        demoEquityUsd: demo?.equity ?? null,
        demoIncomplete: demo?.markIncomplete ?? true,
        paperEquityUsd: paper.equity,
        wallets: paperWallets,
        walletsIncomplete: paperWallets.some((w) => w.totalUsd === null),
        totalUsd: practiceUsd,
        totalEur: toEur(practiceUsd),
      },
      real: {
        connected: connections.length > 0 || liveWallets.length > 0,
        accounts: realAccounts,
        wallets: liveWallets,
        walletsIncomplete: liveWallets.some((w) => w.totalUsd === null),
        totalUsd: connections.length > 0 || liveWallets.length > 0 ? realTotalUsd : 0,
        totalEur: connections.length > 0 || liveWallets.length > 0 ? toEur(realTotalUsd) : 0,
      },
      eurUsdRate: eurUsd,
    };
  }),

  /** Zeitverlauf aus echten Snapshots (stündlicher Worker-Job). */
  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(10).max(2000).default(500) }))
    .query(({ ctx, input }) => loadValueHistory(ctx.db, ctx.user.id, input.limit)),
});
