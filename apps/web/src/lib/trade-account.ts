/**
 * Konto-Schalter der Seite „Traden“ (Welle 3). Die Konten sind Tabs im Hash:
 * `demo` und `wallet` wählen das Konto direkt, die übrigen Tabs gehören zum
 * Agenten-Konto. Ohne Tab gilt das zuletzt benutzte Konto (sonst Demo).
 * Rein & getestet.
 */

export type TradeAccount = 'demo' | 'agent' | 'wallet';

export const TRADE_ACCOUNTS: TradeAccount[] = ['demo', 'agent', 'wallet'];

/** Tabs des Agenten-Kontos (Trading-Ansicht). */
export const AGENT_TABS = ['positionen', 'historie', 'risiko', 'alerts', 'performance'] as const;

export function accountForHash(hash: string, remembered: TradeAccount | null): TradeAccount {
  const q = hash.indexOf('?');
  const tab = q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get('tab');
  if (tab === 'demo' || tab === 'wallet') return tab;
  if (tab && (AGENT_TABS as readonly string[]).includes(tab)) return 'agent';
  return remembered ?? 'demo';
}

/** Hash beim Umschalten: Demo/Wallet als Tab, Agenten-Konto startet bei den Positionen. */
export function hashForAccount(account: TradeAccount): string {
  return `#/traden?tab=${account === 'agent' ? 'positionen' : account}`;
}

const KEY = 'gladiator.tradeAccount';

export function rememberedAccount(): TradeAccount | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'demo' || v === 'agent' || v === 'wallet' ? v : null;
  } catch {
    return null;
  }
}

export function rememberAccount(a: TradeAccount): void {
  try {
    localStorage.setItem(KEY, a);
  } catch {
    // privater Modus o. ä. — dann eben ohne Merker
  }
}
