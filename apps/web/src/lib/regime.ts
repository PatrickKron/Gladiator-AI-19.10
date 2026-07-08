/**
 * Regime-Daten normalisieren (P0-Workover): `ml.regime` liefert das Ergebnis
 * TOP-LEVEL (`{regime, confidence, components, ts, cached}`) und im Leer-Fall
 * `{regime: null, confidence: 0, components: [], reason}` — NICHT null als
 * Ganzes. Rein & testbar, damit „regime.undefined (NaN %)" nie wieder passiert.
 */

export type RegimeName = 'bull' | 'bear' | 'sideways' | 'high_vol' | 'crisis';

export type RegimeData = {
  regime: RegimeName;
  confidence: number;
  components: { name: string; score: number; detail: string }[];
};

export const REGIME_NAMES: readonly RegimeName[] = ['bull', 'bear', 'sideways', 'high_vol', 'crisis'];

export const REGIME_COLORS: Record<RegimeName, string> = {
  bull: 'var(--color-pos)',
  bear: 'var(--color-neg)',
  sideways: 'var(--color-warn)',
  high_vol: 'var(--color-violet)',
  crisis: 'var(--color-neg)',
};

export const REGIME_ICONS: Record<RegimeName, string> = {
  bull: '▲',
  bear: '▼',
  sideways: '◆',
  high_vol: '⚡',
  crisis: '⚠',
};

/** Antwort von `ml.regime` in anzeigbare Daten überführen; alles Unklare → null (Badge versteckt sich). */
export function normalizeRegime(raw: unknown): RegimeData | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as { regime?: unknown; confidence?: unknown; components?: unknown };
  if (typeof r.regime !== 'string' || !(REGIME_NAMES as readonly string[]).includes(r.regime)) return null;
  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0;
  const components = Array.isArray(r.components)
    ? r.components.filter(
        (c): c is RegimeData['components'][number] =>
          c !== null && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
      )
    : [];
  return { regime: r.regime as RegimeName, confidence, components };
}
