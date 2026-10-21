import { isNativeToken, rpcUrl, SWAP_CHAINS, type SwapChainId } from './chains.js';
import { isOnCurveAddress } from './solana-guard.js';

/**
 * Token-Sicherheitscheck vor dem Kauf (Vision-Punkt 5, „wie Trojan“):
 * - Solana direkt von der Kette (`getAccountInfo`, jsonParsed): Darf jemand
 *   weitere Tokens prägen (Mint-Authority) oder Konten einfrieren
 *   (Freeze-Authority)? Token-2022: Transfergebühr, permanenter Delegierter,
 *   nicht übertragbar.
 * - EVM über die öffentliche GoPlus-API (ohne Schlüssel): Honeypot, Kauf-/
 *   Verkaufssteuer, Eigentümer kann Guthaben ändern; pausierbar/Mint/Proxy als Warnung.
 * `severe` = man kann nicht (vollständig) verkaufen oder verliert die Tokens —
 * Käufe blockiert das Swap-Gate dann immer. `warnings` werden nur angezeigt.
 * Nicht verfügbar → `checked: false` mit Grund, nie „sicher“ geraten.
 */

export const GOPLUS_API = 'https://api.gopluslabs.io/api/v1';

export type TokenSafety = {
  checked: boolean;
  source: 'chain' | 'goplus' | 'native' | null;
  severe: string[];
  warnings: string[];
  /** größte Kauf-/Verkaufssteuer bzw. Transfergebühr in %; null = unbekannt */
  taxPct: number | null;
  /**
   * Anteil am Gesamtangebot, den die 10 größten WALLETS halten (in %) — Pools,
   * Bonding-Curves und Lock-Verträge zählen nicht; null = nicht prüfbar.
   */
  top10Pct?: number | null;
  error: string | null;
};

/** Ab diesem Anteil der Top-10-Wallets: Warnung (Abverkaufsrisiko durch wenige Halter). */
export const TOP10_WARN_PCT = 30;

type Fetch = typeof fetch;

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EHFLp88EzTEbtKFFuh6';

type ParsedMint = {
  owner?: string;
  data?: {
    parsed?: {
      type?: string;
      info?: {
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        extensions?: { extension?: string; state?: Record<string, unknown> }[];
      };
    };
  };
};

/** Reine Bewertung eines geparsten Solana-Mint-Kontos (getestet). */
export function judgeSolanaMint(acc: ParsedMint | null): TokenSafety {
  if (!acc) return { checked: true, source: 'chain', severe: ['not_a_token'], warnings: [], taxPct: null, error: null };
  if (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022) {
    return { checked: true, source: 'chain', severe: ['not_a_token'], warnings: [], taxPct: null, error: null };
  }
  const info = acc.data?.parsed?.info;
  if (acc.data?.parsed?.type !== 'mint' || !info) return { checked: true, source: 'chain', severe: ['not_a_token'], warnings: [], taxPct: null, error: null };
  const severe: string[] = [];
  const warnings: string[] = [];
  if (info.mintAuthority) warnings.push('mint_authority');
  if (info.freezeAuthority) warnings.push('freeze_authority');
  let taxPct = 0;
  for (const ext of info.extensions ?? []) {
    switch (ext.extension) {
      case 'permanentDelegate':
        if (ext.state?.delegate) severe.push('permanent_delegate');
        break;
      case 'nonTransferable':
        severe.push('non_transferable');
        break;
      case 'transferHook':
        if (ext.state?.programId) warnings.push('transfer_hook');
        break;
      case 'pausableConfig':
        if (ext.state?.paused === true) severe.push('transfer_paused');
        else warnings.push('pausable');
        break;
      case 'transferFeeConfig': {
        const fee = (ext.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0;
        const older = (ext.state?.olderTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0;
        taxPct = Math.max(taxPct, fee / 100, older / 100);
        break;
      }
      default:
        break;
    }
  }
  return { checked: true, source: 'chain', severe, warnings, taxPct, error: null };
}

/**
 * Top-10-Konzentration auf Solana (rein, getestet): größte Token-Konten mit
 * ihrem Besitzer; Konten von Programm-Adressen (Pools, Bonding-Curves, Locks —
 * nicht auf der Kurve) zählen nicht. Anteil am Gesamtangebot in %.
 */
export function solanaTop10Pct(accounts: { amount: string; owner: string | null; ownerIsWallet: boolean }[], supply: string): number | null {
  const total = BigInt(supply);
  if (total <= 0n) return null;
  const wallets = accounts.filter((a) => a.owner !== null && a.ownerIsWallet);
  // je Besitzer zusammenfassen (eine Wallet kann mehrere Konten haben)
  const byOwner = new Map<string, bigint>();
  for (const a of wallets) byOwner.set(a.owner!, (byOwner.get(a.owner!) ?? 0n) + BigInt(a.amount));
  const top = [...byOwner.values()].sort((x, y) => (y > x ? 1 : y < x ? -1 : 0)).slice(0, 10);
  const sum = top.reduce((s, x) => s + x, 0n);
  return Number((sum * 1_000_000n) / total) / 10_000;
}

/** Top-10-Konzentration aus GoPlus (`holders`, Anteil 0–1): Verträge und gesperrte Bestände zählen nicht. */
export function goPlusTop10Pct(holders: { percent?: string; is_contract?: number | string; is_locked?: number | string }[] | undefined): number | null {
  if (!holders || holders.length === 0) return null;
  const sum = holders
    .filter((h) => String(h.is_contract) !== '1' && String(h.is_locked) !== '1')
    .slice(0, 10)
    .reduce((s, h) => s + (Number(h.percent) || 0), 0);
  return Math.round(sum * 100 * 100) / 100;
}

type GoPlusResult = Record<string, unknown>;

const flag = (v: unknown) => v === '1';

/** Reine Bewertung einer GoPlus-Antwort (getestet). Steuern kommen als Anteil (0.05 = 5 %). */
export function judgeGoPlus(r: GoPlusResult | undefined): TokenSafety {
  if (!r) return { checked: false, source: 'goplus', severe: [], warnings: [], taxPct: null, error: 'GoPlus kennt diesen Token (noch) nicht.' };
  const severe: string[] = [];
  const warnings: string[] = [];
  if (flag(r.is_honeypot)) severe.push('honeypot');
  if (flag(r.cannot_sell_all)) severe.push('cannot_sell_all');
  if (flag(r.owner_change_balance)) severe.push('owner_change_balance');
  // pausierbar sind auch seriöse Stablecoins (USDC) — Warnung, kein Block
  if (flag(r.transfer_pausable)) warnings.push('pausable');
  if (flag(r.is_mintable)) warnings.push('mint_authority');
  if (flag(r.hidden_owner)) warnings.push('hidden_owner');
  if (flag(r.is_blacklisted)) warnings.push('blacklist');
  if (flag(r.slippage_modifiable)) warnings.push('tax_modifiable');
  if (flag(r.is_proxy)) warnings.push('proxy');
  if (r.is_open_source === '0') warnings.push('not_open_source');
  const taxes = [r.buy_tax, r.sell_tax].filter((v) => v !== undefined && v !== '').map(Number);
  const taxPct = taxes.length > 0 && taxes.every(Number.isFinite) ? Math.max(...taxes) * 100 : null;
  const top10Pct = goPlusTop10Pct(r.holders as Parameters<typeof goPlusTop10Pct>[0]);
  if (top10Pct !== null && top10Pct > TOP10_WARN_PCT) warnings.push('top10_concentrated');
  return { checked: true, source: 'goplus', severe, warnings, taxPct, top10Pct, error: null };
}

/**
 * Halter-Konzentration auf Solana: `getTokenLargestAccounts` beantworten freie
 * öffentliche Knoten nicht (mainnet-beta HTTP 429, publicnode 403, drpc 400 —
 * CI-Befund 2026-10-21). Deshalb: eigener Knoten (`RPC_URL_SOLANA`, z. B. ein
 * freier Helius-Zugang) direkt von der Kette, sonst GoPlus Solana (öffentlich,
 * ohne Schlüssel) — dort ebenfalls nur Wallets auf der Kurve gezählt.
 */
async function solanaRpc(url: string, method: string, params: unknown[], fetchFn: Fetch): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC solana (${new URL(url).host}): HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC solana (${new URL(url).host}): ${body.error.message ?? 'Fehler'}`);
  return body.result;
}

/** Größte Konten (bis 20) + deren Besitzer von der Kette → Top-10-Wallet-Anteil. */
/** GoPlus-Solana-Halter (`account` = Besitzer, Anteil 0–1): nur Wallets auf der Kurve, gesperrte Bestände raus. */
export function goPlusSolanaTop10Pct(holders: { account?: string; percent?: string; is_locked?: number | string }[] | undefined): number | null {
  if (!holders || holders.length === 0) return null;
  const sum = holders
    .filter((h) => h.account && isOnCurveAddress(h.account) && String(h.is_locked) !== '1')
    .slice(0, 10)
    .reduce((s, h) => s + (Number(h.percent) || 0), 0);
  return Math.round(sum * 100 * 100) / 100;
}

async function fetchSolanaTop10FromChain(url: string, mint: string, fetchFn: Fetch): Promise<number | null> {
  const largest = (await solanaRpc(url, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], fetchFn)) as { value?: { address: string; amount: string }[] };
  const supply = (await solanaRpc(url, 'getTokenSupply', [mint, { commitment: 'confirmed' }], fetchFn)) as { value?: { amount?: string } };
  const accs = largest.value ?? [];
  if (accs.length === 0 || !supply.value?.amount) return null;
  const infos = (await solanaRpc(url, 'getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }], fetchFn)) as {
    value?: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[];
  };
  const owners = (infos.value ?? []).map((v) => v?.data?.parsed?.info?.owner ?? null);
  return solanaTop10Pct(
    accs.map((a, i) => ({ amount: a.amount, owner: owners[i] ?? null, ownerIsWallet: owners[i] ? isOnCurveAddress(owners[i]!) : false })),
    supply.value.amount,
  );
}

/** Top-10-Wallet-Anteil: eigener Solana-Knoten (falls gesetzt) von der Kette, sonst GoPlus Solana. */
export async function fetchSolanaTop10Pct(mint: string, fetchFn: Fetch = fetch, env: Record<string, string | undefined> = process.env): Promise<number | null> {
  const problems: string[] = [];
  const own = env.RPC_URL_SOLANA?.trim();
  if (own) {
    try {
      return await fetchSolanaTop10FromChain(own, mint, fetchFn);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  try {
    const res = await fetchFn(`${GOPLUS_API}/solana/token_security?contract_addresses=${mint}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GoPlus Solana: HTTP ${res.status}`);
    const body = (await res.json()) as { code?: number; message?: string; result?: Record<string, { holders?: { account?: string; percent?: string; is_locked?: number | string }[] }> };
    if (body.code !== 1) throw new Error(`GoPlus Solana: ${body.message ?? 'Fehler'}`);
    return goPlusSolanaTop10Pct(body.result?.[mint]?.holders);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  throw new Error(`Halter nicht abrufbar: ${problems.join(' | ')}`);
}

export async function fetchTokenSafety(chain: SwapChainId, address: string, fetchFn: Fetch = fetch): Promise<TokenSafety> {
  if (isNativeToken(chain, address)) return { checked: true, source: 'native', severe: [], warnings: [], taxPct: 0, error: null };
  try {
    if (SWAP_CHAINS[chain].kind === 'solana') {
      const res = await fetchFn(rpcUrl(chain), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`RPC solana: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { value?: ParsedMint | null }; error?: { message?: string } };
      if (body.error) throw new Error(`RPC solana: ${body.error.message ?? 'Fehler'}`);
      const judged = judgeSolanaMint(body.result?.value ?? null);
      if (judged.severe.includes('not_a_token')) return judged;
      // Halter-Konzentration: Fehler hier machen den Check nicht ungültig (dann ehrlich null)
      const top10Pct = await fetchSolanaTop10Pct(address, fetchFn).catch(() => null);
      if (top10Pct !== null && top10Pct > TOP10_WARN_PCT) judged.warnings.push('top10_concentrated');
      return { ...judged, top10Pct };
    }
    const res = await fetchFn(`${GOPLUS_API}/token_security/${SWAP_CHAINS[chain].chainId}?contract_addresses=${address.toLowerCase()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GoPlus: HTTP ${res.status}`);
    const body = (await res.json()) as { code?: number; message?: string; result?: Record<string, GoPlusResult> };
    if (body.code !== 1) throw new Error(`GoPlus: ${body.message ?? 'Fehler'}`);
    return judgeGoPlus(body.result?.[address.toLowerCase()]);
  } catch (err) {
    return { checked: false, source: null, severe: [], warnings: [], taxPct: null, error: err instanceof Error ? err.message : String(err) };
  }
}
