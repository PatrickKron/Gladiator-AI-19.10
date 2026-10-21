import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, bsc, mainnet } from 'viem/chains';
import { isNativeToken, rpcUrl, SWAP_CHAINS, type SwapChainId } from './chains.js';
import { JUPITER_API, KYBER_API, type SwapQuote } from './quotes.js';
import { assertKyberSwap, decodeKyberDesc } from './kyber-guard.js';
import { assertJupiterSwapTx } from './solana-guard.js';
import { signSolanaTx } from './solana-tx.js';

/**
 * Live-Swaps aus der eigenen Trading-Wallet (Vision-Punkt 5c). Es gibt hier
 * bewusst KEINE Überweisungs-Funktion: Gebaut werden nur Aggregator-Swaps mit
 * der eigenen Adresse als Empfänger (Jupiter: Ziel = Token-Konto des Nutzers;
 * KyberSwap: `recipient` = Absender) plus — bei EVM-Verkäufen — ein `approve`
 * exakt in Höhe des Verkaufs an den bekannten KyberSwap-Router.
 * Aufrufer: nur `swaps.execute` NACH Swap-Gate, Live-Freigabe der Wallet und
 * Bestätigung des Nutzers.
 */

type Fetch = typeof fetch;

/** Offizieller KyberSwap MetaAggregationRouterV2 (gleiche Adresse auf allen unterstützten EVM-Ketten). */
export const KYBER_ROUTERS = new Set(['0x6131b5fae19ea4f9d964eac0408e4408b66337b5']);

const VIEM_CHAINS: Record<Exclude<SwapChainId, 'solana'>, Chain> = { ethereum: mainnet, base, arbitrum, bsc };
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/**
 * `pending` = gesendet, Ausgang unbekannt (Netz/Timeout NACH dem Senden) — nie
 * als „nichts passiert“ werten, sonst kauft man womöglich doppelt.
 */
export type LiveSwapResult = {
  txHash: string;
  status: 'filled' | 'failed' | 'pending';
  error: string | null;
  approvalTx: string | null;
  /** EVM: Nonce der Swap-Tx (für die spätere Klärung von `pending`) */
  nonce?: number | null;
};

export type LiveSwapOpts = {
  /** Unmittelbar vor dem Signieren: Freigabe/Order erneut prüfen — wirft → nichts signiert, nichts gesendet. */
  beforeSign?: () => Promise<void>;
};

const UNKNOWN = 'Gesendet, Ausgang unklar — bitte NICHT erneut ausführen; Gladiator prüft den Status jede Minute auf der Kette.';

/** Jupiter-Angebot: Mints, Menge und Slippage müssen genau der bestätigten Anfrage entsprechen. */
function assertJupiterQuote(q: SwapQuote): void {
  const raw = q.raw as { inputMint?: string; outputMint?: string; inAmount?: string; slippageBps?: number };
  if (raw.inputMint !== q.inToken.address || raw.outputMint !== q.outToken.address || raw.inAmount !== q.inAtomic || raw.slippageBps !== q.slippageBps) {
    throw new Error('Swap verweigert: Jupiter-Angebot passt nicht zur bestätigten Anfrage.');
  }
}

/** Anfrage an Jupiter `/swap` — exportiert, damit der Echtdaten-Test genau dieselbe Transaktion bauen lässt. */
export function jupiterSwapRequest(quote: SwapQuote, address: string) {
  return {
    quoteResponse: quote.raw,
    userPublicKey: address,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } },
  };
}

/** Erwartungen des Solana-Wächters aus dem bestätigten Angebot. */
export function jupiterExpect(q: SwapQuote) {
  return { inMint: q.inToken.address, outMint: q.outToken.address, inAmount: BigInt(q.inAtomic), quotedOutAmount: BigInt(q.outAtomic), slippageBps: q.slippageBps };
}

async function postJson(url: string, body: unknown, fetchFn: Fetch, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

async function rpc(chain: SwapChainId, method: string, params: unknown[], fetchFn: Fetch): Promise<unknown> {
  const body = (await postJson(rpcUrl(chain), { jsonrpc: '2.0', id: 1, method, params }, fetchFn)) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${chain} ${method}: ${body.error.message ?? 'Fehler'}`);
  return body.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Solana: Jupiter baut die Transaktion, wir prüfen + signieren, senden und warten auf Bestätigung. */
export async function executeSolanaSwap(
  p: { quote: SwapQuote; address: string; secret: string },
  fetchFn: Fetch = fetch,
  opts: { pollMs?: number; timeoutMs?: number } & LiveSwapOpts = {},
): Promise<LiveSwapResult> {
  assertJupiterQuote(p.quote);
  const built = (await postJson(`${JUPITER_API}/swap`, jupiterSwapRequest(p.quote, p.address), fetchFn)) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (!built.swapTransaction) throw new Error('Jupiter: keine Transaktion erhalten.');
  // Inhalt prüfen: genau der bestätigte Jupiter-Swap für uns, nie Überweisungen/Freigaben an andere
  assertJupiterSwapTx(Uint8Array.from(Buffer.from(built.swapTransaction, 'base64')), p.address, jupiterExpect(p.quote));
  await opts.beforeSign?.();
  const signed = signSolanaTx(built.swapTransaction, p.secret, p.address);
  // Signatur = Transaktions-Id steht VOR dem Senden fest
  const sig = signed.signature;
  try {
    await rpc('solana', 'sendTransaction', [signed.tx, { encoding: 'base64', maxRetries: 3, preflightCommitment: 'confirmed' }], fetchFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // JSON-RPC-Fehler = Knoten hat abgelehnt (Preflight) → nicht gesendet; sonst (Netz/Timeout) unklar
    if (msg.startsWith('RPC solana sendTransaction:')) return { txHash: sig, status: 'failed', error: `Abgelehnt: ${msg}`, approvalTx: null };
    return { txHash: sig, status: 'pending', error: UNKNOWN, approvalTx: null };
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await sleep(opts.pollMs ?? 2_000);
    try {
      const st = (await rpc('solana', 'getSignatureStatuses', [[sig], { searchTransactionHistory: false }], fetchFn)) as {
        value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
      };
      const s = st.value?.[0];
      if (s?.err) return { txHash: sig, status: 'failed', error: `On-chain fehlgeschlagen: ${JSON.stringify(s.err)}`, approvalTx: null };
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { txHash: sig, status: 'filled', error: null, approvalTx: null };
      if (built.lastValidBlockHeight) {
        const height = (await rpc('solana', 'getBlockHeight', [{ commitment: 'confirmed' }], fetchFn)) as number;
        if (height > built.lastValidBlockHeight) {
          // abgelaufen — aber zwischen beiden Abfragen kann sie noch gelandet sein: einmal in der Historie nachsehen
          const again = (await rpc('solana', 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }], fetchFn)) as {
            value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
          };
          const s2 = again.value?.[0];
          if (s2?.err) return { txHash: sig, status: 'failed', error: `On-chain fehlgeschlagen: ${JSON.stringify(s2.err)}`, approvalTx: null };
          if (s2) return { txHash: sig, status: s2.confirmationStatus === 'processed' ? 'pending' : 'filled', error: s2.confirmationStatus === 'processed' ? UNKNOWN : null, approvalTx: null };
          return { txHash: sig, status: 'failed', error: 'Transaktion abgelaufen (nicht in einen Block gekommen).', approvalTx: null };
        }
      }
    } catch {
      // Abfrage-Fehler (z. B. 429) heißt nicht „nicht passiert“ — weiter versuchen
    }
  }
  return { txHash: sig, status: 'pending', error: UNKNOWN, approvalTx: null };
}

/**
 * MEV-Schutz: Flashbots Protect (offizieller öffentlicher RPC, ohne Schlüssel)
 * nimmt die signierte Tx privat an und gibt sie direkt an Block-Builder — sie
 * erscheint nie im öffentlichen Mempool, Sandwich-Angriffe auf den Swap
 * entfallen; ein Revert kostet dort kein Gas. Nur Ethereum (Base/Arbitrum haben
 * keinen öffentlichen Mempool, BSC keinen freien Dienst). Abschalten:
 * `MEV_PROTECT=0`; eigener Endpunkt: `MEV_PROTECT_RPC_ETHEREUM`.
 */
export const FLASHBOTS_PROTECT_RPC = 'https://rpc.flashbots.net';

export function mevProtectRpc(chain: SwapChainId, env: Record<string, string | undefined> = process.env): string | null {
  if (chain !== 'ethereum' || env.MEV_PROTECT === '0') return null;
  return env.MEV_PROTECT_RPC_ETHEREUM?.trim() || FLASHBOTS_PROTECT_RPC;
}

/** Erwartungen des KyberSwap-Wächters aus dem bestätigten Angebot. */
export function kyberExpect(q: SwapQuote, owner: string) {
  return {
    owner,
    srcToken: q.inToken.address,
    dstToken: q.outToken.address,
    amountIn: BigInt(q.inAtomic),
    minOut: BigInt(q.minOutAtomic),
    nativeIn: isNativeToken(q.chain, q.inToken.address),
  };
}

/**
 * KyberSwap `/route/build` mit recipient = eigene Adresse, nur bekannter Router.
 * KyberSwap rechnet beim Bauen den Kurs neu und setzt die Mindestmenge daraus —
 * fällt sie unter die BESTÄTIGTE, wird einmal mit engerer Slippage neu gebaut
 * (so dass die Mindestmenge wieder ≥ bestätigt ist), statt die Grenze aufzuweichen.
 */
export async function buildKyberSwap(
  quote: SwapQuote,
  address: string,
  fetchFn: Fetch = fetch,
): Promise<{ data: `0x${string}`; router: `0x${string}`; value: bigint }> {
  const chainId = quote.chain as Exclude<SwapChainId, 'solana'>;
  const slug = SWAP_CHAINS[chainId].kyberSlug!;
  const raw = quote.raw as { routeSummary?: unknown };
  const minOut = BigInt(quote.minOutAtomic);
  const nativeIn = isNativeToken(chainId, quote.inToken.address);
  const build = async (slippageBps: number) => {
    const res = (await postJson(
      `${KYBER_API}/${slug}/api/v1/route/build`,
      { routeSummary: raw.routeSummary, sender: address, recipient: address, slippageTolerance: slippageBps, source: 'gladiator' },
      fetchFn,
    )) as { code?: number; message?: string; data?: { data?: string; routerAddress?: string; amountOut?: string; transactionValue?: string } };
    const d = res.data;
    if (res.code !== 0 || !d?.data || !d.routerAddress) throw new Error(`KyberSwap: Route nicht baubar (${res.message ?? 'leere Antwort'}).`);
    const router = d.routerAddress.toLowerCase() as `0x${string}`;
    if (!KYBER_ROUTERS.has(router)) throw new Error(`KyberSwap: unbekannter Router ${router} — verweigert.`);
    const data = d.data as `0x${string}`;
    const out = d.amountOut !== undefined ? BigInt(d.amountOut) : null;
    if (out !== null && out < minOut) throw new Error('Kurs hat sich bewegt: Ergebnis unter der Mindestmenge — bitte neu anfragen.');
    const value = d.transactionValue !== undefined ? BigInt(d.transactionValue) : nativeIn ? BigInt(quote.inAtomic) : 0n;
    return { data, router, value, out, minReturn: decodeKyberDesc(data).minReturnAmount };
  };
  let b = await build(quote.slippageBps);
  if (b.minReturn < minOut && b.out !== null) {
    // engere Toleranz, damit out × (1 − s) ≥ bestätigte Mindestmenge
    const tighter = Number(((b.out - minOut) * 10_000n) / b.out);
    if (tighter < 1) throw new Error('Kurs hat sich bewegt: Ergebnis an der Mindestmenge — bitte neu anfragen.');
    b = await build(Math.min(tighter, quote.slippageBps));
  }
  return { data: b.data, router: b.router, value: b.value };
}

/** EVM: KyberSwap baut die Route mit recipient = eigene Adresse; bei Token-Verkauf vorher exakter approve. */
export async function executeEvmSwap(
  p: { quote: SwapQuote; address: string; secret: string },
  fetchFn: Fetch = fetch,
  opts: LiveSwapOpts = {},
): Promise<LiveSwapResult> {
  const chainId = p.quote.chain as Exclude<SwapChainId, 'solana'>;
  const d = await buildKyberSwap(p.quote, p.address, fetchFn);
  const router = d.router;

  const account = privateKeyToAccount(p.secret as `0x${string}`);
  if (account.address.toLowerCase() !== p.address.toLowerCase()) throw new Error('Schlüssel passt nicht zur Wallet-Adresse.');
  const transport = http(rpcUrl(chainId), { fetchFn });
  const chain = VIEM_CHAINS[chainId];
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const amountIn = BigInt(p.quote.inAtomic);
  let approvalTx: string | null = null;
  const nativeIn = isNativeToken(chainId, p.quote.inToken.address);
  const value = d.value;
  // Calldata dekodieren und gegen das bestätigte Angebot prüfen (Empfänger, Tokens, Mengen, Gebühren, value)
  assertKyberSwap(d.data, value, kyberExpect(p.quote, p.address));
  await opts.beforeSign?.();
  if (!nativeIn) {
    const token = p.quote.inToken.address as `0x${string}`;
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [account.address, router] });
    if (allowance < amountIn) {
      // exakt die Verkaufsmenge — kein „unbegrenztes“ Approve
      approvalTx = await wallet.sendTransaction({ to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, amountIn] }), value: 0n });
      const r = await pub.waitForTransactionReceipt({ hash: approvalTx as `0x${string}`, timeout: 120_000 });
      if (r.status !== 'success') return { txHash: approvalTx, status: 'failed', error: 'Freigabe (approve) on-chain fehlgeschlagen.', approvalTx };
    }
  }
  // lokal signieren → Hash steht VOR dem Senden fest
  const request = await wallet.prepareTransactionRequest({ to: router, data: d.data as `0x${string}`, value });
  const serialized = await wallet.signTransaction(request);
  const hash = keccak256(serialized);
  const protectedRpc = mevProtectRpc(chainId);
  try {
    // Ethereum: privat über Flashbots Protect (kein öffentlicher Mempool → kein Sandwich)
    const sender = protectedRpc ? createPublicClient({ chain, transport: http(protectedRpc, { fetchFn }) }) : pub;
    await sender.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    // privat gesendet: öffentliche Knoten kennen die Tx nicht → Fehler heißt hier nie „sicher nicht gesendet“
    if (protectedRpc) return { txHash: hash, status: 'pending', error: UNKNOWN, approvalTx, nonce: request.nonce ?? null };
    // abgelehnt oder doch angekommen? Nur „sicher unbekannt beim Knoten“ zählt als nicht gesendet
    const known = await pub.getTransaction({ hash }).then(
      () => true,
      (e: unknown) => ((e as { name?: string }).name === 'TransactionNotFoundError' ? false : null),
    );
    if (known === false) return { txHash: hash, status: 'failed', error: `Abgelehnt: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, approvalTx };
    return { txHash: hash, status: 'pending', error: UNKNOWN, approvalTx, nonce: request.nonce ?? null };
  }
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    return receipt.status === 'success'
      ? { txHash: hash, status: 'filled', error: null, approvalTx }
      : { txHash: hash, status: 'failed', error: 'Swap on-chain zurückgewiesen (revert).', approvalTx };
  } catch {
    return { txHash: hash, status: 'pending', error: UNKNOWN, approvalTx, nonce: request.nonce ?? null };
  }
}

export async function executeLiveSwap(p: { quote: SwapQuote; address: string; secret: string }, fetchFn: Fetch = fetch, opts: LiveSwapOpts = {}): Promise<LiveSwapResult> {
  return SWAP_CHAINS[p.quote.chain].kind === 'solana' ? executeSolanaSwap(p, fetchFn, opts) : executeEvmSwap(p, fetchFn, opts);
}

/** Ab hier gilt eine nirgends gefundene Solana-Signatur als nie gelandet (Blockhash ≈ 60–90 s gültig). */
export const SOLANA_UNSEEN_FAIL_MS = 5 * 60_000;
/** EVM: ohne Beleg frühestens nach 2 h und nur bei anders verbrauchter Nonce als „nie gelandet“ werten. */
export const EVM_UNSEEN_FAIL_MS = 2 * 60 * 60_000;

/**
 * Stand eines gesendeten Swaps auf der Kette („Ausgang unklar“ klären).
 * pending = noch keine Aussage möglich — nie raten.
 */
export async function checkLiveSwapStatus(
  chain: SwapChainId,
  txHash: string,
  ageMs: number,
  fetchFn: Fetch = fetch,
  /** EVM: Absender + Nonce der Tx — nur damit ist „nie gelandet“ sicher feststellbar */
  sent: { from?: string; nonce?: number | null } = {},
): Promise<{ status: 'filled' | 'failed' | 'pending'; error: string | null }> {
  if (SWAP_CHAINS[chain].kind === 'solana') {
    const st = (await rpc(chain, 'getSignatureStatuses', [[txHash], { searchTransactionHistory: true }], fetchFn)) as {
      value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
    };
    const s = st.value?.[0] ?? null;
    if (s?.err) return { status: 'failed', error: `On-chain fehlgeschlagen: ${JSON.stringify(s.err)}` };
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { status: 'filled', error: null };
    if (!s && ageMs > SOLANA_UNSEEN_FAIL_MS) return { status: 'failed', error: 'Transaktion abgelaufen (nie in einen Block gekommen).' };
    return { status: 'pending', error: null };
  }
  const receipt = (await rpc(chain, 'eth_getTransactionReceipt', [txHash], fetchFn)) as { status?: string } | null;
  if (receipt?.status === '0x1') return { status: 'filled', error: null };
  if (receipt?.status === '0x0') return { status: 'failed', error: 'Swap on-chain zurückgewiesen (revert).' };
  // Ohne Beleg ist eine Tx erst sicher „nie gelandet“, wenn ihre Nonce von einer ANDEREN Tx
  // verbraucht wurde (dann kann sie nie mehr in einen Block). Ein einzelner Knoten, der sie
  // nicht kennt, beweist nichts — sie kann in anderen Mempools stecken.
  if (!receipt && ageMs > EVM_UNSEEN_FAIL_MS && sent.from && typeof sent.nonce === 'number') {
    const count = BigInt((await rpc(chain, 'eth_getTransactionCount', [sent.from, 'latest'], fetchFn)) as string);
    if (count > BigInt(sent.nonce)) return { status: 'failed', error: 'Transaktion nie in einen Block gekommen (Nonce inzwischen anders verbraucht).' };
  }
  return { status: 'pending', error: null };
}

/** On-chain-Bestände (kleinste Einheit) der nativen Währung + angefragter Tokens. */
export async function fetchOnchainBalances(chain: SwapChainId, owner: string, tokens: string[], fetchFn: Fetch = fetch): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const native = SWAP_CHAINS[chain].native.address;
  if (SWAP_CHAINS[chain].kind === 'solana') {
    const bal = (await rpc(chain, 'getBalance', [owner, { commitment: 'confirmed' }], fetchFn)) as { value?: number };
    out.set(native, BigInt(bal.value ?? 0));
    for (const mint of tokens.filter((t) => !isNativeToken(chain, t))) {
      const r = (await rpc(chain, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], fetchFn)) as {
        value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[];
      };
      out.set(mint, (r.value ?? []).reduce((s, a) => s + BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0'), 0n));
    }
    return out;
  }
  const hex = (await rpc(chain, 'eth_getBalance', [owner, 'latest'], fetchFn)) as string;
  out.set(native, BigInt(hex));
  for (const token of tokens.filter((t) => !isNativeToken(chain, t))) {
    // balanceOf(address) = 0x70a08231
    const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, '0')}`;
    const r = (await rpc(chain, 'eth_call', [{ to: token, data }, 'latest'], fetchFn)) as string;
    out.set(token, r && r !== '0x' ? BigInt(r) : 0n);
  }
  return out;
}
