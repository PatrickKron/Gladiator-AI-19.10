import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { fetchEvmWalletSwaps, fetchSolanaWalletSwaps, fromAtomic, SWAP_CHAINS, toAtomic, walletBalances, type ObservedSwap, type SwapChainId } from '@gladiator/exchange';
import { notifySafe } from './notify.js';
import { cachedTokenInfo, executePreparedSwap, prepareSwap, swapNet } from './swap-service.js';

const { watchedWallets, watchedWalletSwaps, swapWallets } = schema;

/**
 * Beobachtete Wallets + Copy-Trading (Vision-Punkt 5, „wie Trojan“). Der
 * schnelle Worker-Takt liest je beobachteter Wallet (Solana oder EVM-Kette) die neuen
 * Transaktionen von der Kette, speichert erkannte Swaps und kopiert sie im
 * Paper-Modus: Kauf → fester Betrag in der gewählten Paper-Wallet (gleiches
 * Gate, gleicher Sicherheitscheck wie im Ticket), Verkauf → ganzen eigenen
 * Bestand verkaufen. Echtes Copy-Trading gibt es bewusst nicht (Mensch im
 * Loop: jede Live-Transaktion bestätigt der User selbst).
 */

export const WATCH_INTERVAL_SECONDS = 45;
/** Je Takt höchstens so viele neue Transaktionen je Wallet (öffentliche RPCs drosseln). */
export const WATCH_TX_LIMIT = 10;
/**
 * Zeitbudget je Worker-Takt: Der schnelle Takt überwacht auch offene
 * Positionen (Stops) — langsame RPCs dürfen ihn nicht minutenlang blockieren.
 * Nicht geprüfte Wallets bleiben fällig und kommen im nächsten Takt zuerst.
 */
export const WATCH_BUDGET_MS = 20_000;

export type WalletCopyResult = { checked: number; deferred: number; detected: number; copied: number; skipped: number; failed: number; errors: string[] };

type WatchedRow = typeof watchedWallets.$inferSelect;

/** Swaps seit dem Cursor lesen — Solana: Signatur, EVM: Blocknummer. */
async function fetchSwaps(chain: SwapChainId, address: string, cursor: string | null) {
  return SWAP_CHAINS[chain].kind === 'solana'
    ? fetchSolanaWalletSwaps(address, { limit: WATCH_TX_LIMIT, until: cursor }, swapNet())
    : fetchEvmWalletSwaps(chain, address, { cursor }, swapNet());
}

const sameToken = (chain: SwapChainId, a: string, b: string) => (SWAP_CHAINS[chain].kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b);

async function shortSymbol(chain: SwapChainId, token: string): Promise<string> {
  try {
    return (await cachedTokenInfo(chain, token)).symbol;
  } catch {
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
  }
}

/**
 * Anteil des eigenen Bestands, den ein kopierter Verkauf abgibt: so viel, wie die
 * beobachtete Wallet von IHREM Bestand verkauft hat (Teilverkauf → Teilverkauf).
 * Unbekannt (EVM, fehlender Vorbestand) oder fast alles (≥ 95 %) → ganz raus.
 */
export function copySellPercent(soldPct: number | null | undefined): number {
  if (soldPct === null || soldPct === undefined || !(soldPct > 0) || soldPct >= 95) return 100;
  return Math.max(1, Math.round(soldPct * 100) / 100);
}

/**
 * Mindestgröße für kopierte Käufe: Kleinst-Käufe des Wals (Tests, Köder) nicht
 * nachkaufen. Ohne sichtbaren nativen Gegenwert (Kauf mit Stablecoin) gilt der Filter nicht.
 */
export function belowCopyMin(nativeAtomic: bigint | null, minNative: string | null, nativeDecimals: number): boolean {
  if (!minNative || nativeAtomic === null) return false;
  return nativeAtomic < toAtomic(minNative, nativeDecimals);
}

/** Einen erkannten Swap in der Paper-Wallet nachbilden. */
async function copySwap(db: Db, w: WatchedRow, s: ObservedSwap): Promise<{ status: 'filled' | 'skipped' | 'failed'; note: string; tradeId?: string }> {
  if (w.copyMode !== 'paper' || !w.copyWalletId || !w.copyAmount) return { status: 'skipped', note: 'Kopieren aus' };
  const [wallet] = await db
    .select()
    .from(swapWallets)
    .where(and(eq(swapWallets.id, w.copyWalletId), isNull(swapWallets.archivedAt)));
  // Doppelte Absicherung: nur Paper-Wallets derselben Person auf derselben Kette
  if (!wallet || wallet.userId !== w.userId || wallet.mode !== 'paper' || wallet.chain !== w.chain) {
    return { status: 'skipped', note: 'Ziel-Wallet fehlt oder ist keine Paper-Wallet dieser Kette' };
  }
  const chain = w.chain as SwapChainId;
  const native = SWAP_CHAINS[chain].native;
  if (s.side === 'buy' && belowCopyMin(s.nativeAtomic, w.copyMinNative, native.decimals)) {
    return { status: 'skipped', note: `Wal-Kauf ${fromAtomic(s.nativeAtomic!, native.decimals)} ${native.symbol} unter der Mindestgröße ${w.copyMinNative} ${native.symbol}` };
  }
  let token = s.token;
  if (s.side === 'sell') {
    const held = (await walletBalances(db, wallet.id)).find((b) => sameToken(chain, b.token, s.token));
    if (!held || BigInt(held.amountAtomic) === 0n) return { status: 'skipped', note: 'kein eigener Bestand' };
    token = held.token;
  }
  try {
    const p = await prepareSwap(db, wallet, s.side === 'buy' ? { side: 'buy', token, amount: w.copyAmount } : { side: 'sell', token, percent: copySellPercent(s.soldPct) });
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
  let res: Awaited<ReturnType<typeof fetchSwaps>>;
  try {
    res = await fetchSwaps(w.chain as SwapChainId, w.address, w.lastSignature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.errors.push(`${w.label}: ${msg}`);
    await db.update(watchedWallets).set({ lastCheckedAt: new Date(), lastError: msg }).where(eq(watchedWallets.id, w.id));
    return;
  }
  // erster Lauf = noch nie erfolgreich gelesen (Cursor null; '' heißt: gelesen, aber leer)
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
        nativeAtomic: s.nativeAtomic === null ? null : s.nativeAtomic.toString(),
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
    const symbol = await shortSymbol(w.chain as SwapChainId, s.token);
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
    .set({
      // '' = Wallet ohne Transaktionen: kein „erster Lauf“ mehr, der erste echte Swap wird kopiert
      lastSignature: res.newestSignature,
      lastCheckedAt: new Date(),
      // Lücke ehrlich zeigen statt still zu überspringen
      lastError: res.gap ? 'Wallet sehr aktiv — nicht alle neuen Transaktionen konnten gelesen werden (Lücke möglich).' : null,
    })
    .where(eq(watchedWallets.id, w.id));
}

/** Worker-Takt: fällige beobachtete Wallets prüfen (je Wallet höchstens alle 45 s). */
export async function runWalletCopy(db: Db, budgetMs = WATCH_BUDGET_MS): Promise<WalletCopyResult> {
  const started = Date.now();
  const out: WalletCopyResult = { checked: 0, deferred: 0, detected: 0, copied: 0, skipped: 0, failed: 0, errors: [] };
  const due = await db
    .select()
    .from(watchedWallets)
    .where(
      or(isNull(watchedWallets.lastCheckedAt), sql`${watchedWallets.lastCheckedAt} < now() - ${sql.raw(`interval '${WATCH_INTERVAL_SECONDS} seconds'`)}`),
    )
    // nie geprüfte zuerst, dann die am längsten wartenden
    .orderBy(sql`${watchedWallets.lastCheckedAt} ASC NULLS FIRST`);
  for (const w of due) {
    if (out.checked > 0 && Date.now() - started > budgetMs) {
      out.deferred = due.length - out.checked;
      break;
    }
    await checkWatchedWallet(db, w, out);
  }
  return out;
}

