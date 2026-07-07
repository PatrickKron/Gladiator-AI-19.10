import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, trpc } from '../api.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { advancedFilterCount, decodeFilters, DEFAULT_FILTERS, encodeFilters, type SignalFilters } from '../lib/signal-filters.js';

/**
 * Signals (09_ §3.2): Feed aller Setups als Sammelkarten mit Filtern
 * (Status, Symbol, Quelle). Agenten-Urteile hängen an jeder Karte.
 */

type SignalStatus = 'new' | 'confirmed' | 'rejected' | 'filled' | 'closed' | 'expired';
type StatusFilter = SignalStatus | 'all';

const ALL_STATUSES: SignalStatus[] = ['new', 'confirmed', 'rejected', 'filled', 'closed', 'expired'];

const STATUS_OPTIONS: { value: StatusFilter; key: string }[] = [
  { value: 'new', key: 'signals.statusNew' },
  { value: 'all', key: 'common.all' },
  { value: 'confirmed', key: 'signals.statusConfirmed' },
  { value: 'rejected', key: 'signals.statusRejected' },
  { value: 'filled', key: 'signals.statusFilled' },
  { value: 'closed', key: 'signals.statusClosed' },
  { value: 'expired', key: 'signals.statusExpired' },
];

const SOURCE_OPTIONS: { value: SignalRow['source'] | 'all'; key: string }[] = [
  { value: 'all', key: 'common.all' },
  { value: 'engine', key: 'signals.sourceEngine' },
  { value: 'pine', key: 'signals.sourcePine' },
  { value: 'instruction', key: 'signals.sourceInstruction' },
  { value: 'manual', key: 'signals.sourceManual' },
];

export function Signals() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<SignalFilters>(() => decodeFilters(window.location.hash));
  const [showFilters, setShowFilters] = useState(false);
  const [universe, setUniverse] = useState<string[]>([]);
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<SignalFilters>) => setFilters((f) => ({ ...f, ...patch }));

  async function load(f: SignalFilters) {
    try {
      const res = await trpc.signals.list.query({
        status: f.status === 'all' ? ALL_STATUSES : [f.status as SignalStatus],
        limit: 100,
        symbol: f.symbol === 'all' ? undefined : f.symbol,
        timeframe: f.timeframe === 'all' ? undefined : (f.timeframe as '15m' | '1h' | '4h' | '1d'),
        setupType: f.setupType === 'all' ? undefined : (f.setupType as 'scalp' | 'swing' | 'position'),
        direction: f.direction === 'all' ? undefined : (f.direction as 'long' | 'short'),
        source: f.source === 'all' ? undefined : (f.source as SignalRow['source']),
        favoritesOnly: f.favoritesOnly,
      });
      setRows(res as SignalRow[]);
      setError(null);
    } catch (err) {
      if (!isUnauthorized(err)) setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void trpc.market.scanUniverse.query().then(setUniverse).catch(() => setUniverse([]));
  }, []);

  useEffect(() => {
    // Filter im URL-Hash persistieren (ohne Reload/History-Spam) + laden.
    const q = encodeFilters(filters);
    window.history.replaceState(null, '', '#/signals' + (q ? '?' + q : ''));
    setRows(null);
    void load(filters);
    const timer = window.setInterval(() => void load(filters), 30_000);
    return () => window.clearInterval(timer);
  }, [filters]);

  const symbols = useMemo(() => {
    const fromRows = (rows ?? []).map((r) => r.symbol);
    return [...new Set([...universe, ...fromRows])].sort();
  }, [rows, universe]);
  const filtered = rows ?? [];
  const advCount = advancedFilterCount(filters);

  const select = 'field cursor-pointer px-2.5 py-1.5 text-sm';
  const pill = (active: boolean, warn = false) =>
    ({
      borderColor: active ? (warn ? 'rgba(232,184,75,0.6)' : 'rgba(79,209,255,0.5)') : 'var(--color-line)',
      color: active ? (warn ? 'var(--color-warn)' : 'var(--color-cyan)') : 'var(--color-mut)',
      background: active ? (warn ? 'rgba(232,184,75,0.08)' : 'rgba(79,209,255,0.08)') : 'transparent',
    }) as React.CSSProperties;

  // Aktive „erweiterte" Filter als Badges (im zugeklappten Zustand).
  const activeBadges = (['source', 'symbol', 'timeframe', 'setupType', 'direction'] as const)
    .filter((k) => filters[k] !== 'all')
    .map((k) => ({ k, value: filters[k] }));

  return (
    <div>
      <PageHeader
        title={t('signals.title')}
        subtitle={t('signals.subtitle')}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => set({ status: filters.status === 'new' ? 'all' : 'new' })}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={pill(filters.status === 'new')}
            >
              {t('signals.onlyNew')}
            </button>
            <button
              onClick={() => set({ favoritesOnly: !filters.favoritesOnly })}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={pill(filters.favoritesOnly, true)}
            >
              ★ {t('signals.favoritesOnly')}
            </button>
            <button
              onClick={() => setShowFilters((o) => !o)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={pill(showFilters || advCount > 0)}
            >
              {t('signals.filters')}{advCount > 0 ? ` (${advCount})` : ''}
            </button>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}

      {/* Aktive Filter als Badges (zugeklappt) */}
      {!showFilters && activeBadges.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {activeBadges.map((b) => (
            <button
              key={b.k}
              onClick={() => set({ [b.k]: 'all' } as Partial<SignalFilters>)}
              className="num rounded-[0.625rem] border px-2 py-1 text-xs"
              style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}
              title={t('signals.clearFilter')}
            >
              {b.value} ✕
            </button>
          ))}
        </div>
      )}

      {/* Einklappbare Filterleiste */}
      {showFilters && (
        <div className="glass mb-5 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterStatus')}</span>
              <select className={select} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSource')}</span>
              <select className={select} value={filters.source} onChange={(e) => set({ source: e.target.value })}>
                {SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSymbol')}</span>
              <select className={select} value={filters.symbol} onChange={(e) => set({ symbol: e.target.value })}>
                <option value="all">{t('common.all')}</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterTimeframe')}</span>
              <select className={select} value={filters.timeframe} onChange={(e) => set({ timeframe: e.target.value })}>
                <option value="all">{t('common.all')}</option>
                {['15m', '1h', '4h', '1d'].map((tf) => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSetup')}</span>
              <select className={select} value={filters.setupType} onChange={(e) => set({ setupType: e.target.value })}>
                <option value="all">{t('common.all')}</option>
                {['scalp', 'swing', 'position'].map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterDirection')}</span>
              <select className={select} value={filters.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="all">{t('common.all')}</option>
                <option value="long">LONG</option>
                <option value="short">SHORT</option>
              </select>
            </label>
          </div>
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="mt-4 rounded-[0.625rem] border px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
          >
            {t('signals.reset')}
          </button>
        </div>
      )}

      {rows === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass p-6 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {filters.status === 'new' ? t('dashboard.noSetup') : t('signals.empty')}
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <SignalCard key={s.id} signal={s} onDecided={() => void load(filters)} readOnly={s.status !== 'new'} />
          ))}
        </div>
      )}
    </div>
  );
}
