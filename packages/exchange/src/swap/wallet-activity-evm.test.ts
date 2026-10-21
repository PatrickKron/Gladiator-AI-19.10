/**
 * Swaps fremder EVM-Wallets erkennen: Kauf mit ETH bzw. WETH, Verkauf (WETH-
 * Erlös sichtbar oder über Router), Token↔Token; Überweisungen, Airdrops und
 * NFTs nie als Swap. „Echte Daten“ liest echte Logs von Base (CI).
 */
import { describe, expect, it } from 'vitest';
import { SWAP_CHAINS } from './chains.js';
import { deriveEvmSwap, ERC20_TRANSFER_TOPIC, EVM_LOG_RPCS, fetchEvmWalletSwaps, logRpcCandidates, padTopic, type EvmLog } from './wallet-activity-evm.js';

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

  it('Verkauf: Erlös als WETH sichtbar bzw. über Router (Erlös unbekannt → null)', () => {
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n), transfer(WETH, POOL, ME, 3n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, tokenAtomic: 9n, nativeAtomic: 3n });
    expect(deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(MEME, ME, POOL, 9n)], ME, dec, null)).toMatchObject({ side: 'sell', token: MEME, nativeAtomic: null });
  });

  it('Token ↔ Token (USDC → Meme) = Kauf mit Gegen-Token', () => {
    const s = deriveEvmSwap('base', '0xabc', { from: ME, to: ROUTER, value: '0x0' }, [transfer(USDC, ME, POOL, 100n), transfer(MEME, POOL, ME, 9n)], ME, dec, null);
    expect(s).toMatchObject({ side: 'buy', token: MEME, counterToken: USDC, nativeAtomic: null });
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
      expect(r).toEqual({ swaps: [], newestSignature: String(0x1000) });
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
