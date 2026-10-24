import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { fmt } from '../components/EquityChart.js';
import { WealthCurve } from '../components/WealthCurve.js';
import { allocation, rangeChange, rangeFilter, rangeStats, WEALTH_RANGES, wealthCurve, type WealthRange } from '../lib/wealth.js';
import { appLocale } from '../lib/locale.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * Vermögen (Welle B, Design-System v3): EINE Zahl, eine Kurve, die Aufteilung,
 * die Konten als Liste mit nächstem Schritt. Alles getrennt und ehrlich:
 * - Übungskonto = virtuelles Geld (Demo manuell + Paper Agenten + Paper-Wallets).
 * - Echtes Geld = verbundene Börsen und eigene Wallets (echte Bestände, echte
 *   Kurse). Keine Verbindung ⇒ „0 € — noch kein Konto verbunden".
 * - EUR nur mit echtem EUR/USD-Kurs; fehlt er, USD und ein Satz dazu.
 * - Verlauf aus stündlichen Momentaufnahmen — beginnt mit der ersten.
 */

type Overview = Awaited<ReturnType<typeof trpc.portfolio.overview.query>>;
type History = Awaited<ReturnType<typeof trpc.portfolio.history.query>>;

function money(n: number | null, unit: '€' | '$', digits = 0): string {
  return n === null ? '—' : `${fmt(n, digits)} ${unit}`;
}

const PART_COLORS: Record<string, string> = { demo: '#3b82f6', paper: '#60a5fa', wallets: '#93c5fd', real: '#22c55e' };

export function Vermoegen() {
  const { t } = useTranslation();
  const [data, setData] = useState<Overview | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<WealthRange>('30d');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [ov, hist] = await Promise.all([trpc.portfolio.overview.query(), trpc.portfolio.history.query({ limit: 2000 })]);
        if (cancelled) return;
        setData(ov);
        setHistory(hist);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setVisibleInterval(() => void load(), 120_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, []);

  const rate = data?.eurUsdRate ?? null;
  const practiceEur = data?.practice.totalEur ?? null;
  const realEur = data?.real.connected ? data.real.totalEur : 0;
  const totalEur = practiceEur !== null && realEur !== null ? practiceEur + realEur : null;
  const totalUsd = (data?.practice.totalUsd ?? 0) + (data?.real.totalUsd ?? 0);

  const curve = useMemo(() => wealthCurve(history), [history]);
  const points = useMemo(() => rangeFilter(curve.points, range, Date.now()), [curve, range]);
  const change = rangeChange(points);
  const stats = rangeStats(points);

  const walletsUsd = data ? data.practice.wallets.reduce((s, w) => s + (w.totalUsd ?? 0), 0) : 0;
  const parts = allocation([
    { key: 'demo', usd: data?.practice.demoEquityUsd ?? null },
    { key: 'paper', usd: data?.practice.paperEquityUsd ?? null },
    { key: 'wallets', usd: walletsUsd > 0 ? walletsUsd : null },
    { key: 'real', usd: data?.real.connected ? data.real.totalUsd : null },
  ]);
  const locale = appLocale();

  return (
    <div className="space-y-6">
      {error && (
        <div className="glass p-4 text-sm" style={{ color: 'var(--color-neg)' }}>
          {error}
        </div>
      )}

      {/* EINE große Zahl + Kurve */}
      <section className="reveal" style={{ '--stagger': 0 } as React.CSSProperties}>
        <p className="label">{t('wealth.totalLabel')}</p>
        <p className="num mt-1 text-[48px] leading-none font-bold tracking-tight">
          {loading ? '…' : totalEur !== null ? money(totalEur, '€') : money(totalUsd, '$')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {change && (
            <span className={`chip ${change.abs > 0 ? 'chip--pos' : change.abs < 0 ? 'chip--neg' : 'chip--mut'}`}>
              {change.abs > 0 ? '▲' : change.abs < 0 ? '▼' : '•'} {money(Math.abs(change.abs), curve.unit)} · {Math.abs(change.pct).toLocaleString(locale, { maximumFractionDigits: 2 })} % ·{' '}
              {t('wealth.changeOver', { range: t(`wealth.range_${range}`) })}
            </span>
          )}
          {rate === null && !loading && <span className="chip chip--warn">{t('wealth.noRate')}</span>}
          {rate !== null && <span className="chip chip--mut">{t('wealth.rateInfo', { rate: fmt(rate, 4) })}</span>}
        </div>
        <div className="mt-4 flex gap-1">
          {WEALTH_RANGES.map((r) => (
            <button key={r} type="button" onClick={() => setRange(r)} className="chip" style={range === r ? { background: 'rgba(59,130,246,0.16)', color: 'var(--color-ink)', borderColor: 'rgba(59,130,246,0.5)' } : { color: 'var(--color-mut)' }} aria-pressed={range === r}>
              {t(`wealth.range_${r}`)}
            </button>
          ))}
        </div>
        <div className="mt-3">
          {points.length >= 2 ? <WealthCurve points={points} height={160} /> : <p className="label py-6">{t('wealth.historyEmpty')}</p>}
          {stats && (
            <p className="num mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('wealth.rangeStats', {
                min: money(stats.min, curve.unit),
                max: money(stats.max, curve.unit),
                from: new Date(stats.from).toLocaleDateString(locale),
                to: new Date(stats.to).toLocaleDateString(locale),
              })}
            </p>
          )}
        </div>
      </section>

      {/* Übungsgeld und echtes Geld als eigene Summen (wie v2) */}
      <section className="grid gap-4 md:grid-cols-2 reveal" style={{ '--stagger': 1 } as React.CSSProperties}>
        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <p className="font-medium">{t('wealth.practiceTitle')}</p>
            <span className="chip chip--acc">{t('wealth.practiceBadge')}</span>
          </div>
          <p className="num mt-3 text-2xl font-semibold">{loading ? '…' : practiceEur !== null ? money(practiceEur, '€') : money(data?.practice.totalUsd ?? null, '$')}</p>
          <a href="#/traden?tab=positionen" className="mt-3 inline-block text-sm underline decoration-dotted" style={{ color: 'var(--color-cyan)' }}>
            {t('wealth.toPractice')}
          </a>
        </div>
        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <p className="font-medium">{t('wealth.realTitle')}</p>
            <span className="chip chip--pos">{t('wealth.realBadge')}</span>
          </div>
          <p className="num mt-3 text-2xl font-semibold">
            {loading ? '…' : !data?.real.connected ? money(0, '€') : data.real.totalEur !== null ? money(data.real.totalEur, '€') : money(data.real.totalUsd, '$')}
          </p>
          {!loading && !data?.real.connected && (
            <a href="#/einstellungen?tab=boersen" className="btn mt-3 inline-block px-3 py-1.5 text-xs">
              {t('wealth.connectCta')}
            </a>
          )}
        </div>
      </section>

      {/* Aufteilung */}
      <section className="glass reveal p-5" style={{ '--stagger': 1 } as React.CSSProperties}>
        <p className="text-sm font-semibold">{t('wealth.allocationTitle')}</p>
        {parts.length === 0 ? (
          <p className="label mt-3">{loading ? t('common.loading') : t('common.empty')}</p>
        ) : (
          <>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full" style={{ gap: 2 }}>
              {parts.map((p) => (
                <i key={p.key} style={{ flex: p.share, background: PART_COLORS[p.key] }} title={`${t(`wealth.part_${p.key}`)} ${(p.share * 100).toFixed(0)} %`} />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--color-mut)' }}>
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-1.5">
                  <i className="inline-block h-2 w-2 rounded-full" style={{ background: PART_COLORS[p.key] }} />
                  {t(`wealth.part_${p.key}`)} <span className="num" style={{ color: 'var(--color-ink)' }}>{(p.share * 100).toLocaleString(locale, { maximumFractionDigits: 0 })} %</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Konten als Liste */}
      <section className="reveal" style={{ '--stagger': 2 } as React.CSSProperties}>
        <p className="mb-2 text-sm font-semibold">{t('wealth.accountsTitle')}</p>
        <div className="flex flex-col gap-2">
          <a href="#/traden?tab=demo" className="glass glass-hover flex items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(59,130,246,0.16)', color: 'var(--color-cyan)' }}>D</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('wealth.part_demo')} <span className="chip chip--acc ml-1">{t('wealth.practiceBadge')}</span></span>
              <span className="block text-xs" style={{ color: 'var(--color-mut)' }}>{t('wealth.demoSub')}{data?.practice.demoIncomplete && !loading ? ` · ${t('wealth.demoIncomplete')}` : ''}</span>
            </span>
            <span className="num text-sm font-semibold">{money(data?.practice.demoEquityUsd ?? null, '$')}</span>
          </a>
          <a href="#/traden?tab=positionen" className="glass glass-hover flex items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(59,130,246,0.16)', color: 'var(--color-cyan)' }}>A</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('wealth.part_paper')} <span className="chip chip--acc ml-1">{t('wealth.practiceBadge')}</span></span>
              <span className="block text-xs" style={{ color: 'var(--color-mut)' }}>{t('wealth.paperSub')}</span>
            </span>
            <span className="num text-sm font-semibold">{money(data?.practice.paperEquityUsd ?? null, '$')}</span>
          </a>
          {data?.practice.wallets.map((w) => (
            <a key={w.walletId} href="#/traden?tab=wallet" className="glass glass-hover flex items-center gap-3 px-4 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(59,130,246,0.16)', color: 'var(--color-cyan)' }}>W</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t('wealth.walletLine', { label: w.label })} <span className="chip chip--acc ml-1">{t('wealth.practiceBadge')}</span></span>
                <span className="block text-xs" style={{ color: w.error ? 'var(--color-warn)' : 'var(--color-mut)' }}>{w.error ?? t('wealth.part_wallets')}</span>
              </span>
              <span className="num text-sm font-semibold">{w.totalUsd !== null ? money(w.totalUsd, '$') : '—'}</span>
            </a>
          ))}
          {data?.practice.walletsIncomplete && <p className="label px-1" style={{ color: 'var(--color-warn)' }}>{t('wealth.walletsIncomplete')}</p>}

          {/* Echtes Geld */}
          {!data?.real.connected ? (
            <div className="glass flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(245,158,11,0.14)', color: 'var(--color-warn)' }}>€</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t('wealth.part_real')} <span className="chip chip--pos ml-1">{t('wealth.realBadge')}</span></span>
                <span className="block text-xs" style={{ color: 'var(--color-mut)' }}>{t('wealth.noExchange')}</span>
              </span>
              <a href="#/einstellungen?tab=boersen" className="btn-primary px-3 py-1.5 text-xs" title={t('wealth.connectHint')}>
                {t('wealth.connectCta')}
              </a>
              <a href="#/echtes-geld" className="text-xs underline decoration-dotted" style={{ color: 'var(--color-mut)' }}>
                {t('wealth.realMoneyInfo')}
              </a>
            </div>
          ) : (
            <>
              {data.real.wallets.map((w) => (
                <div key={w.walletId} className="glass flex items-center gap-3 px-4 py-3">
                  <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(34,197,94,0.14)', color: 'var(--color-pos)' }}>W</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t('wealth.walletLine', { label: w.label })} <span className="chip chip--pos ml-1">{t('wealth.realBadge')}</span></span>
                    {w.error && <span className="block text-xs" style={{ color: 'var(--color-warn)' }}>{w.error}</span>}
                  </span>
                  <span className="num text-sm font-semibold">{w.totalUsd !== null ? money(w.totalUsd, '$') : '—'}</span>
                </div>
              ))}
              {data.real.accounts.map((acc) => (
                <div key={acc.connectionId} className="glass px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: 'rgba(34,197,94,0.14)', color: 'var(--color-pos)' }}>B</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{acc.label || acc.exchangeName} <span className="chip chip--pos ml-1">{t('wealth.realBadge')}</span></span>
                      {acc.error ? (
                        <span className="block text-xs" style={{ color: 'var(--color-neg)' }}>{acc.error}</span>
                      ) : (
                        <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                          {acc.balances.length === 0 ? (
                            <span>{t('wealth.emptyBalances')}</span>
                          ) : (
                            acc.balances.map((b) => (
                              <span key={b.currency} className="num">
                                {fmt(b.total, 6)} {b.currency}
                                {b.valuedUsd === null && <span title={t('wealth.unvalued')}> ⚠</span>}
                              </span>
                            ))
                          )}
                        </span>
                      )}
                    </span>
                    <span className="num text-sm font-semibold">{acc.totalUsd !== null ? money(acc.totalUsd, '$') : '—'}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        <p className="label mt-3">{t('wealth.subtitle')}</p>
      </section>
    </div>
  );
}
