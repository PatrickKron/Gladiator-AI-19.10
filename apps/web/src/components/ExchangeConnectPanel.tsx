import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeWalletAddress, walletAddressKind } from '@gladiator/core/wallet-address';
import { trpc } from '../api.js';
import { Panel } from './ui.js';
import { fmt } from './EquityChart.js';

/**
 * „Börse verbinden" (System-Bereich): jede CCXT-Börse (100+) per API-Key +
 * Secret. Ehrlich: Die Verbindung wird beim Speichern GEGEN DIE ECHTE BÖRSE
 * geprüft — schlägt das fehl, wird nichts gespeichert. Keys liegen nur
 * AES-256-verschlüsselt, Anzeige maskiert. Read-Only ist Default; der
 * Trading-Modus schaltet KEINE Live-Orders frei (die gibt es weiterhin
 * bewusst nicht) — er markiert die Verbindung für den Order-Router.
 */

type Supported = Awaited<ReturnType<typeof trpc.exchanges.supported.query>>;
type Connection = Awaited<ReturnType<typeof trpc.exchanges.list.query>>[number];
type Balances = Awaited<ReturnType<typeof trpc.exchanges.balances.query>>;
type Preferred = Awaited<ReturnType<typeof trpc.exchanges.preferred.query>>[number];

/** Vorauswahl aus dem Chat-Hinweis: '#/einstellungen?tab=boersen&ex=bybit' → 'bybit'. */
function exchangeFromHash(): string | null {
  const q = window.location.hash.indexOf('?');
  return q < 0 ? null : new URLSearchParams(window.location.hash.slice(q + 1)).get('ex');
}

export function ExchangeConnectPanel() {
  const { t } = useTranslation();
  const [supported, setSupported] = useState<Supported>([]);
  const [walletSupported, setWalletSupported] = useState<Supported>([]);
  const [via, setVia] = useState<'api' | 'wallet'>('api');
  const [wallet, setWallet] = useState({ exchangeId: '', label: '', address: '' });
  const [preferred, setPreferred] = useState<Preferred[]>([]);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [form, setForm] = useState({ exchangeId: '', label: '', apiKey: '', secret: '', password: '', mode: 'read_only' as 'read_only' | 'trading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [balances, setBalances] = useState<Record<string, Balances | 'loading' | string>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  async function load() {
    try {
      setConnections(await trpc.exchanges.list.query());
    } catch {
      setConnections([]);
    }
  }

  useEffect(() => {
    void load();
    trpc.exchanges.supported.query().then(setSupported).catch(() => setSupported([]));
    trpc.exchanges.walletSupported.query().then(setWalletSupported).catch(() => setWalletSupported([]));
    trpc.exchanges.preferred.query().then(setPreferred).catch(() => setPreferred([]));
    const ex = exchangeFromHash();
    if (ex) pick(ex, false);
  }, []);

  async function connect() {
    if (!form.exchangeId || !form.apiKey || !form.secret) return;
    setBusy(true);
    setMessage(null);
    try {
      const dto = await trpc.exchanges.connect.mutate({
        exchangeId: form.exchangeId,
        label: form.label || undefined,
        mode: form.mode,
        credentials: {
          apiKey: form.apiKey,
          secret: form.secret,
          ...(form.password ? { password: form.password } : {}),
        },
      });
      setMessage({ ok: true, text: t('exchanges.connected', { name: dto.exchangeName, n: dto.marketsSummary?.symbolCount ?? 0 }) });
      setForm({ exchangeId: '', label: '', apiKey: '', secret: '', password: '', mode: 'read_only' });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBusy(false);
    }
  }

  /** Börse vorauswählen — Wallet-Login-Börsen (Hyperliquid & Co.) landen im Wallet-Formular. */
  function pick(exchangeId: string, walletLogin: boolean) {
    if (walletLogin || exchangeId === 'hyperliquid') {
      setVia('wallet');
      setWallet((w) => ({ ...w, exchangeId }));
    } else {
      setVia('api');
      setForm((f) => ({ ...f, exchangeId }));
    }
  }

  const walletAddressOk = normalizeWalletAddress(wallet.exchangeId, wallet.address) !== null;

  async function connectWallet() {
    if (!wallet.exchangeId || !walletAddressOk) return;
    setBusy(true);
    setMessage(null);
    try {
      const dto = await trpc.exchanges.connectWallet.mutate({
        exchangeId: wallet.exchangeId,
        walletAddress: wallet.address.trim(),
        label: wallet.label || undefined,
      });
      setMessage({ ok: true, text: t('exchanges.connected', { name: dto.exchangeName, n: dto.marketsSummary?.symbolCount ?? 0 }) });
      setWallet({ exchangeId: '', label: '', address: '' });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBusy(false);
    }
  }

  async function loadBalances(id: string) {
    setBalances((b) => ({ ...b, [id]: 'loading' }));
    try {
      const res = await trpc.exchanges.balances.query({ connectionId: id });
      setBalances((b) => ({ ...b, [id]: res }));
    } catch (err) {
      setBalances((b) => ({ ...b, [id]: err instanceof Error ? err.message : t('common.error') }));
    }
  }

  async function toggleMode(conn: Connection) {
    try {
      await trpc.exchanges.setMode.mutate({ connectionId: conn.id, mode: conn.mode === 'read_only' ? 'trading' : 'read_only' });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    }
  }

  async function disconnect(id: string) {
    try {
      await trpc.exchanges.disconnect.mutate({ connectionId: id });
      setConfirmDisconnect(null);
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    }
  }

  const field = 'field w-full px-3 py-2 text-sm';

  return (
    <Panel label={t('exchanges.title')} stagger={5} className="mt-5">
      <p className="mb-4 text-sm" style={{ color: 'var(--color-mut)' }}>
        {t('exchanges.subtitle')}
      </p>

      {/* Aus dem Chat erkannte, noch nicht verbundene Börsen → ein Klick wählt sie vor */}
      {preferred.some((p) => !p.connected) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--color-mut)' }}>
          <span>{t('exchanges.detectedInChat')}</span>
          {preferred
            .filter((p) => !p.connected)
            .map((p) => (
              <button
                key={p.id}
                type="button"
                className="rounded border px-2 py-1"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                title={t('exchanges.mentionedTimes', { n: p.mentions })}
                onClick={() => pick(p.id, p.walletLogin)}
              >
                {p.name}
              </button>
            ))}
        </div>
      )}

      {/* Anschluss-Art: klassische API-Keys oder (nur lesend) öffentliche Wallet-Adresse */}
      <div className="mb-3 flex w-fit overflow-hidden rounded-[0.625rem] border text-xs" style={{ borderColor: 'var(--color-line)' }}>
        {(['api', 'wallet'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVia(v)}
            className="px-3 py-2 transition-colors"
            style={
              via === v
                ? { background: 'rgba(59,130,246,0.25)', color: 'var(--color-ink)' }
                : { color: 'var(--color-mut)' }
            }
          >
            {t(v === 'api' ? 'exchanges.viaApi' : 'exchanges.viaWallet')}
          </button>
        ))}
      </div>

      {via === 'wallet' ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label mb-1 block">{t('exchanges.exchange')}</label>
              <select className={field} value={wallet.exchangeId} onChange={(e) => setWallet((w) => ({ ...w, exchangeId: e.target.value }))}>
                <option value="">{t('exchanges.walletPick', { n: walletSupported.length })}</option>
                {walletSupported.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label mb-1 block">{t('exchanges.label')}</label>
              <input className={field} value={wallet.label} onChange={(e) => setWallet((w) => ({ ...w, label: e.target.value }))} placeholder={t('exchanges.labelPlaceholder')} />
            </div>
            <div className="md:col-span-2">
              <label className="label mb-1 block">{t('exchanges.walletAddress')}</label>
              <input className={`${field} num`} value={wallet.address} onChange={(e) => setWallet((w) => ({ ...w, address: e.target.value }))} placeholder={walletAddressKind(wallet.exchangeId) === 'dydx' ? 'dydx1…' : '0x…'} autoComplete="off" spellCheck={false} />
            </div>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>
            {t('exchanges.walletHint')}
          </p>
          <button className="btn mt-3" disabled={busy || !wallet.exchangeId || !walletAddressOk} onClick={() => void connectWallet()}>
            {busy ? t('exchanges.connecting') : t('exchanges.connectBtn')}
          </button>
        </>
      ) : (
      <>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label mb-1 block">{t('exchanges.exchange')}</label>
          <select className={field} value={form.exchangeId} onChange={(e) => setForm((f) => ({ ...f, exchangeId: e.target.value }))}>
            <option value="">{t('exchanges.pickExchange', { n: supported.length })}</option>
            {supported.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label mb-1 block">{t('exchanges.label')}</label>
          <input className={field} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder={t('exchanges.labelPlaceholder')} />
        </div>
        <div>
          <label className="label mb-1 block">API-Key</label>
          <input className={field} value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} autoComplete="off" />
        </div>
        <div>
          <label className="label mb-1 block">API-Secret</label>
          <input className={field} type="password" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} autoComplete="off" />
        </div>
        <div>
          <label className="label mb-1 block">{t('exchanges.passphrase')}</label>
          <input className={field} type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="off" placeholder={t('exchanges.passphraseHint')} />
        </div>
        <div>
          <label className="label mb-1 block">{t('exchanges.mode')}</label>
          <div className="flex overflow-hidden rounded-[0.625rem] border text-xs" style={{ borderColor: 'var(--color-line)' }}>
            {(['read_only', 'trading'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setForm((f) => ({ ...f, mode: m }))}
                className="flex-1 px-2.5 py-2 transition-colors"
                style={
                  form.mode === m
                    ? { background: 'rgba(59,130,246,0.25)', color: 'var(--color-ink)' }
                    : { color: 'var(--color-mut)' }
                }
                title={t(m === 'read_only' ? 'exchanges.readOnlyHint' : 'exchanges.tradingHint')}
              >
                {t(m === 'read_only' ? 'exchanges.readOnly' : 'exchanges.trading')}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>
        {t('exchanges.withdrawWarning')}
      </p>
      <button className="btn mt-3" disabled={busy || !form.exchangeId || !form.apiKey || !form.secret} onClick={() => void connect()}>
        {busy ? t('exchanges.connecting') : t('exchanges.connectBtn')}
      </button>
      </>
      )}
      {message && (
        <p className="mt-2 text-sm" style={{ color: message.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
          {message.text}
        </p>
      )}

      {/* Bestehende Verbindungen */}
      {connections !== null && connections.length > 0 && (
        <ul className="mt-6 space-y-3">
          {connections.map((conn) => {
            const bal = balances[conn.id];
            return (
              <li key={conn.id} className="rounded border p-3" style={{ borderColor: 'var(--color-line)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {conn.label || conn.exchangeName}{' '}
                      <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>
                        {conn.keyMasked}
                      </span>
                    </p>
                    <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                      {conn.marketsSummary
                        ? t('exchanges.marketsInfo', { n: conn.marketsSummary.symbolCount })
                        : t('exchanges.marketsUnknown')}
                      {conn.status === 'error' && (
                        <span style={{ color: 'var(--color-neg)' }}> · {conn.lastError}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {conn.kind === 'wallet' ? (
                      <span className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                        {t('exchanges.walletBadge')}
                      </span>
                    ) : (
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      style={
                        conn.mode === 'trading'
                          ? { borderColor: 'rgba(245,182,66,0.5)', color: 'var(--color-warn)' }
                          : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                      }
                      onClick={() => void toggleMode(conn)}
                      title={t(conn.mode === 'trading' ? 'exchanges.tradingHint' : 'exchanges.readOnlyHint')}
                    >
                      {t(conn.mode === 'trading' ? 'exchanges.trading' : 'exchanges.readOnly')}
                    </button>
                    )}
                    <button className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} onClick={() => void loadBalances(conn.id)}>
                      {t('exchanges.showBalances')}
                    </button>
                    {confirmDisconnect === conn.id ? (
                      <button className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--color-neg)' }} onClick={() => void disconnect(conn.id)}>
                        {t('exchanges.disconnectConfirm')}
                      </button>
                    ) : (
                      <button className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }} onClick={() => setConfirmDisconnect(conn.id)}>
                        {t('exchanges.disconnect')}
                      </button>
                    )}
                  </div>
                </div>
                {bal === 'loading' && <p className="mt-2 text-xs animate-pulse">{t('common.loading')}</p>}
                {typeof bal === 'string' && bal !== 'loading' && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
                    {bal}
                  </p>
                )}
                {Array.isArray(bal) && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                    {bal.length === 0 && <span>{t('exchanges.noBalances')}</span>}
                    {bal.map((b) => (
                      <span key={b.currency} className="num">
                        {fmt(b.total, 6)} {b.currency}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
