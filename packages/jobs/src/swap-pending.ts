import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { checkLiveSwapStatus, fetchOnchainBalances, resolvePendingLiveSwap, SWAP_CHAINS, type SwapChainId } from '@gladiator/exchange';
import { notifySafe } from './notify.js';
import { cancelSellOrdersIfSoldOut } from './swap-orders.js';
import { swapNet } from './swap-service.js';

const { swapTrades, swapWallets } = schema;

export type PendingSwapsResult = { checked: number; filled: number; failed: number; errors: string[] };

/**
 * „Ausgang unklar“ klären (gesendet, aber Bestätigung nicht abgewartet — Netz,
 * Zeitüberschreitung): Der Worker fragt die Kette jede Minute nach jedem
 * offenen Live-Swap. Ausgeführt → genau wie ein sofort bestätigter Swap
 * verbucht (Bestände von der Kette), Verkauf leert ggf. die übrigen
 * Verkaufs-Orders (OCO); fehlgeschlagen/abgelaufen → nur der Status. Keine
 * Aussage der Kette → bleibt offen, es wird nie geraten. Meldung in der Glocke.
 */
export async function resolvePendingSwaps(db: Db, opts: { now?: Date; walletId?: string } = {}): Promise<PendingSwapsResult> {
  const now = opts.now ?? new Date();
  const out: PendingSwapsResult = { checked: 0, filled: 0, failed: 0, errors: [] };
  const rows = await db
    .select({ trade: swapTrades, wallet: swapWallets })
    .from(swapTrades)
    .innerJoin(swapWallets, eq(swapTrades.walletId, swapWallets.id))
    .where(and(eq(swapTrades.status, 'pending'), eq(swapTrades.mode, 'live'), isNotNull(swapTrades.txHash), opts.walletId ? eq(swapTrades.walletId, opts.walletId) : undefined));
  for (const { trade, wallet } of rows) {
    out.checked++;
    const chain = wallet.chain as SwapChainId;
    try {
      const st = await checkLiveSwapStatus(chain, trade.txHash!, now.getTime() - trade.createdAt.getTime(), swapNet(), {
        from: wallet.address,
        nonce: trade.pendingContext?.nonce ?? null,
      });
      if (st.status === 'pending') continue;
      // gelandet: Mengen MÜSSEN von der Kette kommen (der Spiegel kann den Swap schon enthalten →
      // sonst doppelt gebucht); nicht lesbar → im nächsten Takt erneut
      const onchain = st.status === 'filled' ? await fetchOnchainBalances(chain, wallet.address, [trade.inToken, trade.outToken], swapNet()) : null;
      const done = await resolvePendingLiveSwap(db, trade.id, { status: st.status, error: st.error, onchain });
      if (!done) continue; // inzwischen anderswo geklärt
      const verb = trade.side === 'buy' ? 'Kauf' : 'Verkauf';
      const token = trade.side === 'buy' ? trade.outSymbol : trade.inSymbol;
      if (st.status === 'filled') {
        out.filled++;
        if (trade.side === 'sell') await cancelSellOrdersIfSoldOut(db, wallet.id, trade.inToken);
      } else {
        out.failed++;
      }
      await notifySafe(db, {
        userId: wallet.userId,
        kind: 'system',
        severity: st.status === 'filled' ? 'info' : 'warn',
        title: st.status === 'filled' ? `${verb} doch ausgeführt: ${token}` : `${verb} nicht ausgeführt: ${token}`,
        body:
          st.status === 'filled'
            ? `Die Kette hat den zunächst unklaren Swap bestätigt (${wallet.label}, ${SWAP_CHAINS[chain].name}, Tx ${trade.txHash}).`
            : `${st.error ?? 'fehlgeschlagen'} (${wallet.label}, Tx ${trade.txHash}) — es wurde nichts getauscht.`,
        link: '#/traden?tab=wallet',
      });
    } catch (err) {
      // Abfrage-Fehler heißt nichts — beim nächsten Takt erneut
      out.errors.push(`${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
