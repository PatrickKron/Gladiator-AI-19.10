import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Loading } from './ui.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * Asset-Kontext (Patrick-Lücke 2/6): echte, asset-spezifische Kennzahlen aus
 * eigenen Kerzen/Feeds — wiederverwendet in Oracle, Aegis und Favoriten-Briefing.
 */

export type AssetContext = Awaited<ReturnType<typeof trpc.market.assetContext.query>>;

export function useAssetContext(symbol: string, refreshMs = 60_000) {
  const [ctx, setCtx] = useState<AssetContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    const load = () =>
      trpc.market.assetContext
        .query({ symbol })
        .then((c) => {
          if (!cancelled) setCtx(c);
        })
        .catch(() => {
          if (!cancelled) setCtx({ symbol, available: false, candles: 0 } as AssetContext);
        });
    void load();
    const timer = setVisibleInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [symbol, refreshMs]);
  return ctx;
}

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d });

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <li className="flex justify-between gap-3 py-0.5">
      <span style={{ color: 'var(--color-mut)' }}>{label}</span>
      <span className="num text-right" style={{ color: color ?? 'var(--color-ink)' }}>
        {value}
      </span>
    </li>
  );
}

export function AssetContextBody({ ctx, compact = false }: { ctx: AssetContext | null; compact?: boolean }) {
  const { t } = useTranslation();
  if (ctx === null) return <Loading />;
  if (!ctx.available) {
    return (
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('assetCtx.notAvailable', { candles: ctx.candles })}
      </p>
    );
  }
  const pos = 'var(--color-pos)';
  const neg = 'var(--color-neg)';
  return (
    <>
      <ul className="mt-3 space-y-1 text-sm">
        <Row label={t('assetCtx.price')} value={`${fmt(ctx.price, ctx.price >= 1000 ? 0 : 4)} $`} />
        <Row
          label={t('assetCtx.change24h')}
          value={ctx.change24hPct == null ? '—' : `${ctx.change24hPct >= 0 ? '+' : ''}${ctx.change24hPct.toFixed(2)} %`}
          color={(ctx.change24hPct ?? 0) >= 0 ? pos : neg}
        />
        <Row label={t('assetCtx.regime')} value={ctx.emaRegime ?? '—'} color={ctx.emaRegime === 'above' ? pos : neg} />
        <Row label={t('assetCtx.phase')} value={ctx.marketPhase ?? '—'} color={ctx.marketPhase === 'bull' ? pos : neg} />
        {!compact && (
          <Row
            label={t('assetCtx.structure')}
            value={ctx.lastStructure ? `${ctx.lastStructure.kind} ${ctx.lastStructure.direction} @ ${fmt(ctx.lastStructure.level, 0)}` : '—'}
          />
        )}
        <Row label={t('assetCtx.rsi')} value={fmt(ctx.rsi14, 1)} />
        <Row label={t('assetCtx.atrPct')} value={ctx.atrPct == null ? '—' : `${ctx.atrPct.toFixed(2)} %`} />
        <Row
          label={t('assetCtx.intraday')}
          value={ctx.intradayRangePct == null ? '—' : `${ctx.intradayRangePct.toFixed(2)} %`}
          color={(ctx.intradayRangePct ?? 0) > 10 ? neg : undefined}
        />
        {ctx.funding && (
          <Row
            label={t('assetCtx.funding')}
            value={ctx.funding.rate == null ? '—' : `${(ctx.funding.rate * 100).toFixed(4)} %`}
            color={(ctx.funding.rate ?? 0) >= 0 ? pos : neg}
          />
        )}
        <Row label={t('assetCtx.openSignals')} value={String(ctx.openSignals)} color={ctx.openSignals > 0 ? 'var(--color-cyan)' : undefined} />
        {!compact && <Row label={t('assetCtx.exposure')} value={`${fmt(ctx.exposureNotional)} $`} />}
      </ul>
      {!compact && ctx.matchingGates.length > 0 && (
        <div className="mt-3">
          <p className="label">{t('assetCtx.gates')}</p>
          <ul className="mt-1 space-y-1 text-xs" style={{ color: 'var(--color-violet)' }}>
            {ctx.matchingGates.map((g, i) => (
              <li key={i}>▸ {g}</li>
            ))}
          </ul>
        </div>
      )}
      {!compact && (
        <div className="mt-3">
          <p className="label">{t('assetCtx.news', { base: ctx.symbol.split('/')[0] })}</p>
          {ctx.news.length === 0 ? (
            <p className="mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('assetCtx.noNews')}
            </p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs">
              {ctx.news.map((n) => (
                <li key={n.url}>
                  <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--color-ink)' }}>
                    {n.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="label mt-3">{t('assetCtx.fromOwnData')}</p>
    </>
  );
}
