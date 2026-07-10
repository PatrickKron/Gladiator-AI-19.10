import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { AssetSelect } from '../components/AssetSelect.js';
import { EquityChart, MetricCard, fmt } from '../components/EquityChart.js';
import { Empty, ErrorBox, Loading, Panel } from '../components/ui.js';
import { clearPendingTradeSymbol, peekPendingTradeSymbol } from '../lib/trade-symbol.js';
import { getLatest, onTick } from '../lib/prices.js';
import { getUiMode } from '../lib/ui-mode.js';

/**
 * Demo-Trading (Session 5): manuelles Üben mit virtuellem Guthaben (100k),
 * simulierte Ausführung gegen ECHTE Binance-Orderbücher (Spread/Slippage/
 * Fees echt ausgewiesen). Alles hier spricht NUR den demo-Router an —
 * das Agenten-Paper-Konto bleibt unberührt.
 */

type Account = Awaited<ReturnType<typeof trpc.demo.account.query>>;
type Position = Awaited<ReturnType<typeof trpc.demo.positions.query>>[number];
type OpenOrder = Awaited<ReturnType<typeof trpc.demo.openOrders.query>>[number];
type Trade = Awaited<ReturnType<typeof trpc.demo.history.query>>[number];
type Perf = Awaited<ReturnType<typeof trpc.demo.performance.query>>;
type Preview = Awaited<ReturnType<typeof trpc.demo.preview.mutate>>;

const TABS = ['positions', 'orders', 'history', 'performance'] as const;
type Tab = (typeof TABS)[number];

function num(v: string): number {
  return Number(v.replace(',', '.'));
}

/** demo:<reason>-Fehler des Routers in übersetzte Meldungen mappen. */
function reasonText(t: (k: string) => string, err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg.startsWith('demo:')) {
    const key = `demo.err_${msg.slice(5)}`;
    const translated = t(key);
    return translated === key ? msg : translated;
  }
  return msg || t('common.error');
}

const inputCls = 'field num w-full px-2.5 py-1.5 text-sm';

export function DemoTrading() {
  const { t } = useTranslation();
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('positions');
  const [resetArmed, setResetArmed] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, p, o, h, pf] = await Promise.all([
        trpc.demo.account.query(),
        trpc.demo.positions.query(),
        trpc.demo.openOrders.query(),
        trpc.demo.history.query({ limit: 50 }),
        trpc.demo.performance.query(),
      ]);
      setAccount(a);
      setPositions(p);
      setOrders(o);
      setHistory(h);
      setPerf(pf);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function doReset() {
    setResetBusy(true);
    try {
      await trpc.demo.reset.mutate();
      setResetArmed(false);
      await load();
    } catch (err) {
      setError(reasonText(t, err));
    } finally {
      setResetBusy(false);
    }
  }

  const pnlColor = (v: number | null | undefined) =>
    v == null ? undefined : { color: v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' };

  return (
    <div>
      {/* Banner: unmissverständlich Demo — echte Kurse, simulierte Ausführung */}
      <div
        className="reveal mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[0.625rem] border p-4"
        style={{ borderColor: 'rgba(225,78,207,0.5)', background: 'rgba(225,78,207,0.07)' }}
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--color-magenta)' }}>
            {t('demo.bannerTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('demo.bannerText')}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {resetArmed ? (
            <>
              <button
                onClick={() => void doReset()}
                disabled={resetBusy}
                className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                style={{ borderColor: 'rgba(255,92,108,0.6)', color: 'var(--color-neg)' }}
              >
                {t('demo.resetConfirm')}
              </button>
              <button
                onClick={() => setResetArmed(false)}
                className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              >
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button
              onClick={() => setResetArmed(true)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
            >
              {t('demo.reset')}
            </button>
          )}
        </span>
      </div>

      {error && <ErrorBox message={error} />}

      {/* Konto-Kacheln */}
      <section className="grid gap-3 md:grid-cols-4">
        <Panel stagger={1} className="!p-4">
          <p className="label">{t('demo.balance')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">{fmt(account?.balance)} $</p>
          <p className="label mt-1">
            {t('demo.startBalance')} {fmt(account?.startBalance, 0)} $
            {account && account.resetCount > 0 ? ` · ${t('demo.resets', { n: account.resetCount })}` : ''}
          </p>
        </Panel>
        <Panel stagger={2} className="!p-4">
          <p className="label">{t('demo.equity')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">{fmt(account?.equity)} $</p>
          <p className="label mt-1" style={pnlColor(account?.unrealizedPnl)}>
            uPnL {fmt(account?.unrealizedPnl)} $
            {account?.markIncomplete ? ` · ${t('demo.markIncomplete')}` : ''}
          </p>
        </Panel>
        <Panel stagger={3} className="!p-4">
          <p className="label">{t('demo.available')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">{fmt(account?.available)} $</p>
          <p className="label mt-1">
            {t('demo.openPositionsN', { n: account?.openPositions ?? 0 })} · {t('demo.openOrdersN', { n: account?.openOrders ?? 0 })}
          </p>
        </Panel>
        <Panel stagger={4} className="!p-4">
          <p className="label">{t('demo.fees')}</p>
          <p className="num mt-1.5 text-2xl font-semibold">
            {account ? `${(account.feeRates.maker * 100).toFixed(2)} / ${(account.feeRates.taker * 100).toFixed(2)} %` : '—'}
          </p>
          <p className="label mt-1">{t('demo.feesHint')}</p>
        </Panel>
      </section>

      <OrderTicket onPlaced={() => void load()} />

      {/* Tabs */}
      <div className="mt-5 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--color-line)' }}>
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className="shrink-0 border-b-2 px-4 py-2 text-sm transition-colors"
            style={tab === tb ? { borderColor: 'var(--color-magenta)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
          >
            {t(`demo.tab_${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'positions' && <PositionsPanel positions={positions} onChanged={() => void load()} />}
      {tab === 'orders' && <OrdersPanel orders={orders} onChanged={() => void load()} />}
      {tab === 'history' && <HistoryPanel history={history} />}
      {tab === 'performance' && <PerformancePanel perf={perf} />}
    </div>
  );
}

/**
 * Order-Ticket — EIN Trade-Flow (Umbau 2026-07-10, Patricks Vorgabe):
 * Betrag in € statt Stückzahl (echter EUR-Kurs, echter Live-Preis),
 * Absicherung als Klartext-Schieberegler („Verkaufe automatisch bei −x %"),
 * LIVE-Kosten-Vorschau aus dem echten Orderbuch, dann erst [Jetzt kaufen].
 * Profi kann weiterhin direkt Stückzahl eingeben (Umschalter).
 */
function OrderTicket({ onPlaced }: { onPlaced: () => void }) {
  const { t } = useTranslation();
  // Vorbelegung vom Dashboard-„Traden"-Button: peek (pur) im Initialisierer,
  // clear erst im Effect — StrictMode ruft Initialisierer doppelt auf, ein
  // „lesen+löschen" in einem Schritt würde die Übergabe im Dev-Modus verlieren.
  const [symbol, setSymbol] = useState(() => peekPendingTradeSymbol() ?? 'BTC/USDT');
  useEffect(() => {
    clearPendingTradeSymbol();
  }, []);
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [amountMode, setAmountMode] = useState<'eur' | 'qty'>('eur');
  const [amountEur, setAmountEur] = useState('');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [slPct, setSlPct] = useState(0); // 0 = keine Absicherung
  const [tpPct, setTpPct] = useState(0); // 0 = kein Gewinnziel
  const [eurUsd, setEurUsd] = useState<number | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);

  // Echter EUR/USD-Kurs (Server, Binance EURUSDT) — ohne Kurs ehrlich kein €-Modus.
  useEffect(() => {
    let cancelled = false;
    const loadRate = () =>
      trpc.market.eurUsd
        .query()
        .then((r) => {
          if (!cancelled) setEurUsd(r.rate);
        })
        .catch(() => {
          if (!cancelled) setEurUsd(null);
        });
    void loadRate();
    const timer = window.setInterval(() => void loadRate(), 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Echter Live-Preis fürs Symbol (SSE-Feed) — Grundlage der €→Stück-Umrechnung.
  useEffect(() => {
    setLivePrice(getLatest().find((tick) => tick.symbol === symbol)?.price ?? null);
    return onTick((tick) => {
      if (tick.symbol === symbol) setLivePrice(tick.price);
    });
  }, [symbol]);

  // €-Modus: Stückzahl aus Betrag × Kurs ÷ Preis (nur echte Zahlen, sonst null).
  const previewFill = preview && preview.ok ? preview.estFillPrice : null;
  const refPrice = type === 'limit' && num(limitPrice) > 0 ? num(limitPrice) : (livePrice ?? previewFill);
  const eurAmount = num(amountEur);
  const derivedQty =
    amountMode === 'eur' && eurUsd !== null && refPrice !== null && typeof refPrice === 'number' && refPrice > 0 && eurAmount > 0
      ? (eurAmount * eurUsd) / refPrice
      : null;
  const effQty = amountMode === 'eur' ? (derivedQty ?? 0) : num(qty);

  // Absicherung/Gewinnziel: Prozent vom (Referenz-)Preis, richtungsbewusst.
  const slPrice =
    slPct > 0 && typeof refPrice === 'number' && refPrice > 0
      ? direction === 'long'
        ? refPrice * (1 - slPct / 100)
        : refPrice * (1 + slPct / 100)
      : undefined;
  const tpPrice =
    tpPct > 0 && typeof refPrice === 'number' && refPrice > 0
      ? direction === 'long'
        ? refPrice * (1 + tpPct / 100)
        : refPrice * (1 - tpPct / 100)
      : undefined;

  const valid = effQty > 0 && (type === 'market' || num(limitPrice) > 0);

  function buildInput() {
    return {
      symbol,
      direction,
      type,
      qty: effQty,
      limitPrice: type === 'limit' ? num(limitPrice) : undefined,
      stopLoss: slPrice,
      takeProfit: tpPrice,
    };
  }

  // Live-Vorschau (debounced): jede Eingabe-Änderung rechnet gegen das echte Buch
  useEffect(() => {
    setPreview(null);
    setSuccess(null);
    if (!valid) return;
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      setPreviewing(true);
      trpc.demo.preview
        .mutate(buildInput())
        .then((p) => setPreview(p))
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 600);
    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    };
    // buildInput/valid sind aus denselben Feldern abgeleitet — Felder sind die Wahrheit.
    // livePrice ist bewusst KEINE Dependency: jeder Tick würde sonst das echte
    // Orderbuch neu abfragen; die Platzierung rechnet ohnehin zum Klick-Zeitpunkt.
  }, [symbol, direction, type, amountMode, amountEur, qty, limitPrice, slPct, tpPct, eurUsd]);

  async function place() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await trpc.demo.placeOrder.mutate(buildInput());
      if (r.placed) {
        setSuccess(
          r.status === 'filled'
            ? t('demo.orderFilled', { qty: fmt(r.filledQty, 6), price: fmt(r.avgFillPrice) })
            : r.status === 'partially_filled'
              ? t('demo.orderPartial', { qty: fmt(r.filledQty, 6), rest: fmt(r.restingQty, 6) })
              : t('demo.orderResting'),
        );
        setQty('');
        setAmountEur('');
        onPlaced();
      }
    } catch (err) {
      setError(reasonText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const seg = (active: boolean, tone: 'pos' | 'neg' | 'std' = 'std') => ({
    borderColor: active
      ? tone === 'pos'
        ? 'rgba(61,220,151,0.6)'
        : tone === 'neg'
          ? 'rgba(255,92,108,0.6)'
          : 'rgba(79,209,255,0.6)'
      : 'var(--color-line)',
    color: active
      ? tone === 'pos'
        ? 'var(--color-pos)'
        : tone === 'neg'
          ? 'var(--color-neg)'
          : 'var(--color-cyan)'
      : 'var(--color-mut)',
  });

  return (
    <Panel label={t('demo.ticketTitle')} stagger={5} className="mt-5">
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="label">{t('dashboard.symbol')}</span>
            <AssetSelect value={symbol} onChange={setSymbol} />
          </label>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <span className="label">{t('demo.direction')}</span>
              <div className="mt-1 flex gap-1">
                <button onClick={() => setDirection('long')} className="flex-1 rounded-[0.625rem] border px-3 py-1.5 text-sm" style={seg(direction === 'long', 'pos')}>
                  {t('demo.long')}
                </button>
                <button onClick={() => setDirection('short')} className="flex-1 rounded-[0.625rem] border px-3 py-1.5 text-sm" style={seg(direction === 'short', 'neg')}>
                  {t('demo.short')}
                </button>
              </div>
            </div>
            <div className="flex-1">
              <span className="label">{t('demo.orderType')}</span>
              <div className="mt-1 flex gap-1">
                <button onClick={() => setType('market')} className="flex-1 rounded-[0.625rem] border px-3 py-1.5 text-sm" style={seg(type === 'market')}>
                  Market
                </button>
                <button onClick={() => setType('limit')} className="flex-1 rounded-[0.625rem] border px-3 py-1.5 text-sm" style={seg(type === 'limit')}>
                  Limit
                </button>
              </div>
            </div>
          </div>
          {/* Betrag in € (Standard) oder Stückzahl (Profi-Umschalter) */}
          <div className="flex flex-col gap-1 sm:col-span-2">
            <div className="flex items-center justify-between">
              <span className="label">{t('demo.amount')}</span>
              <div className="flex overflow-hidden rounded-[0.625rem] border text-xs" style={{ borderColor: 'var(--color-line)' }}>
                {(['eur', 'qty'] as const).map((m) => (
                  <button key={m} onClick={() => setAmountMode(m)} className="px-2 py-1" style={seg(amountMode === m)}>
                    {m === 'eur' ? '€' : t('demo.qtyShort')}
                  </button>
                ))}
              </div>
            </div>
            {amountMode === 'eur' ? (
              <>
                <div className="flex items-center gap-2">
                  <input
                    value={amountEur}
                    onChange={(e) => setAmountEur(e.target.value)}
                    inputMode="decimal"
                    placeholder="100"
                    className={inputCls}
                    disabled={eurUsd === null}
                  />
                  <span className="num text-sm" style={{ color: 'var(--color-mut)' }}>€</span>
                  {[50, 100, 500, 1000].map((v) => (
                    <button key={v} onClick={() => setAmountEur(String(v))} className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} disabled={eurUsd === null}>
                      {v}
                    </button>
                  ))}
                </div>
                {eurUsd === null ? (
                  <p className="text-[11px]" style={{ color: 'var(--color-warn)' }}>{t('demo.noEurRate')}</p>
                ) : derivedQty !== null ? (
                  <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    ≈ {fmt(derivedQty, 6)} {symbol.split('/')[0]} · {t('demo.rateUsed', { rate: fmt(eurUsd, 4) })}
                  </p>
                ) : eurAmount > 0 ? (
                  <p className="text-[11px]" style={{ color: 'var(--color-warn)' }}>{t('demo.noLivePrice')}</p>
                ) : null}
              </>
            ) : (
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0.01" className={inputCls} />
            )}
          </div>
          {type === 'limit' && (
            <label className="flex flex-col gap-1">
              <span className="label">{t('demo.limitPrice')}</span>
              <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} inputMode="decimal" className={inputCls} />
            </label>
          )}
          {/* Absicherung in Klartext: „Verkaufe automatisch bei −x %" */}
          <div className="flex flex-col gap-1">
            <span className="label">
              {getUiMode() === 'profi' ? t('demo.stopLossOpt') : t('ticket.protection')}
              <span className="ml-1 cursor-help" title={t('ticket.protectionHint')} style={{ color: 'var(--color-mut)' }}>ⓘ</span>
            </span>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={20} step={0.5} value={slPct} onChange={(e) => setSlPct(Number(e.target.value))} className="w-full" />
              <span className="num w-24 shrink-0 text-right text-xs">
                {slPct > 0 ? `−${slPct.toLocaleString('de-DE')} %` : t('demo.off')}
              </span>
            </div>
            {slPct > 0 && slPrice !== undefined && (
              <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                {t('ticket.protectionText', { pct: slPct.toLocaleString('de-DE') })} (≈ {fmt(slPrice)})
              </p>
            )}
          </div>
          {/* Gewinn sichern: „Verkaufe automatisch bei +x %" */}
          <div className="flex flex-col gap-1">
            <span className="label">
              {getUiMode() === 'profi' ? t('demo.takeProfitOpt') : t('demo.takeProfitSimple')}
              <span className="ml-1 cursor-help" title={t('demo.takeProfitHint')} style={{ color: 'var(--color-mut)' }}>ⓘ</span>
            </span>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={50} step={0.5} value={tpPct} onChange={(e) => setTpPct(Number(e.target.value))} className="w-full" />
              <span className="num w-24 shrink-0 text-right text-xs">
                {tpPct > 0 ? `+${tpPct.toLocaleString('de-DE')} %` : t('demo.off')}
              </span>
            </div>
            {tpPct > 0 && tpPrice !== undefined && (
              <p className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>≈ {fmt(tpPrice)}</p>
            )}
          </div>
        </div>

        {/* Kosten-Vorschau aus dem ECHTEN Buch */}
        <div className="rounded-[0.625rem] border p-4 text-sm" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label">{t('demo.previewTitle')}</p>
          {!valid ? (
            <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('demo.previewHint')}
            </p>
          ) : previewing && !preview ? (
            <Loading />
          ) : preview === null ? (
            <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('demo.previewUnavailable')}
            </p>
          ) : !preview.ok ? (
            <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
              {t(`demo.err_${preview.reason}`)}
            </p>
          ) : (
            <ul className="num mt-3 space-y-1.5">
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('demo.previewFill')}</span>
                <span>{preview.estFillPrice !== null ? fmt(preview.estFillPrice) : '—'}</span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('demo.previewSpread')}</span>
                <span>{preview.spread !== null ? fmt(preview.spread, 4) : '—'}</span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('demo.previewSlippage')}</span>
                <span>{fmt(preview.estSlippage)} $</span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>
                  {t('demo.previewFee')} ({preview.estFeeRole})
                </span>
                <span>{fmt(preview.estFee)} $</span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('demo.previewNotional')}</span>
                <span>{fmt(preview.estNotional)} $</span>
              </li>
              {preview.estRestingQty > 0 && (
                <li className="flex justify-between gap-3">
                  <span style={{ color: 'var(--color-mut)' }}>{t('demo.previewResting')}</span>
                  <span>{fmt(preview.estRestingQty, 6)}</span>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {success && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-pos)' }}>
          {success}
        </p>
      )}
      <button onClick={() => void place()} disabled={busy || !valid} className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-50">
        {busy ? t('common.loading') : t(direction === 'long' ? 'demo.buyNow' : 'demo.sellNow')}
      </button>
    </Panel>
  );
}

function PositionsPanel({ positions, onChanged }: { positions: Position[] | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [protDrafts, setProtDrafts] = useState<Record<string, { sl: string; tp: string }>>({});

  async function close(p: Position) {
    setBusy(p.id);
    setError(null);
    try {
      await trpc.demo.closePosition.mutate({ positionId: p.id });
      onChanged();
    } catch (err) {
      setError(reasonText(t, err));
    } finally {
      setBusy(null);
    }
  }

  async function saveProtection(p: Position) {
    const draft = protDrafts[p.id];
    if (!draft) return;
    setBusy(p.id);
    setError(null);
    try {
      await trpc.demo.setProtection.mutate({
        positionId: p.id,
        stopLoss: draft.sl.trim() === '' ? null : num(draft.sl),
        takeProfit: draft.tp.trim() === '' ? null : num(draft.tp),
      });
      setProtDrafts((d) => {
        const next = { ...d };
        delete next[p.id];
        return next;
      });
      onChanged();
    } catch (err) {
      setError(reasonText(t, err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel label={t('demo.positionsTitle')} stagger={6} className="mt-5">
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {positions === null ? (
        <Loading />
      ) : positions.length === 0 ? (
        <Empty text={t('demo.noPositions')} />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                <th className="py-1.5 pr-3 font-normal" />
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.qty')}</th>
                <th className="py-1.5 pr-3 text-right font-normal">Entry</th>
                <th className="py-1.5 pr-3 text-right font-normal">Mark</th>
                <th className="py-1.5 pr-3 text-right font-normal">uPnL $</th>
                <th className="py-1.5 pr-3 font-normal">SL / TP</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody className="num">
              {positions.map((p) => {
                const draft = protDrafts[p.id] ?? { sl: p.stopLoss?.toString() ?? '', tp: p.takeProfit?.toString() ?? '' };
                const dirty = protDrafts[p.id] !== undefined;
                return (
                  <tr key={p.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">{p.symbol}</td>
                    <td className="py-1.5 pr-3" style={{ color: p.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {p.direction.toUpperCase()}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.qty, 6)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.entryPrice)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(p.markPrice)}</td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: (p.unrealizedPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {fmt(p.unrealizedPnl)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1">
                        <input
                          value={draft.sl}
                          onChange={(e) => setProtDrafts((d) => ({ ...d, [p.id]: { ...draft, sl: e.target.value } }))}
                          placeholder="SL"
                          className="field num w-20 px-1.5 py-1 text-xs"
                        />
                        <input
                          value={draft.tp}
                          onChange={(e) => setProtDrafts((d) => ({ ...d, [p.id]: { ...draft, tp: e.target.value } }))}
                          placeholder="TP"
                          className="field num w-20 px-1.5 py-1 text-xs"
                        />
                        {dirty && (
                          <button onClick={() => void saveProtection(p)} disabled={busy !== null} className="text-xs" style={{ color: 'var(--color-cyan)' }}>
                            {t('common.save')}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() => void close(p)}
                        disabled={busy !== null}
                        className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
                        style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
                      >
                        {busy === p.id ? '…' : t('demo.close')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OrdersPanel({ orders, onChanged }: { orders: OpenOrder[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  async function cancel(id: string) {
    setError(null);
    try {
      await trpc.demo.cancelOrder.mutate({ orderId: id });
      onChanged();
    } catch (err) {
      setError(reasonText(t, err));
    }
  }

  return (
    <Panel label={t('demo.ordersTitle')} stagger={6} className="mt-5">
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {orders.length === 0 ? (
        <Empty text={t('demo.noOrders')} />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                <th className="py-1.5 pr-3 font-normal">Typ</th>
                <th className="py-1.5 pr-3 font-normal" />
                <th className="py-1.5 pr-3 text-right font-normal">Limit</th>
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.filledOf')}</th>
                <th className="py-1.5 pr-3 font-normal">Status</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody className="num">
              {orders.map((o) => (
                <tr key={o.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1.5 pr-3">{o.symbol}</td>
                  <td className="py-1.5 pr-3">{o.type}</td>
                  <td className="py-1.5 pr-3" style={{ color: o.side === 'buy' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {o.side === 'buy' ? t('demo.long') : t('demo.short')}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{o.limitPrice !== null ? fmt(o.limitPrice) : '—'}</td>
                  <td className="py-1.5 pr-3 text-right">
                    {fmt(o.filledQty, 6)} / {fmt(o.qty, 6)}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className="label rounded border px-1.5 py-0.5"
                      style={
                        o.status === 'partially_filled'
                          ? { borderColor: 'rgba(232,184,75,0.5)', color: 'var(--color-warn)' }
                          : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                      }
                    >
                      {t(`demo.status_${o.status}`)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => void cancel(o.id)}
                      className="rounded border px-2 py-0.5 text-xs"
                      style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
                    >
                      {t('demo.cancel')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function HistoryPanel({ history }: { history: Trade[] }) {
  const { t } = useTranslation();
  return (
    <Panel label={t('demo.historyTitle')} stagger={6} className="mt-5">
      {history.length === 0 ? (
        <Empty text={t('demo.noHistory')} />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">Exit</th>
                <th className="py-1.5 pr-3 font-normal">{t('dashboard.symbol')}</th>
                <th className="py-1.5 pr-3 font-normal" />
                <th className="py-1.5 pr-3 text-right font-normal">Entry → Exit</th>
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.qty')}</th>
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.feesCol')}</th>
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.slippageCol')}</th>
                <th className="py-1.5 pr-3 text-right font-normal">{t('demo.netCol')} $</th>
                <th className="py-1.5 pr-3 text-right font-normal">R</th>
                <th className="py-1.5 font-normal">{t('demo.reasonCol')}</th>
              </tr>
            </thead>
            <tbody className="num">
              {history.map((tr) => (
                <tr key={tr.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1.5 pr-3">{new Date(tr.exitTs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="py-1.5 pr-3">{tr.symbol}</td>
                  <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {tr.direction.toUpperCase()}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    {fmt(tr.entryPrice)} → {fmt(tr.exitPrice)}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{fmt(tr.qty, 6)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(tr.fees)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(tr.slippage)}</td>
                  <td className="py-1.5 pr-3 text-right" style={{ color: tr.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {fmt(tr.netPnl)}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{tr.rMultiple !== null ? fmt(tr.rMultiple) : '—'}</td>
                  <td className="py-1.5">
                    <span className="label">{t(`demo.reason_${tr.reason}`)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PerformancePanel({ perf }: { perf: Perf | null }) {
  const { t } = useTranslation();
  return (
    <Panel label={t('demo.perfTitle')} stagger={6} className="mt-5">
      {perf === null ? (
        <Loading />
      ) : !('netPnl' in perf) ? (
        <Empty text={t('demo.noHistory')} />
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label={t('demo.perfTrades')} value={String(perf.trades)} />
            <MetricCard label={t('demo.perfNet')} value={`${fmt(perf.netPnl)} $`} tone={perf.netPnl >= 0 ? 'pos' : 'neg'} />
            <MetricCard label={t('demo.perfWinRate')} value={perf.winRate !== null ? `${(perf.winRate * 100).toFixed(0)} %` : '—'} />
            <MetricCard label={t('demo.perfPF')} value={perf.profitFactor !== null ? fmt(perf.profitFactor) : '—'} />
            <MetricCard label="Sharpe" value={perf.sharpe !== null ? fmt(perf.sharpe) : '—'} />
            <MetricCard label="Sortino" value={perf.sortino !== null ? fmt(perf.sortino) : '—'} />
            <MetricCard label="Max DD" value={`${fmt(perf.maxDrawdownPct)} %`} tone={perf.maxDrawdownPct > 0 ? 'neg' : undefined} />
            <MetricCard label={t('demo.perfExpectancy')} value={perf.expectancyR !== null ? `${fmt(perf.expectancyR)} R` : '—'} />
          </div>
          <div className="mt-5">
            <EquityChart points={perf.equityCurve} emptyText={t('demo.noHistory')} />
          </div>
          <p className="label mt-4">
            {t('demo.perfCosts', {
              fees: fmt(perf.totalFees),
              slippage: fmt(perf.totalSlippage),
              funding: fmt(perf.totalFunding),
            })}
          </p>
          {perf.bySymbol.length > 0 && (
            <ul className="num mt-3 space-y-1 text-sm">
              {perf.bySymbol.map((r) => (
                <li key={r.symbol} className="flex justify-between gap-3">
                  <span style={{ color: 'var(--color-mut)' }}>
                    {r.symbol} ({r.trades})
                  </span>
                  <span style={{ color: r.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(r.netPnl)} $</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
