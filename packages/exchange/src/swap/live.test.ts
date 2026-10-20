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
import { executeEvmSwap, executeSolanaSwap, fetchOnchainBalances, KYBER_ROUTERS } from './live.js';
import { fetchSwapQuote, JUPITER_API, KYBER_API, type SwapQuote } from './quotes.js';
import { parseSolanaTx, signSolanaTx } from './solana-tx.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

function v0Tx(feePayer: Uint8Array): string {
  const keys = [feePayer, new Uint8Array(32).fill(3)];
  const msg = [0x80, 1, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 0, 0];
  return Buffer.from(Uint8Array.from([1, ...new Uint8Array(64), ...msg])).toString('base64');
}

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
    raw: { inAmount: '10000000', outAmount: '1500000' },
  };
}

describe('Solana-Live-Swap (Netz injiziert)', () => {
  const k = generateWalletKey('solana');

  function net(status: unknown, feePayer = base58Decode(k.address)) {
    const sent: string[] = [];
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown[]; userPublicKey?: string };
      if (String(url) === `${JUPITER_API}/swap`) {
        calls.push(`jup:${body.userPublicKey}`);
        return new Response(JSON.stringify({ swapTransaction: v0Tx(feePayer), lastValidBlockHeight: 1_000 }));
      }
      calls.push(body.method!);
      if (body.method === 'sendTransaction') {
        sent.push((body.params as string[])[0]!);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'SIG' }));
      }
      if (body.method === 'getSignatureStatuses') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [status] } }));
      if (body.method === 'getBlockHeight') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 900 }));
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;
    return { f, sent, calls };
  }

  it('baut über Jupiter für die EIGENE Adresse, signiert korrekt, wartet auf Bestätigung', async () => {
    const n = net({ confirmationStatus: 'confirmed', err: null });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 });
    expect(r).toMatchObject({ status: 'filled', txHash: 'SIG', error: null });
    expect(n.calls[0]).toBe(`jup:${k.address}`);
    const tx = Buffer.from(n.sent[0]!, 'base64');
    expect(ed25519.verify(tx.subarray(1, 65), tx.subarray(65), base58Decode(k.address))).toBe(true);
  });

  it('on-chain-Fehler → failed mit Grund (kein „filled“)', async () => {
    const n = net({ confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 6001 }] } });
    const r = await executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/6001/);
  });

  it('fremder Gebührenzahler in der gelieferten Transaktion → nicht signiert, nichts gesendet', async () => {
    const n = net(null, base58Decode(generateWalletKey('solana').address));
    await expect(executeSolanaSwap({ quote: solQuote(), address: k.address, secret: k.secret }, n.f, { pollMs: 1 })).rejects.toThrow(/Gebührenzahler/);
    expect(n.sent).toHaveLength(0);
  });
});

/** Minimaler JSON-RPC-Fake für viem auf Base (Chain 8453). */
function evmNet(build: unknown, allowance = 0n) {
  const raw: Hex[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    if (String(url).startsWith(KYBER_API)) return new Response(JSON.stringify(build));
    const one = (b: { id: number; method: string; params: unknown[] }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: b.id, result });
      switch (b.method) {
        case 'eth_chainId':
          return ok('0x2105');
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
        case 'eth_sendRawTransaction': {
          raw.push((b.params as Hex[])[0]!);
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
  return { f, raw };
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
  const k = generateWalletKey('evm');
  const build = (over: Record<string, unknown> = {}) => ({ code: 0, data: { data: '0xdeadbeef', routerAddress: ROUTER, amountOut: '30000000', ...over } });

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
    const n = evmNet(build({ amountOut: (10n ** 16n).toString() }), 0n);
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

  it('Schlüssel einer anderen Wallet → verweigert', async () => {
    const n = evmNet(build());
    await expect(executeEvmSwap({ quote: baseQuote('buy'), address: k.address, secret: generateWalletKey('evm').secret }, n.f)).rejects.toThrow(/passt nicht/);
    expect(n.raw).toHaveLength(0);
  });
});

describe('echte Daten: Aggregatoren bauen für eine leere Wallet (nichts wird gesendet)', () => {
  it('Jupiter: echte v0-Transaktion, eigene Wallet ist alleiniger Gebührenzahler → signierbar', async () => {
    const k = generateWalletKey('solana');
    const quote = await fetchSwapQuote({ chain: 'solana', inToken: SWAP_CHAINS.solana.native, outToken: { address: USDC_SOL, symbol: 'USDC', decimals: 6 }, inAtomic: toAtomic('0.01', 9), slippageBps: 50 });
    const res = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote.raw, userPublicKey: k.address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    });
    const { swapTransaction } = (await res.json()) as { swapTransaction: string };
    const parsed = parseSolanaTx(Buffer.from(swapTransaction, 'base64'));
    expect(parsed).toMatchObject({ requiredSignatures: 1, signers: [k.address] });
    expect(() => signSolanaTx(swapTransaction, k.secret, k.address)).not.toThrow();
  }, 30_000);

  it('KyberSwap: echte Route auf Base geht an den bekannten Router', async () => {
    const k = generateWalletKey('evm');
    const quote = await fetchSwapQuote({ chain: 'base', inToken: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 }, outToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6 }, inAtomic: 10n ** 15n, slippageBps: 100 });
    const res = await fetch(`${KYBER_API}/base/api/v1/route/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'gladiator' },
      body: JSON.stringify({ routeSummary: (quote.raw as { routeSummary: unknown }).routeSummary, sender: k.address, recipient: k.address, slippageTolerance: 100, source: 'gladiator' }),
    });
    const body = (await res.json()) as { code: number; data: { routerAddress: string; data: string } };
    expect(body.code).toBe(0);
    expect(KYBER_ROUTERS.has(body.data.routerAddress.toLowerCase())).toBe(true);
    // unsere Adresse steckt als Empfänger in den Aufrufdaten
    expect(body.data.data.toLowerCase()).toContain(k.address.slice(2).toLowerCase());
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
