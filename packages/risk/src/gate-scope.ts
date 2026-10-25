/**
 * Welche adaptiven Gates gelten für EIN Asset? Ein Gate ohne Symbol greift überall, eines mit
 * Symbol nur dort — exakt wie `gateMatches` in der Engine (kein Präfix-Abgleich). Rein, für den
 * Risiko-Tab der Chart-Seite (`risk.gates({ symbol })`).
 */
export function gatesForSymbol<T extends { symbol?: string | null }>(gates: T[], symbol: string | undefined | null): T[] {
  if (!symbol) return gates;
  const want = symbol.trim().toUpperCase();
  return gates.filter((g) => g.symbol === null || g.symbol === undefined || g.symbol === want);
}
