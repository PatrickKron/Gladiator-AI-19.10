import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * Agent-Wallet-Prüfung für Hyperliquid (Vision-Punkt 5) — VOR der ersten Order.
 *
 * Hyperliquid unterscheidet nativ zwischen Haupt-Wallet (kann auszahlen) und
 * Agent-/API-Wallet (kann NUR handeln). Gladiator akzeptiert ausschließlich
 * Agent-Keys. Bewiesen wird das über die öffentliche Info-API (`userRole`):
 * Die aus dem Key abgeleitete Adresse muss dort als „agent" der hinterlegten
 * Haupt-Wallet geführt sein. Wird stattdessen der Haupt-Wallet-Key hinterlegt,
 * verweigert Gladiator ihn — der könnte Geld abziehen.
 */

export const HYPERLIQUID_INFO_URL = {
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
  mainnet: 'https://api.hyperliquid.xyz/info',
} as const;

export type HyperliquidNetwork = keyof typeof HYPERLIQUID_INFO_URL;

/** Antwort von `userRole` (Hyperliquid-Info-API). */
export type HyperliquidUserRole =
  | { role: 'missing' | 'user' | 'vault' }
  | { role: 'agent'; data: { user: string } }
  | { role: 'subAccount'; data: { master: string } };

export type AgentCheck = {
  ok: boolean;
  agentAddress: string;
  reason: 'agent_ok' | 'main_wallet_key' | 'not_agent' | 'wrong_master' | 'invalid_key' | 'unreachable';
  detail: string;
};

/** EVM-Adresse (lowercase) aus einem secp256k1-Private-Key (0x + 64 Hex). */
export function addressFromPrivateKey(privateKey: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Private Key muss 0x + 64 Hex-Zeichen sein.');
  const pub = secp256k1.getPublicKey(Buffer.from(privateKey.slice(2), 'hex'), false).slice(1);
  return `0x${Buffer.from(keccak_256(pub).slice(-20)).toString('hex')}`;
}

/** Reine Bewertung — kein Netz; Grundlage für Tests und die UI-Meldung. */
export function judgeAgentRole(walletAddress: string, agentAddress: string, role: HyperliquidUserRole): AgentCheck {
  const wallet = walletAddress.toLowerCase();
  const agent = agentAddress.toLowerCase();
  if (agent === wallet) {
    return {
      ok: false,
      agentAddress: agent,
      reason: 'main_wallet_key',
      detail: 'Das ist der Schlüssel der HAUPT-Wallet (kann auszahlen) — verweigert. Bitte eine Agent-Wallet unter „API" anlegen und deren Key hinterlegen.',
    };
  }
  if (role.role !== 'agent') {
    return {
      ok: false,
      agentAddress: agent,
      reason: 'not_agent',
      detail: `Adresse ${agent} ist bei Hyperliquid keine freigegebene Agent-Wallet (Rolle: ${role.role}). Agent-Wallet in der Hyperliquid-App unter „API" autorisieren.`,
    };
  }
  if (role.data.user.toLowerCase() !== wallet) {
    return {
      ok: false,
      agentAddress: agent,
      reason: 'wrong_master',
      detail: `Agent-Wallet gehört zu ${role.data.user.toLowerCase()}, nicht zur hinterlegten Haupt-Wallet ${wallet}.`,
    };
  }
  return {
    ok: true,
    agentAddress: agent,
    reason: 'agent_ok',
    detail: `Agent-Wallet ${agent} ist für ${wallet} freigegeben — darf handeln, kann nicht auszahlen.`,
  };
}

export async function fetchUserRole(
  address: string,
  network: HyperliquidNetwork,
  fetchFn: typeof fetch = fetch,
): Promise<HyperliquidUserRole> {
  const res = await fetchFn(HYPERLIQUID_INFO_URL[network], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'userRole', user: address }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid-Info-API: HTTP ${res.status}`);
  const body = (await res.json()) as HyperliquidUserRole;
  if (!body || typeof body.role !== 'string') throw new Error('Hyperliquid-Info-API: unerwartete Antwort.');
  return body;
}

/** Vollständige Prüfung: Key → Adresse → `userRole` → Bewertung. */
export async function verifyAgentWallet(
  walletAddress: string,
  agentPrivateKey: string,
  network: HyperliquidNetwork,
  fetchFn: typeof fetch = fetch,
): Promise<AgentCheck> {
  let agentAddress: string;
  try {
    agentAddress = addressFromPrivateKey(agentPrivateKey);
  } catch (err) {
    return { ok: false, agentAddress: '', reason: 'invalid_key', detail: err instanceof Error ? err.message : String(err) };
  }
  // Haupt-Wallet-Key sofort verweigern, ohne Netz
  if (agentAddress === walletAddress.toLowerCase()) return judgeAgentRole(walletAddress, agentAddress, { role: 'user' });
  try {
    return judgeAgentRole(walletAddress, agentAddress, await fetchUserRole(agentAddress, network, fetchFn));
  } catch (err) {
    return {
      ok: false,
      agentAddress,
      reason: 'unreachable',
      detail: `Hyperliquid nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
