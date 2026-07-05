import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, trpc } from '../api.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';

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
  const [status, setStatus] = useState<StatusFilter>('new');
  const [source, setSource] = useState<SignalRow['source'] | 'all'>('all');
  const [symbol, setSymbol] = useState<string>('all');
  const [timeframe, setTimeframe] = useState<string>('all');
  const [setupType, setSetupType] = useState<string>('all');
  const [direction, setDirection] = useState<string>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [universe, setUniverse] = useState<string[]>([]);
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filters = { status, source, symbol, timeframe, setupType, direction, favoritesOnly };

  async function load(f: typeof filters) {
    try {
      const res = await trpc.signals.list.query({
        status: f.status === 'all' ? ALL_STATUSES : [f.status],
        limit: 100,
        symbol: f.symbol === 'all' ? undefined : f.symbol,
        timeframe: f.timeframe === 'all' ? undefined : (f.timeframe as '15m' | '1h' | '4h' | '1d'),
        setupType: f.setupType === 'all' ? undefined : (f.setupType as 'scalp' | 'swing' | 'position'),
        direction: f.direction === 'all' ? undefined : (f.direction as 'long' | 'short'),
        source: f.source === 'all' ? undefined : f.source,
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
    setRows(null);
    void load(filters);
    const timer = window.setInterval(() => void load(filters), 30_000);
    return () => window.clearInterval(timer);
  }, [status, source, symbol, timeframe, setupType, direction, favoritesOnly]);

  const symbols = useMemo(() => {
    const fromRows = (rows ?? []).map((r) => r.symbol);
    return [...new Set([...universe, ...fromRows])].sort();
  }, [rows, universe]);
  const filtered = rows ?? [];

  const select = 'field cursor-pointer px-2.5 py-1.5 text-sm';

  return (
    <div>
      <PageHeader
        title={t('signals.title')}
        subtitle={t('signals.subtitle')}
        right={
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterStatus')}</span>
              <select className={select} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSource')}</span>
              <select className={select} value={source} onChange={(e) => setSource(e.target.value as SignalRow['source'] | 'all')}>
                {SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSymbol')}</span>
              <select className={select} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                <option value="all">{t('common.all')}</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterTimeframe')}</span>
              <select className={select} value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                <option value="all">{t('common.all')}</option>
                {['15m', '1h', '4h', '1d'].map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSetup')}</span>
              <select className={select} value={setupType} onChange={(e) => setSetupType(e.target.value)}>
                <option value="all">{t('common.all')}</option>
                {['scalp', 'swing', 'position'].map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterDirection')}</span>
              <select className={select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="all">{t('common.all')}</option>
                <option value="long">LONG</option>
                <option value="short">SHORT</option>
              </select>
            </label>
            <label className="flex items-center gap-2 self-end pb-1.5">
              <input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} />
              <span className="text-xs" style={{ color: 'var(--color-warn)' }}>{t('signals.favoritesOnly')}</span>
            </label>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}

      {rows === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass p-6 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {status === 'new' ? t('dashboard.noSetup') : t('signals.empty')}
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
