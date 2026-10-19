/**
 * Cluster-Key der Selbstoptimierung (13_ §2) — EINE Funktion für alle
 * Schreiber von VDB1 (`study_trades`): Labor-Backtests UND geschlossene
 * Paper-Trades. Liegt hier, weil Backtest und Executor beide von
 * @gladiator/strategy-engine abhängen (eine Wahrheit, wie `trailStep`).
 *
 * Format: `strategy|symbol|setupType|timeframe|session|structure`
 *   strategy  = Strategie-Slug (z. B. smc-core, DSL-Slug)
 *   symbol    = App-Symbol (BTC/USDT)
 *   setupType = trading_style (scalp|swing|position)
 *   timeframe = Scan-/Backtest-Timeframe
 *   session   = Handels-Session am Entry (asia|london|overlap|newyork|off)
 *   structure = Marktstruktur am Entry, abgeleitet aus EMA200-Regime +
 *               Marktphase (uptrend|downtrend|transition)
 *
 * Abweichungen vom Blueprint-Beispiel (dokumentiert, nicht geraten):
 *  - `package_id` fehlt bewusst: Das Asset-Paket ist durch das Symbol
 *    eindeutig bestimmt (assets.package_id) und würde nur die Position der
 *    Felder verschieben, die buildDevilEvidence (Index 1/3) liest.
 *  - Unbekannte Teile (Session/Struktur nicht erhoben) heißen ehrlich `all`.
 */

export const CLUSTER_ALL = 'all';

export type MarketStructure = 'uptrend' | 'downtrend' | 'transition';

export type ClusterKeyInput = {
  strategy: string;
  symbol: string;
  setupType: string;
  timeframe: string;
  session?: string | null;
  emaRegime?: 'above' | 'below' | null;
  marketPhase?: 'bull' | 'bear' | null;
};

export type ClusterKeyParts = {
  strategy: string;
  symbol: string;
  setupType: string;
  timeframe: string;
  session: string;
  structure: string;
};

export type ClusterLevel = 'exact' | 'session' | 'base';

/** Gleichgerichtet (Kurs über EMA200 + Bull-Phase bzw. darunter + Bear) = Trend, sonst Übergang. */
export function marketStructureOf(
  emaRegime: 'above' | 'below' | null | undefined,
  marketPhase: 'bull' | 'bear' | null | undefined,
): MarketStructure | typeof CLUSTER_ALL {
  if (!emaRegime || !marketPhase) return CLUSTER_ALL;
  if (emaRegime === 'above' && marketPhase === 'bull') return 'uptrend';
  if (emaRegime === 'below' && marketPhase === 'bear') return 'downtrend';
  return 'transition';
}

/** Trennzeichen in freien Teilen (Slug) neutralisieren — sonst verschiebt sich der Key. */
function part(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s.length === 0 ? CLUSTER_ALL : s.replaceAll('|', '/');
}

export function buildClusterKey(i: ClusterKeyInput): string {
  return [
    part(i.strategy),
    part(i.symbol),
    part(i.setupType),
    part(i.timeframe),
    part(i.session),
    marketStructureOf(i.emaRegime, i.marketPhase),
  ].join('|');
}

export function parseClusterKey(key: string): ClusterKeyParts | null {
  const p = key.split('|');
  if (p.length !== 6) return null;
  const [strategy, symbol, setupType, timeframe, session, structure] = p as [string, string, string, string, string, string];
  return { strategy, symbol, setupType, timeframe, session, structure };
}

/**
 * Fallback-Ebenen (13_ §8 „übergeordneter Cluster"): exakt → ohne Struktur
 * → ohne Session und Struktur. Doppelte Ebenen (Key ist schon grob) entfallen.
 */
export function clusterKeyLevels(key: string): { level: ClusterLevel; key: string }[] {
  const p = parseClusterKey(key);
  if (!p) return [];
  const head = `${p.strategy}|${p.symbol}|${p.setupType}|${p.timeframe}`;
  const candidates: { level: ClusterLevel; key: string }[] = [
    { level: 'exact', key: `${head}|${p.session}|${p.structure}` },
    { level: 'session', key: `${head}|${p.session}|${CLUSTER_ALL}` },
    { level: 'base', key: `${head}|${CLUSTER_ALL}|${CLUSTER_ALL}` },
  ];
  const seen = new Set<string>();
  const out: { level: ClusterLevel; key: string }[] = [];
  // Von grob nach fein deduplizieren, damit die gröbste Ebene ihren Namen behält.
  for (const c of [...candidates].reverse()) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.unshift(c);
  }
  return out;
}

/** Alt-Labor-Zeilen (vor Session 11) hatten Session UND Struktur immer `all`. */
export function isLegacyClusterKey(key: string): boolean {
  const p = parseClusterKey(key);
  return p !== null && p.session === CLUSTER_ALL && p.structure === CLUSTER_ALL;
}
