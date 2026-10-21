/**
 * Spot-Swaps (Vision-Punkt 5): Betrags-Umrechnung, Aggregator-Antworten und
 * Token-Infos. Der Block „echte Daten" fragt Jupiter, KyberSwap, DexScreener
 * und öffentliche RPCs live ab (in der Cloud-Sandbox gesperrt, läuft in der CI).
 */
import { describe, expect, it } from 'vitest';
import { EVM_NATIVE, fromAtomic, isTokenAddress, SOL_MINT, SWAP_CHAINS, toAtomic } from './chains.js';
import { fetchSwapQuote, jupiterQuote, kyberQuote } from './quotes.js';
import { fetchPairDepths, fetchRugPool, fetchTokenDecimals, fetchTokenInfo, isConstantProductPair, pickBestPair, pickRugPair } from './token-info.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOL = SWAP_CHAINS.solana.native;
const ETH = SWAP_CHAINS.base.native;

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('Beträge exakt (bigint, kein Float)', () => {
  it('toAtomic/fromAtomic', () => {
    expect(toAtomic('1.5', 9)).toBe(1_500_000_000n);
    expect(toAtomic('0.000001', 6)).toBe(1n);
    expect(toAtomic('0.0000001', 6)).toBe(0n); // mehr Stellen als der Token hat → abgeschnitten
    expect(toAtomic('123', 18)).toBe(123n * 10n ** 18n);
    expect(fromAtomic(1_500_000_000n, 9)).toBe('1.5');
    expect(fromAtomic('1000000', 6)).toBe('1');
    expect(fromAtomic(1n, 18)).toBe('0.000000000000000001');
  });

  it('lehnt Unsinn ab', () => {
    expect(() => toAtomic('-1', 6)).toThrow();
    expect(() => toAtomic('1e5', 6)).toThrow();
    expect(() => toAtomic('abc', 6)).toThrow();
  });

  it('Adress-Formate je Kette', () => {
    expect(isTokenAddress('solana', USDC_SOL)).toBe(true);
    expect(isTokenAddress('solana', USDC_BASE)).toBe(false);
    expect(isTokenAddress('base', USDC_BASE)).toBe(true);
    expect(isTokenAddress('base', USDC_SOL)).toBe(false);
  });
});

describe('Aggregator-Antworten', () => {
  it('Jupiter: Mengen, Mindestmenge, Preis-Einfluss in %, Route', async () => {
    const q = await jupiterQuote(
      { inToken: SOL, outToken: { address: USDC_SOL, symbol: 'USDC', decimals: 6 }, inAtomic: 100_000_000n, slippageBps: 50 },
      jsonFetch({
        inAmount: '100000000',
        outAmount: '15123456',
        otherAmountThreshold: '15047839',
        priceImpactPct: '0.0012',
        routePlan: [{ swapInfo: { label: 'Raydium' } }, { swapInfo: { label: 'Orca' } }, { swapInfo: { label: 'Raydium' } }],
      }),
    );
    // Mindestmenge selbst gerechnet (abgerundet), nicht `otherAmountThreshold` übernommen
    expect(q).toMatchObject({ inAmount: '0.1', outAmount: '15.123456', minOutAtomic: '15047838', route: ['Raydium', 'Orca'] });
    expect(q.priceImpactPct).toBeCloseTo(0.12, 6);
  });

  it('Angebot über eine andere Menge als angefragt, ExactOut oder mit Plattform-Gebühr → verweigert', async () => {
    const p = { inToken: SOL, outToken: { address: USDC_SOL, symbol: 'USDC', decimals: 6 }, inAtomic: 100_000_000n, slippageBps: 50 };
    const base = { inAmount: '100000000', outAmount: '15123456', priceImpactPct: '0', routePlan: [] };
    await expect(jupiterQuote(p, jsonFetch({ ...base, inAmount: '900000000' }))).rejects.toThrow(/passt nicht/);
    await expect(jupiterQuote(p, jsonFetch({ ...base, swapMode: 'ExactOut' }))).rejects.toThrow(/passt nicht/);
    await expect(jupiterQuote(p, jsonFetch({ ...base, platformFee: { amount: '1000', feeBps: 50 } }))).rejects.toThrow(/Plattform-Gebühr/);
    expect((await jupiterQuote(p, jsonFetch({ ...base, swapMode: 'ExactIn', platformFee: null }))).outAtomic).toBe('15123456');
  });

  it('Jupiter ohne Route → ehrlicher Fehler', async () => {
    await expect(
      jupiterQuote({ inToken: SOL, outToken: SOL, inAtomic: 1n, slippageBps: 50 }, jsonFetch({ error: 'No routes found' }, 400)),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('KyberSwap: Preis-Einfluss aus USD-Werten, Mindestmenge aus Slippage, Gas in USD', async () => {
    const q = await kyberQuote(
      { chain: 'base', inToken: ETH, outToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6 }, inAtomic: 10n ** 17n, slippageBps: 100 },
      jsonFetch({
        code: 0,
        message: 'successfully',
        data: {
          routeSummary: {
            amountIn: '100000000000000000',
            amountOut: '300000000',
            amountInUsd: '301.5',
            amountOutUsd: '300',
            gasUsd: '0.02',
            route: [[{ exchange: 'uniswap-v3' }], [{ exchange: 'aerodrome' }]],
          },
          routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
        },
      }),
    );
    expect(q).toMatchObject({ inAmount: '0.1', outAmount: '300', minOutAtomic: '297000000', networkFeeUsd: 0.02, route: ['uniswap-v3', 'aerodrome'] });
    expect(q.priceImpactPct).toBeCloseTo(0.4975, 3);
  });

  it('KyberSwap: Route über eine andere Menge als angefragt → verweigert', async () => {
    await expect(
      kyberQuote(
        { chain: 'base', inToken: ETH, outToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6 }, inAtomic: 10n ** 17n, slippageBps: 100 },
        jsonFetch({ code: 0, data: { routeSummary: { amountIn: '900000000000000000', amountOut: '300000000' } } }),
      ),
    ).rejects.toThrow(/passt nicht/);
  });

  it('Betrag 0 wird gar nicht erst angefragt', async () => {
    await expect(fetchSwapQuote({ chain: 'solana', inToken: SOL, outToken: SOL, inAtomic: 0n, slippageBps: 50 })).rejects.toThrow(/größer als 0/);
  });

  it('pickBestPair: nur Paare der Kette, Token als Basis, liquidester Pool', () => {
    const best = pickBestPair(
      [
        { chainId: 'base', baseToken: { address: USDC_BASE.toLowerCase() }, liquidity: { usd: 10 } },
        { chainId: 'base', baseToken: { address: USDC_BASE }, liquidity: { usd: 500 }, dexId: 'best' },
        { chainId: 'ethereum', baseToken: { address: USDC_BASE }, liquidity: { usd: 9_999 } },
        { chainId: 'base', baseToken: { address: '0x1111111111111111111111111111111111111111' }, liquidity: { usd: 1e9 } },
      ],
      'base',
      USDC_BASE,
    );
    expect(best?.dexId).toBe('best');
  });

  it('Rug-Schutz-Pool: nur konstantes Produkt (v3/v4/CLMM/DLMM/Whirlpool/Bonding-Curve fallen raus)', () => {
    expect(isConstantProductPair({ dexId: 'raydium' })).toBe(true);
    expect(isConstantProductPair({ dexId: 'raydium', labels: ['CPMM'] })).toBe(true);
    expect(isConstantProductPair({ dexId: 'uniswap', labels: ['v2'] })).toBe(true);
    expect(isConstantProductPair({ dexId: 'pumpswap' })).toBe(true);
    for (const labels of [['v3'], ['v4'], ['CLMM'], ['DLMM'], ['wp']]) expect(isConstantProductPair({ dexId: 'x', labels })).toBe(false);
    expect(isConstantProductPair({ dexId: 'orca' })).toBe(false);
    expect(isConstantProductPair({ dexId: 'pumpfun' })).toBe(false);
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const pairs = [
      { chainId: 'solana', dexId: 'raydium', labels: ['CLMM'], pairAddress: 'clmm', baseToken: { address: mint }, liquidity: { usd: 9e6 } },
      { chainId: 'solana', dexId: 'raydium', pairAddress: 'amm', baseToken: { address: mint }, liquidity: { usd: 1e6 } },
    ];
    expect(pickBestPair(pairs, 'solana', mint)?.pairAddress).toBe('clmm');
    expect(pickRugPair(pairs, 'solana', mint)?.pairAddress).toBe('amm');
    expect(pickRugPair(pairs.slice(0, 1), 'solana', mint)).toBeNull();
  });
});

describe('echte Daten (Jupiter, KyberSwap, DexScreener, RPC)', () => {
  it('Jupiter: 0,1 SOL → USDC liefert eine echte Route', async () => {
    const q = await fetchSwapQuote({
      chain: 'solana',
      inToken: SOL,
      outToken: { address: USDC_SOL, symbol: 'USDC', decimals: 6 },
      inAtomic: 100_000_000n,
      slippageBps: 50,
    });
    expect(Number(q.outAmount)).toBeGreaterThan(1); // 0,1 SOL ist mehr als 1 USD wert
    expect(q.route.length).toBeGreaterThan(0);
  }, 30_000);

  it('KyberSwap: 0,01 ETH → USDC auf Base liefert eine echte Route', async () => {
    const q = await fetchSwapQuote({
      chain: 'base',
      inToken: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 },
      outToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6 },
      inAtomic: 10n ** 16n,
      slippageBps: 50,
    });
    expect(Number(q.outAmount)).toBeGreaterThan(1);
    expect(q.priceImpactPct).toBeLessThan(5);
  }, 30_000);

  it('Nachkommastellen von der Kette: USDC = 6 (Solana + Base)', async () => {
    expect(await fetchTokenDecimals('solana', USDC_SOL)).toBe(6);
    expect(await fetchTokenDecimals('base', USDC_BASE)).toBe(6);
  }, 30_000);

  it('Token-Info: SOL mit Preis und Liquidität aus DexScreener', async () => {
    const info = await fetchTokenInfo('solana', SOL_MINT);
    expect(info.symbol).toBe('SOL');
    expect(info.priceUsd).toBeGreaterThan(1);
    expect(info.liquidityUsd).toBeGreaterThan(100_000);
  }, 30_000);

  it('Rug-Schutz-Pool echter Meme-Token (BONK): alle Pools, konstantes Produkt, Tiefe > 0', async () => {
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${BONK}`);
    const pairs = (await res.json()) as { dexId?: string; labels?: string[]; pairAddress?: string; liquidity?: { usd?: number } }[];
    // Pool-Bauarten laut DexScreener (bei Abweichung im CI-Protokoll sichtbar)
    const kinds = pairs.slice(0, 15).map((p) => `${p.dexId}[${(p.labels ?? []).join('/')}] ${Math.round(p.liquidity?.usd ?? 0)}$ cp=${isConstantProductPair(p)}`).join('; ');
    expect(pairs.length, kinds).toBeGreaterThan(1);
    const pool = await fetchRugPool('solana', BONK);
    expect(pool, kinds).not.toBeNull();
    expect(isConstantProductPair(pairs.find((p) => p.pairAddress === pool!.pairAddress)!), kinds).toBe(true);
    expect(pool!.depth).toBeGreaterThan(0);
    // dieselbe Tiefe über den Pool-Abruf des Workers
    const depths = await fetchPairDepths('solana', [pool!.pairAddress]);
    expect(depths.get(pool!.pairAddress)?.depth).toBeGreaterThan(0);
    // DexScreener kennzeichnet Pool-Bauarten (sonst wäre der Ausschluss wirkungslos)
    expect(pairs.some((p) => (p.labels ?? []).length > 0), kinds).toBe(true);
  }, 30_000);
});
