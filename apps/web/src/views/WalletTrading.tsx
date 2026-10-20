import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { bpsLabel, fmtAmount, fmtPct, fmtUsd, slippageChoices, swapReasonKey } from '../lib/swap-format.js';

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

          {wallet && <WalletView key={wallet.id} config={config} wallet={wallet} onWalletChanged={loadWallets} />}

          <Panel label={t('swap.liveTitle')} className="mt-4">
            <p className="mt-2 text-sm" style={{ color: 'var(--color-mut)' }}>
              {config.liveKeysAllowed ? t('swap.liveAllowedSoon') : t('swap.liveNotAllowed')}
            </p>
          </Panel>
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

function WalletView({ config, wallet, onWalletChanged }: { config: Config; wallet: Wallet; onWalletChanged: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const chain = config.chains.find((c) => c.id === wallet.chain)!;
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [slippage, setSlippage] = useState(wallet.slippageBps);
  const [pending, setPending] = useState<SwapReq | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lang = i18n.language;

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

  async function lookup(addr: string) {
    const a = addr.trim();
    setAddress(a);
    setToken(null);
    setQuote(null);
    setPending(null);
    setTokenError(null);
    if (!a) return;
    try {
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
      const r = await trpc.swaps.execute.mutate({ walletId: wallet.id, token: token.address, slippageBps: slippage, ...pending });
      const q = r.quote;
      setMsg({
        ok: true,
        text: t('swap.done', { inAmount: fmtAmount(q.inAmount, lang), inSymbol: q.inSymbol, outAmount: fmtAmount(q.outAmount, lang), outSymbol: q.outSymbol }),
      });
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
  const nativeHolding = portfolio?.holdings.find((h) => h.native) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
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

            <p className="label mt-3">{t('swap.sell')}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {[25, 50, 100].map((p) => (
                <button key={p} type="button" className={chip} style={{ borderColor: 'var(--color-neg)' }} disabled={busy || !held} onClick={() => void requestQuote({ side: 'sell', percent: p })}>
                  {p} %
                </button>
              ))}
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
            {!quote.verdict.allowed && (
              <ul className="mt-2 space-y-0.5 text-xs" style={{ color: 'var(--color-neg)' }}>
                {quote.verdict.reasons.map((r) => (
                  <li key={r}>• {t(swapReasonKey(r))}</li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn px-3 py-1.5 text-sm" disabled={busy || !quote.verdict.allowed} onClick={() => void confirm()}>
                {wallet.mode === 'paper' ? t('swap.confirmPaper') : t('swap.confirm')}
              </button>
              <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} disabled={busy} onClick={() => pending && void requestQuote(pending)}>
                {t('swap.refresh')}
              </button>
            </div>
          </div>
        )}
        {msg && <p className="mt-2 text-xs" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>{msg.text}</p>}
      </Panel>

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
                  {portfolio.holdings.map((h) => (
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
                      <td className="text-right">{fmtAmount(h.amount, lang)}</td>
                      <td className="text-right">{h.valueUsd === null ? '—' : fmtUsd(h.valueUsd, lang)}</td>
                      <td className="text-right" style={{ color: h.pnlUsd === null ? undefined : h.pnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {h.pnlUsd === null ? '—' : fmtUsd(h.pnlUsd, lang)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <Panel label={t('swap.history')} stagger={3}>
          {portfolio && portfolio.trades.length === 0 && <Empty text={t('swap.noTrades')} />}
          <ul className="mt-2 space-y-1 text-xs">
            {portfolio?.trades.map((tr) => (
              <li key={tr.id} className="num flex flex-wrap justify-between gap-2 border-t pt-1" style={{ borderColor: 'var(--color-line)' }}>
                <span>
                  <span style={{ color: tr.side === 'buy' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{tr.side === 'buy' ? t('swap.buy') : t('swap.sell')}</span>{' '}
                  {fmtAmount(tr.inAmount, lang)} {tr.inSymbol} → {fmtAmount(tr.outAmount, lang)} {tr.outSymbol}
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

const LIMIT_KEYS = ['maxTradeUsd', 'maxSlippageBps', 'maxPriceImpactPct', 'minLiquidityUsd'] as const;

function LimitsPanel({ config, wallet, onSaved }: { config: Config; wallet: Wallet; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Record<keyof Limits, string>>(() => ({
    maxTradeUsd: String(wallet.limits.maxTradeUsd),
    maxSlippageBps: String(wallet.limits.maxSlippageBps),
    maxPriceImpactPct: String(wallet.limits.maxPriceImpactPct),
    minLiquidityUsd: String(wallet.limits.minLiquidityUsd),
  }));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function applyProfile(limits: Limits) {
    setForm({
      maxTradeUsd: String(limits.maxTradeUsd),
      maxSlippageBps: String(limits.maxSlippageBps),
      maxPriceImpactPct: String(limits.maxPriceImpactPct),
      minLiquidityUsd: String(limits.minLiquidityUsd),
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
