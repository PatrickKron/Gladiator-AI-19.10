import { isStablecoin, SWAP_CHAINS, type SwapChainId } from './chains.js';
import { fetchTokenDecimals } from './token-info.js';
import { tokenVsStable, type ObservedSwap, type WalletSwapsPage } from './wallet-activity.js';

/**
 * Swaps einer fremden EVM-Wallet von der Kette lesen (Ethereum, Base,
 * Arbitrum, BSC; Gegenstück zu wallet-activity.ts für Solana). EVM kennt keine
 * Swap-Liste je Adresse: ERC-20-Transfer-Logs von/an die Wallet blockweise per
 * `eth_getLogs`, je Transaktion Saldo-Differenzen je Token + der mitgeschickte
 * native Betrag (`value`). Wrapped Native (WETH/WBNB) zählt als nativ.
 * Ein Verkauf zählt nur mit SICHTBAREM Erlös: WETH/Stablecoin an die Wallet
 * oder ein Unwrap (`Withdrawal` des Wrapped-Native-Vertrags) in derselben
 * Transaktion — so werden Überweisungen, Bridges, Staking, Multisend nie als
 * Verkauf kopiert. Airdrops und NFTs sind nie ein Swap.
 */

type Fetch = typeof fetch;

/** keccak256("Withdrawal(address,uint256)") — WETH/WBNB auspacken (Router zahlt natives ETH aus) */
export const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Nur Blöcke mit so vielen Bestätigungen lesen: lastverteilte öffentliche Knoten
 * hängen oft ein paar Blöcke hinterher, und an der Spitze gibt es Reorgs — der
 * Cursor darf nie über Blöcke springen, deren Logs der Knoten noch nicht hatte.
 */
export const EVM_CONFIRMATIONS = 3n;

/** Höchstens so viele Blöcke je Abruf (öffentliche RPCs begrenzen `eth_getLogs`). */
export const EVM_MAX_BLOCKS = 500;
/** Höchstens so viele Transaktionen je Abruf (Spam-Airdrops dürfen den Takt nicht fluten). */
export const EVM_MAX_TXS = 15;

/**
 * `eth_getLogs` ohne Vertragsadresse (nur Topics = „alle Transfers dieser
 * Wallet“) lehnen manche öffentlichen RPCs ab (z. B. publicnode: „Please
 * specify an address“). Deshalb je Kette eine Liste öffentlicher Endpunkte,
 * offizielle zuerst; der erste, der die Abfrage annimmt, wird gemerkt.
 * Selbsthoster setzen `RPC_URL_LOGS_<KETTE>` (oder `RPC_URL_<KETTE>`).
 */
export const EVM_LOG_RPCS: Record<Exclude<SwapChainId, 'solana'>, string[]> = {
  ethereum: ['https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://1rpc.io/base', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org', 'https://1rpc.io/arb', 'https://arbitrum.llamarpc.com', 'https://arbitrum-one-rpc.publicnode.com'],
  bsc: ['https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com', 'https://bsc-rpc.publicnode.com'],
};

/** Kandidaten in Reihenfolge: eigener Logs-RPC, eigener RPC, öffentliche Liste (ohne Doppelte). */
export function logRpcCandidates(chain: SwapChainId, env: Record<string, string | undefined> = process.env): string[] {
  const up = chain.toUpperCase();
  const own = [env[`RPC_URL_LOGS_${up}`]?.trim(), env[`RPC_URL_${up}`]?.trim()].filter((x): x is string => Boolean(x));
  const pub = chain === 'solana' ? [] : EVM_LOG_RPCS[chain];
  return [...new Set([...own, ...pub])];
}

/** Zuletzt funktionierender Logs-RPC je Kette (Prozess-Cache). */
const workingLogRpc = new Map<SwapChainId, string>();

export type EvmLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex?: string };
export type EvmTx = { from: string; to: string | null; value: string };

const lc = (a: string) => a.toLowerCase();
const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase();
export const padTopic = (addr: string) => `0x${'0'.repeat(24)}${lc(addr).slice(2)}`;

/**
 * Reine Auswertung einer EVM-Transaktion aus Sicht von `owner` (getestet).
 * `logs`: alle ERC-20-Transfers dieser Transaktion, an denen `owner` beteiligt ist.
 */
export function deriveEvmSwap(
  chain: SwapChainId,
  hash: string,
  tx: EvmTx,
  logs: EvmLog[],
  owner: string,
  decimals: (token: string) => number,
  time: number | null,
  /** in derselben Tx ausgepacktes Wrapped Native (Router-Auszahlung in ETH), aus dem Receipt */
  unwrapped = 0n,
): ObservedSwap | null {
  const me = lc(owner);
  const wrapped = lc(SWAP_CHAINS[chain].wrappedNative);
  const deltas = new Map<string, bigint>();
  for (const l of logs) {
    // ERC-20: genau 3 Topics + Betrag in data; ERC-721 hat 4 Topics → kein Token-Handel
    if (l.topics.length !== 3 || lc(l.topics[0]!) !== ERC20_TRANSFER_TOPIC || !l.data || l.data === '0x') continue;
    const amount = BigInt(l.data.slice(0, 66));
    if (amount === 0n) continue;
    const token = lc(l.address);
    const from = topicAddr(l.topics[1]!);
    const to = topicAddr(l.topics[2]!);
    if (from === me && to === me) continue;
    if (from === me) deltas.set(token, (deltas.get(token) ?? 0n) - amount);
    if (to === me) deltas.set(token, (deltas.get(token) ?? 0n) + amount);
  }
  let native = 0n;
  const sentByOwner = lc(tx.from) === me;
  if (sentByOwner) native -= BigInt(tx.value || '0x0');
  const w = deltas.get(wrapped);
  if (w !== undefined) {
    native += w;
    deltas.delete(wrapped);
  }
  const changed = [...deltas.entries()].filter(([, d]) => d !== 0n);
  const ups = changed.filter(([, d]) => d > 0n);
  const downs = changed.filter(([, d]) => d < 0n);
  const base = { signature: hash, time };

  // Native ↔ Stablecoin ist Absichern/Umschichten, kein Token-Handel → nie kopieren
  const onlyStable = [...ups, ...downs].length === 1 && isStablecoin(chain, (ups[0] ?? downs[0])![0]);
  if (onlyStable) return null;
  // Native → Token
  if (native < 0n && ups.length === 1 && downs.length === 0) {
    const [token, d] = ups[0]!;
    return { ...base, side: 'buy', token, tokenAtomic: d, tokenDecimals: decimals(token), nativeAtomic: -native, counterToken: null };
  }
  // Token → Native: Erlös sichtbar als WETH an die Wallet oder als Unwrap in derselben, von ihr gesendeten Tx
  if (downs.length === 1 && ups.length === 0 && (native > 0n || (sentByOwner && native === 0n && unwrapped > 0n))) {
    const [token, d] = downs[0]!;
    return { ...base, side: 'sell', token, tokenAtomic: -d, tokenDecimals: decimals(token), nativeAtomic: native > 0n ? native : unwrapped, counterToken: null };
  }
  // Token ↔ Stablecoin
  const wrap = (list: [string, bigint][]) => list.map(([t, d]) => [t, { delta: d, decimals: decimals(t) }] as [string, { delta: bigint; decimals: number }]);
  return tokenVsStable(hash, time, native === 0n, wrap(ups), wrap(downs), (t) => isStablecoin(chain, t));
}

const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

/**
 * Summe ausgepackter Wrapped-Native-Beträge in einem Receipt: WETH9-`Withdrawal`
 * bzw. — Arbitrums aeWETH meldet kein Withdrawal — ein Burn (`Transfer` an 0x0)
 * des Wrapped-Native-Vertrags. Bekannte Lücke: Pools mit nativem ETH ohne WETH
 * (Uniswap v4) zeigen den Erlös nirgends im Receipt → solche Verkäufe bleiben
 * unerkannt statt geraten.
 */
export function unwrappedIn(chain: SwapChainId, receiptLogs: { address: string; topics: string[]; data: string }[]): bigint {
  const wrapped = lc(SWAP_CHAINS[chain].wrappedNative);
  let withdrawn = 0n;
  let burned = 0n;
  for (const l of receiptLogs) {
    if (lc(l.address) !== wrapped || !l.data || l.data === '0x') continue;
    const t0 = lc(l.topics[0] ?? '');
    if (t0 === WETH_WITHDRAWAL_TOPIC) withdrawn += BigInt(l.data.slice(0, 66));
    else if (t0 === ERC20_TRANSFER_TOPIC && l.topics.length === 3 && lc(l.topics[2]!) === ZERO_TOPIC) burned += BigInt(l.data.slice(0, 66));
  }
  // nie doppelt zählen, falls ein Vertrag beides meldet
  return withdrawn > burned ? withdrawn : burned;
}

/** Pause vor dem einen Wiederholungsversuch bei HTTP 429 (Tests setzen 0). */
let retryDelayMs = 1_500;
export function setEvmRetryDelayForTests(ms: number | null): void {
  retryDelayMs = ms ?? 1_500;
}

async function rpc(chain: SwapChainId, url: string, method: string, params: unknown[], fetchFn: Fetch): Promise<unknown> {
  const send = () =>
    fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  let res = await send();
  // öffentliche Knoten drosseln kurzzeitig → genau ein zweiter Versuch
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    res = await send();
  }
  if (!res.ok) throw new Error(`RPC ${chain} ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${chain} ${method}: ${body.error.message ?? 'Fehler'}`);
  return body.result;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

/**
 * Swaps einer EVM-Wallet seit Block `cursor` (exklusive), neueste zuerst.
 * Ohne Cursor: die letzten `EVM_MAX_BLOCKS` Blöcke (Verlauf). Liegt der Cursor
 * weiter zurück, werden nur die jüngsten Blöcke gelesen — lieber eine Lücke
 * als Wochen alte Trades nachkopieren. Gibt den neuen Cursor (Blocknummer) zurück.
 */
export async function fetchEvmWalletSwaps(
  chain: SwapChainId,
  owner: string,
  opts: { cursor?: string | null; maxBlocks?: number; maxTxs?: number } = {},
  fetchFn: Fetch = fetch,
): Promise<WalletSwapsPage> {
  const maxBlocks = BigInt(opts.maxBlocks ?? EVM_MAX_BLOCKS);
  const cursor = opts.cursor ? BigInt(opts.cursor) : null;

  // Ersten Endpunkt nehmen, der Blocknummer UND adressfreie Logs liefert (der gemerkte zuerst)
  const cached = workingLogRpc.get(chain);
  const candidates = logRpcCandidates(chain);
  const order = cached && candidates.includes(cached) ? [cached, ...candidates.filter((c) => c !== cached)] : candidates;
  const problems: string[] = [];
  for (const url of order) {
    try {
      const head = BigInt((await rpc(chain, url, 'eth_blockNumber', [], fetchFn)) as string);
      const latest = head > EVM_CONFIRMATIONS ? head - EVM_CONFIRMATIONS : 0n;
      // hinterherhängender Knoten: Cursor nie zurückdrehen (sonst wird doppelt gelesen)
      if (cursor !== null && latest <= cursor) return { swaps: [], newestSignature: cursor.toString(), gap: false };
      const floor = latest - maxBlocks + 1n > 0n ? latest - maxBlocks + 1n : 0n;
      const from = cursor === null ? floor : cursor + 1n > floor ? cursor + 1n : floor;
      if (from > latest) return { swaps: [], newestSignature: latest.toString(), gap: false };
      // Cursor lag weiter zurück als das Fenster → Lücke (ehrlich melden statt still)
      const gap = cursor !== null && cursor + 1n < floor;
      const range = { fromBlock: hex(from), toBlock: hex(latest) };
      // nacheinander statt parallel: öffentliche Knoten drosseln gleichzeitige Log-Abfragen
      const outgoing = (await rpc(chain, url, 'eth_getLogs', [{ ...range, topics: [ERC20_TRANSFER_TOPIC, padTopic(owner)] }], fetchFn)) as EvmLog[];
      const incoming = (await rpc(chain, url, 'eth_getLogs', [{ ...range, topics: [ERC20_TRANSFER_TOPIC, null, padTopic(owner)] }], fetchFn)) as EvmLog[];
      workingLogRpc.set(chain, url);
      const page = await readSwaps(chain, url, owner, outgoing ?? [], incoming ?? [], latest, cursor === null, opts.maxTxs ?? EVM_MAX_TXS, fetchFn);
      return { ...page, gap: page.gap || gap };
    } catch (err) {
      problems.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
      if (workingLogRpc.get(chain) === url) workingLogRpc.delete(chain);
    }
  }
  throw new Error(
    `Kein ${SWAP_CHAINS[chain].name}-RPC liefert die Transfer-Logs (${problems.join(' | ')}). Eigenen Knoten per RPC_URL_LOGS_${chain.toUpperCase()} setzen.`,
  );
}

async function readSwaps(
  chain: SwapChainId,
  url: string,
  owner: string,
  outgoing: EvmLog[],
  incoming: EvmLog[],
  latest: bigint,
  firstRun: boolean,
  maxTxs: number,
  fetchFn: Fetch,
): Promise<WalletSwapsPage> {
  const byTx = new Map<string, EvmLog[]>();
  for (const l of [...outgoing, ...incoming]) {
    const list = byTx.get(l.transactionHash) ?? [];
    // derselbe Log kann in beiden Listen stehen (von mir an mich) — nur einmal zählen
    if (!list.some((x) => x.logIndex !== undefined && x.logIndex === l.logIndex)) list.push(l);
    byTx.set(l.transactionHash, list);
  }
  const blockOf = (logs: EvmLog[]) => BigInt(logs[0]!.blockNumber);
  const chrono = [...byTx.entries()].sort((a, b) => (blockOf(a[1]) < blockOf(b[1]) ? -1 : blockOf(a[1]) > blockOf(b[1]) ? 1 : 0));
  let txs = chrono;
  let cursor = latest;
  if (chrono.length > maxTxs) {
    if (firstRun) {
      // Verlauf: nur die jüngsten
      txs = chrono.slice(-maxTxs);
    } else {
      // lückenlos: die ältesten, an einer Blockgrenze geschnitten; Rest im nächsten Takt
      const firstLeft = blockOf(chrono[maxTxs]![1]);
      txs = chrono.filter(([, l]) => blockOf(l) < firstLeft);
      if (txs.length === 0) {
        // mehr als maxTxs in EINEM Block: diesen Block ganz lesen
        txs = chrono.filter(([, l]) => blockOf(l) === firstLeft);
        cursor = firstLeft;
      } else {
        cursor = firstLeft - 1n;
      }
    }
  }

  const decimals = new Map<string, number>();
  const blockTime = new Map<string, number | null>();
  const swaps: ObservedSwap[] = [];
  for (const [hash, logs] of txs) {
    const tx = (await rpc(chain, url, 'eth_getTransactionByHash', [hash], fetchFn)) as EvmTx | null;
    if (!tx) continue;
    for (const l of logs) {
      const t = lc(l.address);
      if (!decimals.has(t) && t !== lc(SWAP_CHAINS[chain].wrappedNative)) {
        try {
          decimals.set(t, await fetchTokenDecimals(chain, t, fetchFn));
        } catch {
          decimals.set(t, -1); // kein ERC-20 (z. B. NFT) → wird unten verworfen
        }
      }
    }
    const blockNo = logs[0]!.blockNumber;
    if (!blockTime.has(blockNo)) {
      const b = (await rpc(chain, url, 'eth_getBlockByNumber', [blockNo, false], fetchFn)) as { timestamp?: string } | null;
      blockTime.set(blockNo, b?.timestamp ? Number(BigInt(b.timestamp)) : null);
    }
    // Erlös-Nachweis für Verkäufe gegen natives ETH: Unwrap im Receipt (nur bei eigenen Tx nötig)
    let unwrapped = 0n;
    if (lc(tx.from) === lc(owner)) {
      const receipt = (await rpc(chain, url, 'eth_getTransactionReceipt', [hash], fetchFn)) as { logs?: EvmLog[] } | null;
      unwrapped = unwrappedIn(chain, receipt?.logs ?? []);
    }
    const s = deriveEvmSwap(chain, hash, tx, logs, owner, (t) => decimals.get(t) ?? -1, blockTime.get(blockNo) ?? null, unwrapped);
    if (s && s.tokenDecimals >= 0) swaps.push(s);
  }
  return { swaps: swaps.reverse(), newestSignature: cursor.toString(), gap: false };
}
