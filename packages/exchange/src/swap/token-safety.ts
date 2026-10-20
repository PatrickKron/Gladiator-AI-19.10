import { isNativeToken, rpcUrl, SWAP_CHAINS, type SwapChainId } from './chains.js';

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
  error: string | null;
};

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

type GoPlusResult = Record<string, string | undefined>;

const flag = (v: string | undefined) => v === '1';

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
  return { checked: true, source: 'goplus', severe, warnings, taxPct, error: null };
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
      return judgeSolanaMint(body.result?.value ?? null);
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
