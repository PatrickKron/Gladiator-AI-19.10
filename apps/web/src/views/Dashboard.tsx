import { useEffect, useMemo, useState } from 'react';
import { getAccessToken, isUnauthorized, logout, refreshSession, trpc } from '../api.js';
import { Sparkline } from '../components/Sparkline.js';

type Ticker = { symbol: string; price: number; changePct24h: number | null; ts: string };
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
  { name: '0a Fundament: Repo, DB-Schema, Seed', status: 'fertig' },
  { name: '0b Echte Auth (JWT + Refresh)', status: 'fertig' },
  { name: '0c Secrets-Vault (AES-256-GCM)', status: 'fertig' },
  { name: '1 Marktdaten (Live + Historie)', status: 'teilweise' },
  { name: '2 Strategie-Engine (SMC Core, echtes Scoring)', status: 'offen' },
  { name: '3 Backtesting netto + Walk-Forward', status: 'offen' },
  { name: '4 Risk-Engine + Börsen (Paper/Testnet)', status: 'offen' },
  { name: '5 KI-Agenten + Pine/Anweisungen', status: 'offen' },
  { name: '6 Finales UI (nach deinen Referenzbildern)', status: 'offen' },
  { name: '7 Ausspielung, Härtung, Live-Freigabe', status: 'offen' },
];

function fmtPrice(p: number): string {
  return p >= 1000
    ? p.toLocaleString('de-DE', { maximumFractionDigits: 0 })
    : p.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}

export function Dashboard() {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [feedState, setFeedState] = useState<'verbindet' | 'live' | 'getrennt'>('verbindet');
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [ingest, setIngest] = useState<IngestRow[] | null>(null);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [error, setError] = useState<string | null>(null);

  // Einmalige Datenladung (Status, Ingest, Sparklines aus echten DB-Kerzen)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sys, ing] = await Promise.all([trpc.system.status.query(), trpc.market.ingestStatus.query()]);
        if (cancelled) return;
        setSystem(sys);
        setIngest(ing);
        const sparkEntries = await Promise.all(
          SYMBOLS.map(async (symbol) => {
            const candles = await trpc.market.ohlcv.query({ symbol, timeframe: '1h', limit: 72 });
            return [symbol, candles.map((c) => c.close)] as const;
          }),
        );
        if (!cancelled) setSparks(Object.fromEntries(sparkEntries));
      } catch (err) {
        if (isUnauthorized(err)) {
          const ok = await refreshSession();
          if (!ok) return; // App wechselt automatisch zum Login
        } else if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Laden fehlgeschlagen.');
        }
      }
    }
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Live-Ticks über SSE (echte Binance-WebSocket-Daten, durchgereicht)
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const es = new EventSource(`/api/stream/prices?access_token=${encodeURIComponent(token)}`);
    const apply = (t: Ticker) => setTickers((prev) => ({ ...prev, [t.symbol]: t }));

    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as { tickers: Ticker[] };
      for (const t of snap.tickers) apply(t);
      setFeedState('live');
    });
    es.addEventListener('tick', (e) => {
      apply(JSON.parse((e as MessageEvent).data) as Ticker);
      setFeedState('live');
    });
    es.addEventListener('status', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { status: string };
      if (s.status === 'disconnected') setFeedState('getrennt');
    });
    es.onerror = () => setFeedState('getrennt');
    return () => es.close();
  }, []);

  const feedBadge = useMemo(() => {
    const map = {
      live: { text: 'LIVE', cls: 'text-pos border-pos/50' },
      verbindet: { text: 'VERBINDET …', cls: 'text-warn border-warn/50' },
      getrennt: { text: 'GETRENNT', cls: 'text-neg border-neg/50' },
    } as const;
    return map[feedState];
  }, [feedState]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-[0.25em]">GLADIATOR</h1>
          <span className="text-sm text-mut">v2</span>
          <span className="rounded border border-warn/50 px-1.5 py-0.5 text-xs text-warn">ROHBAU</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className={`rounded border px-2 py-0.5 text-xs ${feedBadge.cls}`}>{feedBadge.text}</span>
          <button onClick={() => void logout()} className="text-mut transition hover:text-ink">
            Abmelden
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-neg/40 bg-neg/10 p-4 text-sm text-neg">{error}</div>
      )}

      {/* Live-Preise (echte Binance-Daten) */}
      <section className="grid gap-4 md:grid-cols-3">
        {SYMBOLS.map((symbol) => {
          const t = tickers[symbol];
          const closes = sparks[symbol] ?? [];
          return (
            <div key={symbol} className="rounded-2xl border border-line bg-panel p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="font-medium">{symbol.replace('/USDT', '')}</h2>
                <span className="text-xs text-mut">{symbol}</span>
              </div>
              {t ? (
                <>
                  <p className="mt-2 font-mono text-2xl">{fmtPrice(t.price)} $</p>
                  <p className={`mt-1 text-sm ${t.changePct24h == null ? 'text-mut' : t.changePct24h >= 0 ? 'text-pos' : 'text-neg'}`}>
                    {t.changePct24h == null ? '24h: —' : `24h: ${t.changePct24h >= 0 ? '+' : ''}${t.changePct24h.toFixed(2)} %`}
                  </p>
                </>
              ) : (
                <p className="mt-2 animate-pulse text-mut">Warte auf ersten Tick …</p>
              )}
              <div className="mt-4">
                <Sparkline closes={closes} />
                <p className="mt-1 text-xs text-mut">72 h · 1h-Kerzen aus der eigenen DB</p>
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        {/* System-Status (alles echt gemessen) */}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="font-medium">System</h2>
          {system ? (
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex justify-between">
                <span className="text-mut">Datenbank</span>
                <span className="text-pos">läuft</span>
              </li>
              <li className="flex justify-between">
                <span className="text-mut">API-Uptime</span>
                <span>{fmtUptime(system.uptimeSec)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-mut">OHLCV-Kerzen</span>
                <span className="font-mono">{system.counts.ohlcv_rows?.toLocaleString('de-DE')}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-mut">Pakete / Assets (aus v1)</span>
                <span className="font-mono">
                  {system.counts.packages} / {system.counts.assets}
                </span>
              </li>
              <li className="flex justify-between">
                <span className="text-mut">Signale</span>
                <span className="font-mono">{system.counts.signals} (Engine kommt in Phase 2)</span>
              </li>
            </ul>
          ) : (
            <p className="mt-3 animate-pulse text-sm text-mut">Lade …</p>
          )}
        </div>

        {/* Quellen-Status: ehrlich, was verbunden ist und was nicht */}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="font-medium">Datenquellen</h2>
          {system ? (
            <ul className="mt-3 space-y-2 text-sm">
              {Object.entries(system.sources).map(([key, value]) => {
                const connected = value === 'verbunden';
                return (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <span className="text-mut">{key.replaceAll('_', ' ')}</span>
                    <span className={connected ? 'text-pos' : 'text-mut'}>
                      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${connected ? 'bg-pos' : 'bg-line'}`} />
                      {value}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 animate-pulse text-sm text-mut">Lade …</p>
          )}
        </div>

        {/* Roadmap zum Ziel: Signale bestätigen + eigenes Backtesting */}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="font-medium">Roadmap</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {PHASEN.map((p) => (
              <li key={p.name} className="flex items-center gap-2">
                <span
                  className={
                    p.status === 'fertig' ? 'text-pos' : p.status === 'teilweise' ? 'text-warn' : 'text-mut'
                  }
                >
                  {p.status === 'fertig' ? '✓' : p.status === 'teilweise' ? '◐' : '○'}
                </span>
                <span className={p.status === 'offen' ? 'text-mut' : ''}>{p.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-mut">
            Ziel: Signale vorab sehen → per Klick bestätigen/ablehnen → eigenes Backtesting.
          </p>
        </div>
      </section>

      {/* Ingest-Detail: welche echten Kerzen liegen in der DB */}
      <section className="mt-6 rounded-2xl border border-line bg-panel p-5">
        <h2 className="font-medium">Historische Daten (Binance, echt)</h2>
        {ingest === null ? (
          <p className="mt-3 animate-pulse text-sm text-mut">Lade …</p>
        ) : ingest.length === 0 ? (
          <p className="mt-3 text-sm text-mut">Noch kein Backfill gelaufen.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-mut">
                <tr>
                  <th className="py-1.5 pr-4 font-normal">Symbol</th>
                  <th className="py-1.5 pr-4 font-normal">Timeframe</th>
                  <th className="py-1.5 pr-4 font-normal">Kerzen</th>
                  <th className="py-1.5 pr-4 font-normal">Von</th>
                  <th className="py-1.5 font-normal">Bis</th>
                </tr>
              </thead>
              <tbody>
                {ingest.map((r) => (
                  <tr key={`${r.symbol}-${r.timeframe}`} className="border-t border-line">
                    <td className="py-1.5 pr-4">{r.symbol}</td>
                    <td className="py-1.5 pr-4 font-mono">{r.timeframe}</td>
                    <td className="py-1.5 pr-4 font-mono">{r.candles.toLocaleString('de-DE')}</td>
                    <td className="py-1.5 pr-4 text-mut">{new Date(r.from_ts).toLocaleDateString('de-DE')}</td>
                    <td className="py-1.5 text-mut">{new Date(r.to_ts).toLocaleString('de-DE')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="mt-8 text-center text-xs text-mut">
        Rohbau-Oberfläche — zeigt ausschließlich echte Daten oder ehrliche Leerzustände.
        Das finale Design entsteht in Phase 6 aus deinen Referenzbildern.
      </footer>
    </div>
  );
}
