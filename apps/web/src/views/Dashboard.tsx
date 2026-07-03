import { useEffect, useMemo, useRef, useState } from 'react';
import { isUnauthorized, logout, refreshSession, trpc } from '../api.js';
import { Sparkline } from '../components/Sparkline.js';
import { setRainHighlight } from '../components/MatrixRain.js';
import { PlexusHero } from '../components/PlexusHero.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import {
  ensurePriceStream,
  getFeedState,
  getLatest,
  onFeedState,
  onTick,
  type FeedState,
  type TickWithDirection,
} from '../lib/prices.js';

type SystemStatus = {
  db: 'up';
  uptimeSec: number;
  counts: Record<string, number>;
  priceFeed: Record<string, string> | null;
  sources: Record<string, string>;
};
type IngestRow = { symbol: string; timeframe: string; candles: number; from_ts: string; to_ts: string };

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

const PHASEN: { name: string; status: 'fertig' | 'teilweise' | 'offen' }[] = [
  { name: '0 Fundament: DB, Auth, Vault', status: 'fertig' },
  { name: '1 Marktdaten (Live + Historie)', status: 'teilweise' },
  { name: '2 Strategie-Engine → Signale bestätigen', status: 'teilweise' },
  { name: '3 Eigenes Backtesting (netto)', status: 'offen' },
  { name: '4 Risk-Engine + Börsen (Paper)', status: 'offen' },
  { name: '5 KI-Agenten-Schwarm', status: 'offen' },
  { name: '6 Finales Design (deine Referenzen)', status: 'offen' },
  { name: '7 Härtung + Live-Freigabe', status: 'offen' },
];

function fmtPrice(p: number): string {
  return p >= 1000
    ? p.toLocaleString('de-DE', { maximumFractionDigits: 0 })
    : p.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}

/** Preis-Karte: große Mono-Zahl, Micro-Glow bei echten Ticks, Hover koppelt in den Rain. */
function PriceCard({ symbol, closes, stagger }: { symbol: string; closes: number[]; stagger: number }) {
  const [tick, setTick] = useState<TickWithDirection | null>(
    () => getLatest().find((t) => t.symbol === symbol) ?? null,
  );
  const [pulse, setPulse] = useState<'tick-pos' | 'tick-neg' | ''>('');
  const pulseTimer = useRef(0);

  useEffect(() => {
    const off = onTick((t) => {
      if (t.symbol !== symbol) return;
      setTick(t);
      if (t.direction !== 'flat') {
        setPulse('');
        cancelAnimationFrame(pulseTimer.current);
        pulseTimer.current = requestAnimationFrame(() =>
          setPulse(t.direction === 'up' ? 'tick-pos' : 'tick-neg'),
        );
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
                tick.changePct24h == null
                  ? 'var(--color-mut)'
                  : tick.changePct24h >= 0
                    ? 'var(--color-pos)'
                    : 'var(--color-neg)',
            }}
          >
            {tick.changePct24h == null
              ? '24h —'
              : `${tick.changePct24h >= 0 ? '▲' : '▼'} ${Math.abs(tick.changePct24h).toFixed(2)} % · 24h`}
          </p>
        </>
      ) : (
        <p className="mt-3 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
          Warte auf ersten echten Tick …
        </p>
      )}
      <div className="mt-5">
        <Sparkline closes={closes} id={`spark-${short}`} />
        <p className="label mt-2">72 h · 1h-Kerzen · eigene DB</p>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [feed, setFeed] = useState<FeedState>(getFeedState());
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [ingest, setIngest] = useState<IngestRow[] | null>(null);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [signalRows, setSignalRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSignals() {
    try {
      const rows = await trpc.signals.list.query({ status: ['new'], limit: 30 });
      setSignalRows(rows as SignalRow[]);
    } catch (err) {
      if (!isUnauthorized(err)) setSignalRows((prev) => prev ?? []);
    }
  }

  useEffect(() => {
    ensurePriceStream();
    return onFeedState(setFeed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sys, ing] = await Promise.all([trpc.system.status.query(), trpc.market.ingestStatus.query()]);
        if (cancelled) return;
        setSystem(sys);
        setIngest(ing);
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
          await refreshSession(); // schlägt fehl → App wechselt zum Login
        } else if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Laden fehlgeschlagen.');
        }
      }
    }
    void load();
    void loadSignals();
    const t = window.setInterval(() => void load(), 60_000);
    const ts = window.setInterval(() => void loadSignals(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.clearInterval(ts);
    };
  }, []);

  const feedBadge = useMemo(() => {
    const map: Record<FeedState, { text: string; color: string }> = {
      live: { text: '● LIVE', color: 'var(--color-pos)' },
      connecting: { text: '◌ VERBINDET', color: 'var(--color-warn)' },
      disconnected: { text: '○ GETRENNT', color: 'var(--color-neg)' },
    };
    return map[feed];
  }, [feed]);

  return (
    <div className="relative z-10 mx-auto max-w-6xl px-6 pt-8 pb-16">
      {/* Hero-Konstellation hinter Kopfzeile + Preiskarten (pulst auf echte Ticks) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden" aria-hidden="true">
        <PlexusHero density={22} className="opacity-60" />
      </div>
      <header
        className="reveal mb-10 flex flex-wrap items-center justify-between gap-4"
        style={{ '--stagger': 0 } as React.CSSProperties}
      >
        <div className="flex items-baseline gap-4">
          <h1 className="wordmark text-lg font-semibold">GLADIATOR</h1>
          <nav className="flex gap-4 text-sm">
            <a href="#/" style={{ color: 'var(--color-cyan)' }}>Dashboard</a>
            <a href="#/labor" style={{ color: 'var(--color-mut)' }}>Strategie-Labor</a>
            <a href="#/trading" style={{ color: 'var(--color-mut)' }}>Trading</a>
          </nav>
          <span className="label rounded border border-warn/40 px-1.5 py-0.5" style={{ color: 'var(--color-warn)' }}>
            Rohbau
          </span>
        </div>
        <div className="flex items-center gap-5">
          <span className="num text-xs tracking-widest" style={{ color: feedBadge.color }}>
            {feedBadge.text}
          </span>
          <button
            onClick={() => void logout()}
            className="text-sm transition-colors hover:text-[color:var(--color-ink)]"
            style={{ color: 'var(--color-mut)' }}
          >
            Abmelden
          </button>
        </div>
      </header>

      {error && (
        <div className="glass mb-6 p-4 text-sm" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
          {error}
        </div>
      )}

      {/* Live-Preise — echte Binance-WebSocket-Daten */}
      <section className="grid gap-5 md:grid-cols-3">
        {SYMBOLS.map((symbol, i) => (
          <PriceCard key={symbol} symbol={symbol} closes={sparks[symbol] ?? []} stagger={i + 1} />
        ))}
      </section>

      {/* Signal-Feed: echte SMC-Core-Setups aus der Engine, Mensch im Loop */}
      <section className="reveal mt-8" style={{ '--stagger': 3 } as React.CSSProperties}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="label">Signale · SMC Core · Multi-Timeframe</h2>
          <span className="label">Scan alle 5 min auf 15m/1h/4h/1d</span>
        </div>
        {signalRows === null ? (
          <div className="glass p-6">
            <p className="animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>Lade Signale …</p>
          </div>
        ) : signalRows.length === 0 ? (
          <div className="glass p-6 text-sm" style={{ color: 'var(--color-mut)' }}>
            Aktuell kein offenes Setup. Die Engine handelt nur, wenn ALLE Pflicht-Confluences stimmen
            (Trend + Struktur-Bruch + Retest + RSI + Volumen) — kein Setup ist ehrlicher als ein erfundenes.
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {signalRows.map((s) => (
              <SignalCard key={s.id} signal={s} onDecided={() => void loadSignals()} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* System — alles echt gemessen */}
        <div className="glass glass-hover reveal p-6" style={{ '--stagger': 4 } as React.CSSProperties}>
          <h2 className="label">System</h2>
          {system ? (
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>Datenbank</span>
                <span style={{ color: 'var(--color-pos)' }}>läuft</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>API-Uptime</span>
                <span className="num">{fmtUptime(system.uptimeSec)}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>OHLCV-Kerzen</span>
                <span className="num">{system.counts.ohlcv_rows?.toLocaleString('de-DE')}</span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>Pakete / Assets (v1)</span>
                <span className="num">
                  {system.counts.packages} / {system.counts.assets}
                </span>
              </li>
              <li className="flex justify-between">
                <span style={{ color: 'var(--color-mut)' }}>Signale</span>
                <span className="num">{system.counts.signals}</span>
              </li>
            </ul>
          ) : (
            <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>Lade …</p>
          )}
        </div>

        {/* Datenquellen — ehrlicher Verbindungsstatus */}
        <div className="glass glass-hover reveal p-6" style={{ '--stagger': 5 } as React.CSSProperties}>
          <h2 className="label">Datenquellen</h2>
          {system ? (
            <ul className="mt-4 space-y-2.5 text-sm">
              {Object.entries(system.sources).map(([key, value]) => {
                const connected = value === 'verbunden';
                return (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <span style={{ color: 'var(--color-mut)' }}>{key.replaceAll('_', ' ')}</span>
                    <span className="flex items-center gap-2" style={{ color: connected ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                      <span className={`neon-dot ${connected ? 'neon-dot--on' : 'neon-dot--off'}`} />
                      {value}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>Lade …</p>
          )}
        </div>

        {/* Roadmap zu deinem Ziel */}
        <div className="glass glass-hover reveal p-6" style={{ '--stagger': 6 } as React.CSSProperties}>
          <h2 className="label">Roadmap</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            {PHASEN.map((p) => (
              <li key={p.name} className="flex items-center gap-2.5">
                <span
                  className="num"
                  style={{
                    color:
                      p.status === 'fertig'
                        ? 'var(--color-pos)'
                        : p.status === 'teilweise'
                          ? 'var(--color-warn)'
                          : 'var(--color-mut)',
                  }}
                >
                  {p.status === 'fertig' ? '✓' : p.status === 'teilweise' ? '◐' : '○'}
                </span>
                <span style={{ color: p.status === 'offen' ? 'var(--color-mut)' : 'var(--color-ink)' }}>{p.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            Ziel: Signale vorab sehen → per Klick bestätigen/ablehnen → eigenes Backtesting.
          </p>
        </div>
      </section>

      {/* Historische Daten — echte Binance-Kerzen in der eigenen DB */}
      <section className="glass glass-hover reveal mt-5 p-6" style={{ '--stagger': 7 } as React.CSSProperties}>
        <h2 className="label">Historische Daten · Binance · echt</h2>
        {ingest === null ? (
          <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>Lade …</p>
        ) : ingest.length === 0 ? (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-mut)' }}>Noch kein Backfill gelaufen.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="label">
                  <th className="py-2 pr-4 font-normal">Symbol</th>
                  <th className="py-2 pr-4 font-normal">Timeframe</th>
                  <th className="py-2 pr-4 text-right font-normal">Kerzen</th>
                  <th className="py-2 pr-4 font-normal">Von</th>
                  <th className="py-2 font-normal">Bis</th>
                </tr>
              </thead>
              <tbody>
                {ingest.map((r) => (
                  <tr key={`${r.symbol}-${r.timeframe}`} style={{ borderTop: '1px solid rgba(79,209,255,0.07)' }}>
                    <td className="py-2 pr-4">{r.symbol}</td>
                    <td className="num py-2 pr-4">{r.timeframe}</td>
                    <td className="num py-2 pr-4 text-right">{r.candles.toLocaleString('de-DE')}</td>
                    <td className="py-2 pr-4" style={{ color: 'var(--color-mut)' }}>
                      {new Date(r.from_ts).toLocaleDateString('de-DE')}
                    </td>
                    <td className="py-2" style={{ color: 'var(--color-mut)' }}>
                      {new Date(r.to_ts).toLocaleString('de-DE')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="reveal mt-10 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)', '--stagger': 8 } as React.CSSProperties}>
        Alles Angezeigte ist echt oder ehrlich als „nicht verbunden" markiert — auch der Regen besteht aus echten Ticks.
        <br />
        Finales Design folgt in Phase 6.
      </footer>
    </div>
  );
}
