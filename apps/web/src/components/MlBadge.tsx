import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

type Prediction = {
  probability: string;
  betSize: string;
  truthCorePass: boolean;
};

export function MlBadge({ signalId }: { signalId: string }) {
  const { t } = useTranslation();
  const [pred, setPred] = useState<Prediction | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    trpc.ml.latestPrediction
      .query({ signalId })
      .then((p) => {
        if (!cancelled) setPred(p);
      })
      .catch(() => {
        if (!cancelled) setPred(null);
      });
    return () => { cancelled = true; };
  }, [signalId]);

  if (pred === undefined || pred === null) return null;

  const prob = Number(pred.probability);
  const bet = Number(pred.betSize);
  const pctText = `${(prob * 100).toFixed(0)}%`;
  const color = prob >= 0.6 ? 'var(--color-pos)' : prob >= 0.5 ? 'var(--color-warn)' : 'var(--color-neg)';

  return (
    <span
      className="num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] tracking-wider"
      style={{ borderColor: color, color }}
      title={`${t('ml.probability')}: ${pctText} · ${t('ml.betSize')}: ${(bet * 100).toFixed(0)}% · ${t('ml.truthCore')}: ${pred.truthCorePass ? t('ml.passed') : t('ml.failed')}`}
    >
      <span>{pctText}</span>
      {pred.truthCorePass ? (
        <span style={{ color: 'var(--color-pos)' }}>✓</span>
      ) : (
        <span style={{ color: 'var(--color-neg)' }}>✕</span>
      )}
    </span>
  );
}
