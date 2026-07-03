import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, trpc } from '../api.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';

/**
 * Signals (09_ §3.2): Feed aller Setups als Sammelkarten mit Filtern
 * (Status, Symbol, Quelle). Agenten-Urteile hängen an jeder Karte.
 */

type StatusFilter = 'new' | 'confirmed' | 'rejected' | 'filled' | 'closed' | 'expired';

const STATUS_OPTIONS: { value: StatusFilter; key: string }[] = [
  { value: 'new', key: 'signals.statusNew' },
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
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(currentStatus: StatusFilter) {
    try {
      const res = await trpc.signals.list.query({ status: [currentStatus], limit: 100 });
      setRows(res as SignalRow[]);
      setError(null);
    } catch (err) {
      if (!isUnauthorized(err)) setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    setRows(null);
    void load(status);
    const timer = window.setInterval(() => void load(status), 30_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const symbols = useMemo(() => [...new Set((rows ?? []).map((r) => r.symbol))].sort(), [rows]);
  const filtered = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => (source === 'all' || r.source === source) && (symbol === 'all' || r.symbol === symbol),
      ),
    [rows, source, symbol],
  );

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
            <SignalCard key={s.id} signal={s} onDecided={() => void load(status)} readOnly={status !== 'new'} />
          ))}
        </div>
      )}
    </div>
  );
}
