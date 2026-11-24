import { describe, expect, it } from 'vitest';
import {
  checkAssetNetworkCompatibility,
  expectedWalletApprovalPhrase,
  fetchOnChainAssetBalance,
  validateDestinationAddress,
  verifyWalletApprovalPhrase,
} from './spot-workflow.js';

describe('3-Wege Spot-Kauf & Wallet-Workflow (Welle 27)', () => {
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

  it('liest BTC- und EVM-Salden sauber über injizierten RPC-Fetch aus', async () => {
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
  });
});
