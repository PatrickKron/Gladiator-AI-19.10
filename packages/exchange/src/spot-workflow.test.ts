import { describe, expect, it } from 'vitest';
import {
  checkAssetNetworkCompatibility,
  compareLiveSpotQuotes,
  expectedWalletApprovalPhrase,
  fetchOnChainAssetBalance,
  validateDestinationAddress,
  verifyWalletApprovalPhrase,
} from './spot-workflow.js';

describe('3-Wege Spot-Kauf & Wallet-Workflow (Welle 27 + Welle 28)', () => {
  it('prüft Bitcoin-, Solana- und EVM-Zieladressen streng deterministisch', () => {
    expect(validateDestinationAddress('BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').valid).toBe(true);
    expect(validateDestinationAddress('BTC', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F').valid).toBe(false);

    expect(validateDestinationAddress('SOL', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU').valid).toBe(true);
    expect(validateDestinationAddress('SOL', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').valid).toBe(false);

    expect(validateDestinationAddress('ERC20', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F').valid).toBe(true);
    expect(validateDestinationAddress('ARBITRUM', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F').valid).toBe(true);
    expect(validateDestinationAddress('ERC20', '0x1234').valid).toBe(false);
  });

  it('verhindert gefährliche Fehl-Chain-Kombinationen (z. B. BTC -> SOL oder SOL -> ERC20)', () => {
    expect(checkAssetNetworkCompatibility('BTC', 'BTC').compatible).toBe(true);
    expect(checkAssetNetworkCompatibility('BTC', 'SOL').compatible).toBe(false);
    expect(checkAssetNetworkCompatibility('SOL', 'SOL').compatible).toBe(true);
    expect(checkAssetNetworkCompatibility('SOL', 'ERC20').compatible).toBe(false);
    expect(checkAssetNetworkCompatibility('ETH', 'BTC').compatible).toBe(false);
    expect(checkAssetNetworkCompatibility('QNT', 'ERC20').compatible).toBe(true);
  });

  it('verlangt exakte WALLET-FREIGABE-Phrase für Whitelist-Freischaltung', () => {
    expect(expectedWalletApprovalPhrase('Ledger BTC')).toBe('WALLET-FREIGABE LEDGER BTC');
    expect(verifyWalletApprovalPhrase('wallet-freigabe ledger btc', 'Ledger BTC')).toBe(true);
    expect(verifyWalletApprovalPhrase('FREIGABE Ledger BTC', 'Ledger BTC')).toBe(false);
  });

  it('liest BTC-, EVM- und Solana-SPL-Token-Salden inkl. RPC-Fallback sauber aus', async () => {
    const fakeBtcFetch = (async () =>
      new Response(
        JSON.stringify({
          chain_stats: { funded_txo_sum: 25_000_000, spent_txo_sum: 5_000_000 },
          mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const btcRes = await fetchOnChainAssetBalance('BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'BTC', fakeBtcFetch);
    expect(btcRes.supported).toBe(true);
    expect(btcRes.balance).toBe(0.2);

    const fakeEthFetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }), { status: 200 })) as unknown as typeof fetch; // 1 ETH
    const ethRes = await fetchOnChainAssetBalance('ERC20', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'ETH', fakeEthFetch);
    expect(ethRes.supported).toBe(true);
    expect(ethRes.balance).toBe(1);

    // Solana SPL-Token (USDC) mit RPC-Fallback (erster Knoten 503, zweiter liefert 250.5 USDC)
    let solCallCount = 0;
    const fakeSolSplFetch = (async () => {
      solCallCount++;
      if (solCallCount === 1) return new Response('Service Unavailable', { status: 503 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 200.25, decimals: 6 } } } } } },
              { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 50.25, decimals: 6 } } } } } },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const splRes = await fetchOnChainAssetBalance('SOL', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'USDC', fakeSolSplFetch);
    expect(splRes.supported).toBe(true);
    expect(splRes.balance).toBe(250.5);
    expect(splRes.unit).toBe('USDC');
    expect(solCallCount).toBe(2);
  });

  it('vergleicht Spot-Börsenkurse netto nach Taker-Gebühr und markiert die beste Börse', async () => {
    const fakePrices: Record<string, number> = {
      binance: 90_000, // 0.1% fee -> eff 90_090.09
      kraken: 89_850,  // 0.26% fee -> eff 90_084.22 (Trotz höherer Fee günstiger!)
      coinbase: 90_100, // 0.6% fee
    };
    const rows = await compareLiveSpotQuotes('BTC/EUR', 1000, async (_sym, exId) => {
      const p = fakePrices[exId];
      if (!p) throw new Error('nicht gelistet');
      return { askPrice: p, exchangeId: exId, takerFeeRate: 0.001 };
    });

    const available = rows.filter((r) => r.estBaseQty !== null);
    expect(available).toHaveLength(3);
    expect(available[0]!.exchangeId).toBe('kraken');
    expect(available[0]!.isBest).toBe(true);
    expect(available[0]!.diffPctFromBest).toBe(0);
    expect(available[1]!.exchangeId).toBe('binance');
    expect(available[1]!.isBest).toBe(false);
    expect(available[1]!.diffPctFromBest).toBeGreaterThan(0);
  });
});
