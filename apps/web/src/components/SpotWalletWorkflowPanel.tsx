import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { appLocale } from '../lib/locale.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel, fmtNum } from './ui.js';

type Overview = Awaited<ReturnType<typeof trpc.spotWorkflow.overview.query>>;
type Quote = Awaited<ReturnType<typeof trpc.spotWorkflow.quote.query>>;
type CompareQuote = Awaited<ReturnType<typeof trpc.spotWorkflow.compareQuotes.query>>[number];
type NetworkId = Overview['networks'][number]['id'];
type WorkflowPath = 'guided_cex' | 'dex_direct' | 'api_withdraw';

const QUICK_BASE_COINS = ['BTC', 'ETH', 'SOL', 'QNT', 'LINK', 'ARB', 'AAVE', 'UNI'];
const QUOTE_CURRENCIES = ['USDT', 'USDC', 'EUR'] as const;
const QUICK_AMOUNTS = [50, 100, 250, 500, 1000];

const STAGE_META: Record<string, { step: 1 | 2 | 3; label: string; color: string; bg: string }> = {
  bought: { step: 1, label: '① Spot gekauft', color: 'var(--color-cyan)', bg: 'rgba(6,182,212,0.14)' },
  awaiting_transfer: { step: 2, label: '② Bereit zum Wallet-Transfer', color: '#fbbf24', bg: 'rgba(245,158,11,0.16)' },
  withdrawn: { step: 2, label: '② Unterwegs auf Blockchain', color: '#38bdf8', bg: 'rgba(56,189,248,0.16)' },
  onchain_confirmed: { step: 3, label: '③ ✅ Auf Wallet bestätigt', color: 'var(--color-pos)', bg: 'rgba(16,185,129,0.16)' },
  failed: { step: 2, label: '⚠️ Prüfen', color: 'var(--color-neg)', bg: 'rgba(239,68,68,0.14)' },
};

/**
 * Visuell geordneter 3-Wege Spot-Kauf & Self-Custody Wallet-Workflow (Welle 27):
 * - Weg A: CEX-Spot kaufen + Geführter Wallet-Transfer (API-Key OHNE Withdraw-Recht + On-Chain-Check)
 * - Weg B: On-Chain DEX-Direktkauf (Jupiter / KyberSwap — landet sofort in eigener Wallet)
 * - Weg C: CEX-Spot kaufen + 1-Klick Whitelist-API-Auszahlung (4-Stufen-Gate, 0 KI-/Agenten-Zugriff)
 */
export function SpotWalletWorkflowPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<WorkflowPath>('guided_cex');

  // Schritt 1: Neue Ziel-Wallet anlegen
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [wLabel, setWLabel] = useState('');
  const [wNetwork, setWNetwork] = useState<NetworkId>('BTC');
  const [wAddress, setWAddress] = useState('');
  const [wMemo, setWMemo] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [approvePhraseById, setApprovePhraseById] = useState<Record<string, string>>({});
  const [liveBalById, setLiveBalById] = useState<Record<string, string>>({});

  // Schritt 2: Spot-Kauf-Ticket
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [quoteCurrency, setQuoteCurrency] = useState<(typeof QUOTE_CURRENCIES)[number]>('USDT');
  const [quoteAmountStr, setQuoteAmountStr] = useState('100');
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [connectionId, setConnectionId] = useState<string>('');
  const [destWalletId, setDestWalletId] = useState<string>('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [compareRows, setCompareRows] = useState<CompareQuote[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyFeedback, setBuyFeedback] = useState<string | null>(null);

  // Schritt 3: Aktionen an laufenden Workflows
  const [wfBusyId, setWfBusyId] = useState<string | null>(null);
  const [confirmWithdrawById, setConfirmWithdrawById] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await trpc.spotWorkflow.overview.query();
      setData(res);
      setDestWalletId((cur) => cur || (res.addressBook[0]?.id ?? ''));
      setConnectionId((cur) => cur || (res.connections[0]?.id ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spot-Workflow konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedWallet = data?.addressBook.find((w) => w.id === destWalletId) ?? null;
  const selectedConn = data?.connections.find((c) => c.id === connectionId) ?? null;
  const quoteAmount = Number(quoteAmountStr) || 0;

  // Live-Spot-Vorschau aktualisieren
  useEffect(() => {
    if (activePath === 'dex_direct' || quoteAmount <= 0 || symbol.trim().length < 3) {
      setQuote(null);
      setCompareRows([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void trpc.spotWorkflow.quote
        .query({
          symbol,
          quoteAmount,
          exchangeId: mode === 'live' && selectedConn ? selectedConn.exchangeId : 'binance',
          network: selectedWallet?.network,
        })
        .then((q) => {
          if (!cancelled) setQuote(q);
        })
        .catch(() => {
          if (!cancelled) setQuote(null);
        });
      if (showCompare) {
        void trpc.spotWorkflow.compareQuotes
          .query({ symbol, quoteAmount })
          .then((rows) => {
            if (!cancelled) setCompareRows(rows);
          })
          .catch(() => {
            if (!cancelled) setCompareRows([]);
          });
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activePath, symbol, quoteAmount, mode, selectedConn, selectedWallet, showCompare]);

  function selectQuoteCurrency(nextQuote: (typeof QUOTE_CURRENCIES)[number]) {
    setQuoteCurrency(nextQuote);
    const base = symbol.split('/')[0]?.trim().toUpperCase() || 'BTC';
    setSymbol(`${base}/${nextQuote}`);
  }

  function copyText(key: string, value: string) {
    void navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1800);
  }

  async function handleAddWallet() {
    setWalletBusy(true);
    setError(null);
    try {
      const res = await trpc.spotWorkflow.addWallet.mutate({
        label: wLabel,
        network: wNetwork,
        address: wAddress,
        memo: wMemo || undefined,
      });
      setWLabel('');
      setWAddress('');
      setWMemo('');
      setShowAddWallet(false);
      await load();
      setDestWalletId(res.wallet.id);
      if (res.onchain?.balance !== null && res.onchain?.balance !== undefined) {
        setLiveBalById((prev) => ({
          ...prev,
          [res.wallet.id]: `${res.onchain!.balance} ${res.onchain!.unit}`,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet konnte nicht gespeichert werden.');
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleApproveWallet(id: string) {
    const phrase = approvePhraseById[id] ?? '';
    setWalletBusy(true);
    setError(null);
    try {
      await trpc.spotWorkflow.approveWallet.mutate({ id, phrase });
      setApprovePhraseById((prev) => ({ ...prev, [id]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Freigabe fehlgeschlagen.');
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleCheckWalletBal(id: string) {
    setLiveBalById((prev) => ({ ...prev, [id]: 'Lädt…' }));
    try {
      const b = await trpc.spotWorkflow.walletBalance.query({ id });
      setLiveBalById((prev) => ({
        ...prev,
        [id]: b.balance !== null ? `${b.balance} ${b.unit}` : (b.error ?? 'n/v'),
      }));
    } catch {
      setLiveBalById((prev) => ({ ...prev, [id]: 'Fehler' }));
    }
  }

  async function handleDeleteWallet(id: string) {
    setWalletBusy(true);
    try {
      await trpc.spotWorkflow.deleteWallet.mutate({ id });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleBuySpot() {
    if (activePath === 'dex_direct') return;
    setBuying(true);
    setBuyFeedback(null);
    setError(null);
    try {
      const wf = await trpc.spotWorkflow.buySpot.mutate({
        path: activePath,
        mode,
        symbol,
        quoteAmount,
        exchangeConnectionId: mode === 'live' ? connectionId || null : null,
        destinationWalletId: destWalletId || null,
      });
      setBuyFeedback(
        `✅ Schritt 1 erledigt: ${Number(wf.filledBaseQty ?? 0).toFixed(6)} ${wf.baseAsset} (${wf.mode.toUpperCase()}) gekauft — jetzt unten in Schritt 3 auf deine Wallet bewegen!`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spot-Kauf fehlgeschlagen.');
    } finally {
      setBuying(false);
    }
  }

  async function handleMarkSent(workflowId: string) {
    setWfBusyId(workflowId);
    setError(null);
    try {
      await trpc.spotWorkflow.markManualSent.mutate({ workflowId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status-Update fehlgeschlagen.');
    } finally {
      setWfBusyId(null);
    }
  }

  async function handleApiWithdraw(workflowId: string) {
    const phrase = confirmWithdrawById[workflowId] ?? '';
    setWfBusyId(workflowId);
    setError(null);
    try {
      const res = await trpc.spotWorkflow.withdrawToWhitelistedWallet.mutate({
        workflowId,
        confirmPhrase: phrase,
      });
      if (!res.ok) setError(res.error);
      setConfirmWithdrawById((prev) => ({ ...prev, [workflowId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API-Auszahlung fehlgeschlagen.');
    } finally {
      setWfBusyId(null);
    }
  }

  async function handleCheckArrival(workflowId: string) {
    setWfBusyId(workflowId);
    setError(null);
    try {
      await trpc.spotWorkflow.checkOnChainArrival.mutate({ workflowId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'On-Chain-Prüfung fehlgeschlagen.');
    } finally {
      setWfBusyId(null);
    }
  }

  return (
    <div className="min-w-0 space-y-5 overflow-hidden">
      <PageHeader
        title="🪙 Spot kaufen & auf eigene Wallet sichern"
        subtitle="Ein geordneter Workflow in 3 Schritten — wähle den für dich passenden Sicherheits-Weg."
      />

      {error && <ErrorBox message={error} />}
      {loading && !data && <Loading />}

      {/* ── Visuell geordnete 3-Wege-Auswahl ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <PathCard
          active={activePath === 'guided_cex'}
          onClick={() => setActivePath('guided_cex')}
          badge="EMPFOHLEN · MAXIMALE KEY-SICHERHEIT"
          badgeColor="var(--color-pos)"
          title="🏦 Weg A: CEX-Spot + Geführter Transfer"
          summary="Spot in der App kaufen (Paper oder Live) → Zieladresse & exakte Menge kopieren → mit 2FA auf der Börse absenden → App bestätigt den echten Blockchain-Eingang automatisch."
          pros={[
            'API-Key braucht KEIN Withdraw-Recht',
            'Netzwerk-Kompatibilitäts-Prüfung vorab',
            'Automatischer Live-On-Chain-Eingangscheck',
          ]}
        />
        <PathCard
          active={activePath === 'dex_direct'}
          onClick={() => setActivePath('dex_direct')}
          badge="ON-CHAIN · 0 BÖRSEN-ZWISCHENSCHRITT"
          badgeColor="var(--color-cyan)"
          title="⚡ Weg B: DEX-Direktkauf in deine Wallet"
          summary="Tausche USDC / SOL / ETH über Jupiter (Solana) oder KyberSwap (Ethereum, Arbitrum, Base, BSC) direkt on-chain — der gekaufte Coin liegt sofort in deiner eigenen Wallet."
          pros={[
            'Kein CEX-Auszahlungs-Schritt nötig',
            'Echte Aggregator-Routen + Honeypot-Gate',
            'Sofort im eigenen Self-Custody-Bestand',
          ]}
        />
        <PathCard
          active={activePath === 'api_withdraw'}
          onClick={() => setActivePath('api_withdraw')}
          badge="1-KLICK · 4-STUFEN-WHITELIST-GATE"
          badgeColor="#f59e0b"
          title="🔐 Weg C: CEX-Spot + Whitelist-API-Transfer"
          summary="Spot kaufen und direkt per API an deine freigegebene Cold-/Hardware-Wallet auszahlen — streng abgeriegelt (nur eigene Whitelist-Wallets, 0 Zugriff für KI/Agenten)."
          pros={[
            'Nur an Wallets mit WALLET-FREIGABE',
            'Manuelle Bestätigung je Transfer Pflicht',
            'Auf Börse IP- & Adress-Whitelist nutzen!',
          ]}
        />
      </div>

      {/* ── Visuelle Schritt-für-Schritt-Leiste ── */}
      <div className="glass min-w-0 p-3.5">
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: 'rgba(6,182,212,0.4)' }}>
            <span className="num rounded-full px-2 py-0.5 font-bold" style={{ background: 'rgba(6,182,212,0.18)', color: 'var(--color-cyan)' }}>1</span>
            <div>
              <p className="font-medium">Ziel-Wallet &amp; Netzwerk</p>
              <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>Eigene Adresse hinterlegen &amp; prüfen</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: 'rgba(167,139,250,0.4)' }}>
            <span className="num rounded-full px-2 py-0.5 font-bold" style={{ background: 'rgba(167,139,250,0.18)', color: 'var(--color-violet)' }}>2</span>
            <div>
              <p className="font-medium">Spot ohne Hebel kaufen</p>
              <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>Paper-Übung oder echte Börsen-Order</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: 'rgba(16,185,129,0.4)' }}>
            <span className="num rounded-full px-2 py-0.5 font-bold" style={{ background: 'rgba(16,185,129,0.18)', color: 'var(--color-pos)' }}>3</span>
            <div>
              <p className="font-medium">Auf Wallet bewegen &amp; prüfen</p>
              <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>Transfer + echter Blockchain-Beleg</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── WEG B: DEX-Direktkauf Ansicht ── */}
      {activePath === 'dex_direct' && data && (
        <Panel label="⚡ Weg B — On-Chain DEX-Direktkauf (Sofort in deiner eigenen Wallet)">
          <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            Beim DEX-Direktkauf brauchst du gar keine Börsen-Auszahlung: Der Swap läuft direkt über Jupiter (Solana) bzw.
            KyberSwap (Ethereum, Arbitrum, Base, BSC) in deine Wallet. Wähle unten ein verifiziertes Spot-Asset (kopiert
            automatisch die geprüfte Contract-Adresse) und öffne das DEX-Swap-Ticket.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {data.dexPresets.map((p) => (
              <div
                key={`${p.chain}:${p.symbol}`}
                className="rounded-[0.625rem] border p-3 text-xs space-y-2"
                style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{p.symbol}</span>
                  <span className="rounded-full px-2 py-0.5 text-[10px] uppercase" style={{ background: 'rgba(6,182,212,0.14)', color: 'var(--color-cyan)' }}>
                    {p.chain}
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>{p.name}</p>
                <p className="mono truncate text-[10px]" style={{ color: 'var(--color-mut)' }} title={p.tokenAddress}>
                  {p.tokenAddress}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => copyText(`dex:${p.symbol}`, p.tokenAddress)}
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                  >
                    {copiedKey === `dex:${p.symbol}` ? '✓ Adresse kopiert' : '📋 Adresse'}
                  </button>
                  <a
                    href="#/traden?tab=wallet"
                    onClick={() => copyText(`dex:${p.symbol}`, p.tokenAddress)}
                    className="rounded border px-2.5 py-1 text-[11px] font-medium"
                    style={{ borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.14)', color: 'var(--color-ink)' }}
                  >
                    ⚡ Im DEX-Ticket kaufen →
                  </a>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ── WEG A & WEG C: Schritt 1 (Ziel-Wallet-Adressbuch) + Schritt 2 (Spot-Kauf) ── */}
      {activePath !== 'dex_direct' && data && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Linke Spalte: Ziel-Wallet-Adressbuch */}
          <div className="min-w-0 lg:col-span-5">
            <Panel label={`① Dein Ziel-Wallet-Adressbuch (${data.addressBook.length})`}>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                  Nur öffentliche Empfängeradressen (Ledger, Phantom, MetaMask…). Nie Private Keys!
                </p>
                <button
                  type="button"
                  onClick={() => setShowAddWallet((s) => !s)}
                  className="shrink-0 rounded-[0.5rem] border px-2.5 py-1 text-xs font-medium"
                  style={{ borderColor: 'var(--color-cyan)', color: 'var(--color-cyan)' }}
                >
                  {showAddWallet ? 'Schließen' : '+ Ziel-Wallet'}
                </button>
              </div>

              {showAddWallet && (
                <div className="mt-3 rounded-[0.625rem] border p-3 space-y-2.5 text-xs" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.45)' }}>
                  <label className="block">
                    <span className="label block">Name (z. B. Ledger BTC, Phantom Cold)</span>
                    <input
                      value={wLabel}
                      onChange={(e) => setWLabel(e.target.value)}
                      placeholder="Mein Ledger BTC"
                      className="field mt-1 w-full px-2.5 py-1.5 text-xs"
                    />
                  </label>
                  <label className="block">
                    <span className="label block">Blockchain / Netzwerk</span>
                    <select
                      value={wNetwork}
                      onChange={(e) => setWNetwork(e.target.value as NetworkId)}
                      className="field mt-1 w-full px-2.5 py-1.5 text-xs"
                    >
                      {data.networks.map((n) => (
                        <option key={n.id} value={n.id}>{n.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label block">Öffentliche Empfänger-Adresse</span>
                    <input
                      value={wAddress}
                      onChange={(e) => setWAddress(e.target.value)}
                      placeholder={data.networks.find((n) => n.id === wNetwork)?.addressExample ?? ''}
                      className="field mono mt-1 w-full px-2.5 py-1.5 text-xs"
                    />
                  </label>
                  <label className="block">
                    <span className="label block">Memo / Tag (nur falls nötig, sonst leer)</span>
                    <input
                      value={wMemo}
                      onChange={(e) => setWMemo(e.target.value)}
                      className="field mt-1 w-full px-2.5 py-1.5 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={walletBusy || wLabel.trim().length < 2 || wAddress.trim().length < 10}
                    onClick={() => void handleAddWallet()}
                    className="w-full rounded-[0.5rem] border py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ borderColor: 'var(--color-pos)', background: 'rgba(16,185,129,0.18)', color: 'var(--color-ink)' }}
                  >
                    {walletBusy ? '⏳ Prüft Adresse…' : '💾 Adresse prüfen & speichern'}
                  </button>
                </div>
              )}

              {data.addressBook.length === 0 ? (
                <div className="mt-3">
                  <Empty text="Noch keine Ziel-Wallet hinterlegt. Klicke oben auf „+ Ziel-Wallet“, um z. B. deine Ledger- oder Phantom-Adresse einzutragen." />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {data.addressBook.map((w) => {
                    const selected = w.id === destWalletId;
                    return (
                      <li
                        key={w.id}
                        onClick={() => setDestWalletId(w.id)}
                        className="cursor-pointer rounded-[0.625rem] border p-3 text-xs space-y-1.5 transition-colors"
                        style={
                          selected
                            ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.1)' }
                            : { borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.28)' }
                        }
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <span className="font-semibold">
                            {selected ? '● ' : '○ '}
                            {w.label}{' '}
                            <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(148,163,184,0.16)', color: 'var(--color-cyan)' }}>
                              {w.network}
                            </span>
                          </span>
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px]"
                            style={
                              w.isWhitelisted
                                ? { background: 'rgba(16,185,129,0.16)', color: 'var(--color-pos)' }
                                : { background: 'rgba(148,163,184,0.14)', color: 'var(--color-mut)' }
                            }
                          >
                            {w.isWhitelisted ? '🔐 Whitelist aktiv' : 'Nur Weg A (noch nicht Weg C)'}
                          </span>
                        </div>

                        <p className="mono break-all text-[11px]" style={{ color: 'var(--color-mut)' }}>
                          {w.address}
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleCheckWalletBal(w.id);
                              }}
                              className="rounded border px-2 py-0.5 text-[11px]"
                              style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                            >
                              🔍 Saldo {liveBalById[w.id] ? `(${liveBalById[w.id]})` : 'prüfen'}
                            </button>
                            <a
                              href={w.explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border px-2 py-0.5 text-[11px]"
                              style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
                            >
                              Explorer ↗
                            </a>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteWallet(w.id);
                            }}
                            className="text-[11px]"
                            style={{ color: 'var(--color-neg)' }}
                          >
                            Entfernen
                          </button>
                        </div>

                        {/* Whitelist-Freigabe für Weg C */}
                        {!w.isWhitelisted && activePath === 'api_withdraw' && (
                          <div
                            className="mt-2 rounded border p-2 space-y-1.5"
                            style={{ borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(2,6,23,0.45)' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <p className="text-[11px]" style={{ color: '#fbbf24' }}>
                              Für Weg C einmalig freigeben — tippe exakt: <strong className="mono">{w.approvalPhraseExpected}</strong>
                            </p>
                            <div className="flex gap-1.5">
                              <input
                                value={approvePhraseById[w.id] ?? ''}
                                onChange={(e) => setApprovePhraseById((prev) => ({ ...prev, [w.id]: e.target.value }))}
                                placeholder={w.approvalPhraseExpected}
                                className="field mono flex-1 px-2 py-1 text-[11px]"
                              />
                              <button
                                type="button"
                                disabled={walletBusy}
                                onClick={() => void handleApproveWallet(w.id)}
                                className="rounded border px-2.5 py-1 text-[11px] font-medium"
                                style={{ borderColor: '#f59e0b', color: '#fbbf24' }}
                              >
                                Freigeben
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>

          {/* Rechte Spalte: CEX-Spot-Kauf-Ticket */}
          <div className="min-w-0 lg:col-span-7">
            <Panel label="② Spot kaufen (ohne Hebel, echte Live-Kurse)">
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_BASE_COINS.map((base) => {
                    const pair = `${base}/${quoteCurrency}`;
                    return (
                      <button
                        key={base}
                        type="button"
                        onClick={() => setSymbol(pair)}
                        className="rounded border px-2.5 py-1 text-xs transition-colors"
                        style={
                          symbol.startsWith(`${base}/`)
                            ? { borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.16)', color: 'var(--color-ink)' }
                            : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                        }
                      >
                        {base}
                      </button>
                    );
                  })}
                </div>

                {/* Quote-Währung (USDT / USDC / EUR) + Paper vs. Live Umschalter */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex rounded-lg border p-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)' }} title="Kaufwährung (USDT, USDC oder EUR)">
                    {QUOTE_CURRENCIES.map((qc) => (
                      <button
                        key={qc}
                        type="button"
                        onClick={() => selectQuoteCurrency(qc)}
                        className="rounded-md px-2 py-0.5 font-medium"
                        style={quoteCurrency === qc ? { background: 'rgba(167,139,250,0.2)', color: 'var(--color-ink)' } : { color: 'var(--color-mut)' }}
                      >
                        {qc}
                      </button>
                    ))}
                  </div>
                  <div className="flex rounded-lg border p-0.5 text-xs" style={{ borderColor: 'var(--color-line)' }}>
                    <button
                      type="button"
                      onClick={() => setMode('paper')}
                      className="rounded-md px-2.5 py-1 font-medium"
                      style={mode === 'paper' ? { background: 'rgba(6,182,212,0.18)', color: 'var(--color-cyan)' } : { color: 'var(--color-mut)' }}
                    >
                      🧪 Paper-Übung
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('live')}
                      className="rounded-md px-2.5 py-1 font-medium"
                      style={mode === 'live' ? { background: 'rgba(245,158,11,0.2)', color: '#fbbf24' } : { color: 'var(--color-mut)' }}
                    >
                      ● Live-Börse
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="label block">Spot-Paar</span>
                  <input
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    placeholder="BTC/USDT"
                    className="field mt-1 w-full px-3 py-1.5 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="label block">Kaufbetrag ({symbol.split('/')[1] ?? 'USDT'})</span>
                  <input
                    type="number"
                    min={5}
                    step="any"
                    value={quoteAmountStr}
                    onChange={(e) => setQuoteAmountStr(e.target.value)}
                    className="field num mt-1 w-full px-3 py-1.5 text-sm"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {QUICK_AMOUNTS.map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setQuoteAmountStr(String(amt))}
                        className="rounded border px-2 py-0.5 text-[11px]"
                        style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                      >
                        {amt}
                      </button>
                    ))}
                  </div>
                </label>
              </div>

              {mode === 'live' && (
                <div className="mt-3">
                  <span className="label block">Verbundene Live-Börse</span>
                  {data.connections.length === 0 ? (
                    <p className="mt-1 text-xs" style={{ color: 'var(--color-warn)' }}>
                      Noch keine aktive Börse verbunden — bitte unter{' '}
                      <a href="#/einstellungen?tab=boersen" className="underline" style={{ color: 'var(--color-cyan)' }}>
                        #/einstellungen?tab=boersen
                      </a>{' '}
                      verbinden (oder oben Paper-Übung wählen).
                    </p>
                  ) : (
                    <select
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                      className="field mt-1 w-full px-3 py-1.5 text-xs"
                    >
                      {data.connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.exchangeName}
                          {c.label ? ` (${c.label})` : ''} — {c.mode === 'trading' ? 'Trading' : 'nur lesend'} ·{' '}
                          {c.hasLiveApproval ? 'LIVE-FREIGABE aktiv' : 'ohne LIVE-FREIGABE'}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Ziel-Wallet Zuordnung + Netzwerk-Kompatibilitäts-Ampel */}
              <div className="mt-3 rounded-[0.625rem] border p-3 text-xs space-y-2" style={{ borderColor: 'var(--color-line)', background: 'rgba(2,6,23,0.4)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="label">Ziel-Wallet für Schritt 3:</span>
                  <span className="font-medium" style={{ color: selectedWallet ? 'var(--color-cyan)' : 'var(--color-warn)' }}>
                    {selectedWallet ? `${selectedWallet.label} (${selectedWallet.network})` : 'Keine Ziel-Wallet ausgewählt (links wählen/anlegen)'}
                  </span>
                </div>

                {quote && (
                  <div className="grid grid-cols-3 gap-2 border-t pt-2 num" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
                    <div>
                      <span className="label block">Live-Ask</span>
                      <span>{fmtNum(quote.askPrice, quote.askPrice >= 100 ? 2 : 4)} {quote.quoteAsset}</span>
                    </div>
                    <div>
                      <span className="label block">Gesch. Gebühr</span>
                      <span>{fmtNum(quote.feeQuote, 2)} {quote.quoteAsset}</span>
                    </div>
                    <div>
                      <span className="label block">Netto-Menge</span>
                      <span className="font-semibold" style={{ color: 'var(--color-pos)' }}>
                        ≈ {fmtNum(quote.estBaseQty, 6)} {quote.baseAsset}
                      </span>
                    </div>
                  </div>
                )}

                {quote?.compatibility && !quote.compatibility.compatible && (
                  <p className="rounded border px-2.5 py-1.5 text-[11px]" style={{ borderColor: 'var(--color-neg)', color: 'var(--color-neg)' }}>
                    ⛔ Ketten-Schutz: {quote.compatibility.warning}
                  </p>
                )}
                {quote?.compatibility && quote.compatibility.compatible && quote.compatibility.warning && (
                  <p className="rounded border px-2.5 py-1.5 text-[11px]" style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}>
                    ⚠️ {quote.compatibility.warning}
                  </p>
                )}

                {/* Aufklappbarer Live-Spot-Börsenvergleich */}
                <div className="border-t pt-2" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
                  <button
                    type="button"
                    onClick={() => setShowCompare((s) => !s)}
                    className="flex w-full items-center justify-between text-[11px] font-medium"
                    style={{ color: 'var(--color-cyan)' }}
                  >
                    <span>⚖️ Spot-Börsenvergleich für {symbol} ({quoteAmount} {symbol.split('/')[1] ?? 'USDT'})</span>
                    <span>{showCompare ? '▲ Ausblenden' : '▼ Beste Börse vergleichen'}</span>
                  </button>
                  {showCompare && (
                    <div className="mt-2 overflow-x-auto">
                      {compareRows.length === 0 ? (
                        <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>Lädt echte Börsenkurse…</p>
                      ) : (
                        <table className="w-full text-left text-[11px] num">
                          <thead>
                            <tr style={{ color: 'var(--color-mut)' }}>
                              <th className="py-1 pr-2">Börse</th>
                              <th className="py-1 pr-2">Ask</th>
                              <th className="py-1 pr-2">Gebühr</th>
                              <th className="py-1 pr-2">Netto-Erhalt</th>
                              <th className="py-1">Abstand</th>
                            </tr>
                          </thead>
                          <tbody>
                            {compareRows.map((r) => (
                              <tr
                                key={r.exchangeId}
                                onClick={() => {
                                  if (r.connectionId) {
                                    setConnectionId(r.connectionId);
                                    setMode('live');
                                  }
                                }}
                                className={r.connectionId ? 'cursor-pointer hover:opacity-90' : ''}
                                style={{ borderTop: '1px solid rgba(148,163,184,0.1)' }}
                              >
                                <td className="py-1 pr-2 font-medium">
                                  {r.exchangeName}
                                  {r.isBest && (
                                    <span className="ml-1 rounded px-1 py-0.5 text-[9px]" style={{ background: 'rgba(16,185,129,0.18)', color: 'var(--color-pos)' }}>
                                      BESTER
                                    </span>
                                  )}
                                  {r.connected && (
                                    <span className="ml-1 rounded px-1 py-0.5 text-[9px]" style={{ background: 'rgba(6,182,212,0.16)', color: 'var(--color-cyan)' }}>
                                      verbunden
                                    </span>
                                  )}
                                </td>
                                <td className="py-1 pr-2">
                                  {r.askPrice !== null ? fmtNum(r.askPrice, r.askPrice >= 100 ? 2 : 4) : '—'}
                                </td>
                                <td className="py-1 pr-2">
                                  {(r.takerFeeRate * 100).toFixed(2)} %
                                </td>
                                <td className="py-1 pr-2 font-semibold" style={{ color: r.isBest ? 'var(--color-pos)' : 'var(--color-ink)' }}>
                                  {r.estBaseQty !== null ? `${fmtNum(r.estBaseQty, 6)} ${symbol.split('/')[0]}` : 'nicht gelistet'}
                                </td>
                                <td className="py-1" style={{ color: r.isBest ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                                  {r.diffPctFromBest === null ? '—' : r.isBest ? '0,00 %' : `−${r.diffPctFromBest.toFixed(2)} %`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                disabled={
                  buying ||
                  quoteAmount <= 0 ||
                  Boolean(quote?.compatibility && !quote.compatibility.compatible) ||
                  (activePath === 'api_withdraw' && (!selectedWallet || !selectedWallet.isWhitelisted))
                }
                onClick={() => void handleBuySpot()}
                className="mt-4 w-full rounded-[0.625rem] border py-2.5 text-sm font-semibold transition-colors disabled:opacity-45"
                style={{ borderColor: 'var(--color-pos)', background: 'rgba(16,185,129,0.2)', color: 'var(--color-ink)' }}
              >
                {buying
                  ? '⏳ Führt Spot-Kauf aus…'
                  : activePath === 'api_withdraw' && selectedWallet && !selectedWallet.isWhitelisted
                    ? '🔐 Bitte links zuerst Ziel-Wallet per WALLET-FREIGABE freischalten'
                    : `🪙 Jetzt ${symbol.split('/')[0]} Spot kaufen (${mode === 'paper' ? 'Paper-Übung' : 'LIVE'}) & Workflow starten`}
              </button>

              {buyFeedback && (
                <p className="mt-2.5 rounded border px-3 py-2 text-xs" style={{ borderColor: 'rgba(16,185,129,0.45)', color: 'var(--color-pos)' }}>
                  {buyFeedback}
                </p>
              )}
            </Panel>
          </div>
        </div>
      )}

      {/* ── SCHRITT 3: Laufende & abgeschlossene Spot-→-Wallet-Workflows ── */}
      {data && (
        <Panel label={`③ Deine Spot-&-Wallet-Workflows (${data.workflows.length})`}>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
            ⚡ <strong style={{ color: 'var(--color-ink)' }}>Automatischer On-Chain-Wächter aktiv:</strong> Offene Transfers werden im Hintergrund alle 2 Minuten gegen die Blockchain (Bitcoin, Solana + SPL, Ethereum/Arbitrum/Base/BSC/Polygon) geprüft und senden dir bei Eingang automatisch eine Benachrichtigung.
          </p>
          {data.workflows.length === 0 ? (
            <Empty text="Noch kein Spot-Workflow gestartet. Kaufe oben in Schritt ② deinen ersten Spot-Bestand (gern zuerst im Paper-Modus zum Durchspielen!)." />
          ) : (
            <ul className="mt-3 space-y-3">
              {data.workflows.map((wf) => {
                const st = STAGE_META[wf.stage] ?? STAGE_META.bought!;
                const busy = wfBusyId === wf.id;
                const qtyStr = wf.filledBaseQty !== null ? wf.filledBaseQty.toFixed(6) : '—';

                return (
                  <li
                    key={wf.id}
                    className="rounded-[0.625rem] border p-3.5 space-y-2.5 text-xs"
                    style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm">
                          {qtyStr} {wf.baseAsset}
                        </span>
                        <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                          ({fmtNum(wf.quoteAmount, 2)} {wf.quoteAsset} @ {wf.avgFillPrice !== null ? fmtNum(wf.avgFillPrice, 2) : '—'} · {wf.exchangeName})
                        </span>
                        <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: st.bg, color: st.color }}>
                          {st.label}
                        </span>
                        <span className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                          {wf.path === 'api_withdraw' ? '🔐 Weg C (API)' : '🏦 Weg A (Geführt)'} · {wf.mode.toUpperCase()}
                        </span>
                      </div>
                      <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                        {new Date(wf.createdAt).toLocaleString(appLocale())}
                      </span>
                    </div>

                    {/* Visueller 3-Stufen-Balken */}
                    <div className="grid grid-cols-3 gap-1.5">
                      {[1, 2, 3].map((stepNum) => (
                        <div
                          key={stepNum}
                          className="h-1.5 rounded-full"
                          style={{
                            background: st.step >= stepNum ? st.color : 'rgba(148,163,184,0.16)',
                          }}
                        />
                      ))}
                    </div>

                    {wf.destinationAddress && wf.destinationNetwork && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-2" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.38)' }}>
                        <div className="min-w-0">
                          <span className="label mr-2">Ziel ({wf.destinationNetwork}):</span>
                          <span className="mono break-all text-[11px]">{wf.destinationAddress}</span>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => copyText(`addr:${wf.id}`, wf.destinationAddress!)}
                            className="rounded border px-2 py-0.5 text-[11px]"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                          >
                            {copiedKey === `addr:${wf.id}` ? '✓ Kopiert' : '📋 Adresse'}
                          </button>
                          <button
                            type="button"
                            onClick={() => copyText(`qty:${wf.id}`, qtyStr)}
                            className="rounded border px-2 py-0.5 text-[11px]"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                          >
                            {copiedKey === `qty:${wf.id}` ? '✓ Kopiert' : '📋 Menge'}
                          </button>
                          {wf.explorerUrl && (
                            <a
                              href={wf.explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded border px-2 py-0.5 text-[11px]"
                              style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
                            >
                              Explorer ↗
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    {wf.statusNote && (
                      <p style={{ color: wf.stage === 'onchain_confirmed' ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                        {wf.statusNote}
                      </p>
                    )}

                    {/* Aktionsleiste für offene Transfers */}
                    {wf.stage !== 'onchain_confirmed' && wf.destinationAddress && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {wf.path === 'guided_cex' && (
                          <>
                            {wf.exchangeWithdrawLink && (
                              <a
                                href={wf.exchangeWithdrawLink}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded border px-2.5 py-1 text-xs font-medium"
                                style={{ borderColor: 'var(--color-cyan)', color: 'var(--color-cyan)' }}
                              >
                                🏦 Börsen-Auszahlung öffnen ↗
                              </a>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleMarkSent(wf.id)}
                              className="rounded border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                              style={{ borderColor: 'rgba(16,185,129,0.5)', color: 'var(--color-pos)' }}
                            >
                              ✓ Auf Börse gesendet
                            </button>
                          </>
                        )}

                        {wf.path === 'api_withdraw' && wf.stage !== 'withdrawn' && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <input
                              value={confirmWithdrawById[wf.id] ?? ''}
                              onChange={(e) => setConfirmWithdrawById((prev) => ({ ...prev, [wf.id]: e.target.value }))}
                              placeholder={data.withdrawConfirmPhrase}
                              className="field mono px-2.5 py-1 text-xs"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleApiWithdraw(wf.id)}
                              className="rounded border px-3 py-1 text-xs font-semibold disabled:opacity-50"
                              style={{ borderColor: '#f59e0b', background: 'rgba(245,158,11,0.18)', color: '#fbbf24' }}
                            >
                              {busy ? '⏳ Sendet…' : '🔐 Jetzt per API an Whitelist-Wallet senden'}
                            </button>
                          </div>
                        )}

                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleCheckArrival(wf.id)}
                          className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                          style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                        >
                          {busy ? '⏳ Prüft Blockchain…' : '🔍 On-Chain-Eingang live prüfen'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}

function PathCard({
  active,
  onClick,
  badge,
  badgeColor,
  title,
  summary,
  pros,
}: {
  active: boolean;
  onClick: () => void;
  badge: string;
  badgeColor: string;
  title: string;
  summary: string;
  pros: string[];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass min-w-0 p-4 text-left transition-all"
      style={
        active
          ? { borderColor: badgeColor, boxShadow: `0 0 0 1px ${badgeColor}` }
          : { borderColor: 'var(--color-line)', opacity: 0.85 }
      }
    >
      <span
        className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={{ background: 'rgba(15,23,42,0.7)', color: badgeColor }}
      >
        {badge}
      </span>
      <h3 className="mt-2 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {summary}
      </p>
      <ul className="mt-2.5 space-y-1 text-[11px]">
        {pros.map((p) => (
          <li key={p} className="flex items-center gap-1.5">
            <span style={{ color: badgeColor }}>✓</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}
