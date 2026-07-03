import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel, StatusDot } from '../components/ui.js';

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

export function Trading() {
  const { t } = useTranslation();
  const [account, setAccount] = useState<Account | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [prot, setProt] = useState<ProtOrder[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

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
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, []);

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

  return (
    <div>
      <PageHeader title={t('trading.title')} subtitle={t('trading.subtitle')} />
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

      {/* Venues + Risk-Cockpit */}
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

      {/* Offene Positionen */}
      <Panel label={t('trading.positionsTitle')} stagger={7} className="mt-5">
        {positions === null ? (
          <Loading />
        ) : positions.length === 0 ? (
          <Empty text={t('trading.noPositions')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 pr-3 text-right font-normal">{t('signals.qty')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('signals.entry')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Mark</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('trading.uPnl')} $</th>
                  <th className="py-1.5 font-normal">{t('common.date')}</th>
                </tr>
              </thead>
              <tbody className="num">
                {positions.map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">{p.symbol}</td>
                    <td className="py-1.5 pr-3" style={{ color: p.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {p.direction.toUpperCase()}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.qty, 6)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.entryPrice)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.markPrice)}</td>
                    <td
                      className="py-1.5 pr-3 text-right"
                      style={{ color: (p.unrealizedPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
                    >
                      {fmt(p.unrealizedPnl)}
                    </td>
                    <td className="py-1.5">{new Date(p.openedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Schutz-Orders */}
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

      {/* Historie (netto) */}
      <Panel label={t('trading.historyTitle')} stagger={9} className="mt-5">
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
                  <th className="py-1.5 text-right font-normal">R</th>
                </tr>
              </thead>
              <tbody className="num">
                {history.map((tr) => (
                  <tr key={tr.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">
                      {tr.exitTs ? new Date(tr.exitTs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                    </td>
                    <td className="py-1.5 pr-3">{tr.symbol}</td>
                    <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {tr.direction.toUpperCase()}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {fmt(Number(tr.entryPrice))} → {tr.exitPrice ? fmt(Number(tr.exitPrice)) : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: Number(tr.netPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {fmt(Number(tr.netPnl ?? 0))}
                    </td>
                    <td className="py-1.5 text-right">{tr.rMultiple ? fmt(Number(tr.rMultiple)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <LiveApprovals />
    </div>
  );
}
