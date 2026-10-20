import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { fmtPct, fmtUsd, poolAge } from '../lib/swap-format.js';
import { ErrorBox, Panel } from './ui.js';

/**
 * Token entdecken (Vision-Punkt 5, „wie Trojan“): Trend-Pools und neue Pools
 * der Kette (GeckoTerminal, echte Werte, „—“ wenn unbekannt). Klick lädt den
 * Token ins Ticket — dort laufen Sicherheitscheck und Gate wie immer.
 */

type Chain = Parameters<typeof trpc.swaps.discover.query>[0]['chain'];
type Kind = Parameters<typeof trpc.swaps.discover.query>[0]['kind'];
type Item = Awaited<ReturnType<typeof trpc.swaps.discover.query>>[number];

const chip = 'rounded border px-2.5 py-1 text-xs';

export function TokenDiscovery({ chain, onPick }: { chain: Chain; onPick: (address: string) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [kind, setKind] = useState<Kind>('trending');
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await trpc.swaps.discover.query({ chain, kind }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }, [chain, kind, t]);

  useEffect(() => {
    setItems(null);
    void load();
    const timer = setVisibleInterval(() => void load(), 60_000);
    return () => clearVisibleInterval(timer);
  }, [load]);

  const pct = (v: number | null) =>
    v === null ? <span style={{ color: 'var(--color-mut)' }}>—</span> : <span style={{ color: v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{v > 0 ? '+' : ''}{fmtPct(v, lang)}</span>;
  const usd = (v: number | null) => (v === null ? '—' : fmtUsd(v, lang, true));

  return (
    <Panel label={t('swap.discoverTitle')} stagger={1}>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(['trending', 'new'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={chip}
            style={{ borderColor: kind === k ? 'var(--color-cyan)' : 'var(--color-line)', color: kind === k ? 'var(--color-ink)' : 'var(--color-mut)' }}
            onClick={() => setKind(k)}
          >
            {t(`swap.discover_${k}`)}
          </button>
        ))}
        <span className="ml-auto text-[10px]" style={{ color: 'var(--color-mut)' }}>
          GeckoTerminal · {t('swap.discoverHint')}
        </span>
      </div>
      {error && <ErrorBox message={error} />}
      {!items && !error && <p className="mt-2 animate-pulse text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>}
      {items && items.length === 0 && <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.discoverEmpty')}</p>}
      {items && items.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="num w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--color-mut)' }}>
                <th className="py-1 pr-2 font-normal">{t('swap.discoverToken')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('swap.price')}</th>
                <th className="py-1 pr-2 text-right font-normal">1h</th>
                <th className="py-1 pr-2 text-right font-normal">24h</th>
                <th className="py-1 pr-2 text-right font-normal">{t('swap.discoverVolume')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('swap.liquidity')}</th>
                <th className="py-1 text-right font-normal">{t('swap.discoverAge')}</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 20).map((it) => (
                <tr key={it.pool} className="border-t" style={{ borderColor: 'var(--color-line)' }}>
                  <td className="py-1 pr-2">
                    <button type="button" className="text-left hover:underline" title={`${it.name ?? it.symbol} · ${it.address}`} onClick={() => onPick(it.address)}>
                      <b>{it.symbol.slice(0, 12)}</b>
                    </button>
                  </td>
                  <td className="py-1 pr-2 text-right">{it.priceUsd === null ? '—' : fmtUsd(it.priceUsd, lang)}</td>
                  <td className="py-1 pr-2 text-right">{pct(it.change1hPct)}</td>
                  <td className="py-1 pr-2 text-right">{pct(it.change24hPct)}</td>
                  <td className="py-1 pr-2 text-right">{usd(it.volume24hUsd)}</td>
                  <td className="py-1 pr-2 text-right">{usd(it.liquidityUsd)}</td>
                  <td className="py-1 text-right" style={{ color: 'var(--color-mut)' }}>
                    {poolAge(it.poolCreatedAt, lang)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
