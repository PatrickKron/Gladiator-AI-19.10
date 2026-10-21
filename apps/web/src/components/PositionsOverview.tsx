import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { fmtAmount, fmtPct, fmtUsd, pnlPercent } from '../lib/swap-format.js';
import { ErrorBox, Panel } from './ui.js';

/**
 * Alle offenen Token-Positionen über alle Wallets (Vision-Punkt 5, Trojan
 * „Positions“): Wert, Einstand, PnL — echte Kurse, fehlende als „—“. Klick
 * wählt Wallet + Token im Ticket. Ohne Positionen wird nichts angezeigt.
 */

type Data = Awaited<ReturnType<typeof trpc.swaps.positions.query>>;

export function PositionsOverview({ chainName, version, onOpen }: { chainName: (id: string) => string; version: number; onOpen: (walletId: string, token: string) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await trpc.swaps.positions.query());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = setVisibleInterval(() => void load(), 60_000);
    return () => clearVisibleInterval(timer);
  }, [load, version]);

  if (error) return <ErrorBox message={error} />;
  if (!data || data.positions.length === 0) return null;
  const color = (v: number | null) => (v === null ? undefined : v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)');

  return (
    <Panel label={t('swap.positionsTitle')} className="mb-4">
      <div className="num mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: 'var(--color-mut)' }}>
        <span>
          {t('swap.total')}: <b style={{ color: 'var(--color-ink)' }}>{data.totalValueUsd === null ? '—' : fmtUsd(data.totalValueUsd, lang)}</b>
        </span>
        <span>
          {t('swap.unrealized')}: <b style={{ color: color(data.unrealizedPnlUsd) }}>{data.unrealizedPnlUsd === null ? '—' : fmtUsd(data.unrealizedPnlUsd, lang)}</b>
        </span>
        {data.problems.map((p) => (
          <span key={p} style={{ color: 'var(--color-warn)' }}>
            {p}
          </span>
        ))}
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="num w-full whitespace-nowrap text-xs">
          <thead style={{ color: 'var(--color-mut)' }}>
            <tr className="text-left">
              <th className="py-1 pr-2 font-normal">{t('swap.token')}</th>
              <th className="py-1 pr-2 font-normal">{t('swap.wallet')}</th>
              <th className="py-1 pr-2 text-right font-normal">{t('swap.amount')}</th>
              <th className="py-1 pr-2 text-right font-normal">{t('swap.value')}</th>
              <th className="py-1 text-right font-normal">{t('swap.pnl')}</th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p) => {
              const pct = pnlPercent(p.pnlUsd, p.costUsd);
              return (
                <tr key={`${p.walletId}:${p.token}`} className="border-t" style={{ borderColor: 'var(--color-line)' }}>
                  <td className="py-1 pr-2">
                    <button type="button" className="underline decoration-dotted" title={p.token} onClick={() => onOpen(p.walletId, p.token)}>
                      {p.symbol}
                    </button>
                  </td>
                  <td className="py-1 pr-2" style={{ color: 'var(--color-mut)' }}>
                    {p.walletLabel} · {chainName(p.chain)} · {p.mode === 'paper' ? t('swap.paper') : t('swap.live')}
                  </td>
                  <td className="py-1 pr-2 text-right">{fmtAmount(p.amount, lang)}</td>
                  <td className="py-1 pr-2 text-right">{p.valueUsd === null ? '—' : fmtUsd(p.valueUsd, lang)}</td>
                  <td className="py-1 text-right" style={{ color: color(p.pnlUsd) }}>
                    {p.pnlUsd === null ? '—' : fmtUsd(p.pnlUsd, lang)}
                    {pct !== null && ` (${pct > 0 ? '+' : ''}${fmtPct(pct, lang)})`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
