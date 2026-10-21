/**
 * Swaps fremder EVM-Wallets erkennen: Kauf mit ETH bzw. WETH, Verkauf (WETH-
 * Erlös sichtbar oder über Router), Token↔Token; Überweisungen, Airdrops und
 * NFTs nie als Swap. „Echte Daten“ liest echte Logs von Base (CI).
 */
import { describe, expect, it } from 'vitest';
import { SWAP_CHAINS } from './chains.js';
import { deriveEvmSwap, ERC20_TRANSFER_TOPIC, fetchEvmWalletSwaps, padTopic, type EvmLog } from './wallet-activity-evm.js';

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
