import ccxt from 'ccxt';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { loadFundedGateForConnection, loadRiskSettings } from './executor.js';
import { decryptCredentials } from './vault.js';

const { auditLog, exchangeConnections, spotWorkflows, venueApprovals, walletAddressBook } = schema;

/**
 * 3-Wege Spot-Kauf & Self-Custody Wallet-Workflow (Welle 27, Patricks Freigabe 2026-11-24):
 * - Weg A (`guided_cex`): CEX-Spot kaufen (Paper/Live) + geführter Transfer ohne Withdraw-API-Key
 *   + automatische On-Chain-Eingangsprüfung.
 * - Weg B (`dex_direct`): On-Chain DEX-Direktkauf (Jupiter/KyberSwap) direkt in die eigene Wallet.
 * - Weg C (`api_withdraw`): CEX-Spot kaufen + manuelle 1-Klick-Auszahlung (`ccxt.withdraw`)
 *   AUSSCHLIESSLICH an freigegebene Whitelist-Wallets (`WALLET-FREIGABE <Label>`) + Phrase
 *   `TRANSFER BESTÄTIGEN`. KI/Agenten/Szenarien haben bauartbedingt KEINEN Zugriff.
 */

export const SPOT_NETWORK_IDS = ['BTC', 'SOL', 'ERC20', 'ARBITRUM', 'BASE', 'BSC', 'POLYGON'] as const;
export type SpotNetworkId = (typeof SPOT_NETWORK_IDS)[number];

export type SpotNetworkMeta = {
  id: SpotNetworkId;
  label: string;
  ccxtNetwork: string;
  nativeAsset: string;
  addressExample: string;
};

export const SPOT_NETWORKS: SpotNetworkMeta[] = [
  { id: 'BTC', label: 'Bitcoin Mainnet (Native SegWit / Legacy)', ccxtNetwork: 'BTC', nativeAsset: 'BTC', addressExample: 'bc1q...' },
  { id: 'SOL', label: 'Solana Mainnet', ccxtNetwork: 'SOL', nativeAsset: 'SOL', addressExample: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
  { id: 'ERC20', label: 'Ethereum Mainnet (ERC-20)', ccxtNetwork: 'ERC20', nativeAsset: 'ETH', addressExample: '0x71C...89A' },
  { id: 'ARBITRUM', label: 'Arbitrum One', ccxtNetwork: 'ARBITRUM', nativeAsset: 'ETH', addressExample: '0x71C...89A' },
  { id: 'BASE', label: 'Base Mainnet', ccxtNetwork: 'BASE', nativeAsset: 'ETH', addressExample: '0x71C...89A' },
  { id: 'BSC', label: 'BNB Smart Chain (BEP-20)', ccxtNetwork: 'BEP20', nativeAsset: 'BNB', addressExample: '0x71C...89A' },
  { id: 'POLYGON', label: 'Polygon PoS', ccxtNetwork: 'MATIC', nativeAsset: 'POL', addressExample: '0x71C...89A' },
];

export const WITHDRAW_CONFIRM_PHRASE = 'TRANSFER BESTÄTIGEN';

/** Kuratierte, verifizierte Spot-Assets für Weg B (DEX-Direktkauf ohne CEX). */
export const DEX_DIRECT_PRESETS: Array<{
  symbol: string;
  name: string;
  chain: 'solana' | 'ethereum' | 'arbitrum' | 'base';
  tokenAddress: string;
}> = [
  { symbol: 'SOL', name: 'Wrapped SOL (Jupiter)', chain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' },
  { symbol: 'WBTC', name: 'Wrapped BTC (Ethereum)', chain: 'ethereum', tokenAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  { symbol: 'WETH', name: 'Wrapped Ether (Arbitrum)', chain: 'arbitrum', tokenAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  { symbol: 'ARB', name: 'Arbitrum (Arbitrum One)', chain: 'arbitrum', tokenAddress: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
  { symbol: 'QNT', name: 'Quant (Ethereum ERC-20)', chain: 'ethereum', tokenAddress: '0x4a220E6096B25EADb88358cb44068A3248254675' },
  { symbol: 'LINK', name: 'Chainlink (Ethereum ERC-20)', chain: 'ethereum', tokenAddress: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
  { symbol: 'AAVE', name: 'Aave (Ethereum ERC-20)', chain: 'ethereum', tokenAddress: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' },
  { symbol: 'UNI', name: 'Uniswap (Ethereum ERC-20)', chain: 'ethereum', tokenAddress: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
];

/** Strenge deterministische Adressprüfung je Ziel-Netzwerk. */
export function validateDestinationAddress(
  network: SpotNetworkId,
  rawAddress: string,
): { valid: boolean; normalized: string; reason: string | null } {
  const addr = rawAddress.trim();
  if (!addr) return { valid: false, normalized: '', reason: 'Adresse darf nicht leer sein.' };

  if (network === 'BTC') {
    const isBech32 = /^bc1[a-z0-9]{25,87}$/i.test(addr);
    const isLegacy = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr);
    if (!isBech32 && !isLegacy) {
      return { valid: false, normalized: addr, reason: 'Ungültige Bitcoin-Adresse (erwartet bc1..., 1... oder 3...).' };
    }
    return { valid: true, normalized: addr.startsWith('bc1') || addr.startsWith('BC1') ? addr.toLowerCase() : addr, reason: null };
  }

  if (network === 'SOL') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
      return { valid: false, normalized: addr, reason: 'Ungültige Solana-Adresse (Base58, 32–44 Zeichen).' };
    }
    return { valid: true, normalized: addr, reason: null };
  }

  // EVM-Netzwerke
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { valid: false, normalized: addr, reason: `Ungültige ${network}-Adresse (erwartet 0x + 40 Hex-Zeichen).` };
  }
  return { valid: true, normalized: addr, reason: null };
}

/** Prüft, ob das gekaufte Asset sinnvoll über das gewählte Netzwerk auszahlbar ist (verhindert Fehl-Chain-Verlust). */
export function checkAssetNetworkCompatibility(
  baseAsset: string,
  network: SpotNetworkId,
): { compatible: boolean; warning: string | null } {
  const asset = baseAsset.trim().toUpperCase();
  if (asset === 'BTC') {
    if (network === 'BTC') return { compatible: true, warning: null };
    if (network === 'SOL') {
      return { compatible: false, warning: 'Natives BTC kann nicht direkt auf eine Solana-Adresse ausgezahlt werden (dafür Bitcoin Mainnet wählen).' };
    }
    return {
      compatible: true,
      warning: `Hinweis: BTC über ${network} kommt als Wrapped/Pegged-BTC auf der EVM-Chain an — für echtes Bitcoin „BTC (Mainnet)“ wählen.`,
    };
  }
  if (asset === 'SOL') {
    if (network === 'SOL') return { compatible: true, warning: null };
    return { compatible: false, warning: 'SOL muss über das Solana-Mainnet (SOL) ausgezahlt werden.' };
  }
  if (network === 'BTC' && asset !== 'BTC') {
    return { compatible: false, warning: `${asset} kann nicht über das Bitcoin-Mainnet übertragen werden.` };
  }
  if (network === 'SOL' && !['SOL', 'USDC', 'USDT', 'BONK', 'WIF', 'RNDR', 'HNT', 'JUP', 'RAY'].includes(asset)) {
    return {
      compatible: true,
      warning: `Prüfe auf deiner Börse, ob ${asset} als SPL-Token auf Solana unterstützt wird (sonst ERC20/Arbitrum wählen).`,
    };
  }
  return { compatible: true, warning: null };
}

export function expectedWalletApprovalPhrase(label: string): string {
  return `WALLET-FREIGABE ${label.trim().toUpperCase()}`;
}

export function verifyWalletApprovalPhrase(phrase: string, label: string): boolean {
  return phrase.trim().toUpperCase() === expectedWalletApprovalPhrase(label);
}

export function explorerAddressUrl(network: SpotNetworkId, address: string): string {
  switch (network) {
    case 'BTC':
      return `https://mempool.space/address/${encodeURIComponent(address)}`;
    case 'SOL':
      return `https://solscan.io/account/${encodeURIComponent(address)}`;
    case 'ARBITRUM':
      return `https://arbiscan.io/address/${encodeURIComponent(address)}`;
    case 'BASE':
      return `https://basescan.org/address/${encodeURIComponent(address)}`;
    case 'BSC':
      return `https://bscscan.com/address/${encodeURIComponent(address)}`;
    case 'POLYGON':
      return `https://polygonscan.com/address/${encodeURIComponent(address)}`;
    case 'ERC20':
    default:
      return `https://etherscan.io/address/${encodeURIComponent(address)}`;
  }
}

export function exchangeWithdrawUrl(exchangeId: string, asset: string): string | null {
  const a = encodeURIComponent(asset.toUpperCase());
  switch (exchangeId.toLowerCase()) {
    case 'binance':
      return `https://www.binance.com/de/my/wallet/account/main/withdrawal/crypto/${a}`;
    case 'kraken':
      return 'https://pro.kraken.com/app/funding/withdraw';
    case 'bybit':
      return 'https://www.bybit.com/user/assets/withdraw';
    case 'okx':
      return 'https://www.okx.com/balance/withdrawal';
    case 'coinbase':
      return 'https://www.coinbase.com/assets';
    case 'bitget':
      return 'https://www.bitget.com/asset/withdraw';
    case 'kucoin':
      return 'https://www.kucoin.com/assets/withdraw';
    default:
      return null;
  }
}

const EVM_RPC_LISTS: Record<Exclude<SpotNetworkId, 'BTC' | 'SOL'>, string[]> = {
  ERC20: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
  ARBITRUM: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  BASE: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  BSC: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
  POLYGON: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
};

const SOLANA_RPC_LIST = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

/** Verifizierte Solana SPL-Token-Mints für echten On-Chain-Kontostand-Abruf (`getTokenAccountsByOwner`) ohne API-Key. */
export const SOL_SPL_MINTS: Record<string, { mint: string; decimals: number }> = {
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  WIF: { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  RNDR: { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', decimals: 8 },
  RENDER: { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', decimals: 8 },
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  RAY: { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
};

/** Verifizierte ERC-20-Verträge (Contract + Decimals) für echten `balanceOf`-Check ohne API-Key. */
const ERC20_CONTRACTS: Record<string, Partial<Record<Exclude<SpotNetworkId, 'BTC' | 'SOL'>, { address: string; decimals: number }>>> = {
  USDT: {
    ERC20: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    ARBITRUM: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    BSC: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    POLYGON: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  },
  USDC: {
    ERC20: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ARBITRUM: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    BASE: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    BSC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    POLYGON: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  DAI: {
    ERC20: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    ARBITRUM: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  },
  WBTC: {
    ERC20: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    ARBITRUM: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
  },
  WETH: {
    ERC20: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    ARBITRUM: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    BASE: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
  QNT: {
    ERC20: { address: '0x4a220E6096B25EADb88358cb44068A3248254675', decimals: 18 },
  },
  LINK: {
    ERC20: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    ARBITRUM: { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18 },
  },
  UNI: {
    ERC20: { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    ARBITRUM: { address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', decimals: 18 },
  },
  AAVE: {
    ERC20: { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 },
    ARBITRUM: { address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', decimals: 18 },
  },
  ARB: {
    ARBITRUM: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    ERC20: { address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', decimals: 18 },
  },
  PEPE: {
    ERC20: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
  },
  SHIB: {
    ERC20: { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
  },
  FET: {
    ERC20: { address: '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', decimals: 18 },
  },
  ONDO: {
    ERC20: { address: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', decimals: 18 },
  },
  PENDLE: {
    ERC20: { address: '0x808507121B80c02388fAd14726482e061B8da827', decimals: 18 },
    ARBITRUM: { address: '0x0c880f6761F1af8d9Aa9C466984b80D99a8c9e8A', decimals: 18 },
  },
};

export type OnChainBalanceResult = {
  supported: boolean;
  balance: number | null;
  unit: string;
  explorerUrl: string;
  error?: string;
};

async function postJsonRpcWithFallback(
  urls: string[],
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
  let lastErr = 'RPC nicht erreichbar';
  for (const url of urls) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(fetchFn === fetch ? { signal: AbortSignal.timeout(7_000) } : {}),
      });
      if (!res.ok) {
        lastErr = `RPC HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      if (json.error) {
        lastErr = typeof json.error === 'object' && json.error && 'message' in json.error ? String((json.error as { message?: unknown }).message) : 'RPC Error';
        continue;
      }
      return { ok: true, json };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Echter öffentlicher On-Chain-Kontostand-Abruf (OHNE API-Key, kein Raten):
 * - Bitcoin über mempool.space
 * - Solana über offiziellen Mainnet-RPC + PublicNode-Fallback (Native SOL + verifizierte SPL-Tokens)
 * - Ethereum / Arbitrum / Base / BSC / Polygon über Multi-RPC-Failover (Native + verifizierte ERC-20).
 */
export async function fetchOnChainAssetBalance(
  network: SpotNetworkId,
  address: string,
  asset?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OnChainBalanceResult> {
  const explorerUrl = explorerAddressUrl(network, address);
  const meta = SPOT_NETWORKS.find((n) => n.id === network)!;
  const targetAsset = (asset ?? meta.nativeAsset).trim().toUpperCase();

  try {
    if (network === 'BTC') {
      if (targetAsset !== 'BTC') {
        return { supported: false, balance: null, unit: targetAsset, explorerUrl };
      }
      const res = await fetchFn(`https://mempool.space/api/address/${encodeURIComponent(address)}`, {
        ...(fetchFn === fetch ? { signal: AbortSignal.timeout(8_000) } : {}),
      });
      if (!res.ok) return { supported: true, balance: null, unit: 'BTC', explorerUrl, error: `mempool.space HTTP ${res.status}` };
      const json = (await res.json()) as {
        chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
        mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
      };
      const sats =
        (json.chain_stats?.funded_txo_sum ?? 0) -
        (json.chain_stats?.spent_txo_sum ?? 0) +
        (json.mempool_stats?.funded_txo_sum ?? 0) -
        (json.mempool_stats?.spent_txo_sum ?? 0);
      return { supported: true, balance: Math.round((sats / 1e8) * 1e8) / 1e8, unit: 'BTC', explorerUrl };
    }

    if (network === 'SOL') {
      if (targetAsset === 'SOL') {
        const rpc = await postJsonRpcWithFallback(
          SOLANA_RPC_LIST,
          { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] },
          fetchFn,
        );
        if (!rpc.ok) return { supported: true, balance: null, unit: 'SOL', explorerUrl, error: rpc.error };
        const result = rpc.json.result as { value?: number } | undefined;
        const lamports = Number(result?.value ?? 0);
        return { supported: true, balance: Math.round((lamports / 1e9) * 1e6) / 1e6, unit: 'SOL', explorerUrl };
      }

      const spl = SOL_SPL_MINTS[targetAsset];
      if (!spl) {
        return { supported: false, balance: null, unit: targetAsset, explorerUrl };
      }
      const rpc = await postJsonRpcWithFallback(
        SOLANA_RPC_LIST,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [address, { mint: spl.mint }, { encoding: 'jsonParsed' }],
        },
        fetchFn,
      );
      if (!rpc.ok) return { supported: true, balance: null, unit: targetAsset, explorerUrl, error: rpc.error };
      const accounts = ((rpc.json.result as { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number; amount?: string; decimals?: number } } } } } }> } | undefined)?.value) ?? [];
      let sum = 0;
      for (const acc of accounts) {
        const ta = acc.account?.data?.parsed?.info?.tokenAmount;
        if (typeof ta?.uiAmount === 'number' && Number.isFinite(ta.uiAmount)) {
          sum += ta.uiAmount;
        } else if (ta?.amount) {
          sum += Number(ta.amount) / 10 ** (ta.decimals ?? spl.decimals);
        }
      }
      return { supported: true, balance: Math.round(sum * 1e6) / 1e6, unit: targetAsset, explorerUrl };
    }

    const rpcUrls = EVM_RPC_LISTS[network];
    const isNative =
      (network === 'BSC' && targetAsset === 'BNB') ||
      (network === 'POLYGON' && (targetAsset === 'POL' || targetAsset === 'MATIC')) ||
      (['ERC20', 'ARBITRUM', 'BASE'].includes(network) && targetAsset === 'ETH');

    if (isNative) {
      const rpc = await postJsonRpcWithFallback(
        rpcUrls,
        { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
        fetchFn,
      );
      if (!rpc.ok) return { supported: true, balance: null, unit: targetAsset, explorerUrl, error: rpc.error };
      const hex = typeof rpc.json.result === 'string' ? rpc.json.result : '0x0';
      const wei = hex && hex !== '0x' ? BigInt(hex) : 0n;
      const val = Number(wei) / 1e18;
      return { supported: true, balance: Math.round(val * 1e6) / 1e6, unit: targetAsset, explorerUrl };
    }

    const erc20 = ERC20_CONTRACTS[targetAsset]?.[network];
    if (!erc20) {
      return { supported: false, balance: null, unit: targetAsset, explorerUrl };
    }

    const paddedAddr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const data = `0x70a08231${paddedAddr}`;
    const rpc = await postJsonRpcWithFallback(
      rpcUrls,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: erc20.address, data }, 'latest'],
      },
      fetchFn,
    );
    if (!rpc.ok) return { supported: true, balance: null, unit: targetAsset, explorerUrl, error: rpc.error };
    const hex = typeof rpc.json.result === 'string' ? rpc.json.result : '0x0';
    const raw = hex && hex !== '0x' ? BigInt(hex) : 0n;
    const val = Number(raw) / 10 ** erc20.decimals;
    return { supported: true, balance: Math.round(val * 1e6) / 1e6, unit: targetAsset, explorerUrl };
  } catch (err) {
    return {
      supported: true,
      balance: null,
      unit: targetAsset,
      explorerUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type CcxtSpotClient = {
  loadMarkets(): Promise<Record<string, unknown>>;
  fetchTicker(symbol: string): Promise<{ ask?: number; last?: number; close?: number }>;
  amountToPrecision(symbol: string, amount: number): string;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; filled?: number; amount?: number; average?: number; price?: number; fee?: { cost?: number } }>;
  withdraw?(
    code: string,
    amount: number,
    address: string,
    tag?: string,
    params?: Record<string, unknown>,
  ): Promise<{ id?: string; txid?: string; fee?: { cost?: number } }>;
};

const ccxtMod = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => CcxtSpotClient>;

function createCcxtSpotInstance(
  exchangeId: string,
  creds?: { apiKey: string; secret: string; password?: string; uid?: string },
): CcxtSpotClient {
  const Ctor = ccxtMod[exchangeId];
  if (!Ctor) throw new Error(`Börse „${exchangeId}“ wird von CCXT nicht unterstützt.`);
  return new Ctor({
    ...(creds ?? {}),
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
}

/** Holt echten öffentlichen Spot-Ask-Kurs (Binance mit US-Mirror-Fallback oder gewählte CCXT-Börse). */
export async function fetchLiveSpotQuote(
  symbol: string,
  exchangeId = 'binance',
): Promise<{ askPrice: number; exchangeId: string; takerFeeRate: number }> {
  const norm = symbol.trim().toUpperCase();
  if (exchangeId === 'binance') {
    const pair = norm.replace('/', '');
    for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
      try {
        const res = await fetch(`${host}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(pair)}`, {
          signal: AbortSignal.timeout(6_000),
        });
        if (!res.ok) continue;
        const j = (await res.json()) as { askPrice?: string };
        const ask = Number(j.askPrice);
        if (Number.isFinite(ask) && ask > 0) {
          return { askPrice: ask, exchangeId: 'binance', takerFeeRate: 0.001 };
        }
      } catch {
        // Fallback-Host probieren
      }
    }
  }
  const pub = createCcxtSpotInstance(exchangeId);
  const ticker = await pub.fetchTicker(norm);
  const ask = Number(ticker.ask ?? ticker.last ?? ticker.close);
  if (!Number.isFinite(ask) || ask <= 0) {
    throw new Error(`Kein echter Live-Spotkurs für ${norm} auf ${exchangeId} verfügbar.`);
  }
  return { askPrice: ask, exchangeId, takerFeeRate: 0.001 };
}

/**
 * Schritt 1 des Workflows: Spot-Kauf ausführen (Paper-Simulation zum echten Ask-Kurs
 * ODER echter Live-Spot-Kauf auf freigegebener CCXT-Börse hinter Kill-Switch & Prop-Gate).
 */
export async function executeCexSpotBuy(
  db: Db,
  input: {
    userId: string;
    path: 'guided_cex' | 'api_withdraw';
    mode: 'paper' | 'live';
    symbol: string;
    quoteAmount: number;
    exchangeConnectionId?: string | null;
    destinationWalletId?: string | null;
  },
) {
  const settings = await loadRiskSettings(db, input.userId);
  if (settings.killSwitchActive) {
    throw new Error('Kill-Switch ist aktiv — keine neuen Spot-Käufe erlaubt.');
  }

  const normSymbol = input.symbol.trim().toUpperCase();
  const [baseAsset, quoteAsset] = normSymbol.split('/') as [string | undefined, string | undefined];
  if (!baseAsset || !quoteAsset) {
    throw new Error(`Ungültiges Spot-Paar „${input.symbol}“ (erwartet z. B. BTC/USDT oder ETH/EUR).`);
  }

  // Ziel-Wallet laden & Kompatibilität prüfen (falls angegeben)
  let destWallet: typeof walletAddressBook.$inferSelect | null = null;
  let baselineBalance: number | null = null;
  if (input.destinationWalletId) {
    const [w] = await db
      .select()
      .from(walletAddressBook)
      .where(and(eq(walletAddressBook.id, input.destinationWalletId), eq(walletAddressBook.userId, input.userId)))
      .limit(1);
    if (!w) throw new Error('Ausgewählte Ziel-Wallet nicht gefunden.');
    const compat = checkAssetNetworkCompatibility(baseAsset, w.network as SpotNetworkId);
    if (!compat.compatible) throw new Error(compat.warning ?? 'Asset und Ziel-Netzwerk sind nicht kompatibel.');
    if (input.path === 'api_withdraw' && !w.isWhitelisted) {
      throw new Error(`Ziel-Wallet „${w.label}“ ist noch nicht per WALLET-FREIGABE freigegeben.`);
    }
    destWallet = w;
    const onchain = await fetchOnChainAssetBalance(w.network as SpotNetworkId, w.address, baseAsset).catch(() => null);
    baselineBalance = onchain?.balance ?? null;
  }

  if (input.mode === 'paper') {
    const quote = await fetchLiveSpotQuote(normSymbol, 'binance');
    const feeUsd = input.quoteAmount * quote.takerFeeRate;
    const netQuote = input.quoteAmount - feeUsd;
    const filledQty = netQuote / quote.askPrice;

    const [wf] = await db
      .insert(spotWorkflows)
      .values({
        userId: input.userId,
        path: input.path,
        mode: 'paper',
        exchangeName: 'Binance (Paper-Spot)',
        symbol: normSymbol,
        baseAsset,
        quoteAsset,
        quoteAmount: String(input.quoteAmount),
        filledBaseQty: String(filledQty),
        avgFillPrice: String(quote.askPrice),
        feePaid: String(feeUsd),
        destinationWalletId: destWallet?.id ?? null,
        destinationAddress: destWallet?.address ?? null,
        destinationNetwork: destWallet?.network ?? null,
        baselineOnchainBalance: baselineBalance !== null ? String(baselineBalance) : null,
        stage: destWallet ? 'awaiting_transfer' : 'bought',
        statusNote: `Paper-Spotkauf ausgeführt zum echten Live-Ask (${quote.askPrice.toFixed(4)} ${quoteAsset}).`,
      })
      .returning();

    await db.insert(auditLog).values({
      actor: 'user',
      userId: input.userId,
      action: 'spot.buy.paper',
      entityType: 'spot_workflow',
      entityId: wf!.id,
      details: { symbol: normSymbol, quoteAmount: input.quoteAmount, filledQty, askPrice: quote.askPrice },
    });

    return wf!;
  }

  // LIVE-MODUS: erfordert aktive trading-Verbindung + aktive Live-Freigabe + Prop-Gate
  if (!input.exchangeConnectionId) {
    throw new Error('Für einen echten Live-Spotkauf bitte eine verbundene Börse auswählen.');
  }
  const [conn] = await db
    .select()
    .from(exchangeConnections)
    .where(
      and(
        eq(exchangeConnections.id, input.exchangeConnectionId),
        eq(exchangeConnections.userId, input.userId),
        eq(exchangeConnections.status, 'active'),
        isNull(exchangeConnections.revokedAt),
      ),
    )
    .limit(1);
  if (!conn) throw new Error('Börsen-Verbindung nicht gefunden oder nicht aktiv.');
  if (conn.mode !== 'trading') {
    throw new Error(`Verbindung „${conn.exchangeName}“ ist nur lesend (read_only) — für Live-Spotkauf auf Trading stellen.`);
  }

  const activeApprovals = await db
    .select({ venueId: venueApprovals.venueId })
    .from(venueApprovals)
    .where(isNull(venueApprovals.revokedAt));
  const approvedSet = new Set(activeApprovals.map((a) => a.venueId));
  if (!approvedSet.has(conn.exchangeId) && !approvedSet.has(`live:${conn.id}`)) {
    throw new Error(`Keine aktive LIVE-FREIGABE für „${conn.exchangeName}“ — bitte zuerst unter #/traden?tab=risiko freigeben.`);
  }

  const propGate = await loadFundedGateForConnection(db, input.userId, conn.id, input.quoteAmount * 0.05);
  if (propGate && !propGate.allowed) {
    throw new Error(propGate.reason ?? 'Prop-Gate hat den Live-Spotkauf blockiert.');
  }

  const creds = decryptCredentials(conn.encryptedPayload);
  if ('walletAddress' in creds || !creds.apiKey || !creds.secret) {
    throw new Error('Eine Read-Only-Wallet-Verbindung kann keine CEX-Spot-Order ausführen.');
  }

  const client = createCcxtSpotInstance(conn.exchangeId, {
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.uid ? { uid: creds.uid } : {}),
  });
  await client.loadMarkets();
  const ticker = await client.fetchTicker(normSymbol);
  const refAsk = Number(ticker.ask ?? ticker.last ?? ticker.close);
  if (!Number.isFinite(refAsk) || refAsk <= 0) {
    throw new Error(`Kein gültiger Marktpreis für ${normSymbol} auf ${conn.exchangeName}.`);
  }
  const rawBaseQty = input.quoteAmount / refAsk;
  const preciseQty = Number(client.amountToPrecision(normSymbol, rawBaseQty));
  if (!(preciseQty > 0)) {
    throw new Error(`Betrag (${input.quoteAmount} ${quoteAsset}) liegt unter der Mindest-Lotgröße für ${normSymbol}.`);
  }

  const order = await client.createOrder(normSymbol, 'market', 'buy', preciseQty);
  const filledQty = Number(order.filled ?? order.amount ?? preciseQty);
  const fillPrice = Number(order.average ?? order.price ?? refAsk);
  const feePaid = Number(order.fee?.cost ?? 0);

  const [wf] = await db
    .insert(spotWorkflows)
    .values({
      userId: input.userId,
      path: input.path,
      mode: 'live',
      exchangeConnectionId: conn.id,
      exchangeName: conn.exchangeName,
      symbol: normSymbol,
      baseAsset,
      quoteAsset,
      quoteAmount: String(input.quoteAmount),
      filledBaseQty: String(filledQty),
      avgFillPrice: String(fillPrice),
      feePaid: String(feePaid),
      exchangeOrderId: order.id,
      destinationWalletId: destWallet?.id ?? null,
      destinationAddress: destWallet?.address ?? null,
      destinationNetwork: destWallet?.network ?? null,
      baselineOnchainBalance: baselineBalance !== null ? String(baselineBalance) : null,
      stage: destWallet ? 'awaiting_transfer' : 'bought',
      statusNote: `Live-Spotkauf auf ${conn.exchangeName} ausgeführt (Order #${order.id}).`,
    })
    .returning();

  await db.insert(auditLog).values({
    actor: 'user',
    userId: input.userId,
    action: 'spot.buy.live',
    entityType: 'spot_workflow',
    entityId: wf!.id,
    details: { exchange: conn.exchangeId, symbol: normSymbol, filledQty, fillPrice, orderId: order.id },
  });

  return wf!;
}

/**
 * Schritt 2 für Weg C (`api_withdraw`): Manuelle 1-Klick-Auszahlung an eine
 * explizit per `WALLET-FREIGABE` freigegebene eigene Ziel-Wallet.
 * Strenge 4-Stufen-Schranke; bei fehlendem API-Withdraw-Recht ehrliche Meldung + nahtloser Weg-A-Übergang.
 */
export async function executeWhitelistedCexWithdraw(
  db: Db,
  input: {
    userId: string;
    workflowId: string;
    confirmPhrase: string;
  },
) {
  if (input.confirmPhrase.trim().toUpperCase() !== WITHDRAW_CONFIRM_PHRASE) {
    throw new Error(`Bitte exakt „${WITHDRAW_CONFIRM_PHRASE}“ eingeben.`);
  }

  const [wf] = await db
    .select()
    .from(spotWorkflows)
    .where(and(eq(spotWorkflows.id, input.workflowId), eq(spotWorkflows.userId, input.userId)))
    .limit(1);
  if (!wf) throw new Error('Spot-Workflow nicht gefunden.');
  if (!wf.destinationWalletId || !wf.destinationAddress || !wf.destinationNetwork) {
    throw new Error('Diesem Workflow ist keine Ziel-Wallet zugeordnet.');
  }

  const [wallet] = await db
    .select()
    .from(walletAddressBook)
    .where(and(eq(walletAddressBook.id, wf.destinationWalletId), eq(walletAddressBook.userId, input.userId)))
    .limit(1);
  if (!wallet || !wallet.isWhitelisted) {
    throw new Error('Ziel-Wallet ist nicht per WALLET-FREIGABE freigeschaltet — Auszahlung verweigert.');
  }

  const qty = Number(wf.filledBaseQty ?? 0);
  if (!(qty > 0)) throw new Error('Keine gekaufte Menge für den Transfer vorhanden.');

  // Paper-Workflow: klar als Simulation abschließen (keine Börsen-Aktion)
  if (wf.mode === 'paper') {
    const [updated] = await db
      .update(spotWorkflows)
      .set({
        stage: 'onchain_confirmed',
        withdrawTxId: `paper-sim-${wf.id.slice(0, 8)}`,
        statusNote: `Paper-Simulation: Transfer von ${qty.toFixed(6)} ${wf.baseAsset} an „${wallet.label}“ (${wallet.network}) durchgespielt.`,
        updatedAt: new Date(),
      })
      .where(eq(spotWorkflows.id, wf.id))
      .returning();
    return { ok: true as const, simulated: true, workflow: updated! };
  }

  // Live-Modus: echte Verbindung + aktive Live-Freigabe prüfen
  const settings = await loadRiskSettings(db, input.userId);
  if (settings.killSwitchActive) {
    throw new Error('Kill-Switch ist aktiv — Auszahlung gesperrt.');
  }
  if (!wf.exchangeConnectionId) {
    throw new Error('Keine Börsen-Verbindung mit diesem Workflow verknüpft.');
  }

  const [conn] = await db
    .select()
    .from(exchangeConnections)
    .where(and(eq(exchangeConnections.id, wf.exchangeConnectionId), eq(exchangeConnections.userId, input.userId), isNull(exchangeConnections.revokedAt)))
    .limit(1);
  if (!conn) throw new Error('Börsen-Verbindung nicht mehr aktiv.');

  const activeApprovals = await db
    .select({ venueId: venueApprovals.venueId })
    .from(venueApprovals)
    .where(isNull(venueApprovals.revokedAt));
  const approvedSet = new Set(activeApprovals.map((a) => a.venueId));
  if (!approvedSet.has(conn.exchangeId) && !approvedSet.has(`live:${conn.id}`)) {
    throw new Error(`Keine aktive LIVE-FREIGABE für ${conn.exchangeName}.`);
  }

  const creds = decryptCredentials(conn.encryptedPayload);
  if ('walletAddress' in creds || !creds.apiKey || !creds.secret) {
    throw new Error('Read-Only-Verbindung unterstützt keine Auszahlung.');
  }

  const client = createCcxtSpotInstance(conn.exchangeId, {
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.uid ? { uid: creds.uid } : {}),
  });
  if (typeof client.withdraw !== 'function') {
    throw new Error(`${conn.exchangeName} unterstützt in CCXT keinen direkten API-Transfer — bitte Weg A (Geführter Transfer) nutzen.`);
  }

  const netMeta = SPOT_NETWORKS.find((n) => n.id === wallet.network);
  try {
    const res = await client.withdraw(
      wf.baseAsset,
      qty,
      wallet.address,
      wallet.memo ?? undefined,
      netMeta ? { network: netMeta.ccxtNetwork } : undefined,
    );
    const txId = res.txid ?? res.id ?? null;
    const wFee = res.fee?.cost !== undefined ? String(res.fee.cost) : null;

    const [updated] = await db
      .update(spotWorkflows)
      .set({
        stage: 'withdrawn',
        withdrawTxId: txId,
        withdrawFee: wFee,
        statusNote: `API-Auszahlung auf ${conn.exchangeName} angestoßen${txId ? ` (Tx/ID: ${txId})` : ''}. Klicke auf „On-Chain-Eingang prüfen“, sobald die Transaktion bestätigt ist.`,
        updatedAt: new Date(),
      })
      .where(eq(spotWorkflows.id, wf.id))
      .returning();

    await db.insert(auditLog).values({
      actor: 'user',
      userId: input.userId,
      action: 'spot.withdraw.live',
      entityType: 'spot_workflow',
      entityId: wf.id,
      details: { exchange: conn.exchangeId, asset: wf.baseAsset, qty, network: wallet.network, walletId: wallet.id, txId },
    });

    return { ok: true as const, simulated: false, workflow: updated! };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const note = `Börse hat API-Auszahlung abgelehnt (${rawMsg.slice(0, 180)}). Tipp: Entweder auf der Börse IP- & Adress-Whitelist für den API-Key aktivieren oder direkt per Weg A (Geführter Transfer mit 2FA) abschließen.`;
    const [updated] = await db
      .update(spotWorkflows)
      .set({
        statusNote: note,
        updatedAt: new Date(),
      })
      .where(eq(spotWorkflows.id, wf.id))
      .returning();
    return { ok: false as const, error: note, workflow: updated! };
  }
}

export const SPOT_COMPARE_EXCHANGES: ReadonlyArray<{
  exchangeId: string;
  exchangeName: string;
  takerFeeRate: number;
}> = [
  { exchangeId: 'binance', exchangeName: 'Binance', takerFeeRate: 0.001 },
  { exchangeId: 'kraken', exchangeName: 'Kraken', takerFeeRate: 0.0026 },
  { exchangeId: 'bybit', exchangeName: 'Bybit', takerFeeRate: 0.001 },
  { exchangeId: 'okx', exchangeName: 'OKX', takerFeeRate: 0.001 },
  { exchangeId: 'bitget', exchangeName: 'Bitget', takerFeeRate: 0.001 },
  { exchangeId: 'kucoin', exchangeName: 'KuCoin', takerFeeRate: 0.001 },
  { exchangeId: 'coinbase', exchangeName: 'Coinbase', takerFeeRate: 0.006 },
];

export type SpotExchangeComparisonQuote = {
  exchangeId: string;
  exchangeName: string;
  askPrice: number | null;
  takerFeeRate: number;
  feeQuote: number | null;
  estBaseQty: number | null;
  effectivePrice: number | null;
  isBest: boolean;
  diffPctFromBest: number | null;
  error: string | null;
};

/**
 * Vergleicht öffentliche Live-Spot-Ask-Kurse (inkl. Taker-Gebühr) über die wichtigsten Börsen
 * und sortiert nach der höchsten Netto-Empfangsmenge (`estBaseQty`).
 */
export async function compareLiveSpotQuotes(
  symbol: string,
  quoteAmount: number,
  quoteFetcher: (sym: string, exId: string) => Promise<{ askPrice: number; exchangeId: string; takerFeeRate: number }> = fetchLiveSpotQuote,
): Promise<SpotExchangeComparisonQuote[]> {
  const norm = symbol.trim().toUpperCase();
  const rows: SpotExchangeComparisonQuote[] = await Promise.all(
    SPOT_COMPARE_EXCHANGES.map(async (ex): Promise<SpotExchangeComparisonQuote> => {
      try {
        const q = await quoteFetcher(norm, ex.exchangeId);
        const feeRate = ex.takerFeeRate;
        const feeQuote = Math.round(quoteAmount * feeRate * 100) / 100;
        const estBaseQty = (quoteAmount - feeQuote) / q.askPrice;
        const effectivePrice = q.askPrice / (1 - feeRate);
        return {
          exchangeId: ex.exchangeId,
          exchangeName: ex.exchangeName,
          askPrice: q.askPrice,
          takerFeeRate: feeRate,
          feeQuote,
          estBaseQty,
          effectivePrice,
          isBest: false,
          diffPctFromBest: null,
          error: null,
        };
      } catch (err) {
        return {
          exchangeId: ex.exchangeId,
          exchangeName: ex.exchangeName,
          askPrice: null,
          takerFeeRate: ex.takerFeeRate,
          feeQuote: null,
          estBaseQty: null,
          effectivePrice: null,
          isBest: false,
          diffPctFromBest: null,
          error: err instanceof Error ? err.message : 'Paar dort nicht gelistet / nicht erreichbar',
        };
      }
    }),
  );

  const available = rows.filter((r) => r.estBaseQty !== null && r.estBaseQty > 0);
  available.sort((a, b) => (b.estBaseQty ?? 0) - (a.estBaseQty ?? 0));
  const bestQty = available[0]?.estBaseQty ?? null;
  if (bestQty !== null && bestQty > 0) {
    for (const r of available) {
      r.isBest = r === available[0];
      r.diffPctFromBest = Math.round(((bestQty - (r.estBaseQty ?? 0)) / bestQty) * 10_000) / 100;
    }
  }
  const unavailable = rows.filter((r) => r.estBaseQty === null || r.estBaseQty <= 0);
  return [...available, ...unavailable];
}

export type AddressBookWalletValuation = {
  walletId: string;
  label: string;
  network: SpotNetworkId;
  address: string;
  isWhitelisted: boolean;
  explorerUrl: string;
  totalUsd: number | null;
  holdings: Array<{
    asset: string;
    balance: number;
    valuedUsd: number | null;
  }>;
  incomplete: boolean;
  error: string | null;
};

/**
 * Bewertet alle im Adressbuch (`wallet_address_book`) hinterlegten Self-Custody-Wallets
 * anhand ihrer ECHTEN On-Chain-Bestände (Nativ-Coin des Netzwerks + alle über `spot_workflows`
 * an diese Wallet übertragenen Assets) und einer übergebenen USD-Bewertungsfunktion.
 * Keine geschätzten Bestände: ist ein RPC nicht erreichbar oder ein Kurs unbekannt,
 * wird `incomplete: true` bzw. `error` ehrlich ausgewiesen.
 */
export async function valueAddressBookWallets(
  db: Db,
  userId: string,
  valueBalancesFn: (amounts: Record<string, number>) => Promise<{ totalUsd: number; valuedUsd: Record<string, number>; unvalued: string[] }>,
  fetchBalanceFn: typeof fetchOnChainAssetBalance = fetchOnChainAssetBalance,
): Promise<AddressBookWalletValuation[]> {
  const [wallets, workflows] = await Promise.all([
    db.select().from(walletAddressBook).where(eq(walletAddressBook.userId, userId)),
    db.select({ destinationWalletId: spotWorkflows.destinationWalletId, baseAsset: spotWorkflows.baseAsset })
      .from(spotWorkflows)
      .where(eq(spotWorkflows.userId, userId)),
  ]);

  if (wallets.length === 0) return [];

  const assetsByWallet = new Map<string, Set<string>>();
  for (const wf of workflows) {
    if (!wf.destinationWalletId || !wf.baseAsset) continue;
    let set = assetsByWallet.get(wf.destinationWalletId);
    if (!set) {
      set = new Set<string>();
      assetsByWallet.set(wf.destinationWalletId, set);
    }
    set.add(wf.baseAsset.trim().toUpperCase());
  }

  const out: AddressBookWalletValuation[] = [];
  for (const w of wallets) {
    const net = w.network as SpotNetworkId;
    const netMeta = SPOT_NETWORKS.find((n) => n.id === net);
    const nativeAsset = netMeta?.nativeAsset ?? 'BTC';
    const assetsToCheck = new Set<string>([nativeAsset, ...(assetsByWallet.get(w.id) ?? [])]);
    if (net === 'SOL') assetsToCheck.add('USDC');
    if (net === 'ERC20' || net === 'ARBITRUM' || net === 'BASE') assetsToCheck.add('USDC');

    const amounts: Record<string, number> = {};
    const rawBalances: Array<{ asset: string; balance: number }> = [];
    const errors: string[] = [];
    let incomplete = false;

    for (const asset of assetsToCheck) {
      const res = await fetchBalanceFn(net, w.address, asset);
      if (!res.supported) continue;
      if (res.balance === null) {
        if (asset === nativeAsset && res.error) errors.push(res.error);
        incomplete = true;
        continue;
      }
      if (res.balance > 0) {
        amounts[res.unit] = (amounts[res.unit] ?? 0) + res.balance;
        rawBalances.push({ asset: res.unit, balance: res.balance });
      }
    }

    if (rawBalances.length === 0) {
      out.push({
        walletId: w.id,
        label: w.label,
        network: net,
        address: w.address,
        isWhitelisted: w.isWhitelisted,
        explorerUrl: explorerAddressUrl(net, w.address),
        totalUsd: errors.length > 0 ? null : 0,
        holdings: [],
        incomplete,
        error: errors[0] ?? null,
      });
      continue;
    }

    try {
      const valued = await valueBalancesFn(amounts);
      if (valued.unvalued.length > 0) incomplete = true;
      out.push({
        walletId: w.id,
        label: w.label,
        network: net,
        address: w.address,
        isWhitelisted: w.isWhitelisted,
        explorerUrl: explorerAddressUrl(net, w.address),
        totalUsd: valued.totalUsd,
        holdings: rawBalances.map((b) => ({
          asset: b.asset,
          balance: b.balance,
          valuedUsd: valued.valuedUsd[b.asset] ?? null,
        })),
        incomplete,
        error: errors[0] ?? null,
      });
    } catch (err) {
      out.push({
        walletId: w.id,
        label: w.label,
        network: net,
        address: w.address,
        isWhitelisted: w.isWhitelisted,
        explorerUrl: explorerAddressUrl(net, w.address),
        totalUsd: null,
        holdings: rawBalances.map((b) => ({ asset: b.asset, balance: b.balance, valuedUsd: null })),
        incomplete: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
