import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { fmtAmount, fmtUsd } from '../lib/swap-format.js';
import { Empty, ErrorBox, Panel } from './ui.js';

/**
 * Wallets beobachten + Copy-Trading (Vision-Punkt 5, „wie Trojan“): fremde
 * Wallets (Solana und EVM-Ketten), deren Swaps der Worker direkt von der
 * Kette liest. Kopiert wird nur in eine Paper-Wallet derselben Kette — echte
 * Copy-Trades gibt es nicht.
 */

type Watched = Awaited<ReturnType<typeof trpc.swaps.watched.query>>[number];
type Activity = Awaited<ReturnType<typeof trpc.swaps.watchedActivity.query>>[number];
type PaperWallet = { id: string; label: string; chain: string };
/** Ketten-Infos aus swaps.config (Name, native Währung, Explorer). */
export type WatchChain = { id: ChainId; name: string; kind: 'solana' | 'evm'; nativeSymbol: string; explorerTx: string };
type CopyMode = Watched['copyMode'];
type ChainId = NonNullable<Parameters<typeof trpc.swaps.addWatched.mutate>[0]['chain']>;

const field = 'field num w-full px-2.5 py-1.5 text-sm';
const chip = 'rounded border px-2.5 py-1 text-xs';
const COPY_COLOR: Record<Activity['copyStatus'], string> = {
  none: 'var(--color-mut)',
  filled: 'var(--color-pos)',
  skipped: 'var(--color-warn)',
  failed: 'var(--color-neg)',
};

function short(a: string): string {
  return a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Explorer-Link für Konto bzw. Transaktion (Solscan: /account/, EVM-Scanner: /address/). */
function explorer(c: WatchChain | undefined, kind: 'tx' | 'account', id: string): string {
  const tx = c?.explorerTx ?? 'https://solscan.io/tx/';
  return kind === 'tx' ? `${tx}${id}` : tx.replace(/\/tx\/$/, c?.kind === 'evm' ? '/address/' : '/account/') + id;
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Formular für Name + Kopier-Einstellungen (Anlegen und Bearbeiten). */
function CopyFields({
  paperWallets,
  mode,
  setMode,
  target,
  setTarget,
  amount,
  setAmount,
  minNative,
  setMinNative,
  nativeSymbol,
}: {
  nativeSymbol: string;
  paperWallets: PaperWallet[];
  mode: CopyMode;
  setMode: (m: CopyMode) => void;
  target: string;
  setTarget: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  minNative: string;
  setMinNative: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-4">
      <div className="text-xs">
        {t('swap.copyMode')}
        <div className="mt-1 flex gap-1.5">
          {(['off', 'paper'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={chip}
              disabled={m === 'paper' && paperWallets.length === 0}
              style={{ borderColor: mode === m ? 'var(--color-cyan)' : 'var(--color-line)', color: mode === m ? 'var(--color-ink)' : 'var(--color-mut)' }}
              onClick={() => setMode(m)}
            >
              {t(`swap.copyMode_${m}`)}
            </button>
          ))}
        </div>
        {paperWallets.length === 0 && <span className="mt-1 block" style={{ color: 'var(--color-mut)' }}>{t('swap.copyNeedsPaper')}</span>}
      </div>
      {mode === 'paper' && (
        <>
          <label className="text-xs">
            {t('swap.copyTarget')}
            <select className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
              {paperWallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            {t('swap.copyAmount', { symbol: nativeSymbol })}
            <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
          </label>
          <label className="text-xs" title={t('swap.copyMinHint')}>
            {t('swap.copyMin', { symbol: nativeSymbol })}
            <input className={field} inputMode="decimal" value={minNative} placeholder={t('swap.copyMinNone')} onChange={(e) => setMinNative(e.target.value.replace(',', '.'))} />
          </label>
        </>
      )}
    </div>
  );
}

export function WatchedWallets({ chains, paperWallets: allPaper, onCopied }: { chains: WatchChain[]; paperWallets: PaperWallet[]; onCopied: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [list, setList] = useState<Watched[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainId>('solana');
  const [address, setAddress] = useState('');
  const c = chains.find((x) => x.id === chain);
  const paperWallets = allPaper.filter((w) => w.chain === chain);
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<CopyMode>('off');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('0.1');
  const [minNative, setMinNative] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await trpc.swaps.watched.query());
      setError(null);
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = setVisibleInterval(() => void load(), 30_000);
    return () => clearVisibleInterval(timer);
  }, [load]);

  async function add() {
    setBusy(true);
    try {
      const w = await trpc.swaps.addWatched.mutate({
        chain,
        address: address.trim(),
        label: label.trim() || short(address.trim()),
        copyMode: mode,
        copyWalletId: mode === 'paper' ? target || paperWallets[0]?.id || null : null,
        copyAmount: mode === 'paper' ? amount : null,
        copyMinNative: mode === 'paper' && minNative.trim() ? minNative.trim() : null,
      });
      setAddress('');
      setLabel('');
      setOpenId(w.id);
      await load();
    } catch (err) {
      setError(errText(err, t('common.error')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('swap.watchTitle')} className="mt-4">
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>{t('swap.watchIntro')}</p>
      {error && <ErrorBox message={error} />}
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="text-xs">
          {t('swap.chain')}
          <select
            className={field}
            value={chain}
            onChange={(e) => {
              setChain(e.target.value as ChainId);
              setMode('off');
              setTarget('');
              setAmount(e.target.value === 'solana' ? '0.1' : '0.01');
            }}
          >
            {chains.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          {t('swap.watchAddress', { chain: c?.name ?? chain })}
          <input className={`${field} font-mono`} value={address} spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="text-xs">
          {t('swap.label')}
          <input className={field} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <CopyFields nativeSymbol={c?.nativeSymbol ?? ''} paperWallets={paperWallets} mode={mode} setMode={setMode} target={target || paperWallets[0]?.id || ''} setTarget={setTarget} amount={amount} setAmount={setAmount} minNative={minNative} setMinNative={setMinNative} />
      <button type="button" className="btn mt-3 px-3 py-1.5 text-sm" disabled={busy || address.trim().length < (c?.kind === 'evm' ? 42 : 32)} onClick={() => void add()}>
        {busy ? t('common.loading') : t('swap.watchAdd')}
      </button>

      {list && list.length === 0 && <Empty text={t('swap.watchNone')} />}
      <ul className="mt-3 space-y-2">
        {list?.map((w) => (
          <WatchedRow
            key={w.id}
            w={w}
            lang={lang}
            open={openId === w.id}
            onToggle={() => setOpenId((cur) => (cur === w.id ? null : w.id))}
            chain={chains.find((x) => x.id === w.chain)}
            paperWallets={allPaper.filter((p) => p.chain === w.chain)}
            onChanged={load}
            onCopied={onCopied}
          />
        ))}
      </ul>
    </Panel>
  );
}

function WatchedRow({
  w,
  chain,
  lang,
  open,
  onToggle,
  paperWallets,
  onChanged,
  onCopied,
}: {
  w: Watched;
  chain: WatchChain | undefined;
  lang: string;
  open: boolean;
  onToggle: () => void;
  paperWallets: PaperWallet[];
  onChanged: () => Promise<void>;
  onCopied: () => void;
}) {
  const { t } = useTranslation();
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(w.label);
  const [mode, setMode] = useState<CopyMode>(w.copyMode);
  const [target, setTarget] = useState(w.copyWalletId ?? paperWallets[0]?.id ?? '');
  const [amount, setAmount] = useState(w.copyAmount ?? '0.1');
  const [minNative, setMinNative] = useState(w.copyMinNative ?? '');
  const copyTargetLabel = paperWallets.find((p) => p.id === w.copyWalletId)?.label;

  // Ref statt Abhängigkeit: der Aufrufer übergibt evtl. je Render eine neue Funktion
  const onCopiedRef = useRef(onCopied);
  onCopiedRef.current = onCopied;
  const lastIds = useRef<Set<string> | null>(null);
  const loadActivity = useCallback(async () => {
    try {
      const next = await trpc.swaps.watchedActivity.query({ id: w.id });
      const prev = lastIds.current;
      lastIds.current = new Set(next.map((a) => a.id));
      setActivity(next);
      setError(null);
      // neue ausgeführte Kopie → Wallet-Bestände neu laden (außerhalb des State-Updaters, genau einmal)
      if (prev && next.some((a) => a.copyStatus === 'filled' && !prev.has(a.id))) onCopiedRef.current();
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }, [w.id, t]);

  useEffect(() => {
    if (!open) return;
    void loadActivity();
    const timer = setVisibleInterval(() => void loadActivity(), 30_000);
    return () => clearVisibleInterval(timer);
  }, [open, loadActivity]);

  async function save() {
    try {
      await trpc.swaps.updateWatched.mutate({
        id: w.id,
        label: label.trim() || w.label,
        copyMode: mode,
        copyWalletId: mode === 'paper' ? target || null : null,
        copyAmount: mode === 'paper' ? amount : null,
        copyMinNative: mode === 'paper' && minNative.trim() ? minNative.trim() : null,
      });
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }

  async function remove() {
    try {
      await trpc.swaps.removeWatched.mutate({ id: w.id });
      await onChanged();
    } catch (err) {
      setError(errText(err, t('common.error')));
    }
  }

  return (
    <li className="rounded border p-2 text-xs" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-left" onClick={onToggle} aria-expanded={open}>
          <b>{w.label}</b> <span style={{ color: 'var(--color-mut)' }}>{chain?.name ?? w.chain}</span>{' '}
          <span className="num" style={{ color: 'var(--color-mut)' }}>
            {short(w.address)}
          </span>
        </button>
        <span className="flex flex-wrap items-center gap-2" style={{ color: 'var(--color-mut)' }}>
          <span style={{ color: w.copyMode === 'paper' ? 'var(--color-cyan)' : undefined }}>
            {w.copyMode === 'paper' ? t('swap.copyingInto', { amount: w.copyAmount, symbol: chain?.nativeSymbol ?? '', wallet: copyTargetLabel ?? '—' }) : t('swap.copyMode_off')}
            {w.copyMode === 'paper' && w.copyMinNative ? ` · ${t('swap.copyMinListed', { min: w.copyMinNative, symbol: chain?.nativeSymbol ?? '' })}` : ''}
          </span>
          {w.lastError ? (
            <span style={{ color: 'var(--color-warn)' }} title={w.lastError}>
              {t('swap.watchError')}
            </span>
          ) : (
            <span>{w.lastCheckedAt ? t('swap.watchChecked', { time: new Date(w.lastCheckedAt).toLocaleTimeString(lang) }) : t('swap.watchPending')}</span>
          )}
        </span>
      </div>

      {(w.copyStats.buys > 0 || w.copyStats.sells > 0) && (
        <p className="num mt-1" style={{ color: 'var(--color-mut)' }}>
          {t('swap.copyStats', {
            buys: w.copyStats.buys,
            sells: w.copyStats.sells,
            wins: w.copyStats.wins,
            invested: fmtUsd(w.copyStats.investedUsd, lang),
          })}{' '}
          <span style={{ color: w.copyStats.realizedPnlUsd > 0 ? 'var(--color-pos)' : w.copyStats.realizedPnlUsd < 0 ? 'var(--color-neg)' : undefined }}>
            {t('swap.copyRealized', { pnl: `${w.copyStats.realizedPnlUsd > 0 ? '+' : ''}${fmtUsd(w.copyStats.realizedPnlUsd, lang)}` })}
          </span>
        </p>
      )}
      {open && (
        <div className="mt-2">
          {error && <ErrorBox message={error} />}
          {w.lastError && <p style={{ color: 'var(--color-warn)' }}>{w.lastError}</p>}
          <div className="flex flex-wrap gap-1.5">
            <a className={chip} style={{ borderColor: 'var(--color-line)' }} href={explorer(chain, 'account', w.address)} target="_blank" rel="noreferrer">
              Explorer ↗
            </a>
            <button type="button" className={chip} style={{ borderColor: 'var(--color-line)' }} onClick={() => setEditing((e) => !e)}>
              {t('swap.watchEdit')}
            </button>
            <button type="button" className={chip} style={{ borderColor: 'var(--color-line)', color: 'var(--color-neg)' }} onClick={() => void remove()}>
              {t('swap.watchRemove')}
            </button>
          </div>
          {editing && (
            <div className="mt-2">
              <label className="block text-xs">
                {t('swap.label')}
                <input className={field} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <CopyFields nativeSymbol={chain?.nativeSymbol ?? ''} paperWallets={paperWallets} mode={mode} setMode={setMode} target={target} setTarget={setTarget} amount={amount} setAmount={setAmount} minNative={minNative} setMinNative={setMinNative} />
              <button type="button" className="btn mt-2 px-3 py-1 text-xs" onClick={() => void save()}>
                {t('swap.watchSave')}
              </button>
            </div>
          )}
          <p className="mt-3 font-semibold">{t('swap.watchActivity')}</p>
          {activity && activity.length === 0 && <p style={{ color: 'var(--color-mut)' }}>{t('swap.watchNoActivity')}</p>}
          <ul className="mt-1 space-y-1">
            {activity?.map((a) => (
              <li key={a.id} className="num flex flex-wrap items-center justify-between gap-2 border-t pt-1" style={{ borderColor: 'var(--color-line)' }}>
                <span>
                  <b style={{ color: a.side === 'buy' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{t(a.side === 'buy' ? 'swap.buy' : 'swap.sell')}</b>{' '}
                  {fmtAmount(a.amount, lang)} {a.symbol ?? short(a.token)}
                  {a.native !== null && (
                    <span style={{ color: 'var(--color-mut)' }}>
                      {' '}
                      · {fmtAmount(a.native, lang)} {chain?.nativeSymbol}
                    </span>
                  )}
                  {a.counterToken !== null && <span style={{ color: 'var(--color-mut)' }}> · {t('swap.watchVia', { token: short(a.counterToken) })}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span style={{ color: COPY_COLOR[a.copyStatus] }} title={a.copyNote ?? undefined}>
                    {t(`swap.copy_${a.copyStatus}`)}
                  </span>
                  {a.txTime && <span style={{ color: 'var(--color-mut)' }}>{new Date(a.txTime).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })}</span>}
                  <a href={explorer(chain, 'tx', a.signature)} target="_blank" rel="noreferrer" style={{ color: 'var(--color-cyan)' }}>
                    ↗
                  </a>
                </span>
                {a.copyNote && a.copyStatus !== 'none' && <span className="w-full" style={{ color: 'var(--color-mut)' }}>{a.copyNote}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
