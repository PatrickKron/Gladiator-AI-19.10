import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { TokenChart } from '../components/TokenChart.js';
import { PositionsOverview } from '../components/PositionsOverview.js';
import { TokenDiscovery } from '../components/TokenDiscovery.js';
import { WatchedWallets } from '../components/WatchedWallets.js';
import { buildAutoOrders, loadAutoOrders, saveAutoOrders, type AutoOrdersSetting } from '../lib/auto-orders.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { avgEntryUsd, bpsLabel, fmtAmount, fmtPct, fmtUsd, initialsPercent, mcapTriggerPrice, parseCompactUsd, pnlPercent, slippageChoices, swapReasonKey } from '../lib/swap-format.js';

/**
 * Wallet-Trading (Vision-Punkt 5, „wie Trojan, für alle Wallets"):
 * Token-Adresse einfügen → echte Token-Infos → Schnellkauf/-verkauf → echte
 * Route (Jupiter/KyberSwap) mit Urteil des Swap-Gates → bestätigen.
 * Paper-Wallets führen zum echten Angebot virtuell aus. Live-Wallets gibt es
 * nur, wenn der Betreiber der Instanz es erlaubt (Selbsthoster).
 */

type Config = Awaited<ReturnType<typeof trpc.swaps.config.query>>;
type Wallet = Awaited<ReturnType<typeof trpc.swaps.wallets.query>>[number];
type Portfolio = Awaited<ReturnType<typeof trpc.swaps.portfolio.query>>;
type TokenInfo = Awaited<ReturnType<typeof trpc.swaps.token.query>>;
type Quote = Awaited<ReturnType<typeof trpc.swaps.quote.query>>;
type Safety = Awaited<ReturnType<typeof trpc.swaps.safety.query>>;
type Order = Awaited<ReturnType<typeof trpc.swaps.orders.query>>[number];
type OrderKind = Order['kind'];
type ChainId = Wallet['chain'];
type Limits = Wallet['limits'];
type SwapReq = { side: 'buy' | 'sell'; amount?: string; percent?: number };

const field = 'field num w-full px-2.5 py-1.5 text-sm';
const chip = 'rounded border px-2.5 py-1 text-xs';

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function WalletTrading() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<Config | null>(null);
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** aus der Positionsübersicht: Token im Ticket öffnen (nonce erzwingt erneutes Öffnen) */
  const [openToken, setOpenToken] = useState<{ token: string; nonce: number } | null>(null);

  const loadWallets = useCallback(async () => {
    try {
      const [c, w] = await Promise.all([trpc.swaps.config.query(), trpc.swaps.wallets.query()]);
      setConfig(c);
      setWallets(w);
      setWalletId((cur) => (cur && w.some((x) => x.id === cur) ? cur : (w[0]?.id ?? null)));
      setError(null);
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }, [t]);

  useEffect(() => {
    void loadWallets();
  }, [loadWallets]);
  const reloadWallets = useCallback(() => void loadWallets(), [loadWallets]);

  const wallet = wallets?.find((w) => w.id === walletId) ?? null;

  return (
    <div>
      <PageHeader title={t('swap.title')} subtitle={t('swap.subtitle')} />
      {error && <ErrorBox message={error} />}
      {!wallets || !config ? (
        !error && <Loading />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWalletId(w.id)}
                className={chip}
                style={{
                  borderColor: w.id === walletId ? 'var(--color-cyan)' : 'var(--color-line)',
                  color: w.id === walletId ? 'var(--color-ink)' : 'var(--color-mut)',
                }}
              >
                {w.label} · {config.chains.find((c) => c.id === w.chain)?.name} · {w.mode === 'paper' ? t('swap.paper') : t('swap.live')}
              </button>
            ))}
            <button type="button" className="btn px-2.5 py-1 text-xs" onClick={() => setCreating((c) => !c)}>
              {t('swap.newPaperWallet')}
            </button>
          </div>

          <PositionsOverview
            version={wallets.length}
            chainName={(id) => config.chains.find((c) => c.id === id)?.name ?? id}
            onOpen={(id, token) => {
              setWalletId(id);
              setOpenToken({ token, nonce: Date.now() });
            }}
          />

          {(creating || wallets.length === 0) && (
            <CreateWallet
              config={config}
              onCreated={async (id) => {
                setCreating(false);
                await loadWallets();
                setWalletId(id);
              }}
            />
          )}

          {wallet && <WalletView key={wallet.id} config={config} wallet={wallet} onWalletChanged={loadWallets} openToken={openToken} />}

          <WatchedWallets
            chains={config.chains.map((c) => ({ id: c.id, name: c.name, kind: c.kind, nativeSymbol: c.native.symbol, explorerTx: c.explorerTx }))}
            paperWallets={wallets.filter((w) => w.mode === 'paper').map((w) => ({ id: w.id, label: w.label, chain: w.chain }))}
            onCopied={reloadWallets}
          />

          <LiveWalletPanel
            config={config}
            onCreated={async (id) => {
              await loadWallets();
              setWalletId(id);
            }}
          />
        </>
      )}
    </div>
  );
}

function CreateWallet({ config, onCreated }: { config: Config; onCreated: (id: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [chain, setChain] = useState<ChainId>('solana');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('10');
  const [profile, setProfile] = useState('standard');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const c = config.chains.find((x) => x.id === chain)!;

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const limits = config.profiles.find((p) => p.id === profile)!.limits;
      const w = await trpc.swaps.createPaperWallet.mutate({ chain, label: label.trim() || `${c.name} Paper`, startAmount: amount.replace(',', '.'), limits });
      await onCreated(w.id);
    } catch (err) {
      setMsg(errText(err, t('common.error')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('swap.createTitle')} className="mb-4">
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('swap.createHint')}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="text-xs">
          {t('swap.chain')}
          <select className={field} value={chain} onChange={(e) => setChain(e.target.value as ChainId)}>
            {config.chains.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          {t('swap.label')}
          <input className={field} value={label} maxLength={40} placeholder={`${c.name} Paper`} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="text-xs">
          {t('swap.startAmount', { symbol: c.native.symbol })}
          <input className={field} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="text-xs">
          {t('swap.profile')}
          <select className={field} value={profile} onChange={(e) => setProfile(e.target.value)}>
            {config.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`swap.profile_${p.id}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className="btn mt-3 px-3 py-1.5 text-sm" disabled={busy} onClick={() => void create()}>
        {busy ? t('common.loading') : t('swap.create')}
      </button>
      {msg && <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>{msg}</p>}
    </Panel>
  );
}

function WalletView({
  config,
  wallet,
  onWalletChanged,
  openToken,
}: {
  config: Config;
  wallet: Wallet;
  onWalletChanged: () => Promise<void>;
  openToken: { token: string; nonce: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const chain = config.chains.find((c) => c.id === wallet.chain)!;
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [safety, setSafety] = useState<Safety | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [slippage, setSlippage] = useState(wallet.slippageBps);
  const [pending, setPending] = useState<SwapReq | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lang = i18n.language;

  const [ordersVersion, setOrdersVersion] = useState(0);
  const [auto, setAuto] = useState<AutoOrdersSetting>(() => loadAutoOrders(wallet.id));
  const changeAuto = (next: AutoOrdersSetting) => {
    setAuto(next);
    saveAutoOrders(wallet.id, next);
  };
  const autoBuilt = buildAutoOrders(auto);
  const ticketRef = useRef<HTMLDivElement>(null);

  const loadPortfolio = useCallback(async () => {
    try {
      setPortfolio(await trpc.swaps.portfolio.query({ walletId: wallet.id }));
      setPfError(null);
    } catch (err) {
      setPfError(errText(err, t('common.error')));
    }
  }, [wallet.id, t]);

  useEffect(() => {
    void loadPortfolio();
  }, [loadPortfolio]);

  // Token aus der Positionsübersicht öffnen (auch nach Wallet-Wechsel: Komponente ist neu gemountet);
  // nur der Nonce zählt — jeder Klick öffnet genau einmal
  const openNonce = openToken?.nonce;
  useEffect(() => {
    if (!openToken) return;
    void lookup(openToken.token);
    ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openNonce]);

  async function lookup(addr: string) {
    const a = addr.trim();
    setAddress(a);
    setToken(null);
    setSafety(null);
    setQuote(null);
    setPending(null);
    setTokenError(null);
    if (!a) return;
    try {
      // Sicherheitscheck parallel — die Token-Infos warten nicht darauf
      void trpc.swaps.safety
        .query({ chain: wallet.chain, address: a })
        .then(setSafety)
        .catch(() => setSafety(null));
      setToken(await trpc.swaps.token.query({ chain: wallet.chain, address: a }));
    } catch (err) {
      setTokenError(errText(err, t('common.error')));
    }
  }

  async function requestQuote(req: SwapReq) {
    if (!token) return;
    setPending(req);
    setQuote(null);
    setMsg(null);
    setBusy(true);
    try {
      setQuote(await trpc.swaps.quote.query({ walletId: wallet.id, token: token.address, slippageBps: slippage, ...req }));
    } catch (err) {
      setMsg({ ok: false, text: errText(err, t('common.error')) });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!token || !pending) return;
    setBusy(true);
    try {
      const r = await trpc.swaps.execute.mutate({
        walletId: wallet.id,
        token: token.address,
        slippageBps: slippage,
        ...pending,
        ...(wallet.mode === 'live' ? { confirmLive: true } : {}),
        ...(pending.side === 'buy' && autoBuilt.value ? { autoOrders: autoBuilt.value } : {}),
      });
      const q = r.quote;
      const autoText = r.autoOrders
        .map((o) => (o.error ? `${t(`swap.kind_${o.kind}`)}: ${o.error}` : `${t(`swap.kind_${o.kind}`)} @ ${fmtUsd(o.triggerPriceUsd, lang)}`))
        .join(' · ');
      setMsg({
        ok: true,
        text:
          t('swap.done', { inAmount: fmtAmount(q.inAmount, lang), inSymbol: q.inSymbol, outAmount: fmtAmount(q.outAmount, lang), outSymbol: q.outSymbol }) +
          (r.trade.txHash ? ` · Tx ${r.trade.txHash.slice(0, 10)}…` : '') +
          (autoText ? ` · ${autoText}` : ''),
      });
      if (r.autoOrders.length > 0) setOrdersVersion((v) => v + 1);
      setQuote(null);
      setPending(null);
      await loadPortfolio();
    } catch (err) {
      setMsg({ ok: false, text: errText(err, t('common.error')) });
    } finally {
      setBusy(false);
    }
  }

  const held = portfolio?.holdings.find((h) => token && h.token === token.address) ?? null;
  const initials = held ? initialsPercent(held.costUsd, held.valueUsd) : null;
  const nativeHolding = portfolio?.holdings.find((h) => h.native) ?? null;

  return (
    <>
    <WalletBar wallet={wallet} explorerTx={chain.explorerTx} chainOk={portfolio?.chainOk ?? null} onChanged={onWalletChanged} />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
      <div ref={ticketRef}>
      <Panel label={t('swap.ticket')}>
        <label className="mt-3 block text-xs">
          {t('swap.tokenAddress', { chain: chain.name })}
          <input
            className={`${field} font-mono`}
            value={address}
            placeholder={chain.kind === 'solana' ? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' : '0x…'}
            onChange={(e) => setAddress(e.target.value)}
            onPaste={(e) => {
              const v = e.clipboardData.getData('text');
              e.preventDefault();
              void lookup(v);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void lookup(address)}
            onBlur={() => address.trim() && address.trim() !== token?.address && void lookup(address)}
          />
        </label>
        {tokenError && <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>{tokenError}</p>}

        {token && (
          <div className="mt-3 rounded border p-3" style={{ borderColor: 'var(--color-line)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {token.imageUrl && <img src={token.imageUrl} alt="" width={24} height={24} className="rounded-full" />}
                <span className="font-semibold">{token.symbol}</span>
                <span className="text-xs" style={{ color: 'var(--color-mut)' }}>{token.name}</span>
              </div>
              {token.pairUrl && (
                <a href={token.pairUrl} target="_blank" rel="noreferrer noopener" className="text-xs" style={{ color: 'var(--color-cyan)' }}>
                  DexScreener ↗
                </a>
              )}
            </div>
            <dl className="num mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <Stat label={t('swap.price')} value={token.priceUsd === null ? '—' : fmtUsd(token.priceUsd, lang)} />
              <Stat label={t('swap.liquidity')} value={token.liquidityUsd === null ? '—' : fmtUsd(token.liquidityUsd, lang, true)} />
              <Stat label={t('swap.mcap')} value={token.marketCapUsd === null ? '—' : fmtUsd(token.marketCapUsd, lang, true)} />
              <Stat label={t('swap.volume24h')} value={token.volume24hUsd === null ? '—' : fmtUsd(token.volume24hUsd, lang, true)} />
              <Stat
                label={t('swap.change24h')}
                value={token.change24hPct === null ? '—' : `${token.change24hPct > 0 ? '+' : ''}${fmtPct(token.change24hPct, lang)}`}
                color={token.change24hPct === null ? undefined : token.change24hPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
              />
              <Stat label={t('swap.pairAge')} value={token.pairCreatedAt ? new Date(token.pairCreatedAt).toLocaleDateString(lang) : '—'} />
            </dl>
            <SafetyBadges safety={safety} />
            {token.pairAddress && <TokenChart key={token.pairAddress} chain={wallet.chain} pool={token.pairAddress} />}

            <p className="label mt-4">{t('swap.buyWith', { symbol: chain.native.symbol })}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {chain.quickBuy.map((a) => (
                <button key={a} type="button" className={chip} style={{ borderColor: 'var(--color-pos)' }} disabled={busy} onClick={() => void requestQuote({ side: 'buy', amount: String(a) })}>
                  {fmtAmount(String(a), lang)} {chain.native.symbol}
                </button>
              ))}
              <input className="field num w-24 px-2 py-1 text-xs" value={customAmount} inputMode="decimal" placeholder={t('swap.custom')} onChange={(e) => setCustomAmount(e.target.value)} />
              <button
                type="button"
                className={chip}
                style={{ borderColor: 'var(--color-pos)' }}
                disabled={busy || !/^\d+([.,]\d+)?$/.test(customAmount)}
                onClick={() => void requestQuote({ side: 'buy', amount: customAmount.replace(',', '.') })}
              >
                {t('swap.buy')}
              </button>
            </div>
            {nativeHolding && (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                {t('swap.available', { amount: fmtAmount(nativeHolding.amount, lang), symbol: chain.native.symbol })}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1.5" title={t('swap.autoHint')}>
                <input type="checkbox" checked={auto.enabled} onChange={(e) => changeAuto({ ...auto, enabled: e.target.checked })} />
                {t('swap.autoTpSl')}
              </label>
              {auto.enabled && (
                <>
                  <label className="flex items-center gap-1">
                    TP +
                    <input className="field num w-14 px-1.5 py-0.5 text-[11px]" inputMode="decimal" value={auto.takeProfitPct} onChange={(e) => changeAuto({ ...auto, takeProfitPct: e.target.value })} />%
                  </label>
                  <label className="flex items-center gap-1">
                    SL −
                    <input className="field num w-14 px-1.5 py-0.5 text-[11px]" inputMode="decimal" value={auto.stopLossPct} onChange={(e) => changeAuto({ ...auto, stopLossPct: e.target.value })} />%
                  </label>
                  {autoBuilt.error && <span style={{ color: 'var(--color-warn)' }}>{t('swap.autoInvalid')}</span>}
                </>
              )}
            </div>

            <p className="label mt-3">{t('swap.sell')}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {[25, 50, 100].map((p) => (
                <button key={p} type="button" className={chip} style={{ borderColor: 'var(--color-neg)' }} disabled={busy || !held} onClick={() => void requestQuote({ side: 'sell', percent: p })}>
                  {p} %
                </button>
              ))}
              {initials !== null && (
                <button
                  type="button"
                  className={chip}
                  style={{ borderColor: 'var(--color-pos)' }}
                  title={t('swap.initialsHint')}
                  disabled={busy}
                  onClick={() => void requestQuote({ side: 'sell', percent: initials })}
                >
                  {t('swap.initials', { pct: fmtPct(initials, lang) })}
                </button>
              )}
              {!held && <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('swap.noHolding')}</span>}
            </div>

            <p className="label mt-3">{t('swap.slippage')}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {slippageChoices(wallet.limits.maxSlippageBps).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={chip}
                  style={{ borderColor: b === slippage ? 'var(--color-cyan)' : 'var(--color-line)', color: b === slippage ? 'var(--color-ink)' : 'var(--color-mut)' }}
                  onClick={() => {
                    setSlippage(b);
                    setQuote(null);
                    setPending(null);
                  }}
                >
                  {bpsLabel(b, lang)}
                </button>
              ))}
            </div>
          </div>
        )}

        {busy && !quote && <Loading />}
        {quote && (
          <div className="mt-3 rounded border p-3 text-sm" style={{ borderColor: quote.verdict.allowed ? 'var(--color-line)' : 'var(--color-neg)' }}>
            <p className="label">{t('swap.preview')}</p>
            <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <Stat label={t('swap.youPay')} value={`${fmtAmount(quote.inAmount, lang)} ${quote.inSymbol}`} />
              <Stat label={t('swap.youGet')} value={`${fmtAmount(quote.outAmount, lang)} ${quote.outSymbol}`} />
              <Stat label={t('swap.minReceived')} value={`${fmtAmount(quote.minOut, lang)} ${quote.outSymbol}`} />
              <Stat label={t('swap.value')} value={fmtUsd(quote.valueUsd, lang)} />
              <Stat label={t('swap.priceImpact')} value={quote.priceImpactPct === null ? '—' : fmtPct(quote.priceImpactPct, lang)} />
              <Stat label={t('swap.networkFee')} value={quote.networkFeeUsd === null ? '—' : fmtUsd(quote.networkFeeUsd, lang)} />
              <Stat label={t('swap.route')} value={`${quote.route.join(' → ') || '—'} (${quote.aggregator})`} />
              <Stat label={t('swap.slippage')} value={bpsLabel(quote.slippageBps, lang)} />
            </dl>
            {quote.safety && !quote.safety.checked && (
              <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>{t('swap.safety_unchecked')}</p>
            )}
            {!quote.verdict.allowed && (
              <ul className="mt-2 space-y-0.5 text-xs" style={{ color: 'var(--color-neg)' }}>
                {quote.verdict.reasons.map((r) => (
                  <li key={r}>• {t(swapReasonKey(r))}</li>
                ))}
              </ul>
            )}
            {pending?.side === 'buy' && autoBuilt.value && (
              <p className="mt-2 text-[11px]" style={{ color: wallet.mode === 'live' ? 'var(--color-warn)' : 'var(--color-mut)' }}>
                {t(wallet.mode === 'live' ? 'swap.autoLiveNote' : 'swap.autoNote', {
                  tp: autoBuilt.value.takeProfitPct !== undefined ? `+${autoBuilt.value.takeProfitPct} %` : '—',
                  sl: autoBuilt.value.stopLossPct !== undefined ? `−${autoBuilt.value.stopLossPct} %` : '—',
                })}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="btn px-3 py-1.5 text-sm"
                style={wallet.mode === 'live' ? { borderColor: 'var(--color-warn)' } : undefined}
                disabled={busy || !quote.verdict.allowed || (pending?.side === 'buy' && autoBuilt.error) || (wallet.mode === 'live' && !wallet.liveApproved)}
                onClick={() => void confirm()}
              >
                {wallet.mode === 'paper' ? t('swap.confirmPaper') : t('swap.confirmLive')}
              </button>
              <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} disabled={busy} onClick={() => pending && void requestQuote(pending)}>
                {t('swap.refresh')}
              </button>
            </div>
          </div>
        )}
        {msg && <p className="mt-2 text-xs" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>{msg.text}</p>}
        {token && token.priceUsd !== null && (
          <OrderForm
            wallet={wallet}
            token={token}
            nativeSymbol={chain.native.symbol}
            held={held !== null}
            slippageBps={slippage}
            onCreated={() => setOrdersVersion((v) => v + 1)}
          />
        )}
      </Panel>
      </div>
      <TokenDiscovery
        chain={wallet.chain}
        onPick={(a) => {
          void lookup(a);
          ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />
      </div>

      <div className="space-y-4">
        <Panel label={t('swap.holdings')} stagger={2}>
          {pfError && <ErrorBox message={pfError} />}
          {!portfolio ? (
            !pfError && <Loading />
          ) : (
            <>
              <div className="num mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                <span>
                  {t('swap.total')}: <b style={{ color: 'var(--color-ink)' }}>{portfolio.totalValueUsd === null ? '—' : fmtUsd(portfolio.totalValueUsd, lang)}</b>
                </span>
                <span>
                  {t('swap.realized')}:{' '}
                  <b style={{ color: portfolio.realizedPnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmtUsd(portfolio.realizedPnlUsd, lang)}</b>
                </span>
                {!portfolio.pricesOk && <span style={{ color: 'var(--color-warn)' }}>{t('swap.pricesUnavailable')}</span>}
              </div>
              <table className="num mt-3 w-full text-xs">
                <thead style={{ color: 'var(--color-mut)' }}>
                  <tr>
                    <th className="text-left font-normal">{t('swap.token')}</th>
                    <th className="text-right font-normal">{t('swap.amount')}</th>
                    <th className="text-right font-normal">{t('swap.value')}</th>
                    <th className="text-right font-normal">{t('swap.pnl')}</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.holdings.map((h) => {
                    const pct = h.native ? null : pnlPercent(h.pnlUsd, h.costUsd);
                    const entry = h.native ? null : avgEntryUsd(h.costUsd, h.amount);
                    return (
                    <tr key={h.token} className="border-t" style={{ borderColor: 'var(--color-line)' }}>
                      <td className="py-1.5">
                        {h.native ? (
                          h.symbol
                        ) : (
                          <button type="button" className="underline decoration-dotted" onClick={() => void lookup(h.token)} title={h.token}>
                            {h.symbol}
                          </button>
                        )}
                      </td>
                      <td className="text-right">
                        {fmtAmount(h.amount, lang)}
                        {entry !== null && (
                          <span className="block text-[10px]" style={{ color: 'var(--color-mut)' }} title={t('swap.avgEntryHint')}>
                            Ø {fmtUsd(entry, lang)}
                          </span>
                        )}
                      </td>
                      <td className="text-right">{h.valueUsd === null ? '—' : fmtUsd(h.valueUsd, lang)}</td>
                      <td className="text-right" style={{ color: h.pnlUsd === null ? undefined : h.pnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {h.pnlUsd === null ? '—' : fmtUsd(h.pnlUsd, lang)}
                        {pct !== null && <span className="block text-[10px]">{`${pct > 0 ? '+' : ''}${fmtPct(pct, lang)}`}</span>}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <OrdersPanel walletId={wallet.id} version={ordersVersion} onChanged={() => void loadPortfolio()} />

        <Panel label={t('swap.history')} stagger={3}>
          {portfolio && portfolio.trades.length === 0 && <Empty text={t('swap.noTrades')} />}
          <ul className="mt-2 space-y-1 text-xs">
            {portfolio?.trades.map((tr) => (
              <li key={tr.id} className="num flex flex-wrap justify-between gap-2 border-t pt-1" style={{ borderColor: 'var(--color-line)' }}>
                <span>
                  <span style={{ color: tr.side === 'buy' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{tr.side === 'buy' ? t('swap.buy') : t('swap.sell')}</span>{' '}
                  {fmtAmount(tr.inAmount, lang)} {tr.inSymbol} → {fmtAmount(tr.outAmount, lang)} {tr.outSymbol}
                  {tr.status !== 'filled' && (
                    <b className="ml-1.5" style={{ color: tr.status === 'failed' ? 'var(--color-neg)' : 'var(--color-warn)' }}>
                      {t(`swap.trade_${tr.status}`)}
                    </b>
                  )}
                </span>
                <span style={{ color: 'var(--color-mut)' }}>
                  {tr.realizedPnlUsd !== null && (
                    <b style={{ color: tr.realizedPnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmtUsd(tr.realizedPnlUsd, lang)} · </b>
                  )}
                  {tr.txHash ? (
                    <a href={`${chain.explorerTx}${tr.txHash}`} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--color-cyan)' }}>
                      tx ↗
                    </a>
                  ) : (
                    t('swap.paper')
                  )}{' '}
                  · {new Date(tr.createdAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <LimitsPanel config={config} wallet={wallet} onSaved={onWalletChanged} />
      </div>
    </div>
    </>
  );
}

/** Kopfzeile der gewählten Wallet: Adresse, Live-Freigabe, Entfernen. */
function WalletBar({ wallet, explorerTx, chainOk, onChanged }: { wallet: Wallet; explorerTx: string; chainOk: boolean | null; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const [word, setWord] = useState('');
  const [backedUp, setBackedUp] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const explorer = explorerTx.replace(/\/tx\/$/, wallet.chain === 'solana' ? '/account/' : '/address/');

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setMsg(errText(err, t('common.error')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass mb-4 flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
      {wallet.mode === 'live' && wallet.address ? (
        <>
          <span style={{ color: 'var(--color-mut)' }}>{t('swap.address')}</span>
          <a className="num" href={`${explorer}${wallet.address}`} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--color-cyan)' }}>
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-6)} ↗
          </a>
          <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} onClick={() => void navigator.clipboard?.writeText(wallet.address!)}>
            {t('swap.copy')}
          </button>
          {chainOk === false && <span style={{ color: 'var(--color-warn)' }}>{t('swap.chainUnavailable')}</span>}
          {wallet.liveApproved ? (
            <>
              <span style={{ color: 'var(--color-warn)' }}>● {t('swap.liveActive')}</span>
              <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} disabled={busy} onClick={() => void run(() => trpc.swaps.revokeLive.mutate({ walletId: wallet.id }))}>
                {t('swap.revoke')}
              </button>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--color-mut)' }}>{t('swap.approveHint')}</span>
              <input className="field num w-28 px-2 py-1 text-xs" value={word} placeholder="FREIGEBEN" onChange={(e) => setWord(e.target.value)} />
              <button
                type="button"
                className={chip}
                style={{ borderColor: 'var(--color-warn)' }}
                disabled={busy || word !== 'FREIGEBEN'}
                onClick={() => void run(() => trpc.swaps.approveLive.mutate({ walletId: wallet.id, confirm: 'FREIGEBEN' }))}
              >
                {t('swap.approve')}
              </button>
            </>
          )}
        </>
      ) : (
        <span style={{ color: 'var(--color-mut)' }}>{t('swap.paperHint')}</span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {removeArmed ? (
          <>
            {wallet.mode === 'live' && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
                {t('swap.keyBackedUp')}
              </label>
            )}
            <button
              type="button"
              className={chip}
              style={{ borderColor: 'var(--color-neg)', color: 'var(--color-neg)' }}
              disabled={busy || (wallet.mode === 'live' && !backedUp)}
              onClick={() => void run(() => trpc.swaps.archiveWallet.mutate({ walletId: wallet.id, confirmKeyBackedUp: wallet.mode === 'live' ? backedUp : undefined }))}
            >
              {t('swap.removeConfirm')}
            </button>
            <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} onClick={() => setRemoveArmed(false)}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button type="button" className={chip} style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} onClick={() => setRemoveArmed(true)}>
            {t('swap.remove')}
          </button>
        )}
      </span>
      {msg && <p className="w-full" style={{ color: 'var(--color-neg)' }}>{msg}</p>}
    </div>
  );
}

/**
 * Eigene Trading-Wallet anlegen (nur wenn der Betreiber es erlaubt): neu erzeugen
 * (empfohlen) oder importieren. Ein erzeugter Schlüssel erscheint GENAU EINMAL.
 */
function LiveWalletPanel({ config, onCreated }: { config: Config; onCreated: (id: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [chain, setChain] = useState<ChainId>('solana');
  const [label, setLabel] = useState('');
  const [source, setSource] = useState<'generate' | 'import'>('generate');
  const [secret, setSecret] = useState('');
  const [profile, setProfile] = useState('standard');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; address: string; secret: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const c = config.chains.find((x) => x.id === chain)!;

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const limits = config.profiles.find((p) => p.id === profile)!.limits;
      const r = await trpc.swaps.createLiveWallet.mutate({
        chain,
        label: label.trim() || `${c.name} Trading`,
        source,
        secret: source === 'import' ? secret.trim() : undefined,
        limits,
      });
      setSecret('');
      if (r.secretOnce) setShown({ id: r.wallet.id, address: r.wallet.address!, secret: r.secretOnce });
      else await onCreated(r.wallet.id);
    } catch (err) {
      setMsg(errText(err, t('common.error')));
    } finally {
      setBusy(false);
    }
  }

  if (!config.liveKeysAllowed) {
    return (
      <Panel label={t('swap.liveTitle')} className="mt-4">
        <p className="mt-2 text-sm" style={{ color: 'var(--color-mut)' }}>{t('swap.liveNotAllowed')}</p>
      </Panel>
    );
  }

  if (shown) {
    return (
      <Panel label={t('swap.secretTitle')} className="mt-4">
        <p className="mt-2 text-sm" style={{ color: 'var(--color-warn)' }}>{t('swap.secretWarn')}</p>
        <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.address')}</p>
        <p className="num break-all text-sm">{shown.address}</p>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.secretKey')}</p>
        <p className="num break-all rounded border p-2 text-sm" style={{ borderColor: 'var(--color-warn)' }}>{shown.secret}</p>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.fundHint', { symbol: c.native.symbol })}</p>
        <label className="mt-3 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t('swap.secretSaved')}
        </label>
        <button
          type="button"
          className="btn mt-3 px-3 py-1.5 text-sm"
          disabled={!saved}
          onClick={() => {
            const id = shown.id;
            setShown(null);
            setSaved(false);
            void onCreated(id);
          }}
        >
          {t('swap.done_close')}
        </button>
      </Panel>
    );
  }

  return (
    <Panel label={t('swap.liveTitle')} className="mt-4">
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.liveIntro')}</p>
      <div className="mt-3 flex gap-1.5">
        {(['generate', 'import'] as const).map((src) => (
          <button
            key={src}
            type="button"
            className={chip}
            style={{ borderColor: source === src ? 'var(--color-cyan)' : 'var(--color-line)', color: source === src ? 'var(--color-ink)' : 'var(--color-mut)' }}
            onClick={() => setSource(src)}
          >
            {t(`swap.source_${src}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-xs">
          {t('swap.chain')}
          <select className={field} value={chain} onChange={(e) => setChain(e.target.value as ChainId)}>
            {config.chains.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          {t('swap.label')}
          <input className={field} value={label} maxLength={40} placeholder={`${c.name} Trading`} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="text-xs">
          {t('swap.profile')}
          <select className={field} value={profile} onChange={(e) => setProfile(e.target.value)}>
            {config.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`swap.profile_${p.id}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {source === 'import' && (
        <label className="mt-3 block text-xs">
          {t('swap.importKey')}
          <input className={`${field} font-mono`} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <span className="mt-1 block" style={{ color: 'var(--color-warn)' }}>{t('swap.importWarn')}</span>
        </label>
      )}
      <button type="button" className="btn mt-3 px-3 py-1.5 text-sm" disabled={busy || (source === 'import' && secret.trim().length < 32)} onClick={() => void create()}>
        {busy ? t('common.loading') : source === 'generate' ? t('swap.generate') : t('swap.import')}
      </button>
      {msg && <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>{msg}</p>}
    </Panel>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt style={{ color: 'var(--color-mut)' }}>{label}</dt>
      <dd className="text-right" style={{ color: color ?? 'var(--color-ink)' }}>
        {value}
      </dd>
    </div>
  );
}

const LIMIT_KEYS = ['maxTradeUsd', 'maxSlippageBps', 'maxPriceImpactPct', 'minLiquidityUsd', 'maxTokenTaxPct'] as const;

/** Ergebnis des Sicherheitschecks: schwere Befunde rot (Kauf gesperrt), Warnungen gelb, sonst grün. */
function SafetyBadges({ safety }: { safety: Safety | null }) {
  const { t, i18n } = useTranslation();
  if (!safety) return <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('swap.safety_loading')}</p>;
  if (!safety.checked) {
    return (
      <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }} title={safety.error ?? undefined}>
        {t('swap.safety_unchecked')}
      </p>
    );
  }
  if (safety.source === 'native') return null;
  const badge = (key: string, color: string) => (
    <span key={key} className="rounded border px-1.5 py-0.5" style={{ borderColor: color, color }}>
      {t(`swap.flag_${key}`)}
    </span>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span style={{ color: 'var(--color-mut)' }}>{t('swap.safety')}:</span>
      {safety.severe.length === 0 && safety.warnings.length === 0 && badge('ok', 'var(--color-pos)')}
      {safety.severe.map((f) => badge(f, 'var(--color-neg)'))}
      {safety.warnings.filter((f) => !['top10_concentrated', 'lp_unlocked', 'creator_holds'].includes(f)).map((f) => badge(f, 'var(--color-warn)'))}
      {safety.top10Pct != null && (
        // Top-10-Wallets (ohne Pools/Locks): gelb ab der Warnschwelle, sonst nur zur Info
        <span
          className="rounded border px-1.5 py-0.5"
          style={{
            borderColor: safety.warnings.includes('top10_concentrated') ? 'var(--color-warn)' : 'var(--color-line)',
            color: safety.warnings.includes('top10_concentrated') ? 'var(--color-warn)' : 'var(--color-mut)',
          }}
          title={t('swap.top10Hint')}
        >
          {t('swap.top10', { pct: fmtPct(safety.top10Pct, i18n.language) })}
        </span>
      )}
      {safety.lpLockedPct != null && (
        // Pool-Anteile gesperrt/verbrannt: gelb unter der Warnschwelle, sonst nur zur Info
        <span
          className="rounded border px-1.5 py-0.5"
          style={{
            borderColor: safety.warnings.includes('lp_unlocked') ? 'var(--color-warn)' : 'var(--color-line)',
            color: safety.warnings.includes('lp_unlocked') ? 'var(--color-warn)' : 'var(--color-mut)',
          }}
          title={t('swap.lpLockedHint')}
        >
          {t('swap.lpLocked', { pct: fmtPct(safety.lpLockedPct, i18n.language) })}
        </span>
      )}
      {safety.creatorPct != null && (
        // Ersteller-Wallet hält noch: gelb über der Warnschwelle, sonst nur zur Info
        <span
          className="rounded border px-1.5 py-0.5"
          style={{
            borderColor: safety.warnings.includes('creator_holds') ? 'var(--color-warn)' : 'var(--color-line)',
            color: safety.warnings.includes('creator_holds') ? 'var(--color-warn)' : 'var(--color-mut)',
          }}
          title={t('swap.creatorHint')}
        >
          {t('swap.creator', { pct: fmtPct(safety.creatorPct, i18n.language) })}
        </span>
      )}
      {safety.taxPct !== null && safety.taxPct > 0 && (
        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}>
          {t('swap.tax', { pct: fmtPct(safety.taxPct, i18n.language) })}
        </span>
      )}
    </div>
  );
}

function LimitsPanel({ config, wallet, onSaved }: { config: Config; wallet: Wallet; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Record<keyof Limits, string>>(() => ({
    maxTradeUsd: String(wallet.limits.maxTradeUsd),
    maxSlippageBps: String(wallet.limits.maxSlippageBps),
    maxPriceImpactPct: String(wallet.limits.maxPriceImpactPct),
    minLiquidityUsd: String(wallet.limits.minLiquidityUsd),
    maxTokenTaxPct: String(wallet.limits.maxTokenTaxPct),
  }));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function applyProfile(limits: Limits) {
    setForm({
      maxTradeUsd: String(limits.maxTradeUsd),
      maxSlippageBps: String(limits.maxSlippageBps),
      maxPriceImpactPct: String(limits.maxPriceImpactPct),
      minLiquidityUsd: String(limits.minLiquidityUsd),
      maxTokenTaxPct: String(limits.maxTokenTaxPct),
    });
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(form[k].replace(',', '.'))])) as Limits;
      await trpc.swaps.updateWallet.mutate({ walletId: wallet.id, limits, slippageBps: Math.min(wallet.slippageBps, limits.maxSlippageBps) });
      await onSaved();
      setMsg({ ok: true, text: t('swap.limitsSaved') });
    } catch (err) {
      setMsg({ ok: false, text: errText(err, t('common.error')) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('swap.limits')} stagger={4}>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('swap.limitsHint')}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {config.profiles.map((p) => (
          <button key={p.id} type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} onClick={() => applyProfile(p.limits)}>
            {t(`swap.profile_${p.id}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {LIMIT_KEYS.map((k) => (
          <label key={k} className="text-xs">
            {t(`swap.limit_${k}`)}
            <input
              className={field}
              value={form[k]}
              inputMode="decimal"
              title={`${config.bounds[k].min} – ${config.bounds[k].max}`}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <button type="button" className="btn mt-3 px-3 py-1.5 text-sm" disabled={busy} onClick={() => void save()}>
        {t('swap.saveLimits')}
      </button>
      {msg && <p className="mt-2 text-xs" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>{msg.text}</p>}
    </Panel>
  );
}

const ORDER_KINDS: OrderKind[] = ['take_profit', 'stop_loss', 'trailing_stop', 'rug_guard', 'dev_sell', 'limit_buy', 'dca', 'alert_above', 'alert_below'];
/** DCA-Abstände in Minuten */
const DCA_INTERVALS = [15, 60, 240, 720, 1440, 10_080];

/**
 * Limit-Order / Auto-Sell zum gewählten Token anlegen. Ziel als Abstand zum
 * aktuellen Preis (+50 % = Take-Profit bei 1,5 × Kurs); der Worker prüft jede Minute.
 */
function OrderForm({
  wallet,
  token,
  nativeSymbol,
  held,
  slippageBps,
  onCreated,
}: {
  wallet: Wallet;
  token: TokenInfo;
  nativeSymbol: string;
  held: boolean;
  slippageBps: number;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [kind, setKind] = useState<OrderKind>('take_profit');
  const [offset, setOffset] = useState('50');
  const [sellPercent, setSellPercent] = useState(100);
  const [buyAmount, setBuyAmount] = useState('0.1');
  const [confirmLive, setConfirmLive] = useState(false);
  const [interval, setIntervalMin] = useState(240);
  const [runs, setRuns] = useState('6');
  const [capPct, setCapPct] = useState('');
  // Ziel als Abstand in % oder als Marktkapitalisierung („verkaufe bei 10M MC“)
  const [targetBy, setTargetBy] = useState<'pct' | 'mcap'>('pct');
  const [mcapInput, setMcapInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const price = token.priceUsd!;
  const dca = kind === 'dca';
  const alert = kind === 'alert_above' || kind === 'alert_below';
  const runsN = Number(runs);
  const cap = capPct.trim() === '' ? null : price * (1 + Number(capPct.replace(',', '.')) / 100);
  const amountN = Number(buyAmount.replace(',', '.'));
  const off = Number(offset.replace(',', '.'));
  const sign = kind === 'take_profit' || kind === 'alert_above' ? 1 : -1;
  const mcapNow = token.marketCapUsd !== null && token.marketCapUsd > 0 ? token.marketCapUsd : null;
  // Rug-Schutz: Verkauf, wenn die Pool-Liquidität um X % unter ihr Hoch fällt (kein Kursziel)
  const rug = kind === 'rug_guard';
  const liqNow = token.liquidityUsd !== null && token.liquidityUsd > 0 ? token.liquidityUsd : null;
  // Dev-Verkauf-Schutz (nur EVM): Verkauf, wenn die Ersteller-Wallet X % ihres Bestands abgibt
  const devSell = kind === 'dev_sell';
  const mcapPossible = mcapNow !== null && !dca && !rug && !devSell && kind !== 'trailing_stop';
  const byMcap = mcapPossible && targetBy === 'mcap';
  const mcapTarget = byMcap ? parseCompactUsd(mcapInput) : null;
  // Ziel-MC muss auf der richtigen Seite liegen (Take-Profit/Alarm über: darüber, sonst darunter)
  const mcapSideOk = mcapTarget !== null && mcapNow !== null && (sign === 1 ? mcapTarget > mcapNow : mcapTarget < mcapNow);
  const trigger =
    kind === 'trailing_stop' || rug || devSell ? null : byMcap ? (mcapTarget !== null && mcapNow !== null ? mcapTriggerPrice(price, mcapNow, mcapTarget) : null) : price * (1 + (sign * off) / 100);
  const needsHolding = kind !== 'limit_buy' && !dca && !alert;
  const valid = dca
    ? amountN > 0 && Number.isInteger(runsN) && runsN >= 2 && runsN <= 500 && (cap === null || (Number.isFinite(cap) && cap > 0))
    : rug
      ? Number.isFinite(off) && off >= 10 && off <= 90 && liqNow !== null && held
      : devSell
      ? Number.isFinite(off) && off >= 10 && off <= 100 && held
      : byMcap
      ? trigger !== null && mcapSideOk && (!needsHolding || held)
      : Number.isFinite(off) && off > 0 && (sign === 1 || off < 100) && (!needsHolding || held);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      await trpc.swaps.createOrder.mutate({
        walletId: wallet.id,
        token: token.address,
        kind,
        triggerPriceUsd: dca ? undefined : (trigger ?? undefined),
        trailPct: kind === 'trailing_stop' || rug || devSell ? off : undefined,
        sellPercent: needsHolding ? sellPercent : undefined,
        buyAmount: kind === 'limit_buy' || dca ? buyAmount.replace(',', '.') : undefined,
        intervalMinutes: dca ? interval : undefined,
        runsTotal: dca ? runsN : undefined,
        maxPriceUsd: dca && cap !== null ? cap : undefined,
        slippageBps,
        confirmLive: wallet.mode === 'live' && !alert ? confirmLive : undefined,
      });
      setMsg({ ok: true, text: t('swap.orderCreated') });
      onCreated();
    } catch (err) {
      setMsg({ ok: false, text: errText(err, t('common.error')) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <p className="label">{t('swap.ordersTitle')}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ORDER_KINDS.filter((k) => k !== 'dev_sell' || wallet.chain !== 'solana').map((k) => (
          <button
            key={k}
            type="button"
            className={chip}
            style={{ borderColor: k === kind ? 'var(--color-cyan)' : 'var(--color-line)', color: k === kind ? 'var(--color-ink)' : 'var(--color-mut)' }}
            onClick={() => {
              setKind(k);
              setOffset(k === 'take_profit' || k === 'alert_above' || k === 'rug_guard' || k === 'dev_sell' ? '50' : k === 'trailing_stop' ? '15' : '20');
              setMsg(null);
            }}
          >
            {t(`swap.kind_${k}`)}
          </button>
        ))}
      </div>
      {dca ? (
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <label>
            {t('swap.buyAmount', { symbol: nativeSymbol })}
            <input className={field} value={buyAmount} inputMode="decimal" onChange={(e) => setBuyAmount(e.target.value)} />
          </label>
          <label>
            {t('swap.dcaInterval')}
            <select className={field} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
              {DCA_INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {t(`swap.dcaEvery_${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('swap.dcaRuns')}
            <input className={field} value={runs} inputMode="numeric" onChange={(e) => setRuns(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>
            {t('swap.dcaCap')}
            <input className={field} value={capPct} inputMode="decimal" placeholder={t('swap.dcaCapNone')} onChange={(e) => setCapPct(e.target.value)} />
          </label>
        </div>
      ) : (
      <>
      {mcapPossible && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {t('swap.targetBy')}
          {(['pct', 'mcap'] as const).map((b) => (
            <button
              key={b}
              type="button"
              className={chip}
              style={{ borderColor: b === targetBy ? 'var(--color-cyan)' : 'var(--color-line)', color: b === targetBy ? 'var(--color-ink)' : 'var(--color-mut)' }}
              onClick={() => setTargetBy(b)}
            >
              {t(`swap.targetBy_${b}`)}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        {byMcap ? (
          <label>
            {t('swap.mcapTarget')}
            <input className={field} value={mcapInput} inputMode="text" placeholder={t('swap.mcapPlaceholder')} onChange={(e) => setMcapInput(e.target.value)} />
          </label>
        ) : (
        <label>
          {rug ? t('swap.rugDrop') : devSell ? t('swap.devDrop') : sign === 1 ? t('swap.offsetUp') : kind === 'trailing_stop' ? t('swap.trailPct') : t('swap.offsetDown')}
          <input className={field} value={offset} inputMode="decimal" onChange={(e) => setOffset(e.target.value)} />
        </label>
        )}
        {alert ? (
          <p className="self-end text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('swap.alertOnly')}</p>
        ) : kind === 'limit_buy' ? (
          <label>
            {t('swap.buyAmount', { symbol: nativeSymbol })}
            <input className={field} value={buyAmount} inputMode="decimal" onChange={(e) => setBuyAmount(e.target.value)} />
          </label>
        ) : (
          <div>
            {t('swap.sellShare')}
            <div className="mt-1 flex gap-1.5">
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={chip}
                  style={{ borderColor: p === sellPercent ? 'var(--color-cyan)' : 'var(--color-line)', color: p === sellPercent ? 'var(--color-ink)' : 'var(--color-mut)' }}
                  onClick={() => setSellPercent(p)}
                >
                  {p} %
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </>
      )}
      <p className="num mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {dca
          ? t('swap.dcaHint', {
              runs: Number.isFinite(runsN) ? runsN : 0,
              amount: fmtAmount(buyAmount.replace(',', '.'), lang),
              symbol: nativeSymbol,
              every: t(`swap.dcaEvery_${interval}`),
              total: Number.isFinite(amountN * runsN) ? fmtAmount(String(Math.round(amountN * runsN * 1e9) / 1e9), lang) : '—',
            }) + (cap !== null && Number.isFinite(cap) ? ' ' + t('swap.dcaCapHint', { price: fmtUsd(cap, lang) }) : '')
          : rug
          ? liqNow === null
            ? t('swap.rugNoLiquidity')
            : t('swap.rugHint', { pct: fmtPct(Number.isFinite(off) ? off : 0, lang), share: sellPercent, liq: fmtUsd(liqNow, lang, true) })
          : devSell
          ? t('swap.devHint', { pct: fmtPct(Number.isFinite(off) ? off : 0, lang), share: sellPercent })
          : kind === 'trailing_stop'
          ? t('swap.trailHint', { pct: fmtPct(Number.isFinite(off) ? off : 0, lang), price: fmtUsd(price, lang) })
          : byMcap
          ? t('swap.mcapHint', {
              mcap: mcapTarget !== null ? fmtUsd(mcapTarget, lang, true) : '—',
              price: trigger !== null && Number.isFinite(trigger) ? fmtUsd(trigger, lang) : '—',
              now: mcapNow !== null ? fmtUsd(mcapNow, lang, true) : '—',
            })
          : t('swap.triggerHint', { price: trigger !== null && Number.isFinite(trigger) ? fmtUsd(trigger, lang) : '—', now: fmtUsd(price, lang) })}
      </p>
      {byMcap && mcapTarget !== null && !mcapSideOk && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--color-warn)' }}>{t(sign === 1 ? 'swap.mcapMustBeAbove' : 'swap.mcapMustBeBelow')}</p>
      )}
      {needsHolding && !held && <p className="mt-1 text-[11px]" style={{ color: 'var(--color-warn)' }}>{t('swap.noHolding')}</p>}
      {wallet.mode === 'live' && !alert && (
        <label className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>
          <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
          {t('swap.orderConfirmLive')}
        </label>
      )}
      <button
        type="button"
        className="btn mt-2 px-3 py-1.5 text-sm"
        disabled={busy || !valid || (wallet.mode === 'live' && !alert && (!wallet.liveApproved || !confirmLive))}
        onClick={() => void create()}
      >
        {t('swap.createOrder')}
      </button>
      {msg && <p className="mt-2 text-xs" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>{msg.text}</p>}
    </div>
  );
}

const ORDER_STATUS_COLOR: Record<string, string> = {
  open: 'var(--color-cyan)',
  executing: 'var(--color-warn)',
  filled: 'var(--color-pos)',
  failed: 'var(--color-neg)',
  cancelled: 'var(--color-mut)',
};

/** Offene + letzte Orders der Wallet; offene lassen sich stornieren. Aktualisiert alle 30 s (Worker-Takt 1 min). */
function OrdersPanel({ walletId, version, onChanged }: { walletId: string; version: number; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ref statt Abhängigkeit: der Aufrufer übergibt jedes Mal eine neue Funktion
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const next = await trpc.swaps.orders.query({ walletId });
      setOrders((prev) => {
        // eine Order ist inzwischen ausgeführt → Bestände neu laden
        if (prev && next.some((o) => o.status === 'filled' && prev.find((p) => p.id === o.id)?.status !== 'filled')) onChangedRef.current();
        return next;
      });
      setError(null);
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }, [walletId, t]);

  useEffect(() => {
    void load();
    const timer = setVisibleInterval(() => void load(), 30_000);
    return () => clearVisibleInterval(timer);
  }, [load, version]);

  async function cancel(id: string) {
    try {
      await trpc.swaps.cancelOrder.mutate({ orderId: id });
      await load();
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }

  return (
    <Panel label={t('swap.ordersTitle')} stagger={2}>
      {error && <ErrorBox message={error} />}
      {orders && orders.length === 0 && <Empty text={t('swap.noOrders')} />}
      <ul className="mt-2 space-y-1 text-xs">
        {orders?.map((o) => (
          <li key={o.id} className="num flex flex-wrap items-center justify-between gap-2 border-t pt-1" style={{ borderColor: 'var(--color-line)' }}>
            <span>
              <b>{t(`swap.kind_${o.kind}`)}</b> {o.symbol}{' '}
              <span style={{ color: 'var(--color-mut)' }}>
                {o.kind === 'dca'
                  ? `${o.runsDone}/${o.runsTotal ?? '?'} · ${o.intervalMinutes ? t(`swap.dcaEvery_${o.intervalMinutes}`, { defaultValue: `${o.intervalMinutes} min` }) : ''}${o.maxPriceUsd !== null ? ` · ≤ ${fmtUsd(o.maxPriceUsd, lang)}` : ''}${o.status === 'open' && o.nextRunAt ? ` · ${t('swap.dcaNext', { time: new Date(o.nextRunAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) })}` : ''}`
                  : o.kind === 'dev_sell'
                  ? t('swap.devListed', { pct: fmtPct(o.trailPct ?? 0, lang), dev: o.watchAddress ? `${o.watchAddress.slice(0, 6)}…${o.watchAddress.slice(-4)}` : '—' })
                  : o.kind === 'rug_guard'
                  ? t('swap.rugListed', { pct: fmtPct(o.trailPct ?? 0, lang), liq: o.peakLiquidityUsd !== null ? fmtUsd(o.peakLiquidityUsd, lang, true) : '—' })
                  : o.kind === 'trailing_stop'
                  ? `−${fmtPct(o.trailPct ?? 0, lang)} ${t('swap.fromPeak')} ${o.peakPriceUsd !== null ? fmtUsd(o.peakPriceUsd, lang) : '—'}`
                  : `@ ${o.triggerPriceUsd !== null ? fmtUsd(o.triggerPriceUsd, lang) : '—'}`}
                {o.sellPercent !== null ? ` · ${o.sellPercent} %` : ''}
                {o.buyAmount !== null ? ` · ${o.buyAmount}` : ''}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span style={{ color: ORDER_STATUS_COLOR[o.status] }} title={o.error ?? undefined}>
                {t(`swap.status_${o.status}`)}
              </span>
              {o.status === 'open' && (
                <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} onClick={() => void cancel(o.id)}>
                  {t('swap.cancelOrder')}
                </button>
              )}
            </span>
            {o.error && (o.status !== 'open' || o.kind === 'dca') && <span className="w-full" style={{ color: 'var(--color-mut)' }}>{o.error}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
