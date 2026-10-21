/**
 * Swaps fremder EVM-Wallets erkennen: Kauf mit ETH bzw. WETH, Verkauf (WETH-
 * Erlös sichtbar oder über Router), Token↔Token; Überweisungen, Airdrops und
 * NFTs nie als Swap. „Echte Daten“ liest echte Logs von Base (CI).
 */
import { describe, expect, it } from 'vitest';
import { SWAP_CHAINS } from './chains.js';
import {
  deriveEvmSwap,
  ERC20_TRANSFER_TOPIC,
  EVM_LOG_RPCS,
  fetchEvmWalletSwaps,
  logRpcCandidates,
  padTopic,
  setEvmRetryDelayForTests,
  unwrappedIn,
  WETH_WITHDRAWAL_TOPIC,
  type EvmLog,
} from './wallet-activity-evm.js';

const ME = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const MEME = '0x4444444444444444444444444444444444444444';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = SWAP_CHAINS.base.wrappedNative;
const dec = () => 18;

const transfer = (token: string, from: string, to: string, amount: bigint): EvmLog => ({
  address: token,
  topics: [ERC20_TRANSFER_TOPIC, padTopic(from), padTopic(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
  transactionHash: '0xabc',
  blockNumber: '0x10',
});

describe('deriveEvmSwap', () => {
  it('Kauf mit ETH (value) → Token rein', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0xde0b6b3a7640000' }, [transfer(MEME, POOL, ME, 5000n)], ME, dec, 1_700_000_000);
    expect(s).toMatchObject({ side: 'buy', token: MEME, tokenAtomic: 5000n, nativeAtomic: 10n ** 18n, counterToken: null, time: 1_700_000_000 });
  });

  it('Kauf mit WETH zählt als nativ; Adressen in Großschreibung egal', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME.toUpperCase().replace('0X', '0x'), to: ROUTER, value: '0x0' }, [transfer(WETH, ME, POOL, 7n), transfer(MEME.toUpperCase().replace('0X', '0x'), POOL, ME, 9n)], ME, dec, null);
    expect(s).toMatchObject({ side: 'buy', token: MEME, nativeAtomic: 7n });
  });

  it('Verkauf nur mit sichtbarem Erlös: WETH an die Wallet oder Unwrap im Receipt', () => {
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(WETH, POOL, ME, 3n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, nativeAtomic: 3n });
    // Router zahlt natives ETH aus (Unwrap in derselben Tx)
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null, 4n)).toMatchObject({ side: 'sell', token: MEME, nativeAtomic: 4n });
    // Token geht an einen Vertrag ohne sichtbaren Erlös (Bridge, Staking, Multisend) → kein Verkauf
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
  });

  it('Unwrap-Summe aus dem Receipt: nur Withdrawal-Events des Wrapped-Native-Vertrags', () => {
    const w = (addr: string, amount: bigint) => ({ address: addr, topics: [WETH_WITHDRAWAL_TOPIC, padTopic(ROUTER)], data: `0x${amount.toString(16).padStart(64, '0')}` });
    expect(unwrappedIn('base', [w(WETH, 5n), w(WETH.toUpperCase().replace('0X', '0x'), 2n), w(MEME, 100n), transfer(MEME, ME, POOL, 9n)])).toBe(7n);
  });

  it('Stablecoin als Gegenseite: USDC → Meme = Kauf, Meme → USDC = Verkauf, Meme ↔ Meme = kein Swap', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(USDC, ME, POOL, 100n), transfer(MEME, POOL, ME, 9n)], ME, dec, null);
    expect(s).toMatchObject({ side: 'buy', token: MEME, counterToken: USDC, nativeAtomic: null });
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(USDC, POOL, ME, 100n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, counterToken: USDC });
    const OTHER = '0x8888888888888888888888888888888888888888';
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(OTHER, POOL, ME, 5n)], ME, dec, null)).toBeNull();
  });

  it('kein Swap: Überweisung an Freund, Airdrop, NFT, Null-Betrag', () => {
    // Überweisung: Tx geht direkt an den Token-Vertrag
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: MEME, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
    // Airdrop: Token rein, jemand anderes hat die Tx gesendet, nichts bezahlt
    expect(deriveEvmSwap('base', '0xabc', { from: POOL, to: MEME, value: '0x0' }, [transfer(MEME, POOL, ME, 9n)], ME, dec, null)).toBeNull();
    // Token raus, aber von jemand anderem ausgelöst (z. B. transferFrom nach Freigabe) → nicht als eigener Verkauf deuten
    expect(deriveEvmSwap('base', '0xabc', { from: POOL, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toBeNull();
    // NFT (ERC-721: 4 Topics, kein data)
    const nft: EvmLog = { address: MEME, topics: [ERC20_TRANSFER_TOPIC, padTopic(POOL), padTopic(ME), '0x01'], data: '0x', transactionHash: '0xabc', blockNumber: '0x10' };
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x2386f26fc10000' }, [nft], ME, dec, null)).toBeNull();
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x1' }, [transfer(MEME, POOL, ME, 0n)], ME, dec, null)).toBeNull();
  });
});

describe('Logs-RPC-Auswahl', () => {
  it('eigener Logs-RPC, dann eigener RPC, dann öffentliche Liste — ohne Doppelte', () => {
    expect(logRpcCandidates('base', {})).toEqual(EVM_LOG_RPCS.base);
    expect(logRpcCandidates('base', { RPC_URL_BASE: 'https://mein-knoten', RPC_URL_LOGS_BASE: 'https://logs-knoten' })).toEqual(['https://logs-knoten', 'https://mein-knoten', ...EVM_LOG_RPCS.base]);
    expect(logRpcCandidates('base', { RPC_URL_BASE: EVM_LOG_RPCS.base[0] })).toEqual(EVM_LOG_RPCS.base);
  });

  it('RPC lehnt adressfreie Logs ab → nächster Endpunkt; keiner → ehrlicher Fehler mit Hinweis', async () => {
    const used: string[] = [];
    const net = (refuse: (url: string) => boolean) =>
      (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        used.push(`${new URL(url).host}:${body.method}`);
        const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
        if (body.method === 'eth_blockNumber') return rpc('0x1000');
        if (body.method === 'eth_getLogs') {
          return refuse(url) ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Please specify an address in your request' } })) : rpc([]);
        }
        return rpc(null);
      }) as unknown as typeof fetch;
    const prev = { ...process.env };
    delete process.env.RPC_URL_ARBITRUM;
    delete process.env.RPC_URL_LOGS_ARBITRUM;
    try {
      const first = new URL(EVM_LOG_RPCS.arbitrum[0]!).host;
      const r = await fetchEvmWalletSwaps('arbitrum', ME, {}, net((u) => new URL(u).host === first));
      expect(r).toEqual({ swaps: [], newestSignature: String(0x1000), gap: false });
      expect(used.some((u) => u.startsWith(first))).toBe(true);
      // der funktionierende Endpunkt wird gemerkt → nächster Abruf fragt ihn zuerst
      used.length = 0;
      await fetchEvmWalletSwaps('arbitrum', ME, {}, net((u) => new URL(u).host === first));
      expect(used[0]!.startsWith(new URL(EVM_LOG_RPCS.arbitrum[1]!).host)).toBe(true);

      await expect(fetchEvmWalletSwaps('arbitrum', ME, {}, net(() => true))).rejects.toThrow(/RPC_URL_LOGS_ARBITRUM/);
    } finally {
      process.env = prev;
    }
  });
});

describe('Drosselung', () => {
  it('HTTP 429 → genau ein zweiter Versuch, dann weiter', async () => {
    setEvmRetryDelayForTests(0);
    let calls = 0;
    const net = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls++;
      if (body.method === 'eth_blockNumber' && calls === 1) return new Response('zu viele', { status: 429 });
      const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      return body.method === 'eth_blockNumber' ? rpc('0x20') : rpc([]);
    }) as unknown as typeof fetch;
    try {
      await expect(fetchEvmWalletSwaps('bsc', ME, {}, net)).resolves.toEqual({ swaps: [], newestSignature: String(0x20), gap: false });
      expect(calls).toBe(4); // 429, Blocknummer, Logs raus, Logs rein
    } finally {
      setEvmRetryDelayForTests(null);
    }
  });
});

describe('lückenlos nachholen', () => {
  // 5 Käufe in den Blöcken 101..105 (je ein Tx), aktueller Block 110
  const buys = [101, 102, 103, 104, 105].map((b) => ({ ...transfer(MEME, POOL, ME, BigInt(b)), transactionHash: `0x${b}`, blockNumber: `0x${b.toString(16)}`, logIndex: '0x0' }));
  const net = (logs: EvmLog[], latest = 110) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      switch (body.method) {
        case 'eth_blockNumber':
          return rpc(`0x${latest.toString(16)}`);
        case 'eth_getLogs': {
          const f = body.params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
          const incoming = f.topics[1] === null;
          return rpc(incoming ? logs.filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock)) : []);
        }
        case 'eth_getTransactionByHash':
          return rpc({ from: ME, to: ROUTER, value: '0x1' });
        case 'eth_getTransactionReceipt':
          return rpc({ logs: [] });
        case 'eth_getBlockByNumber':
          return rpc({ timestamp: '0x1' });
        case 'eth_call':
          return rpc(`0x${'12'.padStart(64, '0')}`);
      }
      return rpc(null);
    }) as unknown as typeof fetch;

  it('mehr neue Tx als erlaubt → die ältesten zuerst, Cursor davor, Rest im nächsten Abruf; nichts fehlt', async () => {
    const r1 = await fetchEvmWalletSwaps('base', ME, { cursor: '100', maxTxs: 2 }, net(buys));
    expect(r1.swaps.map((s) => s.signature)).toEqual(['0x102', '0x101']);
    expect(r1).toMatchObject({ newestSignature: '102', gap: false });
    const r2 = await fetchEvmWalletSwaps('base', ME, { cursor: r1.newestSignature, maxTxs: 2 }, net(buys));
    expect(r2.swaps.map((s) => s.signature)).toEqual(['0x104', '0x103']);
    const r3 = await fetchEvmWalletSwaps('base', ME, { cursor: r2.newestSignature, maxTxs: 2 }, net(buys));
    expect(r3).toMatchObject({ newestSignature: '110', gap: false });
    expect(r3.swaps.map((s) => s.signature)).toEqual(['0x105']);
  });

  it('erster Lauf: nur die jüngsten als Verlauf; Cursor weit hinter dem Fenster → Lücke gemeldet', async () => {
    const first = await fetchEvmWalletSwaps('base', ME, { maxTxs: 2 }, net(buys));
    expect(first.swaps.map((s) => s.signature)).toEqual(['0x105', '0x104']);
    expect(first.newestSignature).toBe('110');
    const behind = await fetchEvmWalletSwaps('base', ME, { cursor: '10', maxBlocks: 50 }, net(buys));
    expect(behind.gap).toBe(true);
  });
});

describe('echte Daten (Base-RPC)', () => {
  it('liest echte Transfer-Logs einer aktiven Adresse; Cursor = aktuelle Blocknummer, erkannte Swaps vollständig', async () => {
    // Uniswap Universal Router auf Base: garantiert laufend Token-Transfers
    const r = await fetchEvmWalletSwaps('base', '0x6fF5693b99212Da76ad316178A184AB56D299b43', { maxBlocks: 20, maxTxs: 4 });
    expect(r.newestSignature).toMatch(/^\d+$/);
    expect(Number(r.newestSignature)).toBeGreaterThan(20_000_000);
    for (const s of r.swaps) {
      expect(['buy', 'sell']).toContain(s.side);
      expect(s.token).toMatch(/^0x[0-9a-f]{40}$/);
      expect(s.tokenDecimals).toBeGreaterThanOrEqual(0);
    }
    // Cursor = aktueller Block → nächster Abruf liest nichts doppelt
    const again = await fetchEvmWalletSwaps('base', '0x6fF5693b99212Da76ad316178A184AB56D299b43', { cursor: r.newestSignature, maxBlocks: 20, maxTxs: 4 });
    expect(again.swaps.every((s) => !r.swaps.some((x) => x.signature === s.signature))).toBe(true);
  }, 90_000);
});
