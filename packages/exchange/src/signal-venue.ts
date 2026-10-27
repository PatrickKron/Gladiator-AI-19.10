/**
 * Ausführbarkeit eines Signals nach Kerzenquelle (`signals.venue`, Migration 0044). Der aktive
 * Trading-Venue kennt nur Binance-Paare; Signale aus Yahoo/Twelve Data werden seit A1 erzeugt,
 * ihre Paper-Ausführung zum letzten Schlusskurs folgt mit A2. Bis dahin: ehrlicher Grund, kein
 * Börsenfehler eines Symbols, das es dort nicht gibt. null = ausführbar.
 */
export function signalExecutionBlock(venue: string): string | null {
  if (venue === 'binance') return null;
  return `Signale aus der Kursquelle „${venue}“ können noch nicht ausgeführt werden — die Schlusskurs-Ausführung im Agenten-Konto folgt im nächsten Schritt.`;
}
