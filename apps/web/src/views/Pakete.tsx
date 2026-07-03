import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { getLatest, onTick } from '../lib/prices.js';

/**
 * Pakete / Trading-Universum (09_ §3.3): echte v1-Bestände (35 Pakete,
 * 221 Assets). Live-Preise nur für Krypto-Paare mit echtem Feed —
 * Aktien/ETF ehrlich ohne Kurs (Phase-1-Rest).
 */

type Pkg = Awaited<ReturnType<typeof trpc.product.packages.query>>[number];
type Asset = Awaited<ReturnType<typeof trpc.product.assets.query>>[number];

function PackageCard({ pkg, stagger, prices }: { pkg: Pkg; stagger: number; prices: Map<string, number> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[] | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && assets === null) {
      try {
        setAssets(await trpc.product.assets.query({ packageId: pkg.id }));
      } catch {
        setAssets([]);
      }
    }
  }

  return (
    <div
      className="glass glass-hover reveal p-5"
      style={{ '--stagger': Math.min(stagger, 10), borderTop: pkg.color ? `2px solid ${pkg.color}` : undefined } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label">{pkg.category}{pkg.subcategory ? ` · ${pkg.subcategory}` : ''}</p>
          <h2 className="mt-1 text-[15px] font-medium">
            {pkg.icon ? `${pkg.icon} ` : ''}
            {pkg.name}
          </h2>
        </div>
        <span className="num rounded border px-1.5 py-0.5 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {pkg.assetCount} {t('packages.assets')}
        </span>
      </div>
      {pkg.description && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {pkg.description}
        </p>
      )}
      <button onClick={() => void toggle()} className="mt-3 text-xs" style={{ color: 'var(--color-cyan)' }}>
        {open ? `− ${t('packages.hide')}` : `+ ${t('packages.show')}`}
      </button>
      {open && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded border p-2" style={{ borderColor: 'var(--color-line)' }}>
          {assets === null ? (
            <Loading />
          ) : (
            <ul className="space-y-1 text-xs">
              {assets.map((a) => {
                const live = a.tradingPair ? prices.get(a.tradingPair.replace('USDT', '/USDT')) : undefined;
                return (
                  <li key={a.id} className="flex items-center justify-between gap-2 py-0.5">
                    <span>
                      <span className="num font-medium">{a.ticker}</span>{' '}
                      <span style={{ color: 'var(--color-mut)' }}>{a.name}</span>
                    </span>
                    <span className="num shrink-0" style={{ color: live !== undefined ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
                      {live !== undefined
                        ? `${live.toLocaleString(undefined, { maximumFractionDigits: live >= 1000 ? 0 : 2 })} $`
                        : t('packages.noPrice')}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Pakete() {
  const { t } = useTranslation();
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Map<string, number>>(new Map(getLatest().map((x) => [x.symbol, x.price])));

  useEffect(() => {
    trpc.product.packages
      .query()
      .then(setPkgs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
    return onTick((x) => setPrices((prev) => new Map(prev).set(x.symbol, x.price)));
  }, []);

  const totalAssets = useMemo(() => (pkgs ?? []).reduce((a, p) => a + p.assetCount, 0), [pkgs]);

  return (
    <div>
      <PageHeader
        title={t('packages.title')}
        subtitle={t('packages.subtitle', { packages: pkgs?.length ?? '…', assets: totalAssets || '…' })}
      />
      {error && <ErrorBox message={error} />}
      <p className="mb-5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('packages.livePrice')}
      </p>
      {pkgs === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {pkgs.map((p, i) => (
            <PackageCard key={p.id} pkg={p} stagger={i + 1} prices={prices} />
          ))}
        </div>
      )}
    </div>
  );
}
