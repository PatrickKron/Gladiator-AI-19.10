import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { fetchSolanaWalletSwaps, walletBalances, type ObservedSwap } from '@gladiator/exchange';
import { notifySafe } from './notify.js';
import { cachedTokenInfo, executePreparedSwap, prepareSwap, swapNet } from './swap-service.js';

const { watchedWallets, watchedWalletSwaps, swapWallets } = schema;

/**
 * Beobachtete Wallets + Copy-Trading (Vision-Punkt 5, „wie Trojan“). Der
 * schnelle Worker-Takt liest je beobachteter Solana-Wallet die neuen
 * Transaktionen von der Kette, speichert erkannte Swaps und kopiert sie im
 * Paper-Modus: Kauf → fester Betrag in der gewählten Paper-Wallet (gleiches
 * Gate, gleicher Sicherheitscheck wie im Ticket), Verkauf → ganzen eigenen
 * Bestand verkaufen. Echtes Copy-Trading gibt es bewusst nicht (Mensch im
 * Loop: jede Live-Transaktion bestätigt der User selbst).
 */

export const WATCH_INTERVAL_SECONDS = 45;
/** Je Takt höchstens so viele neue Transaktionen je Wallet (öffentliche RPCs drosseln). */
export const WATCH_TX_LIMIT = 10;

export type WalletCopyResult = { checked: number; detected: number; copied: number; skipped: number; failed: number; errors: string[] };

type WatchedRow = typeof watchedWallets.$inferSelect;

async function shortSymbol(token: string): Promise<string> {
  try {
    return (await cachedTokenInfo('solana', token)).symbol;
  } catch {
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
  }
}

/** Einen erkannten Swap in der Paper-Wallet nachbilden. */
async function copySwap(db: Db, w: WatchedRow, s: ObservedSwap): Promise<{ status: 'filled' | 'skipped' | 'failed'; note: string; tradeId?: string }> {
  if (w.copyMode !== 'paper' || !w.copyWalletId || !w.copyAmount) return { status: 'skipped', note: 'Kopieren aus' };
  const [wallet] = await db
    .select()
    .from(swapWallets)
    .where(and(eq(swapWallets.id, w.copyWalletId), isNull(swapWallets.archivedAt)));
  // Doppelte Absicherung: nur Paper-Wallets derselben Person auf Solana
  if (!wallet || wallet.userId !== w.userId || wallet.mode !== 'paper' || wallet.chain !== 'solana') {
    return { status: 'skipped', note: 'Ziel-Wallet fehlt oder ist keine Solana-Paper-Wallet' };
  }
  if (s.side === 'sell') {
    const held = (await walletBalances(db, wallet.id)).find((b) => b.token === s.token);
    if (!held || BigInt(held.amountAtomic) === 0n) return { status: 'skipped', note: 'kein eigener Bestand' };
  }
  try {
    const p = await prepareSwap(db, wallet, s.side === 'buy' ? { side: 'buy', token: s.token, amount: w.copyAmount } : { side: 'sell', token: s.token, percent: 100 });
    if (!p.verdict.allowed) return { status: 'skipped', note: `Gate: ${p.verdict.reasons.join(', ')}` };
    const r = await executePreparedSwap(db, p, s.side, { userId: w.userId, ip: null, actor: 'system', confirmedLive: false, origin: `Copy-Trade ${w.label}` });
    return { status: 'filled', note: `${p.quote.inAmount} ${p.quote.inToken.symbol} → ${p.quote.outAmount} ${p.quote.outToken.symbol}`, tradeId: r.tradeId };
  } catch (err) {
    return { status: 'failed', note: err instanceof Error ? err.message : String(err) };
  }
}

/** Eine beobachtete Wallet prüfen. Erster Lauf: nur Verlauf merken, nichts kopieren. */
export async function checkWatchedWallet(db: Db, w: WatchedRow, out: WalletCopyResult): Promise<void> {
  out.checked++;
  let res: Awaited<ReturnType<typeof fetchSolanaWalletSwaps>>;
  try {
    res = await fetchSolanaWalletSwaps(w.address, { limit: WATCH_TX_LIMIT, until: w.lastSignature }, swapNet());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.errors.push(`${w.label}: ${msg}`);
    await db.update(watchedWallets).set({ lastCheckedAt: new Date(), lastError: msg }).where(eq(watchedWallets.id, w.id));
    return;
  }
  const firstRun = w.lastSignature === null;
  // älteste zuerst, damit Kauf vor Verkauf kopiert wird
  for (const s of [...res.swaps].reverse()) {
    const [row] = await db
      .insert(watchedWalletSwaps)
      .values({
        watchedId: w.id,
        signature: s.signature,
        side: s.side,
        token: s.token,
        tokenAtomic: s.tokenAtomic.toString(),
        tokenDecimals: s.tokenDecimals,
        solLamports: s.solLamports === null ? null : s.solLamports.toString(),
        counterToken: s.counterToken,
        txTime: s.time === null ? null : new Date(s.time * 1000),
        copyStatus: 'none',
        copyNote: firstRun ? 'vor Beobachtungsbeginn' : null,
      })
      .onConflictDoNothing()
      .returning({ id: watchedWalletSwaps.id });
    if (!row) continue; // schon verarbeitet — nie doppelt kopieren
    out.detected++;
    if (firstRun || w.copyMode === 'off') continue;

    const c = await copySwap(db, w, s);
    await db
      .update(watchedWalletSwaps)
      .set({ copyStatus: c.status, copyNote: c.note, copyTradeId: c.tradeId ?? null })
      .where(eq(watchedWalletSwaps.id, row.id));
    const symbol = await shortSymbol(s.token);
    const verb = s.side === 'buy' ? 'Kauf' : 'Verkauf';
    if (c.status === 'filled') {
      out.copied++;
      await notifySafe(db, {
        userId: w.userId,
        kind: 'system',
        title: `Copy-Trade ausgeführt: ${verb} ${symbol}`,
        body: `${w.label}: ${c.note} (Paper)`,
        link: '#/traden?tab=wallet',
      });
    } else if (c.status === 'failed') {
      out.failed++;
      out.errors.push(`${w.label} ${verb} ${symbol}: ${c.note}`);
      await notifySafe(db, {
        userId: w.userId,
        kind: 'system',
        severity: 'warn',
        title: `Copy-Trade fehlgeschlagen: ${verb} ${symbol}`,
        body: `${w.label}: ${c.note}`,
        link: '#/traden?tab=wallet',
      });
    } else {
      out.skipped++;
    }
  }
  await db
    .update(watchedWallets)
    .set({ lastSignature: res.newestSignature, lastCheckedAt: new Date(), lastError: null })
    .where(eq(watchedWallets.id, w.id));
}

/** Worker-Takt: fällige beobachtete Wallets prüfen (je Wallet höchstens alle 45 s). */
export async function runWalletCopy(db: Db): Promise<WalletCopyResult> {
  const out: WalletCopyResult = { checked: 0, detected: 0, copied: 0, skipped: 0, failed: 0, errors: [] };
  const due = await db
    .select()
    .from(watchedWallets)
    .where(
      and(
        eq(watchedWallets.chain, 'solana'),
        or(isNull(watchedWallets.lastCheckedAt), sql`${watchedWallets.lastCheckedAt} < now() - ${sql.raw(`interval '${WATCH_INTERVAL_SECONDS} seconds'`)}`),
      ),
    )
    .orderBy(asc(watchedWallets.lastCheckedAt));
  for (const w of due) await checkWatchedWallet(db, w, out);
  return out;
}

