/**
 * Symbol-Übergabe „Traden“-Klick (Dashboard-Kachel) → Demo-Ticket (#/trading).
 *
 * WARUM sessionStorage: Der Sprung läuft über einen Hash-Wechsel mit frischem
 * View-Mount — Props/State überleben das nicht. localStorage wäre zu klebrig:
 * Die Vorbelegung soll nur für diesen EINEN Sprung gelten, nicht für immer.
 *
 * WARUM peek + clear getrennt (statt „lesen und sofort löschen“ in einem):
 * React.StrictMode ruft useState-Initialisierer doppelt auf — ein Initialisierer
 * mit Löschen-Nebenwirkung würde die Übergabe im Dev-Modus zufällig verschlucken.
 * Lesen bleibt deshalb pur, das Löschen passiert idempotent im Effect.
 */

export const TRADE_SYMBOL_KEY = 'gladiator.tradeSymbol';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** sessionStorage kann fehlen/gesperrt sein (Privacy-Modus) — dann ehrlich null. */
function defaultStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Vom „Traden“-Button gesetzt, unmittelbar vor dem Sprung nach #/trading. */
export function setPendingTradeSymbol(symbol: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(TRADE_SYMBOL_KEY, symbol.toUpperCase());
  } catch {
    // Storage voll/gesperrt → keine Vorbelegung; das Demo-Ticket funktioniert trotzdem
  }
}

/** Liest die Vorbelegung, ohne sie zu löschen — pur und damit StrictMode-sicher. */
export function peekPendingTradeSymbol(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(TRADE_SYMBOL_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Räumt die Vorbelegung weg — idempotent, damit spätere Ticket-Mounts nicht erneut vorbelegen. */
export function clearPendingTradeSymbol(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(TRADE_SYMBOL_KEY);
  } catch {
    // ohne Storage gibt es auch nichts zu löschen
  }
}
