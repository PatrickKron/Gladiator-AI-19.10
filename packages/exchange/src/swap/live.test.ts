/**
 * Live-Swaps (Vision-Punkt 5c). Netz in den ersten Blöcken injiziert (Jupiter,
 * KyberSwap, JSON-RPC) — es wird nichts gesendet. Der Block „echte Daten" lässt
 * Jupiter/KyberSwap echte Transaktionen für eine frisch erzeugte, LEERE Wallet
 * bauen und prüft unsere Sicherheitsannahmen (Gebührenzahler, Router-Adresse,
 * Empfänger) — gesendet wird auch dort nichts.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { parseTransaction, decodeFunctionData, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { EVM_NATIVE, SWAP_CHAINS, toAtomic } from './chains.js';
import { base58Decode, generateWalletKey } from './keys.js';
import { buildKyberSwap, checkLiveSwapStatus, EVM_UNSEEN_FAIL_MS, executeEvmSwap, FLASHBOTS_PROTECT_RPC, mevProtectRpc, SOLANA_UNSEEN_FAIL_MS, executeSolanaSwap, fetchOnchainBalances, jupiterExpect, jupiterSwapRequest, KYBER_ROUTERS, kyberExpect } from './live.js';
import { fetchSwapQuote, JUPITER_API, KYBER_API, type SwapQuote } from './quotes.js';
import { parseSolanaTx, signSolanaTx } from './solana-tx.js';
import { assertJupiterSwapTx } from './solana-guard.js';
import { assertKyberSwap } from './kyber-guard.js';
import { kyberSwapCalldata } from './testing/kyber-calldata.js';
import { buildV0Tx, jupiterLikeIxs, systemTransfer } from './testing/solana-tx-builder.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';


function solQuote(): SwapQuote {
  return {
    chain: 'solana',
    aggregator: 'jupiter',
    inToken: SWAP_CHAINS.solana.native,
    outToken: { address: USDC_SOL, symbol: 'USDC', decimals: 6 },
    inAtomic: '10000000',
    outAtomic: '1500000',
    minOutAtomic: '1490000',
    inAmount: '0.01',
    outAmount: '1.5',
    slippageBps: 50,
    priceImpactPct: 0.01,
    networkFeeNative: '0.000005',
    networkFeeUsd: null,
    route: ['Raydium'],
    raw: { inputMint: SWAP_CHAINS.solana.native.address, outputMint: USDC_SOL, inAmount: '10000000', outAmount: '1500000', slippageBps: 50 },
  };
}

describe('Solana-Live-Swap (Netz injiziert)', () => {
  const k = generateWalletKey('solana');

  function net(
    status: unknown,
    opts: { feePayer?: string; tx?: string; send?: 'ok' | 'network' | 'rejected'; statusErrors?: number; height?: number; history?: unknown } = {},
  ) {
    const sent: string[] = [];
    const calls: string[] = [];
    let statusErrors = opts.statusErrors ?? 0;
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown[]; userPublicKey?: string };
      if (String(url) === `${JUPITER_API}/swap`) {
        calls.push(`jup:${body.userPublicKey}`);
        const tx = opts.tx ?? buildV0Tx(opts.feePayer ?? k.address, jupiterLikeIxs(k.address, jupiterExpect(solQuote())));
        return new Response(JSON.stringify({ swapTransaction: tx, lastValidBlockHeight: 1_000 }));
      }
      calls.push(body.method!);
      if (body.method === 'sendTransaction') {
        sent.push((body.params as string[])[0]!);
        if (opts.send === 'network') throw new TypeError('fetch failed');
        if (opts.send === 'rejected') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Transaction simulation failed' } }));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'egal' }));
      }
      if (body.method === 'getSignatureStatuses') {
        if (statusErrors-- > 0) return new Response('zu viele', { status: 429 });
        const history = (body.params as [unknown, { searchTransactionHistory?: boolean }])[1]?.searchTransactionHistory;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [history ? (opts.history ?? null) : status] } }));
      }
      if (body.method === 'getBlockHeight') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: opts.height ?? 900 }));
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;
    return { f, sent, calls };
  }

  it('baut über Jupiter für die EIGENE Adresse, signiert korrekt, wartet auf Bestätigung', async () => {
    const n = net({ confirmationStatus: 'confirmed', err: null });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 });
    expect(n.calls[0]).toBe(`jup:${k.address}`);
    const tx = Buffer.from(n.sent[0]!, 'base64');
    expect(ed25519.verify(tx.subarray(1, 65), tx.subarray(65), base58Decode(k.address))).toBe(true);
    // Transaktions-Id = unsere Signatur, schon vor dem Senden bekannt
    expect(r).toMatchObject({ status: 'filled', error: null });
    expect(base58Decode(r.txHash)).toEqual(Uint8Array.from(tx.subarray(1, 65)));
  });

  it('Diebstahl in der gelieferten Transaktion (SOL an Fremde) → nicht signiert, nichts gesendet', async () => {
    const thief = generateWalletKey('solana').address;
    const n = net(null, { tx: buildV0Tx(k.address, [...jupiterLikeIxs(k.address, jupiterExpect(solQuote())), systemTransfer(k.address, thief, 9_000_000_000n)]) });
    await expect(executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 })).rejects.toThrow(/fremdes Konto/);
    expect(n.sent).toHaveLength(0);
  });

  it('Angebot passt nicht zur Anfrage (anderer Mint/Menge) → nicht einmal gebaut', async () => {
    const n = net(null);
    const q = solQuote();
    await expect(executeSolanaSwap({ quote: { ...q, raw: { ...(q.raw as object), inAmount: '999999999' } }, address: k.address, secret: k.secret }, n.f)).rejects.toThrow(/passt nicht/);
    expect(n.calls).toHaveLength(0);
  });

  it('Haken vor dem Signieren wirft (Freigabe zurückgezogen) → nichts signiert, nichts gesendet', async () => {
    const n = net(null);
    const beforeSign = async () => {
      throw new Error('Freigabe zurückgezogen');
    };
    await expect(executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1, beforeSign })).rejects.toThrow(/zurückgezogen/);
    expect(n.sent).toHaveLength(0);
  });

  it('Netzfehler NACH dem Signieren → „pending“ mit Tx-Id (nie „nichts passiert“); Knoten-Ablehnung → failed', async () => {
    const a = net(null, { send: 'network' });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, a.f, { pollMs: 1 });
    expect(r).toMatchObject({ status: 'pending' });
    expect(r.error).toMatch(/NICHT erneut/);
    expect(r.txHash.length).toBeGreaterThan(60);
    const b = net(null, { send: 'rejected' });
    expect(await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, b.f, { pollMs: 1 })).toMatchObject({ status: 'failed' });
  });

  it('Blockhash abgelaufen: in der Historie gelandet → filled (OCO greift), sonst failed', async () => {
    const landed = net(null, { height: 2_000, history: { confirmationStatus: 'finalized', err: null } });
    expect((await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, landed.f, { pollMs: 1 })).status).toBe('filled');
    const gone = net(null, { height: 2_000 });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, gone.f, { pollMs: 1 });
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.error).toMatch(/abgelaufen/);
  });

  it('Jupiter liefert eine Route an ein fremdes Ziel-Konto → nicht signiert, nichts gesendet', async () => {
    const thief = generateWalletKey('solana').address;
    const tx = buildV0Tx(k.address, jupiterLikeIxs(k.address, jupiterExpect(solQuote()), { destination: thief }));
    const n = net(null, { tx });
    await expect(executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 })).rejects.toThrow(/Ziel/);
    expect(n.sent).toHaveLength(0);
  });

  it('Status-Abfrage gedrosselt (429) → weiter warten statt abbrechen; ohne Bestätigung → pending', async () => {
    const a = net({ confirmationStatus: 'confirmed', err: null }, { statusErrors: 2 });
    expect((await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, a.f, { pollMs: 1 })).status).toBe('filled');
    const b = net(null);
    expect((await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, b.f, { pollMs: 1, timeoutMs: 20 })).status).toBe('pending');
  });

  it('on-chain-Fehler → failed mit Grund (kein „filled“)', async () => {
    const n = net({ confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 6001 }] } });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/6001/);
  });

  it('fremder Gebührenzahler in der gelieferten Transaktion → nicht signiert, nichts gesendet', async () => {
    const n = net(null, { feePayer: generateWalletKey('solana').address });
    await expect(executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 })).rejects.toThrow(/Gebührenzahler/);
    expect(n.sent).toHaveLength(0);
  });
});

describe('checkLiveSwapStatus („Ausgang unklar“ klären, Netz injiziert)', () => {
  const rpcFake = (answers: Record<string, unknown>) =>
    (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      if (method === 'getSignatureStatuses') expect((params[1] as { searchTransactionHistory: boolean }).searchTransactionHistory).toBe(true);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answers[method] ?? null }));
    }) as unknown as typeof fetch;
  const sol = (s: unknown, ageMs = 1_000) => checkLiveSwapStatus('solana', 'sig', ageMs, rpcFake({ getSignatureStatuses: { value: [s] } }));

  it('Solana: bestätigt → filled; Fehler → failed; unbekannt → erst offen, nach Ablauf failed; nur „processed“ → offen', async () => {
    expect(await sol({ confirmationStatus: 'finalized', err: null })).toEqual({ status: 'filled', error: null });
    expect((await sol({ confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 6001 }] } })).status).toBe('failed');
    expect((await sol(null)).status).toBe('pending');
    expect(await sol(null, SOLANA_UNSEEN_FAIL_MS + 1)).toMatchObject({ status: 'failed', error: expect.stringMatching(/abgelaufen/) });
    expect((await sol({ confirmationStatus: 'processed', err: null }, SOLANA_UNSEEN_FAIL_MS + 1)).status).toBe('pending');
  });

  it('EVM: Beleg 0x1 → filled, 0x0 → failed; ohne Beleg offen — „nie gelandet“ erst nach langer Zeit UND anders verbrauchter Nonce', async () => {
    const sent = { from: '0x00000000000000000000000000000000000000aa', nonce: 7 };
    const evm = (answers: Record<string, unknown>, ageMs = 1_000, s2: { from?: string; nonce?: number | null } = sent) =>
      checkLiveSwapStatus('base', '0xabc', ageMs, rpcFake(answers), s2);
    expect((await evm({ eth_getTransactionReceipt: { status: '0x1' } })).status).toBe('filled');
    expect((await evm({ eth_getTransactionReceipt: { status: '0x0' } })).status).toBe('failed');
    expect((await evm({ eth_getTransactionCount: '0x9' })).status).toBe('pending'); // noch jung
    // alt, aber Nonce noch frei → kann noch landen → offen
    expect((await evm({ eth_getTransactionCount: '0x7' }, EVM_UNSEEN_FAIL_MS + 1)).status).toBe('pending');
    // alt, Nonce von anderer Tx verbraucht → kann nie mehr landen
    expect(await evm({ eth_getTransactionCount: '0x8' }, EVM_UNSEEN_FAIL_MS + 1)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Nonce/) });
    // Gegenprobe: zweiter Beleg-Abruf findet die Tx doch (Knoten hing hinterher) → filled statt failed
    let calls = 0;
    const lagging = (async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string };
      const result = method === 'eth_getTransactionCount' ? '0x8' : method === 'eth_getTransactionReceipt' ? (calls++ === 0 ? null : { status: '0x1' }) : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    }) as unknown as typeof fetch;
    expect((await checkLiveSwapStatus('base', '0xabc', EVM_UNSEEN_FAIL_MS + 1, lagging, sent)).status).toBe('filled');
    // ohne bekannte Nonce nie „fehlgeschlagen“ raten
    expect((await evm({ eth_getTransactionCount: '0x99' }, EVM_UNSEEN_FAIL_MS + 1, { from: sent.from })).status).toBe('pending');
  });
});

/** Minimaler JSON-RPC-Fake für viem auf Base (Chain 8453). */
function evmNet(build: unknown, allowance = 0n, opts: { send?: 'ok' | 'rejected' | 'network'; chainId?: string } = {}) {
  const raw: Hex[] = [];
  const sentTo: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (opts.send === 'network' && String(init.body).includes('eth_sendRawTransaction')) throw new TypeError('fetch failed');
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    if (String(url).startsWith(KYBER_API)) return new Response(JSON.stringify(build));
    const one = (b: { id: number; method: string; params: unknown[] }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: b.id, result });
      switch (b.method) {
        case 'eth_chainId':
          return ok(opts.chainId ?? '0x2105');
        case 'eth_call':
          return ok(`0x${allowance.toString(16).padStart(64, '0')}`);
        case 'eth_getTransactionCount':
          return ok('0x0');
        case 'eth_estimateGas':
          return ok('0x30000');
        case 'eth_gasPrice':
        case 'eth_maxPriorityFeePerGas':
          return ok('0x3b9aca00');
        case 'eth_getBlockByNumber':
          return ok({ baseFeePerGas: '0x3b9aca00', number: '0x10', hash: `0x${'1'.repeat(64)}`, timestamp: '0x1', transactions: [] });
        case 'eth_blockNumber':
          return ok('0x20');
        case 'eth_getTransactionByHash':
          return ok(null);
        case 'eth_sendRawTransaction': {
          raw.push((b.params as Hex[])[0]!);
          sentTo.push(String(url));
          if (opts.send === 'rejected') return { jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'insufficient funds' } };
          return ok(`0x${String(raw.length).padStart(64, '0')}`);
        }
        case 'eth_getTransactionReceipt':
          return ok({ status: '0x1', blockNumber: '0x11', transactionHash: (b.params as string[])[0], logs: [], blockHash: `0x${'2'.repeat(64)}`, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', from: '0x0', to: '0x0', transactionIndex: '0x0', type: '0x2', logsBloom: `0x${'0'.repeat(512)}`, contractAddress: null });
        default:
          return { jsonrpc: '2.0', id: b.id, error: { code: -32601, message: `fake: ${b.method}` } };
      }
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  }) as unknown as typeof fetch;
  return { f, raw, sentTo };
}

function baseQuote(side: 'buy' | 'sell'): SwapQuote {
  const eth = SWAP_CHAINS.base.native;
  const usdc = { address: USDC_BASE, symbol: 'USDC', decimals: 6 };
  return {
    chain: 'base',
    aggregator: 'kyberswap',
    inToken: side === 'buy' ? eth : usdc,
    outToken: side === 'buy' ? usdc : eth,
    inAtomic: side === 'buy' ? (10n ** 16n).toString() : '30000000',
    outAtomic: side === 'buy' ? '30000000' : (10n ** 16n).toString(),
    minOutAtomic: side === 'buy' ? '29700000' : (99n * 10n ** 14n).toString(),
    inAmount: '',
    outAmount: '',
    slippageBps: 100,
    priceImpactPct: 0.1,
    networkFeeNative: null,
    networkFeeUsd: 0.01,
    route: ['uniswap-v3'],
    raw: { routeSummary: { amountIn: '1' } },
  };
}

describe('EVM-Live-Swap (Netz injiziert)', () => {
  it('Kurs beim Bauen leicht gefallen (Mindestmenge < bestätigt) → einmal mit engerer Slippage neu gebaut, nie aufgeweicht', async () => {
    const asked: number[] = [];
    const kyber = (out: bigint) =>
      (async (_url: string, init: RequestInit) => {
        const { slippageTolerance } = JSON.parse(String(init.body)) as { slippageTolerance: number };
        asked.push(slippageTolerance);
        const minReturnAmount = (out * BigInt(10_000 - slippageTolerance)) / 10_000n;
        const data = kyberSwapCalldata({ srcToken: EVM_NATIVE, dstToken: USDC_BASE, dstReceiver: k.address, amount: 10n ** 16n, minReturnAmount });
        return new Response(JSON.stringify({ code: 0, data: { data, routerAddress: ROUTER, amountOut: out.toString() } }));
      }) as unknown as typeof fetch;
    const q = baseQuote('buy'); // bestätigt: mind. 29,7 USDC bei 1 % Slippage
    const b = await buildKyberSwap(q, k.address, kyber(29_800_000n));
    expect(asked).toEqual([100, 33]);
    expect(() => assertKyberSwap(b.data, b.value, kyberExpect(q, k.address))).not.toThrow();
    // unter der bestätigten Mindestmenge → gar nicht erst
    asked.length = 0;
    await expect(buildKyberSwap(q, k.address, kyber(29_600_000n))).rejects.toThrow(/Kurs hat sich bewegt/);
    expect(asked).toEqual([100]);
  });

  const k = generateWalletKey('evm');
  const buyData = (receiver = k.address) => kyberSwapCalldata({ srcToken: EVM_NATIVE, dstToken: USDC_BASE, dstReceiver: receiver, amount: 10n ** 16n, minReturnAmount: 29_700_000n });
  const sellData = kyberSwapCalldata({ srcToken: USDC_BASE, dstToken: EVM_NATIVE, dstReceiver: k.address, amount: 30_000_000n, minReturnAmount: 99n * 10n ** 14n });
  const build = (over: Record<string, unknown> = {}) => ({ code: 0, data: { data: buyData(), routerAddress: ROUTER, amountOut: '30000000', ...over } });

  it('MEV-Schutz: auf Ethereum geht die Swap-Tx privat an Flashbots Protect (abschaltbar), auf Base an den normalen Knoten', async () => {
    expect(mevProtectRpc('ethereum', {})).toBe(FLASHBOTS_PROTECT_RPC);
    expect(mevProtectRpc('ethereum', { MEV_PROTECT: '0' })).toBeNull();
    expect(mevProtectRpc('ethereum', { MEV_PROTECT_RPC_ETHEREUM: 'https://eigen.example' })).toBe('https://eigen.example');
    expect(mevProtectRpc('base', {})).toBeNull();
    const saved = process.env.MEV_PROTECT;
    delete process.env.MEV_PROTECT;
    try {
      const eth = evmNet(build(), 0n, { chainId: '0x1' });
      const q = { ...baseQuote('buy'), chain: 'ethereum' as const };
      expect((await executeEvmSwap({ quote: q, address: k.address, secret: k.secret }, eth.f)).status).toBe('filled');
      expect(eth.sentTo.map((u) => new URL(u).origin)).toEqual([new URL(FLASHBOTS_PROTECT_RPC).origin]);
      const base = evmNet(build());
      await executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, base.f);
      expect(base.sentTo).toHaveLength(1);
      expect(new URL(base.sentTo[0]!).origin).not.toBe(new URL(FLASHBOTS_PROTECT_RPC).origin);
      // privat gesendet + Netzfehler: öffentliche Knoten kennen die Tx nicht → nie „failed“, sondern unklar (mit Nonce)
      const lost = evmNet(build(), 0n, { send: 'network', chainId: '0x1' });
      const r = await executeEvmSwap({ quote: q, address: k.address, secret: k.secret }, lost.f);
      expect(r).toMatchObject({ status: 'pending', nonce: 0 });
      // Flashbots lehnt mit JSON-RPC-Fehler ab → sicher nicht angenommen → failed (nicht „unklar“)
      const refused = evmNet(build(), 0n, { send: 'rejected', chainId: '0x1' });
      expect(await executeEvmSwap({ quote: q, address: k.address, secret: k.secret }, refused.f)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Abgelehnt/) });
    } finally {
      if (saved !== undefined) process.env.MEV_PROTECT = saved;
    }
  });

  it('Kauf mit ETH: genau EINE Transaktion an den Router, value = Betrag, Base-Chain', async () => {
    const n = evmNet(build());
    const r = await executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, n.f);
    expect(r).toMatchObject({ status: 'filled', approvalTx: null });
    expect(n.raw).toHaveLength(1);
    const tx = parseTransaction(n.raw[0]!);
    expect(tx.to?.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(tx.value).toBe(10n ** 16n);
    expect(tx.chainId).toBe(8453);
  });

  it('Verkauf eines Tokens: erst approve EXAKT in Verkaufshöhe an den Router, dann Swap ohne value', async () => {
    const n = evmNet(build({ data: sellData, amountOut: (10n ** 16n).toString() }), 0n);
    const r = await executeEvmSwap({ quote: baseQuote('sell'), address: k.address, secret: k.secret }, n.f);
    expect(r.status).toBe('filled');
    expect(n.raw).toHaveLength(2);
    const approve = parseTransaction(n.raw[0]!);
    expect(approve.to?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    const call = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: approve.data! });
    expect((call.args[0] as string).toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(call.args[1]).toBe(30_000_000n);
    const swap = parseTransaction(n.raw[1]!);
    expect(swap.to?.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(swap.value ?? 0n).toBe(0n);
  });

  it('unbekannter Router oder Ergebnis unter Mindestmenge → verweigert, nichts gesendet', async () => {
    const a = evmNet(build({ routerAddress: '0x000000000000000000000000000000000000dEaD' }));
    await expect(executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, a.f)).rejects.toThrow(/unbekannter Router/);
    expect(a.raw).toHaveLength(0);
    const b = evmNet(build({ amountOut: '1' }));
    await expect(executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, b.f)).rejects.toThrow(/Mindestmenge/);
    expect(b.raw).toHaveLength(0);
  });

  it('manipulierte Calldata (fremder Empfänger) → verweigert, nichts gesendet (auch kein approve)', async () => {
    const n = evmNet(build({ data: buyData('0x00000000000000000000000000000000000000bb') }));
    await expect(executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, n.f)).rejects.toThrow(/Empfänger/);
    expect(n.raw).toHaveLength(0);
  });

  it('Knoten lehnt ab und kennt die Tx nicht → failed; Hash steht vorher fest', async () => {
    const n = evmNet(build(), 0n, { send: 'rejected' });
    const r = await executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: k.secret }, n.f);
    expect(r.status).toBe('failed');
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('Schlüssel einer anderen Wallet → verweigert', async () => {
    const n = evmNet(build());
    await expect(executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: generateWalletKey('evm').secret }, n.f)).rejects.toThrow(/passt nicht/);
    expect(n.raw).toHaveLength(0);
  });
});

describe('echte Daten: Aggregatoren bauen für eine leere Wallet (nichts wird gesendet)', () => {
  async function realJupiter(inToken: SwapQuote['inToken'], outToken: SwapQuote['outToken'], inAtomic: bigint) {
    const k = generateWalletKey('solana');
    const quote = await fetchSwapQuote({ chain: 'solana', inToken, outToken, inAtomic, slippageBps: 50 });
    // genau die Anfrage, die auch der Live-Pfad stellt
    const res = await fetch(`${JUPITER_API}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jupiterSwapRequest(quote, k.address)) });
    const { swapTransaction } = (await res.json()) as { swapTransaction: string };
    return { k, quote, swapTransaction };
  }
  const USDC_TOKEN = { address: USDC_SOL, symbol: 'USDC', decimals: 6 };

  it('Jupiter: echte v0-Transaktion, eigene Wallet ist alleiniger Gebührenzahler → signierbar; Wächter akzeptiert Kauf', async () => {
    const { k, quote, swapTransaction } = await realJupiter(SWAP_CHAINS.solana.native, USDC_TOKEN, toAtomic('0.01', 9));
    const parsed = parseSolanaTx(Buffer.from(swapTransaction, 'base64'));
    expect(parsed).toMatchObject({ requiredSignatures: 1, signers: [k.address] });
    expect(() => signSolanaTx(swapTransaction, k.secret, k.address)).not.toThrow();
    // der Wächter akzeptiert eine ECHTE Jupiter-Transaktion (Allowlist + Route-Aufbau passen zur Realität)
    expect(() => assertJupiterSwapTx(Uint8Array.from(Buffer.from(swapTransaction, 'base64')), k.address, jupiterExpect(quote))).not.toThrow();
  }, 30_000);

  it('Jupiter: Wächter akzeptiert einen echten Verkauf (Token → SOL, auspacken)', async () => {
    const { k, quote, swapTransaction } = await realJupiter(USDC_TOKEN, SWAP_CHAINS.solana.native, 2_000_000n);
    expect(() => assertJupiterSwapTx(Uint8Array.from(Buffer.from(swapTransaction, 'base64')), k.address, jupiterExpect(quote))).not.toThrow();
  }, 30_000);

  it('KyberSwap: echte Route auf Base geht an den bekannten Router; Wächter akzeptiert die echte Calldata', async () => {
    const k = generateWalletKey('evm');
    const quote = await fetchSwapQuote({ chain: 'base', inToken: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 }, outToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6 }, inAtomic: 10n ** 15n, slippageBps: 100 });
    // genau der Bau-Schritt des Live-Pfads (inkl. Neubau bei bewegtem Kurs)
    const built = await buildKyberSwap(quote, k.address);
    expect(KYBER_ROUTERS.has(built.router)).toBe(true);
    // unsere Adresse steckt als Empfänger in den Aufrufdaten
    expect(built.data.toLowerCase()).toContain(k.address.slice(2).toLowerCase());
    // der Wächter dekodiert ECHTE KyberSwap-Calldata und akzeptiert sie (ABI passt zur Realität)
    expect(() => assertKyberSwap(built.data, built.value, kyberExpect(quote, k.address))).not.toThrow();
  }, 60_000); // zwei KyberSwap-Aufrufe, je bis zu drei Pausen bei Drosselung (http.ts)

  it('Flashbots Protect (MEV-Schutz) ist erreichbar und gehört zu Ethereum', async () => {
    const res = await fetch(FLASHBOTS_PROTECT_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    expect(((await res.json()) as { result: string }).result).toBe('0x1');
  }, 30_000);

  it('On-chain-Bestände lesen (Solana + Base)', async () => {
    const sol = await fetchOnchainBalances('solana', '11111111111111111111111111111111', [USDC_SOL]);
    expect(typeof sol.get(SWAP_CHAINS.solana.native.address)).toBe('bigint');
    // (an das System-Programm wurden tatsächlich schon USDC geschickt — nur Typ/Vorzeichen prüfen)
    expect(sol.get(USDC_SOL)! >= 0n).toBe(true);
    const b = await fetchOnchainBalances('base', '0x000000000000000000000000000000000000dEaD', [USDC_BASE]);
    expect(b.get(EVM_NATIVE)! >= 0n).toBe(true);
    expect(typeof b.get(USDC_BASE)).toBe('bigint');
  }, 30_000);
});
