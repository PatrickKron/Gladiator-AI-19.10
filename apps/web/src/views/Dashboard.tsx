import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, refreshSession, trpc } from '../api.js';
import { Sparkline } from '../components/Sparkline.js';
import { setRainHighlight } from '../components/MatrixRain.js';
import { PlexusHero } from '../components/PlexusHero.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import { Empty, ErrorBox, Loading, Panel, StatusDot } from '../components/ui.js';
import { getLatest, onTick, type TickWithDirection } from '../lib/prices.js';

/** Dashboard (09_ §3.1): Begrüßung, Live-Markt, offene Setups, Konto, System — alles echt. */

type SystemStatus = {
  db: 'up';
  uptimeSec: number;
  counts: Record<string, number>;
  sources: Record<string, string>;
};
type IngestRow = { symbol: string; timeframe: string; candles: number; from_ts: string; to_ts: string };
type Account = Awaited<ReturnType<typeof trpc.trading.account.query>>;
type Briefing = Awaited<ReturnType<typeof trpc.system.briefing.query>>;

/** Morning-Briefing der Nacht-Pipeline (08_ §7) — echter Inhalt aus der DB. */
function BriefingPanel() {
  const { t } = useTranslation();
  const [briefing, setBriefing] = useState<Briefing | undefined>(undefined);

  useEffect(() => {
    void trpc.system.briefing.query().then(setBriefing).catch(() => setBriefing(null));
  }, []);

  return (
    <Panel label={t('dashboard.briefingTitle')} stagger={4} className="mt-5">
      {briefing === undefined ? (
        <Loading />
      ) : briefing === null ? (
        <Empty text={t('dashboard.briefingNone')} />
      ) : (
        <>
          {/* Telegram-HTML-Tags für die Web-Anzeige entfernen — Inhalt bleibt identisch */}
          <pre className="mt-3 text-sm leading-relaxed whitespace-pre-wrap" style={{ fontFamily: 'var(--font-sans)' }}>
            {briefing.text.replace(/<\/?(b|i|code)>/g, '')}
          </pre>
          <p className="label mt-3">
            {briefing.day} · {briefing.sentAt ? t('dashboard.briefingSent') : t('dashboard.briefingNotSent')}
          </p>
        </>
      )}
    </Panel>
  );
}

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

function fmtPrice(p: number): string {
  return p >= 1000
    ? p.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}

function PriceCard({ symbol, closes, stagger, footnote }: { symbol: string; closes: number[]; stagger: number; footnote: string }) {
  const { t } = useTranslation();
  const [tick, setTick] = useState<TickWithDirection | null>(() => getLatest().find((x) => x.symbol === symbol) ?? null);
  const [pulse, setPulse] = useState<'tick-pos' | 'tick-neg' | ''>('');
  const pulseTimer = useRef(0);

  useEffect(() => {
    const off = onTick((x) => {
      if (x.symbol !== symbol) return;
      setTick(x);
      if (x.direction !== 'flat') {
        setPulse('');
        cancelAnimationFrame(pulseTimer.current);
        pulseTimer.current = requestAnimationFrame(() => setPulse(x.direction === 'up' ? 'tick-pos' : 'tick-neg'));
      }
    });
    return () => {
      off();
      cancelAnimationFrame(pulseTimer.current);
    };
  }, [symbol]);

  const short = symbol.replace('/USDT', '');
  return (
    <div
      className="glass glass-hover reveal p-6"
      style={{ '--stagger': stagger } as React.CSSProperties}
      onMouseEnter={() => setRainHighlight(symbol)}
      onMouseLeave={() => setRainHighlight(null)}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium">{short}</h2>
        <span className="label">{symbol}</span>
      </div>
      {tick ? (
        <>
          <p className={`num mt-3 text-[32px] leading-none font-semibold ${pulse}`}>
            {fmtPrice(tick.price)} <span className="text-base font-normal" style={{ color: 'var(--color-mut)' }}>$</span>
          </p>
          <p
            className="num mt-2 text-sm"
            style={{
              color:
                tick.changePct24h == null ? 'var(--color-mut)' : tick.changePct24h >= 0 ? 'var(--color-pos)' : 'var(--color-neg)',
            }}
          >
            {tick.changePct24h == null ? '24h —' : `${tick.changePct24h >= 0 ? '▲' : '▼'} ${Math.abs(tick.changePct24h).toFixed(2)} % · 24h`}
          </p>
        </>
      ) : (
        <p className="mt-3 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </p>
      )}
      <div className="mt-5">
        <Sparkline closes={closes} id={`spark-${short}`} />
        <p className="label mt-2">{footnote}</p>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [ingest, setIngest] = useState<IngestRow[] | null>(null);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [signalRows, setSignalRows] = useState<SignalRow[] | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSignals() {
    try {
      const rows = await trpc.signals.list.query({ status: ['new'], limit: 6 });
      setSignalRows(rows as SignalRow[]);
    } catch (err) {
      if (!isUnauthorized(err)) setSignalRows((prev) => prev ?? []);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sys, ing, acc, me] = await Promise.all([
          trpc.system.status.query(),
          trpc.market.ingestStatus.query(),
          trpc.trading.account.query(),
          trpc.auth.me.query(),
        ]);
        if (cancelled) return;
        setSystem(sys);
        setIngest(ing);
        setAccount(acc);
        setUserName(me.name ?? me.email.split('@')[0] ?? null);
        setError(null);
        const sparkEntries = await Promise.all(
          SYMBOLS.map(async (symbol) => {
            const candles = await trpc.market.ohlcv.query({ symbol, timeframe: '1h', limit: 72 });
            return [symbol, candles.map((c) => c.close)] as const;
          }),
        );
        if (!cancelled) setSparks(Object.fromEntries(sparkEntries));
      } catch (err) {
        if (isUnauthorized(err)) {
          await refreshSession();
        } else if (!cancelled) {
          setError(err instanceof Error ? err.message : t('common.error'));
        }
      }
    }
    void load();
    void loadSignals();
    const timer = window.setInterval(() => void load(), 60_000);
    const sigTimer = window.setInterval(() => void loadSignals(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(sigTimer);
    };
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 11 ? t('dashboard.greetingMorning') : hour < 18 ? t('dashboard.greetingDay') : t('dashboard.greetingEvening');

  return (
    <div className="relative">
      {/* Hero-Konstellation hinter Begrüßung + Preiskarten (pulst auf echte Ticks) */}
      <div className="pointer-events-none absolute inset-x-0 -top-8 h-[380px] overflow-hidden" aria-hidden="true">
        <PlexusHero density={22} className="opacity-60" />
      </div>

      <header className="reveal relative mb-8" style={{ '--stagger': 0 } as React.CSSProperties}>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting}
          {userName ? `, ${userName}` : ''}
        </h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('dashboard.marketTitle')} · {t('dashboard.scanInfo')}
        </p>
      </header>

      {error && <ErrorBox message={error} />}

      {/* Live-Preise — echte Binance-WebSocket-Daten */}
      <section className="relative grid gap-5 md:grid-cols-3">
        {SYMBOLS.map((symbol, i) => (
          <PriceCard key={symbol} symbol={symbol} closes={sparks[symbol] ?? []} stagger={i + 1} footnote={t('dashboard.candles72h')} />
        ))}
      </section>

      {/* Signal-Vorschau */}
      <section className="reveal mt-8" style={{ '--stagger': 4 } as React.CSSProperties}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="label">{t('dashboard.signalsTitle')}</h2>
          <a href="#/signals" className="text-xs" style={{ color: 'var(--color-cyan)' }}>
            → {t('signals.title')}
          </a>
        </div>
        {signalRows === null ? (
          <div className="glass p-6">
            <Loading />
          </div>
        ) : signalRows.length === 0 ? (
          <div className="glass p-6 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('dashboard.noSetup')}
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {signalRows.map((s) => (
              <SignalCard key={s.id} signal={s} onDecided={() => void loadSignals()} />
            ))}
          </div>
        )}
      </section>

      <BriefingPanel />

      <section className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* Konto-Snapshot */}
        <Panel label={t('trading.accountTitle')} stagger={5}>
          {account ? (
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.equity')}</span>
                <span className="num">{account.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })} $</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.dailyPnl')}</span>
                <span className="num" style={{ color: account.dailyPnlPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                  {account.dailyPnlPct.toFixed(2)} %
                </span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.openPositions')}</span>
                <span className="num">{account.openPositions}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>Venue</span>
                <span className="num">{account.venue.id}</span>
              </li>
            </ul>
          ) : (
            <Loading />
          )}
          <a href="#/trading" className="mt-4 inline-block text-xs" style={{ color: 'var(--color-cyan)' }}>
            → {t('trading.title')}
          </a>
        </Panel>

        {/* System — alles echt gemessen */}
        <Panel label={t('dashboard.systemTitle')} stagger={6}>
          {system ? (
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.db')}</span>
                <span style={{ color: 'var(--color-pos)' }}>{t('dashboard.dbUp')}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.uptime')}</span>
                <span className="num">{fmtUptime(system.uptimeSec)}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.candles')}</span>
                <span className="num">{system.counts.ohlcv_rows?.toLocaleString()}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.packagesAssets')}</span>
                <span className="num">
                  {system.counts.packages} / {system.counts.assets}
                </span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>{t('dashboard.signalsCount')}</span>
                <span className="num">{system.counts.signals}</span>
              </li>
            </ul>
          ) : (
            <Loading />
          )}
        </Panel>

        {/* Datenquellen — ehrlicher Verbindungsstatus */}
        <Panel label={t('dashboard.sourcesTitle')} stagger={7}>
          {system ? (
            <ul className="mt-4 space-y-2.5 text-sm">
              {Object.entries(system.sources).map(([key, value]) => {
                const connected = value.startsWith('verbunden') || value.startsWith('aktiv');
                return (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <span className="shrink-0" style={{ color: 'var(--color-mut)' }}>
                      {key.replaceAll('_', ' ')}
                    </span>
                    <span className="flex items-center gap-2 text-right text-xs" style={{ color: connected ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                      <StatusDot on={connected} />
                      {value}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Loading />
          )}
        </Panel>
      </section>

      {/* Historische Daten — echte Binance-Kerzen in der eigenen DB */}
      <Panel label={t('dashboard.historyTitle')} stagger={8} className="mt-5">
        {ingest === null ? (
          <Loading />
        ) : ingest.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="label">
                  <th className="py-2 pr-4 font-normal">{t('dashboard.symbol')}</th>
                  <th className="py-2 pr-4 font-normal">{t('dashboard.timeframe')}</th>
                  <th className="py-2 pr-4 text-right font-normal">{t('dashboard.candlesCol')}</th>
                  <th className="py-2 pr-4 font-normal">{t('dashboard.from')}</th>
                  <th className="py-2 font-normal">{t('dashboard.to')}</th>
                </tr>
              </thead>
              <tbody>
                {ingest.map((r) => (
                  <tr key={`${r.symbol}-${r.timeframe}`} style={{ borderTop: '1px solid rgba(79,209,255,0.07)' }}>
                    <td className="py-2 pr-4">{r.symbol}</td>
                    <td className="num py-2 pr-4">{r.timeframe}</td>
                    <td className="num py-2 pr-4 text-right">{r.candles.toLocaleString()}</td>
                    <td className="py-2 pr-4" style={{ color: 'var(--color-mut)' }}>
                      {new Date(r.from_ts).toLocaleDateString()}
                    </td>
                    <td className="py-2" style={{ color: 'var(--color-mut)' }}>
                      {new Date(r.to_ts).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
