import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import {
  decryptSecret,
  executeLiveSwap,
  executePaperSwap,
  fetchOnchainBalances,
  fetchSwapQuote,
  fetchTokenInfo,
  fetchTokenPrices,
  fetchTokenSafety,
  fromAtomic,
  isNativeToken,
  isTokenAddress,
  recordLiveSwap,
  setWalletAmounts,
  SWAP_CHAINS,
  toAtomic,
  walletBalances,
  type SwapChainId,
  type SwapQuote,
  type TokenInfo,
  type TokenSafety,
} from '@gladiator/exchange';
import { judgeSwap, type SwapLimits, type SwapVerdict } from '@gladiator/risk';
import { notifySafe } from './notify.js';

const { auditLog } = schema;

/**
 * Swap-Dienst (Vision-Punkt 5): EIN Pfad für Swaps aus dem Ticket (API) und
 * für ausgelöste Limit-/Auto-Sell-Orders (Worker). Token-Infos → Angebot →
 * Sicherheitscheck → Swap-Gate → Paper-Fill bzw. Live-Ausführung (nur mit
 * Betreiber-Schalter, Freigabe der Wallet und Bestätigung).
 */

export type SwapErrorCode = 'BAD_REQUEST' | 'BAD_GATEWAY' | 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED';

export class SwapError extends Error {
  constructor(
    readonly code: SwapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SwapError';
  }
}

/** Betreiber-Schalter (Selbsthoster): ohne ihn nimmt die Instanz keine Wallet-Schlüssel an und führt nichts live aus. */
export const liveKeysAllowed = (): boolean => process.env.WALLET_KEYS_ENABLED === '1';

/** Tests ersetzen das Netz (Aggregatoren/DexScreener/RPC); Produktion nutzt fetch. */
let fetchOverride: typeof fetch | null = null;
export function setSwapFetchForTests(f: typeof fetch | null): void {
  fetchOverride = f;
}
export const swapNet = (): typeof fetch => fetchOverride ?? fetch;

/** Tests ersetzen die echte Ausführung (es wird nie etwas gesendet). */
type LiveExecutor = typeof executeLiveSwap;
let liveOverride: LiveExecutor | null = null;
export function setLiveSwapExecutorForTests(f: LiveExecutor | null): void {
  liveOverride = f;
}

const INFO_TTL_MS = 15_000;
const infoCache = new Map<string, { at: number; info: TokenInfo }>();

export async function cachedTokenInfo(chain: SwapChainId, address: string): Promise<TokenInfo> {
  const key = `${chain}:${address}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS && !fetchOverride) return hit.info;
  const info = await fetchTokenInfo(chain, address, swapNet());
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

const SAFETY_TTL_MS = 60_000;
const safetyCache = new Map<string, { at: number; safety: TokenSafety }>();

/** Sicherheitscheck (60 s gecacht, nur erfolgreiche Prüfungen). */
export async function cachedTokenSafety(chain: SwapChainId, address: string): Promise<TokenSafety> {
  const key = `${chain}:${address}`;
  const hit = safetyCache.get(key);
  if (hit && Date.now() - hit.at < SAFETY_TTL_MS && !fetchOverride) return hit.safety;
  const safety = await fetchTokenSafety(chain, address, swapNet());
  if (safety.checked) safetyCache.set(key, { at: Date.now(), safety });
  return safety;
}

/** Netzfehler ehrlich mit Quelle melden (Aggregator, DexScreener oder RPC nicht erreichbar). */
export function netError(err: unknown): SwapError {
  const detail = err instanceof Error ? err.message : String(err);
  return new SwapError('BAD_GATEWAY', `Markt-/Kettendaten nicht erreichbar (DexScreener, RPC bzw. Aggregator): ${detail}`);
}

export type SwapWalletRow = typeof schema.swapWallets.$inferSelect;

export function limitsOf(w: SwapWalletRow): SwapLimits {
  return {
    maxTradeUsd: Number(w.maxTradeUsd),
    maxSlippageBps: w.maxSlippageBps,
    maxPriceImpactPct: Number(w.maxPriceImpactPct),
    minLiquidityUsd: Number(w.minLiquidityUsd),
    maxTokenTaxPct: Number(w.maxTokenTaxPct),
  };
}

/** Live-Wallet: Mengen von der Kette übernehmen (native + bekannte Tokens + optional ein weiterer). */
export async function syncLiveBalances(db: Db, w: SwapWalletRow, extra?: { address: string; symbol: string; decimals: number }): Promise<void> {
  const chain = w.chain as SwapChainId;
  const native = SWAP_CHAINS[chain].native;
  const known = await walletBalances(db, w.id);
  const tokens = new Map<string, { symbol: string; decimals: number }>([[native.address, native]]);
  for (const b of known) tokens.set(b.token, { symbol: b.symbol, decimals: b.decimals });
  if (extra) tokens.set(extra.address, extra);
  const onchain = await fetchOnchainBalances(chain, w.address, [...tokens.keys()], swapNet());
  await setWalletAmounts(
    db,
    w.id,
    [...tokens.entries()].map(([token, t]) => ({ token, symbol: t.symbol, decimals: t.decimals, amountAtomic: onchain.get(token) ?? 0n })),
  );
}

export type SwapRequest = {
  side: 'buy' | 'sell';
  token: string;
  /** Kauf: Betrag in nativer Währung (Dezimal-String) */
  amount?: string;
  /** Verkauf: Anteil des Bestands in % */
  percent?: number;
  slippageBps?: number;
};

export type PreparedSwap = {
  wallet: SwapWalletRow;
  info: TokenInfo;
  /** nur bei Käufen geprüft (Verkauf: raus muss immer gehen) */
  safety: TokenSafety | null;
  nativePriceUsd: number;
  quote: SwapQuote;
  valueUsd: number;
  verdict: SwapVerdict;
};

export async function prepareSwap(db: Db, wallet: SwapWalletRow, req: SwapRequest): Promise<PreparedSwap> {
  const chain = wallet.chain as SwapChainId;
  const native = SWAP_CHAINS[chain].native;
  if (!isTokenAddress(chain, req.token)) throw new SwapError('BAD_REQUEST', `Keine gültige ${SWAP_CHAINS[chain].name}-Token-Adresse.`);
  if (isNativeToken(chain, req.token)) throw new SwapError('BAD_REQUEST', `${native.symbol} gegen sich selbst tauschen geht nicht.`);
  if (req.side === 'buy' ? req.amount === undefined : req.percent === undefined) {
    throw new SwapError('BAD_REQUEST', 'Kauf braucht einen Betrag, Verkauf einen Anteil in %.');
  }

  let info: TokenInfo;
  let nativeInfo: TokenInfo;
  try {
    [info, nativeInfo] = await Promise.all([cachedTokenInfo(chain, req.token), cachedTokenInfo(chain, native.address)]);
  } catch (err) {
    throw netError(err);
  }
  const nativePriceUsd = nativeInfo.priceUsd ?? Number.NaN;
  if (!(nativePriceUsd > 0)) throw new SwapError('BAD_GATEWAY', `Kein ${native.symbol}-Preis verfügbar — Swap nicht bewertbar.`);
  const token = { address: info.address, symbol: info.symbol, decimals: info.decimals };

  if (wallet.mode === 'live') {
    try {
      await syncLiveBalances(db, wallet, token);
    } catch (err) {
      throw netError(err);
    }
  }

  let inAtomic: bigint;
  if (req.side === 'buy') {
    inAtomic = toAtomic(req.amount!, native.decimals);
  } else {
    const bal = (await walletBalances(db, wallet.id)).find((b) => b.token === req.token);
    const held = BigInt(bal?.amountAtomic ?? '0');
    if (held === 0n) throw new SwapError('BAD_REQUEST', `Kein ${info.symbol}-Bestand in dieser Wallet.`);
    // Prozent in Hundertstel, exakt in bigint
    inAtomic = (held * BigInt(Math.round(req.percent! * 100))) / 10_000n;
  }
  if (inAtomic <= 0n) throw new SwapError('BAD_REQUEST', 'Betrag zu klein.');

  const slippageBps = req.slippageBps ?? wallet.slippageBps;
  let quote: SwapQuote;
  try {
    quote = await fetchSwapQuote(
      { chain, inToken: req.side === 'buy' ? native : token, outToken: req.side === 'buy' ? token : native, inAtomic, slippageBps },
      swapNet(),
    );
  } catch (err) {
    throw netError(err);
  }
  const valueUsd = Number(req.side === 'buy' ? quote.inAmount : quote.outAmount) * nativePriceUsd;
  const safety = req.side === 'buy' ? await cachedTokenSafety(chain, req.token) : null;
  // Empfänger = eigene Wallet: Swaps werden nie mit fremdem Empfänger gebaut (Live-Schritt nutzt dieselbe Adresse)
  const verdict = judgeSwap(
    {
      side: req.side,
      safety: safety?.checked ? { severe: safety.severe, taxPct: safety.taxPct } : null,
      owner: wallet.address,
      recipient: wallet.address,
      valueUsd,
      slippageBps,
      priceImpactPct: quote.priceImpactPct,
      liquidityUsd: info.liquidityUsd,
    },
    limitsOf(wallet),
  );
  return { wallet, info, safety, nativePriceUsd, quote, valueUsd, verdict };
}

export function quoteView(p: PreparedSwap) {
  const q = p.quote;
  return {
    token: p.info,
    side: q.inToken.address === p.info.address ? ('sell' as const) : ('buy' as const),
    inAmount: q.inAmount,
    inSymbol: q.inToken.symbol,
    outAmount: q.outAmount,
    outSymbol: q.outToken.symbol,
    minOut: fromAtomic(q.minOutAtomic, q.outToken.decimals),
    priceImpactPct: Number.isFinite(q.priceImpactPct) ? q.priceImpactPct : null,
    slippageBps: q.slippageBps,
    networkFeeNative: q.networkFeeNative,
    networkFeeUsd: q.networkFeeUsd ?? (q.networkFeeNative !== null ? Number(q.networkFeeNative) * p.nativePriceUsd : null),
    valueUsd: p.valueUsd,
    route: q.route,
    aggregator: q.aggregator,
    safety: p.safety,
    verdict: p.verdict,
  };
}

export type ExecuteContext = {
  userId: string;
  ip: string | null;
  /** 'user' = Klick im Ticket; 'system' = ausgelöste Order (Bestätigung beim Anlegen gegeben). */
  actor: 'user' | 'system';
  /** Live: ausdrückliche Bestätigung (Ticket) bzw. beim Anlegen der Order. */
  confirmedLive: boolean;
  /** Herkunft für Meldung/Audit, z. B. „Take-Profit“. */
  origin?: string;
  /** ausgelöste Order: live nur, solange sie noch „executing“ ist (nicht inzwischen gestoppt) */
  orderId?: string;
};

export type ExecuteResult = { tradeId: string; realizedPnlUsd: number | null; txHash: string | null };

/** Führt ein vorbereitetes Angebot aus: Gate muss grün sein; live zusätzlich Schalter, Freigabe, Bestätigung. */
export async function executePreparedSwap(db: Db, p: PreparedSwap, side: 'buy' | 'sell', ctx: ExecuteContext): Promise<ExecuteResult> {
  if (!p.verdict.allowed) throw new SwapError('PRECONDITION_FAILED', `Swap-Gate: ${p.verdict.reasons.join(', ')}`);
  const w = p.wallet;
  if (w.mode === 'paper') {
    try {
      const trade = await executePaperSwap(db, { walletId: w.id, side, quote: p.quote, nativePriceUsd: p.nativePriceUsd });
      return { tradeId: trade.id, realizedPnlUsd: trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd), txHash: null };
    } catch (err) {
      throw new SwapError('BAD_REQUEST', err instanceof Error ? err.message : String(err));
    }
  }
  return executeLive(db, p, side, ctx);
}

/**
 * Live-Ausführung: Betreiber-Schalter, Freigabe der Wallet, Bestätigung —
 * dann Schlüssel entschlüsseln, Aggregator-Transaktion signieren/senden,
 * Ergebnis verbuchen, auditieren, benachrichtigen.
 */
async function executeLive(db: Db, p: PreparedSwap, side: 'buy' | 'sell', ctx: ExecuteContext): Promise<ExecuteResult> {
  // Wallet FRISCH lesen: zwischen Auslösen und Signieren liegen Sekunden (Angebot,
  // Sicherheitscheck) — wurde die Freigabe inzwischen zurückgezogen oder die
  // Wallet entfernt, wird nichts gesendet.
  const [w] = await db.select().from(schema.swapWallets).where(eq(schema.swapWallets.id, p.wallet.id));
  if (!w || w.archivedAt) throw new SwapError('PRECONDITION_FAILED', 'Wallet wurde entfernt — nichts gesendet.');
  if (ctx.orderId) {
    const [o] = await db.select({ status: schema.swapOrders.status }).from(schema.swapOrders).where(eq(schema.swapOrders.id, ctx.orderId));
    if (o?.status !== 'executing') throw new SwapError('PRECONDITION_FAILED', 'Order wurde inzwischen gestoppt — nichts gesendet.');
  }
  if (!liveKeysAllowed()) throw new SwapError('FORBIDDEN', 'Live-Wallets sind auf dieser Instanz abgeschaltet (WALLET_KEYS_ENABLED).');
  if (!w.liveApprovedAt) throw new SwapError('PRECONDITION_FAILED', 'Diese Wallet ist noch nicht für Live-Swaps freigegeben.');
  if (!ctx.confirmedLive) throw new SwapError('PRECONDITION_FAILED', 'Live-Swap bitte ausdrücklich bestätigen.');
  if (!w.encryptedKey) throw new SwapError('PRECONDITION_FAILED', 'Kein Schlüssel gespeichert.');

  const chain = w.chain as SwapChainId;
  const nativeBal = (await walletBalances(db, w.id)).find((b) => b.token === SWAP_CHAINS[chain].native.address);
  if (side === 'buy' && BigInt(nativeBal?.amountAtomic ?? '0') < BigInt(p.quote.inAtomic)) {
    throw new SwapError(
      'BAD_REQUEST',
      `Guthaben reicht nicht: ${p.quote.inAmount} ${p.quote.inToken.symbol} nötig, ${fromAtomic(nativeBal?.amountAtomic ?? '0', SWAP_CHAINS[chain].native.decimals)} vorhanden (plus Netzwerkgebühr).`,
    );
  }

  await db.insert(auditLog).values({
    actor: ctx.actor,
    userId: ctx.userId,
    action: 'swap.live_execute',
    entityType: 'swap_wallet',
    entityId: w.id,
    details: {
      chain,
      side,
      token: p.info.address,
      inAmount: p.quote.inAmount,
      inSymbol: p.quote.inToken.symbol,
      valueUsd: p.valueUsd,
      slippageBps: p.quote.slippageBps,
      origin: ctx.origin ?? 'ticket',
    },
    ip: ctx.ip,
  });

  let result: Awaited<ReturnType<typeof executeLiveSwap>>;
  try {
    result = await (liveOverride ?? executeLiveSwap)({ quote: p.quote, address: w.address, secret: decryptSecret(w.encryptedKey) }, swapNet());
  } catch (err) {
    // vor dem Senden abgebrochen (Route nicht baubar, Sicherheitsprüfung, Netz) — nichts on-chain
    const msg = err instanceof Error ? err.message : String(err);
    await recordLiveSwap(db, { walletId: w.id, side, quote: p.quote, nativePriceUsd: p.nativePriceUsd, txHash: null, status: 'failed', error: msg, onchain: null });
    throw new SwapError('BAD_GATEWAY', msg);
  }

  let onchain: Map<string, bigint> | null = null;
  if (result.status === 'filled') {
    onchain = await fetchOnchainBalances(chain, w.address, [p.quote.inToken.address, p.quote.outToken.address], swapNet()).catch(() => null);
  }
  const trade = await recordLiveSwap(db, {
    walletId: w.id,
    side,
    quote: p.quote,
    nativePriceUsd: p.nativePriceUsd,
    txHash: result.txHash,
    status: result.status,
    error: result.error,
    onchain,
  });
  const verb = `${ctx.origin ? `${ctx.origin}: ` : ''}${side === 'buy' ? 'Kauf' : 'Verkauf'}`;
  await notifySafe(db, {
    userId: ctx.userId,
    kind: 'system',
    severity: result.status === 'filled' ? 'info' : 'warn',
    title: result.status === 'filled' ? `${verb} ausgeführt: ${p.info.symbol}` : `${verb} fehlgeschlagen: ${p.info.symbol}`,
    body:
      result.status === 'filled'
        ? `${p.quote.inAmount} ${p.quote.inToken.symbol} → ${p.quote.outAmount} ${p.quote.outToken.symbol} (${w.label}, ${SWAP_CHAINS[chain].name})`
        : `${result.error ?? 'unbekannter Fehler'} (${w.label})`,
    link: '#/traden?tab=wallet',
  });
  if (result.status !== 'filled') throw new SwapError('BAD_GATEWAY', `${result.error ?? 'Swap fehlgeschlagen'} (Tx ${result.txHash})`);
  return { tradeId: trade.id, realizedPnlUsd: trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd), txHash: result.txHash };
}

export type WalletValuation = {
  walletId: string;
  label: string;
  chain: SwapChainId;
  mode: 'paper' | 'live';
  /** null = nicht vollständig bewertbar (Kurs fehlt, Kette nicht erreichbar) — nie geschätzt */
  totalUsd: number | null;
  error: string | null;
};

/**
 * Wert aller (nicht entfernten) Swap-Wallets eines Users für „Vermögen“.
 * Live-Wallets lesen ihre Bestände vorher frisch von der Kette.
 */
export async function valueSwapWallets(db: Db, userId: string): Promise<WalletValuation[]> {
  const rows = await db
    .select()
    .from(schema.swapWallets)
    .where(and(eq(schema.swapWallets.userId, userId), isNull(schema.swapWallets.archivedAt)));
  const out: WalletValuation[] = [];
  for (const w of rows) {
    const chain = w.chain as SwapChainId;
    const base = { walletId: w.id, label: w.label, chain, mode: w.mode };
    try {
      if (w.mode === 'live') await syncLiveBalances(db, w);
      const balances = await walletBalances(db, w.id);
      if (balances.length === 0) {
        out.push({ ...base, totalUsd: 0, error: null });
        continue;
      }
      const prices = await fetchTokenPrices(chain, balances.map((b) => b.token), swapNet());
      let total = 0;
      let complete = true;
      for (const b of balances) {
        const price = prices.get(b.token);
        if (price === undefined) complete = false;
        else total += Number(fromAtomic(b.amountAtomic, b.decimals)) * price;
      }
      out.push({ ...base, totalUsd: complete ? total : null, error: complete ? null : 'Kurs für mindestens einen Token fehlt' });
    } catch (err) {
      out.push({ ...base, totalUsd: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
