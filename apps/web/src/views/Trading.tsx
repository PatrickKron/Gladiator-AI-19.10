import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel, StatusDot } from '../components/ui.js';
import { SizingCalc } from '../components/SizingCalc.js';
import { Sparkline } from '../components/Sparkline.js';
import { buildTabHash, parseTab } from '../lib/tab-hash.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { isDemoMode, setDemoMode } from '../lib/demo-mode.js';
import { DemoTrading } from './DemoTrading.js';
import { PaperPositions } from '../components/PaperPositions.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { exportYears, tradesCsvFilename } from '../lib/protocol.js';

/** Tabs der Trading-Seite (P1.8). */
const TABS = ['positionen', 'historie', 'risiko', 'alerts', 'performance'] as const;

/**
 * Trading & Börsen (09_ §3.9): Venues mit Verbindungsstatus, Paper-Konto,
 * offene Positionen (uPnL gegen echten Live-Preis), Schutz-Orders, Historie
 * (netto), Risk-Cockpit mit Kill-Switch. Alles echt oder ehrlich leer.
 */

type Account = Awaited<ReturnType<typeof trpc.trading.account.query>>;
type Venue = Awaited<ReturnType<typeof trpc.trading.venues.query>>[number];
type Position = Awaited<ReturnType<typeof trpc.trading.positions.query>>[number];
type ProtOrder = Awaited<ReturnType<typeof trpc.trading.protectionOrders.query>>[number];
type Trade = Awaited<ReturnType<typeof trpc.trading.history.query>>[number];
type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>;

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

const VENUE_LABEL_KEY: Record<string, string> = {
  'paper-internal': 'trading.venuePaperInternal',
  'binance-testnet': 'trading.venueBinanceTestnet',
  'hyperliquid-testnet': 'trading.venueHyperliquidTestnet',
};

type Alert = Awaited<ReturnType<typeof trpc.trading.alerts.query>>[number];
type Performance = Awaited<ReturnType<typeof trpc.trading.performance.query>>;

/**
 * Steuer-Export (10_ §6, §23 EStG): CSV der geschlossenen Trades vom Server,
 * Download clientseitig per Blob. BOM vorangestellt, damit Excel die Umlaute
 * der Kopfzeile (UTF-8) korrekt liest.
 */
function TradeExport() {
  const { t } = useTranslation();
  const [year, setYear] = useState<number | null>(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    try {
      const csv = await trpc.trading.exportTrades.query({ format: 'csv', ...(year !== null ? { year } : {}) });
      const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = tradesCsvFilename(year);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs" style={{ color: 'var(--color-mut)' }} htmlFor="trade-export-year">
          {t('trading.exportYear')}
        </label>
        <select
          id="trade-export-year"
          value={year ?? ''}
          onChange={(e) => setYear(e.target.value === '' ? null : Number(e.target.value))}
          className="field num cursor-pointer px-2.5 py-1.5 text-sm"
        >
          {exportYears().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
          <option value="">{t('trading.exportAllYears')}</option>
        </select>
        <button onClick={() => void download()} disabled={busy} className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50">
          {busy ? t('trading.exportBusy') : t('trading.exportCsv')}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('trading.exportHint')}
      </p>
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Preis-Alerts (Patrick-Luecke 7): minutengenauer Monitor, Trigger -> Telegram. */
function AlertsPanel() {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [condition, setCondition] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setAlerts(await trpc.trading.alerts.query());
    } catch {
      setAlerts([]);
    }
  }
  useEffect(() => {
    void load();
    const timer = setVisibleInterval(() => void load(), 30_000);
    return () => clearVisibleInterval(timer);
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await trpc.trading.createAlert.mutate({
        symbol: symbol.trim(),
        condition,
        price: Number(price.replace(',', '.')),
        note: note.trim() || undefined,
      });
      setPrice('');
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const fmtP = (n: string) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <Panel label={t('trading.alertsTitle')} stagger={8} className="mt-5">
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.alertSymbol')}</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="field num w-32 px-2.5 py-1.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.alertCondition')}</span>
          <select value={condition} onChange={(e) => setCondition(e.target.value as 'above' | 'below')} className="field cursor-pointer px-2.5 py-1.5 text-sm">
            <option value="above">{t('trading.above')}</option>
            <option value="below">{t('trading.below')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.alertPrice')}</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="field num w-32 px-2.5 py-1.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">{t('trading.alertNote')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="field w-48 px-2.5 py-1.5 text-sm" />
        </label>
        <button
          onClick={() => void create()}
          disabled={busy || Number(price.replace(',', '.')) <= 0 || symbol.trim().length < 3}
          className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
        >
          {t('trading.alertCreate')}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {alerts === null ? (
        <Loading />
      ) : alerts.length === 0 ? (
        <Empty text={t('trading.alertsEmpty')} />
      ) : (
        <ul className="mt-4 space-y-2">
          {alerts.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[0.625rem] border p-3 text-sm"
              style={{ borderColor: a.active ? 'rgba(79,209,255,0.3)' : 'var(--color-line)', opacity: a.active ? 1 : 0.65 }}
            >
              <span className="num">
                {a.symbol} {a.condition === 'above' ? '\u2265' : '\u2264'} {fmtP(a.price)}
                {a.note ? <span style={{ color: 'var(--color-mut)' }}> · {a.note}</span> : null}
              </span>
              <span className="flex items-center gap-3">
                <span className="label" style={{ color: a.active ? 'var(--color-pos)' : 'var(--color-warn)' }}>
                  {a.active
                    ? t('trading.alertActive')
                    : t('trading.alertTriggeredAt', {
                        time: a.triggeredAt ? new Date(a.triggeredAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '',
                        price: a.triggeredPrice ? fmtP(a.triggeredPrice) : '',
                      })}
                </span>
                <button
                  onClick={() => void trpc.trading.deleteAlert.mutate({ id: a.id }).then(() => load())}
                  className="rounded border px-2 py-0.5 text-xs"
                  style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
                >
                  {t('secrets.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Performance (Patrick-Luecke 7): echte Netto-Kennzahlen + Equity-Verlauf. */
function PerformancePanel() {
  const { t } = useTranslation();
  const [perf, setPerf] = useState<Performance | null>(null);

  useEffect(() => {
    void trpc.trading.performance.query().then(setPerf).catch(() => setPerf({ trades: 0 } as Performance));
  }, []);

  const fmtN = (n: number | null | undefined, d = 2) => (n == null ? '\u2014' : n.toLocaleString(undefined, { maximumFractionDigits: d }));

  return (
    <Panel label={t('trading.perfTitle')} stagger={9} className="mt-5">
      {perf === null ? (
        <Loading />
      ) : !('netPnl' in perf) ? (
        <Empty text={t('trading.perfEmpty')} />
      ) : (
        <>
          <ul className="num mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-5">
            <li>
              <p className="label">{t('trading.perfTrades')}</p>
              <p className="mt-0.5 text-lg font-semibold">{perf.trades}</p>
            </li>
            <li>
              <p className="label">{t('trading.netPnl')}</p>
              <p className="mt-0.5 text-lg font-semibold" style={{ color: (perf.netPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {fmtN(perf.netPnl)} $
              </p>
            </li>
            <li>
              <p className="label">{t('trading.perfWinRate')}</p>
              <p className="mt-0.5 text-lg font-semibold">{perf.winRate != null ? `${(perf.winRate * 100).toFixed(0)} %` : '\u2014'}</p>
            </li>
            <li>
              <p className="label">{t('trading.perfPF')}</p>
              <p className="mt-0.5 text-lg font-semibold">{fmtN(perf.profitFactor)}</p>
            </li>
            <li>
              <p className="label">{t('trading.perfExpectancy')}</p>
              <p className="mt-0.5 text-lg font-semibold">{fmtN(perf.expectancyR)}</p>
            </li>
          </ul>
          {perf.equityCurve && perf.equityCurve.length > 1 && (
            <div className="mt-4">
              <Sparkline closes={perf.equityCurve.map((c) => c.equity)} id="perf-equity" />
            </div>
          )}
          {perf.bySymbol && perf.bySymbol.length > 0 && (
            <div className="mt-4">
              <p className="label">{t('trading.perfBySymbol')}</p>
              <ul className="num mt-2 space-y-1 text-sm">
                {perf.bySymbol.map((r) => (
                  <li key={r.symbol} className="flex justify-between gap-3">
                    <span style={{ color: 'var(--color-mut)' }}>
                      {r.symbol} ({r.trades})
                    </span>
                    <span style={{ color: r.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmtN(r.netPnl)} $</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

type Approval = Awaited<ReturnType<typeof trpc.trading.approvals.query>>[number];

/** Live-Freigabe pro Börse (Phase 7): Phrase, auditiert, widerrufbar — nur Patrick. */
function LiveApprovals() {
  const { t } = useTranslation();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [phrases, setPhrases] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setApprovals(await trpc.trading.approvals.query());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function approve(venueId: Approval['venueId']) {
    setBusy(venueId);
    setError(null);
    try {
      await trpc.trading.approveVenue.mutate({ venueId, confirmation: phrases[venueId] ?? '' });
      setPhrases({ ...phrases, [venueId]: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(venueId: Approval['venueId']) {
    setBusy(venueId);
    setError(null);
    try {
      await trpc.trading.revokeVenue.mutate({ venueId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel label={t('trading.liveTitle')} stagger={10} className="mt-5">
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('trading.liveHint')}
      </p>
      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {approvals === null ? (
        <Loading />
      ) : (
        <ul className="mt-4 space-y-3">
          {approvals.map((a) => (
            <li
              key={a.venueId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[0.625rem] border p-4"
              style={{ borderColor: a.approved ? 'rgba(79,209,255,0.45)' : 'var(--color-line)' }}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{t(VENUE_LABEL_KEY[a.venueId] ?? a.venueId)}</p>
                <p className="label mt-1">
                  {a.approved
                    ? `${t('trading.liveApproved')} · ${a.approvedAt ? new Date(a.approvedAt).toLocaleString() : ''}`
                    : a.lastRevokedAt
                      ? `${t('trading.liveNotApproved')} · ${t('trading.liveRevokedAt', { date: new Date(a.lastRevokedAt).toLocaleDateString() })}`
                      : t('trading.liveNotApproved')}
                </p>
              </div>
              {a.approved ? (
                <button
                  onClick={() => void revoke(a.venueId)}
                  disabled={busy !== null}
                  className="shrink-0 rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                  style={{ borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)' }}
                >
                  {t('trading.liveRevoke')}
                </button>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <input
                    value={phrases[a.venueId] ?? ''}
                    onChange={(e) => setPhrases({ ...phrases, [a.venueId]: e.target.value })}
                    placeholder={t('trading.livePhrase', { venue: a.venueId })}
                    className="field w-72 max-w-full px-2.5 py-1.5 text-xs"
                  />
                  <button
                    onClick={() => void approve(a.venueId)}
                    disabled={busy !== null || (phrases[a.venueId] ?? '') !== `LIVE-FREIGABE ${a.venueId}`}
                    className="btn-primary shrink-0 px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {t('trading.liveApprove')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Demo-Konto (seit Welle 3 unter #/traden?tab=demo, Konto-Schalter oben).
 * Der Demo-Merker bleibt für das Topbar-Badge erhalten.
 */
export function DemoKonto() {
  return <Trading account="demo" />;
}

export function Trading({ account: accountKind = 'paper' }: { account?: 'paper' | 'demo' }) {
  const { t } = useTranslation();
  const demo = accountKind === 'demo';
  const [account, setAccount] = useState<Account | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [prot, setProt] = useState<ProtOrder[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [tab, setTab] = useState<string>(() => parseTab(window.location.hash, TABS, 'positionen'));

  function changeTab(tb: string) {
    setTab(tb);
    window.history.replaceState(null, '', buildTabHash('#/traden', tb));
  }

  async function saveNote(tradeId: string) {
    try {
      await trpc.trading.setTradeNote.mutate({ tradeId, note: noteDrafts[tradeId] ?? '' });
      setNotes(await trpc.trading.tradeNotes.query());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function load() {
    try {
      const [a, v, p, o, h, s] = await Promise.all([
        trpc.trading.account.query(),
        trpc.trading.venues.query(),
        trpc.trading.positions.query(),
        trpc.trading.protectionOrders.query(),
        trpc.trading.history.query({ limit: 25 }),
        trpc.settings.get.query(),
      ]);
      setNotes(await trpc.trading.tradeNotes.query());
      setAccount(a);
      setVenues(v);
      setPositions(p);
      setProt(o);
      setHistory(h);
      setSettings(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    if (demo) return; // Demo-Konto lädt seine eigenen Daten (DemoTrading)
    void load();
    const timer = setVisibleInterval(() => void load(), 20_000);
    return () => clearVisibleInterval(timer);
  }, [demo]);

  async function toggleKillSwitch() {
    if (!settings) return;
    setSwitching(true);
    try {
      await trpc.settings.setKillSwitch.mutate({ active: !settings.killSwitchActive });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSwitching(false);
    }
  }

  // Merker für das Topbar-Badge: zeigt an, dass zuletzt das Demo-Konto offen war.
  useEffect(() => {
    if (isDemoMode() !== demo) setDemoMode(demo);
  }, [demo]);

  if (demo) {
    return (
      <div>
        <PageHeader
          title={t('demo.title')}
          subtitle={t('demo.subtitle')}
        />
        <DemoTrading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t('trading.title')}
        subtitle={t('trading.subtitle')}
      />
      {error && <ErrorBox message={error} />}

      {/* Konto-Kacheln */}
      <section className="grid gap-3 md:grid-cols-4">
        <Panel stagger={1} className="!p-4">
          <p className="label">{t('trading.accountTitle')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">{fmt(account?.equity)} $</p>
          <p className="label mt-1">
            {t('trading.startEquity')} {fmt(account?.startEquity, 0)} $
          </p>
        </Panel>
        <Panel stagger={2} className="!p-4">
          <p className="label">{t('dashboard.dailyPnl')}</p>
          <p
            className="num mt-1.5 text-2xl font-semibold"
            style={{ color: (account?.dailyPnlPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
          >
            {fmt(account?.dailyPnlPct)} %
          </p>
          <p className="label mt-1">SAFE-001 −{fmt(settings?.dailyLossLimitPct, 0)} %</p>
        </Panel>
        <Panel stagger={3} className="!p-4">
          <p className="label">{t('dashboard.openPositions')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">{account?.openPositions ?? '—'}</p>
          <p className="label mt-1">
            {t('trading.consecutiveLosses')}: {account?.consecutiveLosses ?? 0}
          </p>
        </Panel>
        <Panel stagger={4} className="!p-4">
          <p className="label">{t('trading.killSwitchTitle')}</p>
          <p
            className="num mt-1.5 text-2xl font-semibold"
            style={{ color: settings?.killSwitchActive ? 'var(--color-neg)' : 'var(--color-pos)' }}
          >
            {settings ? (settings.killSwitchActive ? t('common.on') : t('common.off')) : '—'}
          </p>
          <button
            onClick={() => void toggleKillSwitch()}
            disabled={switching || !settings}
            className="mt-2 w-full rounded-[0.625rem] border px-2 py-1.5 text-xs transition-all disabled:opacity-50"
            style={
              settings?.killSwitchActive
                ? { borderColor: 'rgba(61,220,151,0.5)', color: 'var(--color-pos)' }
                : { borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)', boxShadow: '0 0 14px rgba(255,92,108,0.15)' }
            }
          >
            {settings?.killSwitchActive ? t('trading.killSwitchDisable') : t('trading.killSwitchEnable')}
          </button>
        </Panel>
      </section>

      {/* Tab-Leiste (P1.8) — Kill-Switch bleibt oben, immer sichtbar */}
      <div className="mt-5 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--color-line)' }}>
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => changeTab(tb)}
            className="shrink-0 border-b-2 px-4 py-2 text-sm transition-colors"
            style={tab === tb ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
          >
            {t(`trading.tab_${tb}`)}
          </button>
        ))}
      </div>

      {/* Venues + Risk-Cockpit */}
      {tab === 'risiko' && (
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <Panel label={t('trading.venuesTitle')} stagger={5}>
          <ul className="mt-4 space-y-3">
            {venues.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 rounded-[0.625rem] border p-3"
                style={{
                  borderColor: v.active ? 'rgba(79,209,255,0.4)' : 'var(--color-line)',
                  boxShadow: v.active ? '0 0 20px rgba(46,124,246,0.15)' : 'none',
                }}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <StatusDot on={v.configured} />
                    {t(VENUE_LABEL_KEY[v.id] ?? v.id)}
                  </p>
                  <p className="label mt-1">
                    {v.id} · {v.kind}
                    {!v.configured && ` · ${t('trading.venueNotConfigured')}`}
                  </p>
                </div>
                {v.active && (
                  <span className="label shrink-0 rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}>
                    {t('trading.venueActive')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {account?.venue.detail}
          </p>
        </Panel>

        <Panel label={t('trading.riskCockpit')} stagger={6}>
          {settings ? (
            <>
              <p className="label mt-4">{t('trading.limitsNow')}</p>
              <ul className="num mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.riskPerTrade')}</span>
                  <span>{fmt(settings.riskPctPerTrade)} %</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.maxLeverage')}</span>
                  <span>{fmt(settings.maxLeverage, 0)}×</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.maxPositions')}</span>
                  <span>{settings.maxOpenPositions}</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.exposurePerAsset')}</span>
                  <span>{fmt(settings.maxExposurePctPerAsset, 0)} %</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.dailyLimit')}</span>
                  <span>−{fmt(settings.dailyLossLimitPct, 0)} %</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span style={{ color: 'var(--color-mut)' }}>{t('trading.weeklyLimit')}</span>
                  <span>−{fmt(settings.weeklyLossLimitPct, 0)} %</span>
                </li>
              </ul>
              <p
                className="mt-4 rounded-[0.625rem] border p-3 text-xs leading-relaxed"
                style={
                  settings.killSwitchActive
                    ? { borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }
                    : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                }
              >
                {settings.killSwitchActive ? t('trading.killSwitchOn') : t('trading.killSwitchOff')}
              </p>
              <a href="#/einstellungen" className="mt-3 inline-block text-xs" style={{ color: 'var(--color-cyan)' }}>
                → {t('settings.title')}
              </a>
            </>
          ) : (
            <Loading />
          )}
        </Panel>
      </section>
      )}

      {/* Offene Positionen */}
      {tab === 'positionen' && (
      <Panel label={t('trading.positionsTitle')} stagger={7} className="mt-5">
        <PaperPositions positions={positions} onChanged={() => void load()} />
      </Panel>
      )}

      {/* Schutz-Orders */}
      {tab === 'positionen' && (
      <Panel label={t('trading.protection')} stagger={8} className="mt-5">
        {prot.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                  <th className="py-1.5 pr-3 font-normal">Typ</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Trigger</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('signals.qty')}</th>
                  <th className="py-1.5 font-normal">clientOrderId</th>
                </tr>
              </thead>
              <tbody className="num">
                {prot.map((o) => (
                  <tr key={o.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">{o.symbol}</td>
                    <td className="py-1.5 pr-3" style={{ color: o.type === 'stop_market' ? 'var(--color-neg)' : 'var(--color-pos)' }}>
                      {o.type === 'stop_market' ? 'SL' : 'TP'}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{fmt(Number(o.price))}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(Number(o.qty), 6)}</td>
                    <td className="py-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                      {o.clientOrderId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      )}

      {/* Historie (netto) */}
      {tab === 'historie' && (
      <Panel label={t('trading.historyTitle')} stagger={9} className="mt-5">
        <TradeExport />
        {history.length === 0 ? (
          <Empty text={t('trading.noHistory')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">Exit</th>
                  <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 pr-3 text-right font-normal">Entry → Exit</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('trading.netPnl')} $</th>
                  <th className="py-1.5 pr-3 text-right font-normal">R</th>
                  <th className="py-1.5 font-normal">{t('trading.journalNote')}</th>
                </tr>
              </thead>
              <tbody className="num">
                {history.map((tr) => (
                  <tr key={tr.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">
                      {tr.exitTs ? new Date(tr.exitTs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      <a href={buildChartUrl(tr.symbol)} className="hover:underline" style={{ color: 'var(--color-cyan)' }}>{tr.symbol}</a>
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {tr.direction.toUpperCase()}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {fmt(Number(tr.entryPrice))} → {tr.exitPrice ? fmt(Number(tr.exitPrice)) : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: Number(tr.netPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {fmt(Number(tr.netPnl ?? 0))}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{tr.rMultiple ? fmt(Number(tr.rMultiple)) : '—'}</td>
                    <td className="py-1.5">
                      <span className="flex items-center gap-1">
                        <input
                          value={noteDrafts[tr.id] ?? notes[tr.id] ?? ''}
                          onChange={(e) => setNoteDrafts((d) => ({ ...d, [tr.id]: e.target.value }))}
                          placeholder={t('trading.journalNote')}
                          className="field w-40 px-2 py-1 text-xs"
                        />
                        {(noteDrafts[tr.id] ?? '') !== (notes[tr.id] ?? '') && noteDrafts[tr.id] !== undefined && (
                          <button onClick={() => void saveNote(tr.id)} className="text-xs" style={{ color: 'var(--color-cyan)' }}>
                            {t('trading.journalSave')}
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      )}

      {tab === 'risiko' && <SizingCalc />}
      {tab === 'alerts' && <AlertsPanel />}
      {tab === 'performance' && <PerformancePanel />}
      {tab === 'risiko' && <LiveApprovals />}
    </div>
  );
}
