import { useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { buildChartUrl, type ChartVenue } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';
import { Panel } from './ui.js';

/**
 * Marktbreite & Top-Mover (Welle 18):
 * Zeigt auf Basis echter DB-Kerzen (24h) das Verhältnis Gewinner vs. Verlierer,
 * Krypto- vs. Aktien-/ETF-Puls, Top-Gewinner/Top-Verlierer mit 1-Klick-Chartlink
 * sowie ein klares Tagesfazit in Alltagssprache.
 */

type Breadth = Awaited<ReturnType<typeof trpc.market.breadth.query>>;

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toLocaleString(appLocale(), { maximumFractionDigits: 2 })} %`;
}

function fmtPrice(p: number): string {
  const digits = p >= 1000 ? 0 : p >= 1 ? 2 : 4;
  return p.toLocaleString(appLocale(), { maximumFractionDigits: digits });
}

function chartLink(symbol: string, venue: string): string {
  const v: ChartVenue = venue === 'twelvedata' ? 'twelvedata' : venue === 'yahoo' ? 'yahoo' : 'binance';
  return buildChartUrl(symbol, v === 'binance' ? '1h' : '1d', v);
}

export function MarketBreadthPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<Breadth | null>(null);

  useEffect(() => {
    let cancelled = false;
    void trpc.market.breadth
      .query()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || data.total === 0) return null;

  const greenPct = Math.round((data.advancers / Math.max(1, data.total)) * 100);
  const redPct = Math.round((data.decliners / Math.max(1, data.total)) * 100);

  if (compact) {
    return (
      <section className="glass reveal mt-6 p-4" style={{ '--stagger': 2 } as React.CSSProperties}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">🔥 Markt-Puls & Top-Mover (24h)</span>
            <span
              className="num rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                background: greenPct >= 50 ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
                color: greenPct >= 50 ? 'var(--color-pos)' : 'var(--color-neg)',
              }}
            >
              {data.advancers}↑ / {data.decliners}↓ · Ø {fmtPct(data.avgChangePct)}
            </span>
          </div>
          <a href="#/marktlage" className="text-xs hover:underline" style={{ color: 'var(--color-cyan)' }}>
            Zur Marktlage →
          </a>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {data.takeaway}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.topGainers.slice(0, 4).map((g) => (
            <a
              key={`${g.venue}:${g.symbol}`}
              href={chartLink(g.symbol, g.venue)}
              className="num inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-pos)]"
              style={{ borderColor: 'rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.06)' }}
            >
              <span className="font-medium">{g.symbol}</span>
              <span style={{ color: 'var(--color-pos)' }}>{fmtPct(g.changePct24h)}</span>
            </a>
          ))}
          {data.topLosers.slice(0, 3).map((l) => (
            <a
              key={`${l.venue}:${l.symbol}`}
              href={chartLink(l.symbol, l.venue)}
              className="num inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-neg)]"
              style={{ borderColor: 'rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.06)' }}
            >
              <span className="font-medium">{l.symbol}</span>
              <span style={{ color: 'var(--color-neg)' }}>{fmtPct(l.changePct24h)}</span>
            </a>
          ))}
        </div>
      </section>
    );
  }

  return (
    <Panel label="📊 Marktbreite, Asset-Puls & Top-Mover (24h · echte DB-Kerzen)" stagger={1} className="mb-5">
      {/* Tagesfazit */}
      <div
        className="mt-3 rounded-[0.625rem] border p-3 text-xs leading-relaxed"
        style={{
          borderColor: greenPct >= 60 ? 'rgba(34,197,94,0.4)' : greenPct <= 40 ? 'rgba(239,68,68,0.4)' : 'rgba(6,182,212,0.4)',
          background: 'rgba(15,23,42,0.4)',
        }}
      >
        <span className="font-semibold" style={{ color: 'var(--color-cyan)' }}>
          Was bedeutet das heute?{' '}
        </span>
        <span>{data.takeaway}</span>
      </div>

      {/* Marktbreite-Balken + Sektor-Puls */}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="label">Marktbreite ({data.total} Märkte)</span>
            <span className="num font-semibold" style={{ color: (data.avgChangePct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
              Ø {fmtPct(data.avgChangePct)}
            </span>
          </div>
          <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.2)' }}>
            <div style={{ width: `${greenPct}%`, background: 'var(--color-pos)' }} />
            <div style={{ width: `${redPct}%`, background: 'var(--color-neg)' }} />
          </div>
          <div className="num mt-2 flex justify-between text-[11px]" style={{ color: 'var(--color-mut)' }}>
            <span style={{ color: 'var(--color-pos)' }}>{data.advancers} im Plus ({greenPct} %)</span>
            <span style={{ color: 'var(--color-neg)' }}>{data.decliners} im Minus ({redPct} %)</span>
          </div>
        </div>

        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label">Krypto-Puls (Binance)</p>
          <p
            className="num mt-1.5 text-lg font-semibold"
            style={{ color: (data.crypto.avgChangePct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
          >
            {fmtPct(data.crypto.avgChangePct)}
          </p>
          <p className="num mt-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {data.crypto.advancers} von {data.crypto.total} Krypto-Paaren grün
          </p>
        </div>

        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label">Aktien, ETFs & Rohstoffe</p>
          <p
            className="num mt-1.5 text-lg font-semibold"
            style={{ color: (data.tradfi.avgChangePct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
          >
            {data.tradfi.total > 0 ? fmtPct(data.tradfi.avgChangePct) : '—'}
          </p>
          <p className="num mt-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {data.tradfi.total > 0
              ? `${data.tradfi.advancers} von ${data.tradfi.total} Märkten grün`
              : 'Aktien/ETFs über + Markt hinzufügen ergänzen'}
          </p>
        </div>
      </div>

      {/* Top Gewinner & Verlierer */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <p className="label mb-2" style={{ color: 'var(--color-pos)' }}>
            ▲ Stärkste Märkte (24h)
          </p>
          {data.topGainers.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              Aktuell keine positiven 24h-Bewegungen.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {data.topGainers.map((g) => (
                <li key={`${g.venue}:${g.symbol}`} className="flex items-center justify-between rounded border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)' }}>
                  <a href={chartLink(g.symbol, g.venue)} className="font-medium hover:underline">
                    {g.symbol}
                  </a>
                  <span className="num flex items-center gap-3">
                    <span style={{ color: 'var(--color-mut)' }}>{fmtPrice(g.price)}</span>
                    <span className="font-semibold" style={{ color: 'var(--color-pos)' }}>
                      {fmtPct(g.changePct24h)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="label mb-2" style={{ color: 'var(--color-neg)' }}>
            ▼ Schwächste Märkte (24h)
          </p>
          {data.topLosers.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
              Aktuell keine negativen 24h-Bewegungen.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {data.topLosers.map((l) => (
                <li key={`${l.venue}:${l.symbol}`} className="flex items-center justify-between rounded border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)' }}>
                  <a href={chartLink(l.symbol, l.venue)} className="font-medium hover:underline">
                    {l.symbol}
                  </a>
                  <span className="num flex items-center gap-3">
                    <span style={{ color: 'var(--color-mut)' }}>{fmtPrice(l.price)}</span>
                    <span className="font-semibold" style={{ color: 'var(--color-neg)' }}>
                      {fmtPct(l.changePct24h)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
