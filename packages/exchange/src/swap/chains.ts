/**
 * Ketten für Spot-Swaps (Vision-Punkt 5). Solana über Jupiter, EVM-Ketten über
 * KyberSwap — beide öffentliche Aggregator-APIs ohne Schlüssel. RPCs sind
 * öffentliche Standard-Endpunkte; Selbsthoster können sie per Env ersetzen
 * (`RPC_URL_SOLANA`, `RPC_URL_ETHEREUM`, …).
 */

export type SwapToken = { address: string; symbol: string; decimals: number };

export type SwapChain = {
  id: SwapChainId;
  kind: 'solana' | 'evm';
  name: string;
  chainId: number | null;
  /** Native Währung (Gas + Standard-Gegenwährung beim Kaufen). */
  native: SwapToken;
  /** Wrapped-Native-Token (für den USD-Preis über DexScreener). */
  wrappedNative: string;
  aggregator: 'jupiter' | 'kyberswap';
  /** Ketten-Kennung bei KyberSwap bzw. DexScreener. */
  kyberSlug: string | null;
  dexscreenerId: string;
  defaultRpc: string;
  explorerTx: string;
  /** Schnellwahl-Beträge (native) im Kauf-Ticket. */
  quickBuy: number[];
};

export const SWAP_CHAIN_IDS = ['solana', 'ethereum', 'base', 'arbitrum', 'bsc'] as const;
export type SwapChainId = (typeof SWAP_CHAIN_IDS)[number];

/** Platzhalter-Adresse der nativen Währung bei KyberSwap (Konvention der Aggregatoren). */
export const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const SWAP_CHAINS: Record<SwapChainId, SwapChain> = {
  solana: {
    id: 'solana',
    kind: 'solana',
    name: 'Solana',
    chainId: null,
    native: { address: SOL_MINT, symbol: 'SOL', decimals: 9 },
    wrappedNative: SOL_MINT,
    aggregator: 'jupiter',
    kyberSlug: null,
    dexscreenerId: 'solana',
    defaultRpc: 'https://api.mainnet-beta.solana.com',
    explorerTx: 'https://solscan.io/tx/',
    quickBuy: [0.1, 0.5, 1, 2, 5],
  },
  ethereum: {
    id: 'ethereum',
    kind: 'evm',
    name: 'Ethereum',
    chainId: 1,
    native: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 },
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    aggregator: 'kyberswap',
    kyberSlug: 'ethereum',
    dexscreenerId: 'ethereum',
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
    explorerTx: 'https://etherscan.io/tx/',
    quickBuy: [0.01, 0.05, 0.1, 0.25, 0.5],
  },
  base: {
    id: 'base',
    kind: 'evm',
    name: 'Base',
    chainId: 8453,
    native: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 },
    wrappedNative: '0x4200000000000000000000000000000000000006',
    aggregator: 'kyberswap',
    kyberSlug: 'base',
    dexscreenerId: 'base',
    defaultRpc: 'https://base-rpc.publicnode.com',
    explorerTx: 'https://basescan.org/tx/',
    quickBuy: [0.01, 0.05, 0.1, 0.25, 0.5],
  },
  arbitrum: {
    id: 'arbitrum',
    kind: 'evm',
    name: 'Arbitrum',
    chainId: 42161,
    native: { address: EVM_NATIVE, symbol: 'ETH', decimals: 18 },
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    aggregator: 'kyberswap',
    kyberSlug: 'arbitrum',
    dexscreenerId: 'arbitrum',
    defaultRpc: 'https://arbitrum-one-rpc.publicnode.com',
    explorerTx: 'https://arbiscan.io/tx/',
    quickBuy: [0.01, 0.05, 0.1, 0.25, 0.5],
  },
  bsc: {
    id: 'bsc',
    kind: 'evm',
    name: 'BNB Chain',
    chainId: 56,
    native: { address: EVM_NATIVE, symbol: 'BNB', decimals: 18 },
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    aggregator: 'kyberswap',
    kyberSlug: 'bsc',
    dexscreenerId: 'bsc',
    defaultRpc: 'https://bsc-rpc.publicnode.com',
    explorerTx: 'https://bscscan.com/tx/',
    quickBuy: [0.05, 0.1, 0.25, 0.5, 1],
  },
};

export function rpcUrl(chain: SwapChainId): string {
  return process.env[`RPC_URL_${chain.toUpperCase()}`]?.trim() || SWAP_CHAINS[chain].defaultRpc;
}

/** Adress-Format je Kettentyp (Solana base58 32–44, EVM 0x+40 Hex). */
export function isTokenAddress(chain: SwapChainId, address: string): boolean {
  return SWAP_CHAINS[chain].kind === 'solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function isNativeToken(chain: SwapChainId, address: string): boolean {
  const n = SWAP_CHAINS[chain].native.address;
  return SWAP_CHAINS[chain].kind === 'evm' ? n.toLowerCase() === address.toLowerCase() : n === address;
}

/** Dezimal-String → kleinste Einheit (bigint), ohne Float-Rundung. */
export function toAtomic(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Ungültiger Betrag: ${amount}`);
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/** Kleinste Einheit → Dezimal-String (ohne überflüssige Nullen). */
export function fromAtomic(atomic: bigint | string, decimals: number): string {
  const v = BigInt(atomic);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
