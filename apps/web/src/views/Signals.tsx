import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, trpc } from '../api.js';
import type { SignalRow } from '../components/SignalCard.js';
import { SignalListRow } from '../components/SignalListRow.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { DEFAULT_FILTERS, type SignalFilters } from '../lib/signal-filters.js';
import { decodeListFilters, encodeListFilters, splitByExpiry } from '../lib/signal-list.js';

/**
 * Signals (09_ §3.2) — Umbau 2026-07-09 nach Patricks Feedback („unübersichtlich,
 * zu klein, unklar beschriftet"): kompakte, scanbare ZEILEN statt Karten-Grid.
 * Neueste zuerst, Abgelaufene gedimmt als eigener Block am Ende; Details
 * (Chart, alle Agenten-Begründungen) pro Zeile aufklappbar über die
 * bestehende SignalCard (eine Detail-Wahrheit, Karte unverändert).
 *
 * Ehrlichkeit vor dem Klick: das harte Risk-Veto des Schwarms steht als
 * roter Chip in jeder Zeile und erklärt den Bestätigen-Button — Live-Befund:
 * das Risk-Gate blockt aktuell praktisch jede Bestätigung (Margin/Exposure).
 */

type SignalStatus = 'new' | 'confirmed' | 'rejected' | 'filled' | 'closed' | 'expired';

const ALL_STATUSES: SignalStatus[] = ['new', 'confirmed', 'rejected', 'filled', 'closed', 'expired'];

// Listen-Default: ALLES zeigen (Abgelaufene gedimmt hinten) — sonst wirkt der
// Feed leer, weil real oft nur 1 Signal offen ist und der Rest abgelaufen.
const LIST_DEFAULTS: SignalFilters = { ...DEFAULT_FILTERS, status: 'all' };

const STATUS_OPTIONS: { value: string; key: string }[] = [
  { value: 'all', key: 'common.all' },
  { value: 'new', key: 'signals.statusNew' },
  { value: 'confirmed', key: 'signals.statusConfirmed' },
  { value: 'rejected', key: 'signals.statusRejected' },
  { value: 'expired', key: 'signals.statusExpired' },
  { value: 'filled', key: 'signals.statusFilled' },
  { value: 'closed', key: 'signals.statusClosed' },
];

const SOURCE_OPTIONS: { value: SignalRow['source'] | 'all'; key: string }[] = [
  { value: 'all', key: 'common.all' },
  { value: 'engine', key: 'signals.sourceEngine' },
  { value: 'pine', key: 'signals.sourcePine' },
  { value: 'instruction', key: 'signals.sourceInstruction' },
  { value: 'manual', key: 'signals.sourceManual' },
];

// Nur diese Filter stecken hinter dem „Filter"-Aufklapper — Status/Symbol/
// Richtung sind laut Auftrag IMMER sichtbar.
const HIDDEN_FILTER_KEYS = ['source', 'timeframe', 'setupType'] as const;

export function Signals() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<SignalFilters>(() => decodeListFilters(window.location.hash));
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
    const q = encodeListFilters(filters);
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

  // Sortierung laut Vorgabe: neueste zuerst, Abgelaufene gedimmt ans Ende.
  const { active, expired } = useMemo(() => splitByExpiry(rows ?? []), [rows]);

  const hiddenActive = HIDDEN_FILTER_KEYS.filter((k) => filters[k] !== 'all');
  const filtersDirty =
    filters.status !== LIST_DEFAULTS.status ||
    filters.symbol !== 'all' ||
    filters.direction !== 'all' ||
    filters.favoritesOnly ||
    hiddenActive.length > 0;

  const select = 'field cursor-pointer px-2.5 py-1.5 text-sm';
  // „on" statt „active", um das Signal-Array `active` nicht zu verschatten.
  const pill = (on: boolean, warn = false) =>
    ({
      borderColor: on ? (warn ? 'rgba(232,184,75,0.6)' : 'rgba(79,209,255,0.5)') : 'var(--color-line)',
      color: on ? (warn ? 'var(--color-warn)' : 'var(--color-cyan)') : 'var(--color-mut)',
      background: on ? (warn ? 'rgba(232,184,75,0.08)' : 'rgba(79,209,255,0.08)') : 'transparent',
    }) as React.CSSProperties;

  const reload = () => void load(filters);

  return (
    <div>
      <PageHeader
        title={t('signals.title')}
        subtitle={t('signals.subtitleList')}
        right={
          rows !== null ? (
            <p className="num text-sm" style={{ color: 'var(--color-mut)' }}>
              {t('signals.rowsSummary', { n: rows.length })}
              {expired.length > 0 && <> · {t('signals.expiredSummary', { n: expired.length })}</>}
            </p>
          ) : undefined
        }
      />

      {error && <ErrorBox message={error} />}

      {/* Hauptfilter IMMER sichtbar: Status · Symbol · Richtung (Auftrag) — Rest hinter „Filter" */}
      <div className="glass mb-5 p-3 sm:p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">{t('signals.filterStatus')}</span>
            <select className={select} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
              {STATUS_OPTIONS.map((o) => (
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
            <span className="label">{t('signals.filterDirection')}</span>
            <select className={select} value={filters.direction} onChange={(e) => set({ direction: e.target.value })}>
              <option value="all">{t('common.all')}</option>
              <option value="long">LONG</option>
              <option value="short">SHORT</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-2 pb-0.5">
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
              style={pill(showFilters || hiddenActive.length > 0)}
            >
              {t('signals.filters')}{hiddenActive.length > 0 ? ` (${hiddenActive.length})` : ''}
            </button>
            {filtersDirty && (
              <button
                onClick={() => {
                  setFilters(LIST_DEFAULTS);
                  setShowFilters(false);
                }}
                className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              >
                {t('signals.reset')}
              </button>
            )}
          </div>
        </div>

        {/* Aktive Zusatzfilter als Badges, wenn zugeklappt */}
        {!showFilters && hiddenActive.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {hiddenActive.map((k) => (
              <button
                key={k}
                onClick={() => set({ [k]: 'all' } as Partial<SignalFilters>)}
                className="num rounded-[0.625rem] border px-2 py-1 text-xs"
                style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}
                title={t('signals.clearFilter')}
              >
                {filters[k]} ✕
              </button>
            ))}
          </div>
        )}

        {/* Zusatzfilter: Quelle · Timeframe · Setup */}
        {showFilters && (
          <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3" style={{ borderColor: 'var(--color-line)' }}>
            <label className="flex flex-col gap-1">
              <span className="label">{t('signals.filterSource')}</span>
              <select className={select} value={filters.source} onChange={(e) => set({ source: e.target.value })}>
                {SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key)}</option>
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
          </div>
        )}
      </div>

      {rows === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : rows.length === 0 ? (
        <div className="glass p-6 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {filters.status === 'new' ? t('dashboard.noSetup') : t('signals.empty')}
        </div>
      ) : (
        <>
          {/* Aktive Signale: kompakte Zeilen, neueste zuerst */}
          {active.length === 0 ? (
            <div className="glass p-5 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('signals.noActive')}
            </div>
          ) : (
            <div className="glass overflow-hidden">
              {active.map((s, i) => (
                <div key={s.id} className={i > 0 ? 'border-t' : undefined} style={i > 0 ? { borderColor: 'var(--color-line)' } : undefined}>
                  <SignalListRow signal={s} onDecided={reload} />
                </div>
              ))}
            </div>
          )}

          {/* Abgelaufene: gedimmt, als eigener Block ganz am Ende */}
          {expired.length > 0 && (
            <>
              <h2 className="label mt-6 mb-2">{t('signals.expiredSection', { n: expired.length })}</h2>
              <div className="glass overflow-hidden">
                {expired.map((s, i) => (
                  <div key={s.id} className={i > 0 ? 'border-t' : undefined} style={i > 0 ? { borderColor: 'var(--color-line)' } : undefined}>
                    <SignalListRow signal={s} onDecided={reload} />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
