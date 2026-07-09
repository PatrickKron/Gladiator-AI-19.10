import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUnauthorized, refreshSession, trpc } from '../api.js';
import { Sparkline } from '../components/Sparkline.js';
import { setRainHighlight } from '../components/MatrixRain.js';
import { PlexusHero } from '../components/PlexusHero.js';
import { SignalCard, type SignalRow } from '../components/SignalCard.js';
import { Empty, ErrorBox, Loading, Panel, StatusDot } from '../components/ui.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';
import { AddMarketPicker } from '../components/AddMarketPicker.js';
import { FavStar, FavStarSymbol } from '../components/FavStar.js';
import { getLatest, onTick, type TickWithDirection } from '../lib/prices.js';
import { setDemoMode } from '../lib/demo-mode.js';
import { setPendingTradeSymbol } from '../lib/trade-symbol.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { loadTf } from '../lib/chart-tf.js';
import { feedSymbol } from '../lib/pairs.js';
import { normalizeRegime, REGIME_COLORS, REGIME_ICONS, type RegimeData } from '../lib/regime.js';
import { getUiMode, onUiModeChange, type UiMode } from '../lib/ui-mode.js';

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

/** Favoriten-Briefing (Patrick-Luecke 5/6): live Asset-Kontext je Stern-Favorit, 60-s-Refresh. */
function FavoriteBriefingCard({ symbol }: { symbol: string }) {
  const { t } = useTranslation();
  const ctx = useAssetContext(symbol, 60_000);
  return (
    <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(232,184,75,0.3)' }}>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <span style={{ color: 'var(--color-warn)' }}>{'\u2605'}</span> {symbol}
      </p>
      <AssetContextBody ctx={ctx} compact />
      <p className="label mt-2">{t('dashboard.favBriefingUpdated', { time: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })}</p>
    </div>
  );
}

function FavoritesBriefing() {
  const { t } = useTranslation();
  const [symbols, setSymbols] = useState<string[] | null>(null);

  useEffect(() => {
    void trpc.product.favorites
      .query()
      .then((favs) => {
        const pairs = favs
          .map((f) => f.tradingPair?.toUpperCase().replaceAll('/', ''))
          .filter((x): x is string => Boolean(x))
          .map((x) => (x.endsWith('USDT') ? x.slice(0, -4) + '/USDT' : x.endsWith('USDC') ? x.slice(0, -4) + '/USDC' : x));
        setSymbols([...new Set(pairs)].slice(0, 9));
      })
      .catch(() => setSymbols([]));
  }, []);

  return (
    <Panel label={t('dashboard.favBriefingTitle')} stagger={5} className="mt-5">
      {symbols === null ? (
        <Loading />
      ) : symbols.length === 0 ? (
        <div className="mt-4 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          <p>{t('dashboard.favBriefingEmpty')}</p>
          <p className="mt-2">
            <a href="#/pakete" className="hover:underline" style={{ color: 'var(--color-cyan)' }}>
              → {t('nav.packages')}
            </a>
            <span className="mx-2">·</span>
            <a href="#/charts" className="hover:underline" style={{ color: 'var(--color-cyan)' }}>
              → {t('nav.assets')}
            </a>
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {symbols.map((sym) => (
            <FavoriteBriefingCard key={sym} symbol={sym} />
          ))}
        </div>
      )}
    </Panel>
  );
}

/**
 * KI-Status (Cyborg-Investor, P1.6): Markt-Regime, ML-Pipeline-Stand und
 * RL-Agenten auf einen Blick — jede Spalte lädt unabhängig und fällt einzeln
 * graceful zurück (ein Fehler reißt nicht das Panel um). Alles echte Daten.
 */
function AiStatusPanel() {
  const { t } = useTranslation();
  const [regime, setRegime] = useState<RegimeData | null | undefined>(undefined);
  const [mlState, setMlState] = useState<{ activeModel: { name: string; accuracy: number | null } | null; labels: number } | null | undefined>(undefined);
  const [rlState, setRlState] = useState<{ total: number; live: number; bestSharpe: number | null } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    // Regime des Leitmarkts BTC (1h) als Markt-Proxy.
    trpc.ml.regime
      .query({ symbol: 'BTC/USDT', timeframe: '1h' })
      .then((r) => { if (!cancelled) setRegime(normalizeRegime(r)); })
      .catch(() => { if (!cancelled) setRegime(null); });
    Promise.all([trpc.ml.modelMetrics.query(), trpc.ml.labelStats.query({})])
      .then(([m, s]) => {
        if (cancelled) return;
        const active = (m.models as { name: string; isActive: boolean; metrics: Record<string, number> | null }[]).find((x) => x.isActive) ?? null;
        setMlState({
          activeModel: active ? { name: active.name, accuracy: active.metrics?.accuracy ?? null } : null,
          labels: s.total,
        });
      })
      .catch(() => { if (!cancelled) setMlState(null); });
    trpc.rl.agents
      .query()
      .then((a) => {
        if (cancelled) return;
        const rows = a.agents as { status: string; latestPerformance: { sharpeRatio: string | null } | null }[];
        const sharpes = rows
          .map((x) => (x.latestPerformance?.sharpeRatio != null ? parseFloat(x.latestPerformance.sharpeRatio) : NaN))
          .filter((n) => !Number.isNaN(n));
        setRlState({
          total: rows.length,
          live: rows.filter((x) => x.status === 'live').length,
          bestSharpe: sharpes.length > 0 ? Math.max(...sharpes) : null,
        });
      })
      .catch(() => { if (!cancelled) setRlState(null); });
    return () => { cancelled = true; };
  }, []);

  const mut = { color: 'var(--color-mut)' } as const;

  return (
    <Panel label={t('dashboard.aiTitle')} stagger={4} className="mt-8">
      <div className="mt-4 grid gap-5 sm:grid-cols-3">
        {/* Markt-Regime */}
        <div>
          <p className="label">{t('dashboard.aiRegime')}</p>
          {regime === undefined ? (
            <p className="mt-2 animate-pulse text-sm" style={mut}>{t('common.loading')}</p>
          ) : regime === null ? (
            <p className="mt-2 text-sm leading-relaxed" style={mut}>{t('dashboard.aiRegimeNone')}</p>
          ) : (
            <>
              <p className="num mt-2 text-lg font-semibold" style={{ color: REGIME_COLORS[regime.regime] }}>
                {REGIME_ICONS[regime.regime]} {t(`regime.${regime.regime}` as const)}
              </p>
              <p className="num mt-1 text-xs" style={mut}>
                BTC · 1h · {(regime.confidence * 100).toFixed(0)}% {t('regime.confidence')}
              </p>
            </>
          )}
        </div>
        {/* ML-Pipeline */}
        <div>
          <p className="label">{t('dashboard.aiMl')}</p>
          {mlState === undefined ? (
            <p className="mt-2 animate-pulse text-sm" style={mut}>{t('common.loading')}</p>
          ) : mlState === null ? (
            <p className="mt-2 text-sm leading-relaxed" style={mut}>{t('common.error')}</p>
          ) : mlState.activeModel ? (
            <>
              <p className="num mt-2 text-lg font-semibold">{mlState.activeModel.name}</p>
              <p className="num mt-1 text-xs" style={mut}>
                {mlState.activeModel.accuracy != null
                  ? `Accuracy ${(mlState.activeModel.accuracy * 100).toFixed(1)}%`
                  : t('ml.active')}
                {' · '}{mlState.labels} Labels
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm leading-relaxed" style={mut}>
              {t('dashboard.aiMlNone', { n: mlState.labels })}
            </p>
          )}
        </div>
        {/* RL-Agenten */}
        <div>
          <p className="label">{t('dashboard.aiAgents')}</p>
          {rlState === undefined ? (
            <p className="mt-2 animate-pulse text-sm" style={mut}>{t('common.loading')}</p>
          ) : rlState === null ? (
            <p className="mt-2 text-sm leading-relaxed" style={mut}>{t('common.error')}</p>
          ) : rlState.total === 0 ? (
            <p className="mt-2 text-sm leading-relaxed" style={mut}>{t('dashboard.aiAgentsNone')}</p>
          ) : (
            <>
              <p className="num mt-2 text-lg font-semibold">
                {rlState.total} <span className="text-xs font-normal" style={mut}>{t('rl.title')}</span>
              </p>
              <p className="num mt-1 text-xs" style={mut}>
                {rlState.live} {t('rl.live')} · {t('rl.sharpe')} {rlState.bestSharpe != null ? rlState.bestSharpe.toFixed(2) : '—'}
              </p>
            </>
          )}
        </div>
      </div>
      <a href="#/intelligenz" className="mt-4 inline-block text-xs" style={{ color: 'var(--color-cyan)' }}>
        → {t('hub.title')}
      </a>
    </Panel>
  );
}

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

type FavQuote = { price: number; changePct: number | null; currency: string | null } | null;
type QuoteFav = { assetId: number; ticker: string; name: string };

/** Kurs mit Quell-Währung (Auslandsbörsen liefern EUR/JPY/HKD/…); null = ohne Suffix (Renditen/Indizes). */
function fmtFavQuote(price: number, currency: string | null): string {
  const num = price.toLocaleString(undefined, { maximumFractionDigits: price >= 1000 ? 0 : price >= 1 ? 2 : 6 });
  if (currency === null) return num;
  const cur = currency.toUpperCase();
  if (cur === 'USD' || cur === 'USDT') return `${num} $`;
  if (cur === 'EUR') return `${num} €`;
  if (cur === 'JPY') return `${num} ¥`;
  return `${num} ${cur}`;
}

/**
 * „Heute"-Hero (UI-Konzept Welle 2): EINE große Zahl — Gesamtvermögen über
 * beide Konten (Demo + Agenten-Paper) — plus Tages-PnL des Paper-Kontos.
 * Jede Quelle fällt einzeln ehrlich aus (fehlt eine, wird die andere gezeigt
 * und die Aufschlüsselung sagt es).
 */
function HeroWealth({ account }: { account: Account | null }) {
  const { t } = useTranslation();
  const [demo, setDemo] = useState<{ equity: number } | null | undefined>(undefined); // undefined = lädt

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await trpc.demo.account.query();
        if (!cancelled) setDemo({ equity: d.equity });
      } catch {
        if (!cancelled) setDemo(null); // ehrlich: Demo-Konto nicht ladbar
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const paperEquity = account?.equity ?? null;
  const demoEquity = demo === undefined ? null : (demo?.equity ?? null);
  const total = paperEquity === null && demoEquity === null ? null : (paperEquity ?? 0) + (demoEquity ?? 0);
  const dailyPct = account?.dailyPnlPct ?? null;

  return (
    <section className="reveal relative mb-8" style={{ '--stagger': 0.5 } as React.CSSProperties}>
      <p className="label">{t('dashboard.heroTitle')}</p>
      {total === null ? (
        <p className="num mt-2 animate-pulse text-5xl font-semibold" style={{ color: 'var(--color-mut)' }}>…</p>
      ) : (
        <>
          <p className="num mt-1 text-[52px] leading-none font-semibold tracking-tight">
            {total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            <span className="ml-2 text-2xl font-normal" style={{ color: 'var(--color-mut)' }}>$</span>
          </p>
          <p className="num mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {dailyPct !== null && (
              <span style={{ color: dailyPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {dailyPct >= 0 ? '▲' : '▼'} {Math.abs(dailyPct).toFixed(2)} % {t('dashboard.heroToday')}
              </span>
            )}
            <span style={{ color: 'var(--color-mut)' }}>
              {t('dashboard.heroSplit', {
                demo: demoEquity !== null ? demoEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—',
                paper: paperEquity !== null ? paperEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—',
              })}
            </span>
            {account && account.openPositions > 0 && (
              <a href="#/trading" className="underline decoration-dotted" style={{ color: 'var(--color-cyan)' }}>
                {t('dashboard.heroOpenPositions', { n: account.openPositions })}
              </a>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Favoriten-Kachel für Nicht-Krypto (Aktien/ETF/Index/Future/Rohstoff):
 * echter Börsen-Quote (TradingView/CBOE) statt Live-Tick — ehrlich beschriftet.
 */
function QuoteFavCard({ fav, quote, stagger, onRemoved }: { fav: QuoteFav; quote: FavQuote | undefined; stagger: number; onRemoved: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="glass glass-hover reveal p-6" style={{ '--stagger': stagger } as React.CSSProperties}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium">{fav.ticker}</h2>
        <span className="flex items-center gap-1">
          <FavStar assetId={fav.assetId} isFavorite onToggled={(_id, isFav) => { if (!isFav) onRemoved(); }} />
          <span className="label max-w-[140px] truncate">{fav.name}</span>
        </span>
      </div>
      {quote === undefined ? (
        <p className="mt-3 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>
      ) : quote === null ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>{t('packages.noPrice')}</p>
      ) : (
        <>
          <p className="num mt-3 text-[28px] leading-none font-semibold">{fmtFavQuote(quote.price, quote.currency)}</p>
          <p
            className="num mt-2 text-sm"
            style={{ color: quote.changePct == null ? 'var(--color-mut)' : quote.changePct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
          >
            {quote.changePct == null ? '—' : `${quote.changePct >= 0 ? '▲' : '▼'} ${Math.abs(quote.changePct).toFixed(2)} %`}
          </p>
          <p className="label mt-3">{t('dashboard.quoteSource')}</p>
        </>
      )}
      {/* Ehrlich deaktiviert: Demo-Fills laufen gegen ECHTE Binance-Orderbücher — die gibt
          es nur für Krypto. Tooltip auf dem Wrapper, weil deaktivierte Buttons nicht überall
          hovern; die sichtbare Kurzzeile deckt Mobile ab (dort gibt es keine Tooltips). */}
      <span className="mt-4 block cursor-not-allowed" title={t('dashboard.tradeCryptoOnly')}>
        <button
          disabled
          aria-disabled="true"
          title={t('dashboard.tradeCryptoOnly')}
          className="w-full rounded-[0.625rem] border px-3 py-2 text-sm opacity-50"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {t('dashboard.trade')}
        </button>
        <span className="mt-1.5 block text-center text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('dashboard.tradeCryptoOnlyShort')}
        </span>
      </span>
    </div>
  );
}

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

/** Preis + 24h-Änderung aus 1h-Kerzen ableiten (Fallback, wenn kein Live-Tick vorliegt). */
function deriveFromCloses(closes: number[]): { price: number | null; change24h: number | null } {
  if (closes.length === 0) return { price: null, change24h: null };
  const price = closes[closes.length - 1]!;
  const ref = closes.length >= 25 ? closes[closes.length - 25] : undefined; // ~24h zurück (1h-Kerzen)
  return { price, change24h: ref && ref > 0 ? (price / ref - 1) * 100 : null };
}

/**
 * Watchlist-Karte (P0.4): Favorit als Live-Preiskachel — klickbar direkt in den
 * Chart (mit gemerktem Timeframe), Stern zum Entfernen. Preis/24h aus Live-Tick
 * (BTC/ETH/SOL) oder ehrlich aus eigenen 1h-Kerzen abgeleitet.
 */
function WatchCard({ symbol, isFavorite, closes, stagger, onRemoved }: { symbol: string; isFavorite: boolean; closes: number[]; stagger: number; onRemoved: (symbol: string) => void }) {
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

  const short = symbol.replace('/USDT', '').replace('/USDC', '');
  const derived = deriveFromCloses(closes);
  const price = tick?.price ?? derived.price;
  const change = tick?.changePct24h ?? derived.change24h;

  return (
    <a
      href={buildChartUrl(symbol, loadTf(symbol) ?? '1h')}
      className="glass glass-hover reveal block p-6"
      style={{ '--stagger': stagger } as React.CSSProperties}
      onMouseEnter={() => setRainHighlight(symbol)}
      onMouseLeave={() => setRainHighlight(null)}
      title={t('dashboard.openChart', { symbol })}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium">{short}</h2>
        <span className="flex items-center gap-1">
          {/* Fallback-Symbole (BTC/ETH/SOL) sind KEINE Favoriten — Stern darf dort nicht gefüllt lügen. */}
          <FavStarSymbol symbol={symbol} initialFavorite={isFavorite || undefined} onToggled={(fav) => { if (!fav) onRemoved(symbol); }} />
          <span className="label">{symbol}</span>
        </span>
      </div>
      {price != null ? (
        <>
          <p className={`num mt-3 text-[32px] leading-none font-semibold ${pulse}`}>
            {fmtPrice(price)} <span className="text-base font-normal" style={{ color: 'var(--color-mut)' }}>$</span>
          </p>
          <p
            className="num mt-2 text-sm"
            style={{ color: change == null ? 'var(--color-mut)' : change >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
          >
            {change == null ? '24h —' : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)} % · 24h`}
          </p>
        </>
      ) : (
        <p className="mt-3 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </p>
      )}
      <div className="mt-5">
        <Sparkline closes={closes} id={`spark-${short}`} />
        <p className="label mt-2">{t('dashboard.candles72h')}</p>
      </div>
      {/* „Traden“ (Patrick: Favoriten sollen direkt tradebar sein): Die Karte bleibt
          Chart-Link — der Button fängt den Klick ab (stopPropagation + preventDefault,
          sonst navigiert das umschließende <a> zum Chart), schaltet den Demo-Modus ein
          und übergibt das Symbol ans Demo-Ticket (echtes Binance-Orderbuch, 100k virtuell). */}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPendingTradeSymbol(symbol);
          setDemoMode(true);
          window.location.hash = '#/trading';
        }}
        className="btn-primary mt-4 w-full px-3 py-2 text-sm"
        title={t('dashboard.tradeTooltip', { symbol })}
      >
        {t('dashboard.trade')}
      </button>
    </a>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [ingest, setIngest] = useState<IngestRow[] | null>(null);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [watch, setWatch] = useState<string[]>(SYMBOLS);
  const [watchIsFav, setWatchIsFav] = useState(false);
  const [quoteFavs, setQuoteFavs] = useState<QuoteFav[]>([]);
  const [favQuotes, setFavQuotes] = useState<Record<string, FavQuote>>({});
  const [addOpen, setAddOpen] = useState(false); // Inline-Picker „+ Markt hinzufügen"
  const [uiMode, setUiModeState] = useState<UiMode>(() => getUiMode());

  useEffect(() => onUiModeChange(() => setUiModeState(getUiMode())), []);
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

  // Watchlist = Krypto-Favoriten des Users (Fallback: BTC/ETH/SOL), max. 8.
  // Nicht-Krypto-Favoriten (Aktien/ETF/Index/…) bekommen eigene Quote-Kacheln.
  const loadWatch = useCallback(async () => {
    try {
      const favs = await trpc.product.favorites.query();
      const pairs = favs.map((f) => feedSymbol(f.tradingPair)).filter((x): x is string => Boolean(x));
      const uniq = [...new Set(pairs)].slice(0, 8);
      setWatch(uniq.length > 0 ? uniq : SYMBOLS);
      setWatchIsFav(uniq.length > 0);
      const nonCrypto = favs
        .filter((f) => !feedSymbol(f.tradingPair))
        .map((f) => ({ assetId: f.assetId, ticker: f.ticker, name: f.name }))
        .slice(0, 12);
      setQuoteFavs(nonCrypto);
    } catch {
      setWatch(SYMBOLS);
      setWatchIsFav(false);
      setQuoteFavs([]);
    }
  }, []);

  useEffect(() => {
    void loadWatch();
  }, [loadWatch]);

  // Quotes der Nicht-Krypto-Favoriten (60-s-Refresh, ehrlich null bei toter Quelle).
  useEffect(() => {
    if (quoteFavs.length === 0) return;
    let cancelled = false;
    async function loadQuotes() {
      try {
        const q = await trpc.market.assetQuotes.query({ assetIds: quoteFavs.map((f) => f.assetId) });
        if (!cancelled) setFavQuotes(q as Record<string, FavQuote>);
      } catch {
        if (!cancelled) setFavQuotes({});
      }
    }
    void loadQuotes();
    const timer = window.setInterval(() => void loadQuotes(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [quoteFavs]);

  // Sparklines/Preise der Watchlist aus echten 1h-Kerzen; 60-s-Refresh.
  useEffect(() => {
    let cancelled = false;
    async function loadSparks() {
      const entries = await Promise.all(
        watch.map(async (symbol) => {
          try {
            const candles = await trpc.market.ohlcv.query({ symbol, timeframe: '1h', limit: 72 });
            return [symbol, candles.map((c) => c.close)] as const;
          } catch {
            return [symbol, [] as number[]] as const;
          }
        }),
      );
      if (!cancelled) setSparks(Object.fromEntries(entries));
    }
    void loadSparks();
    const timer = window.setInterval(() => void loadSparks(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [watch]);

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

      {/* Heute-Hero: Gesamtvermögen (Demo + Paper) — die EINE große Zahl */}
      <HeroWealth account={account} />

      {/* Watchlist — „Meine Märkte": Favoriten des Users (Fallback BTC/ETH/SOL), klickbar in den Chart.
          „+ Markt hinzufügen" (Patrick: „krieg ich nicht rein"): öffnet den Inline-Picker über alle Assets. */}
      <div className="relative mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="label">{t('dashboard.myMarketsTitle')}</p>
        <button
          onClick={() => setAddOpen((o) => !o)}
          aria-expanded={addOpen}
          className="rounded-[0.625rem] border px-3 py-1.5 text-xs transition-colors"
          style={{ borderColor: 'rgba(79,209,255,0.45)', color: 'var(--color-cyan)' }}
        >
          + {t('dashboard.addMarket')}
        </button>
      </div>
      {addOpen && (
        <div className="relative">
          <AddMarketPicker onClose={() => setAddOpen(false)} onChanged={() => void loadWatch()} />
        </div>
      )}
      <section
        className={`relative grid gap-5 ${
          watch.length >= 4 ? 'md:grid-cols-2 xl:grid-cols-4' : watch.length === 3 ? 'md:grid-cols-3' : 'sm:grid-cols-2'
        }`}
      >
        {watch.map((symbol, i) => (
          <WatchCard
            key={symbol}
            symbol={symbol}
            isFavorite={watchIsFav}
            closes={sparks[symbol] ?? []}
            stagger={i + 1}
            onRemoved={() => void loadWatch()}
          />
        ))}
      </section>

      {/* Nicht-Krypto-Favoriten: echte Börsen-Quotes (TradingView/CBOE) */}
      {quoteFavs.length > 0 && (
        <section className="mt-5">
          <p className="label mb-3">{t('dashboard.quoteFavsTitle')}</p>
          <div className={`grid gap-5 ${quoteFavs.length >= 4 ? 'md:grid-cols-2 xl:grid-cols-4' : quoteFavs.length === 3 ? 'md:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {quoteFavs.map((f, i) => (
              <QuoteFavCard key={f.assetId} fav={f} quote={favQuotes[f.ticker]} stagger={i + 1} onRemoved={() => void loadWatch()} />
            ))}
          </div>
        </section>
      )}

      {/* KI-Status: Regime + ML-Pipeline + RL-Agenten — Detailtiefe für den Profi-Modus */}
      {uiMode === 'profi' && <AiStatusPanel />}

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

      <FavoritesBriefing />

      <BriefingPanel />

      {uiMode === 'profi' && (<>
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
      </>)}
    </div>
  );
}
