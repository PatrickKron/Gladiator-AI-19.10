import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Panel } from './ui.js';

/**
 * Position-Sizing-Rechner (Patrick-Lücke 7): rechnet über trading.sizePreview
 * mit EXAKT derselben Risk-Engine wie die echte Order (eine Wahrheit) —
 * echtes Konto, echte Marktregeln, SAFE-Regeln inklusive.
 */

type Result = Awaited<ReturnType<typeof trpc.trading.sizePreview.mutate>>;

export function SizingCalc({ defaultSymbol = 'BTC/USDT' }: { defaultSymbol?: string }) {
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [entry, setEntry] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [leverage, setLeverage] = useState('1');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function calc() {
    setBusy(true);
    setError(null);
    try {
      const res = await trpc.trading.sizePreview.mutate({
        symbol: symbol.trim(),
        direction,
        entry: Number(entry.replace(',', '.')),
        stopLoss: Number(stopLoss.replace(',', '.')),
        leverage: Number(leverage.replace(',', '.')) || 1,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const valid = Number(entry.replace(',', '.')) > 0 && Number(stopLoss.replace(',', '.')) > 0;

  return (
    <Panel label={t('trading.sizingTitle')} stagger={7}>
      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <label className="flex flex-col gap-1">
          <span className="label">{t('dashboard.symbol')}</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="field num px-2.5 py-1.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.sizingDirection')}</span>
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'long' | 'short')} className="field cursor-pointer px-2.5 py-1.5 text-sm">
            <option value="long">LONG</option>
            <option value="short">SHORT</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.sizingEntry')}</span>
          <input value={entry} onChange={(e) => setEntry(e.target.value)} inputMode="decimal" className="field num px-2.5 py-1.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.sizingSl')}</span>
          <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} inputMode="decimal" className="field num px-2.5 py-1.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.sizingLeverage')}</span>
          <input value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="decimal" className="field num px-2.5 py-1.5 text-sm" />
        </label>
      </div>
      <button onClick={() => void calc()} disabled={busy || !valid} className="btn-primary mt-3 px-4 py-1.5 text-sm disabled:opacity-50">
        {t('trading.sizingCalc')}
      </button>
      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {result && !result.available && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
          {result.detail}
        </p>
      )}
      {result?.available && (
        <div className="mt-4">
          {result.sizing ? (
            <ul className="num grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-4">
              <li>
                <p className="label">{t('trading.sizingQty')}</p>
                <p className="mt-0.5 font-semibold" style={{ color: 'var(--color-cyan)' }}>{num(result.sizing.qty)}</p>
              </li>
              <li>
                <p className="label">{t('trading.sizingNotional')}</p>
                <p className="mt-0.5">{num(Math.round(result.sizing.notional * 100) / 100)} $</p>
              </li>
              <li>
                <p className="label">{t('trading.sizingMargin')}</p>
                <p className="mt-0.5">{num(Math.round(result.sizing.marginRequired * 100) / 100)} $</p>
              </li>
              <li>
                <p className="label">{t('trading.sizingRiskAmount')}</p>
                <p className="mt-0.5">{num(Math.round(result.sizing.riskAmount * 100) / 100)} $ ({result.riskPctPerTrade} %)</p>
              </li>
            </ul>
          ) : null}
          {!result.allowed && (
            <div className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
              <p className="font-medium">{t('trading.sizingBlocked')}</p>
              <ul className="mt-1 list-disc pl-4">
                {result.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {result.note}
          </p>
        </div>
      )}
    </Panel>
  );
}
