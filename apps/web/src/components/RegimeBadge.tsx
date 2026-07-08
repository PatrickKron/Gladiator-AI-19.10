import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { normalizeRegime, REGIME_COLORS, REGIME_ICONS, type RegimeData } from '../lib/regime.js';

/**
 * Markt-Regime-Badge am Signal: nutzt `normalizeRegime` (lib/regime.ts), weil
 * `ml.regime` das Ergebnis TOP-LEVEL liefert und im Leer-Fall `{regime: null}`
 * zurückgibt — bei allem Unklaren versteckt sich das Badge, statt
 * „regime.undefined (NaN %)" anzuzeigen.
 */
export function RegimeBadge({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<RegimeData | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    trpc.ml.regime
      .query({ symbol, timeframe })
      .then((r) => {
        if (!cancelled) setData(normalizeRegime(r));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => { cancelled = true; };
  }, [symbol, timeframe]);

  if (data === undefined || data === null) return null;

  const color = REGIME_COLORS[data.regime];
  const icon = REGIME_ICONS[data.regime];

  return (
    <span
      className="num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] tracking-wider"
      style={{ borderColor: color, color }}
      title={`${t('regime.regime')}: ${t(`regime.${data.regime}` as const)} (${(data.confidence * 100).toFixed(0)}% ${t('regime.confidence')})`}
    >
      <span>{icon}</span>
      <span>{t(`regime.${data.regime}` as const)}</span>
    </span>
  );
}
