import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, bsc, mainnet } from 'viem/chains';
import { isNativeToken, rpcUrl, SWAP_CHAINS, type SwapChainId } from './chains.js';
import { JUPITER_API, KYBER_API, type SwapQuote } from './quotes.js';
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

export type LiveSwapResult = { txHash: string; status: 'filled' | 'failed'; error: string | null; approvalTx: string | null };

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
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<LiveSwapResult> {
  const built = (await postJson(
    `${JUPITER_API}/swap`,
    {
      quoteResponse: p.quote.raw,
      userPublicKey: p.address,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } },
    },
    fetchFn,
  )) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (!built.swapTransaction) throw new Error('Jupiter: keine Transaktion erhalten.');
  const signed = signSolanaTx(built.swapTransaction, p.secret, p.address);
  const sig = (await rpc('solana', 'sendTransaction', [signed.tx, { encoding: 'base64', maxRetries: 3, preflightCommitment: 'confirmed' }], fetchFn)) as string;

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await sleep(opts.pollMs ?? 2_000);
    const st = (await rpc('solana', 'getSignatureStatuses', [[sig], { searchTransactionHistory: false }], fetchFn)) as {
      value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
    };
    const s = st.value?.[0];
    if (s?.err) return { txHash: sig, status: 'failed', error: `On-chain fehlgeschlagen: ${JSON.stringify(s.err)}`, approvalTx: null };
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { txHash: sig, status: 'filled', error: null, approvalTx: null };
    if (built.lastValidBlockHeight) {
      const height = (await rpc('solana', 'getBlockHeight', [{ commitment: 'confirmed' }], fetchFn)) as number;
      if (height > built.lastValidBlockHeight) return { txHash: sig, status: 'failed', error: 'Transaktion abgelaufen (nicht in einen Block gekommen).', approvalTx: null };
    }
  }
  return { txHash: sig, status: 'failed', error: 'Keine Bestätigung innerhalb von 90 s — Status bitte im Explorer prüfen.', approvalTx: null };
}

/** EVM: KyberSwap baut die Route mit recipient = eigene Adresse; bei Token-Verkauf vorher exakter approve. */
export async function executeEvmSwap(
  p: { quote: SwapQuote; address: string; secret: string },
  fetchFn: Fetch = fetch,
): Promise<LiveSwapResult> {
  const chainId = p.quote.chain as Exclude<SwapChainId, 'solana'>;
  const slug = SWAP_CHAINS[chainId].kyberSlug!;
  const raw = p.quote.raw as { routeSummary?: unknown };
  const res = (await postJson(
    `${KYBER_API}/${slug}/api/v1/route/build`,
    { routeSummary: raw.routeSummary, sender: p.address, recipient: p.address, slippageTolerance: p.quote.slippageBps, source: 'gladiator' },
    fetchFn,
  )) as { code?: number; message?: string; data?: { data?: string; routerAddress?: string; amountIn?: string; amountOut?: string; transactionValue?: string } };
  const d = res.data;
  if (res.code !== 0 || !d?.data || !d.routerAddress) throw new Error(`KyberSwap: Route nicht baubar (${res.message ?? 'leere Antwort'}).`);
  const router = d.routerAddress.toLowerCase() as `0x${string}`;
  if (!KYBER_ROUTERS.has(router)) throw new Error(`KyberSwap: unbekannter Router ${router} — verweigert.`);
  if (d.amountOut && BigInt(d.amountOut) < BigInt(p.quote.minOutAtomic)) throw new Error('Kurs hat sich bewegt: Ergebnis unter der Mindestmenge — bitte neu anfragen.');

  const account = privateKeyToAccount(p.secret as `0x${string}`);
  if (account.address.toLowerCase() !== p.address.toLowerCase()) throw new Error('Schlüssel passt nicht zur Wallet-Adresse.');
  const transport = http(rpcUrl(chainId), { fetchFn });
  const chain = VIEM_CHAINS[chainId];
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const amountIn = BigInt(p.quote.inAtomic);
  let approvalTx: string | null = null;
  const nativeIn = isNativeToken(chainId, p.quote.inToken.address);
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
  const value = d.transactionValue !== undefined ? BigInt(d.transactionValue) : nativeIn ? amountIn : 0n;
  const hash = await wallet.sendTransaction({ to: router, data: d.data as `0x${string}`, value });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return receipt.status === 'success'
    ? { txHash: hash, status: 'filled', error: null, approvalTx }
    : { txHash: hash, status: 'failed', error: 'Swap on-chain zurückgewiesen (revert).', approvalTx };
}

export async function executeLiveSwap(p: { quote: SwapQuote; address: string; secret: string }, fetchFn: Fetch = fetch): Promise<LiveSwapResult> {
  return SWAP_CHAINS[p.quote.chain].kind === 'solana' ? executeSolanaSwap(p, fetchFn) : executeEvmSwap(p, fetchFn);
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
