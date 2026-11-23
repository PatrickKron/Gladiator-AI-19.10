import { useEffect, useState } from 'react';
import {
  FUNDED_PROVIDER_PRESETS,
  type FundedPhase,
  type FundedProvider,
  type FundedProviderPreset,
} from '@gladiator/risk';
import { trpc } from '../api.js';
import { Panel } from './ui.js';
import { appLocale } from '../lib/locale.js';

/**
 * Fremdgeldkonten (Welle 22): Prop-Firm- & Drittkapital-Konten (FTMO, Topstep,
 * Apex, FundedNext, The5ers, CCXT-Subaccounts oder eigene Anbieter).
 * Strikt getrennt von Eigengeld, keine Auszahlungen/Transfers.
 */

type FundedRow = Awaited<ReturnType<typeof trpc.fundedAccounts.list.query>>[number];
type ExchangeConn = Awaited<ReturnType<typeof trpc.exchanges.list.query>>[number];

const PHASE_LABEL: Record<string, string> = {
  challenge_1: 'Challenge Phase 1',
  challenge_2: 'Challenge Phase 2',
  funded: 'Funded (Fremdkapital)',
  subaccount: 'Börsen-Subaccount',
};

const STATE_STYLE: Record<'safe' | 'caution' | 'breached', { label: string; color: string }> = {
  safe: { label: '✓ Regeln sicher', color: 'var(--color-pos)' },
  caution: { label: '⚠ Puffer eng', color: 'var(--color-warn)' },
  breached: { label: '✕ Limit verletzt', color: 'var(--color-neg)' },
};

function money(val: number, cur: 'USD' | 'EUR'): string {
  const sym = cur === 'EUR' ? '€' : '$';
  return `${val.toLocaleString(appLocale(), { maximumFractionDigits: 0 })} ${sym}`;
}

export function FundedAccountsPanel({ className = 'mt-5' }: { className?: string }) {
  const [rows, setRows] = useState<FundedRow[] | null>(null);
  const [connections, setConnections] = useState<ExchangeConn[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncId, setSyncId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Formular-State
  const [provider, setProvider] = useState<FundedProvider>('ftmo');
  const [name, setName] = useState('FTMO 100k Challenge');
  const [phase, setPhase] = useState<FundedPhase>('challenge_1');
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD');
  const [startBalance, setStartBalance] = useState(100_000);
  const [currentEquity, setCurrentEquity] = useState(100_000);
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState(5);
  const [maxTotalDrawdownPct, setMaxTotalDrawdownPct] = useState(10);
  const [profitTargetPct, setProfitTargetPct] = useState<string>('10');
  const [payoutSplitPct, setPayoutSplitPct] = useState(80);
  const [trailingDrawdown, setTrailingDrawdown] = useState(false);
  const [exchangeConnectionId, setExchangeConnectionId] = useState<string>('');
  const [notes, setNotes] = useState('');

  // Inline Equity-Edit pro Konto
  const [editEquity, setEditEquity] = useState<Record<string, string>>({});

  async function load() {
    try {
      const [list, conns] = await Promise.all([
        trpc.fundedAccounts.list.query(),
        trpc.exchanges.list.query().catch(() => [] as ExchangeConn[]),
      ]);
      setRows(list);
      setConnections(conns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fremdgeldkonten konnten nicht geladen werden.');
      setRows([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function applyPreset(p: FundedProviderPreset) {
    setProvider(p.provider);
    setName(`${p.label.split(' (')[0]} ${Math.round(p.defaultStartBalance / 1000)}k`);
    setPhase(p.defaultPhase);
    setCurrency(p.currency);
    setStartBalance(p.defaultStartBalance);
    setCurrentEquity(p.defaultStartBalance);
    setDailyLossLimitPct(p.dailyLossLimitPct);
    setMaxTotalDrawdownPct(p.maxTotalDrawdownPct);
    setProfitTargetPct(p.profitTargetPct === null ? '' : String(p.profitTargetPct));
    setPayoutSplitPct(p.payoutSplitPct);
    setTrailingDrawdown(p.trailingDrawdown);
    setShowForm(true);
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const targetNum = profitTargetPct.trim() ? Number(profitTargetPct) : null;
      await trpc.fundedAccounts.create.mutate({
        name: name.trim(),
        provider,
        phase,
        currency,
        startBalance: Number(startBalance),
        currentEquity: Number(currentEquity),
        dailyLossLimitPct: Number(dailyLossLimitPct),
        maxTotalDrawdownPct: Number(maxTotalDrawdownPct),
        profitTargetPct: targetNum !== null && Number.isFinite(targetNum) ? targetNum : null,
        payoutSplitPct: Number(payoutSplitPct),
        trailingDrawdown,
        exchangeConnectionId: exchangeConnectionId || null,
        notes: notes.trim() || undefined,
      });
      setOkMsg(`Fremdgeldkonto „${name.trim()}“ angelegt.`);
      setShowForm(false);
      setNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function saveEquity(row: FundedRow, resetDailyStart = false) {
    const raw = editEquity[row.id];
    const parsed = raw !== undefined && raw.trim() !== '' ? Number(raw) : row.currentEquity;
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setBusy(true);
    setError(null);
    try {
      await trpc.fundedAccounts.update.mutate({
        id: row.id,
        currentEquity: parsed,
        resetDailyStart,
      });
      setOkMsg(resetDailyStart ? `Tagesstart für „${row.name}“ zurückgesetzt.` : `Stand für „${row.name}“ aktualisiert.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aktualisierung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function syncExchange(row: FundedRow) {
    setSyncId(row.id);
    setError(null);
    try {
      const updated = await trpc.fundedAccounts.syncFromExchange.mutate({ id: row.id });
      setOkMsg(`Live-Stand synchronisiert: ${money(updated.currentEquity, updated.currency)}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Börsen-Sync fehlgeschlagen.');
    } finally {
      setSyncId(null);
    }
  }

  async function removeAccount(row: FundedRow) {
    setBusy(true);
    setError(null);
    try {
      await trpc.fundedAccounts.remove.mutate({ id: row.id });
      setOkMsg(`Fremdgeldkonto „${row.name}“ entfernt.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label="🏦 Fremdgeldkonten (Prop-Firm & Drittkapital)" stagger={4} className={`${className} min-w-0 overflow-hidden`}>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          Binde Fremdkapital-Konten (z. B. FTMO, Topstep, Apex, FundedNext, The5ers oder einen verknüpften
          CCXT-Börsen-Subaccount) an — strikt getrennt von deinem Eigengeld. Gladiator überwacht Tagesverlust,
          Gesamt-/Trailing-Drawdown, Ziel-Fortschritt und empfiehlt automatisch ein passendes Risiko je Trade.
          Keine Auszahlungen oder Transfers.
        </p>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-primary shrink-0 px-3.5 py-2 text-xs font-medium"
        >
          {showForm ? 'Formular schließen' : '+ Fremdgeldkonto anbinden'}
        </button>
      </div>

      {/* Schnell-Vorlagen */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {FUNDED_PROVIDER_PRESETS.map((p) => (
          <button
            key={p.provider}
            type="button"
            onClick={() => applyPreset(p)}
            className="rounded border px-2 py-1 text-[11px] transition-colors hover:border-[var(--color-cyan)]"
            style={{
              borderColor: showForm && provider === p.provider ? 'var(--color-cyan)' : 'var(--color-line)',
              color: showForm && provider === p.provider ? 'var(--color-cyan)' : 'var(--color-mut)',
            }}
          >
            + {p.label.split(' (')[0]}
          </button>
        ))}
      </div>

      {okMsg && <p className="mt-3 text-xs font-medium" style={{ color: 'var(--color-pos)' }}>✓ {okMsg}</p>}
      {error && <p className="mt-3 text-xs font-medium" style={{ color: 'var(--color-neg)' }}>{error}</p>}

      {showForm && (
        <form
          onSubmit={(e) => void createAccount(e)}
          className="mt-4 grid gap-3 rounded-[0.625rem] border p-4 text-xs sm:grid-cols-2 lg:grid-cols-3"
          style={{ borderColor: 'rgba(6,182,212,0.4)', background: 'rgba(15,23,42,0.45)' }}
        >
          <label className="flex flex-col gap-1">
            <span className="label">Kontoname</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="field px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Anbieter</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as FundedProvider)} className="field px-2.5 py-1.5 text-xs">
              {FUNDED_PROVIDER_PRESETS.map((p) => (
                <option key={p.provider} value={p.provider}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Phase / Typ</span>
            <select value={phase} onChange={(e) => setPhase(e.target.value as FundedPhase)} className="field px-2.5 py-1.5 text-xs">
              {Object.entries(PHASE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Startkapital</span>
            <input type="number" min={100} step={100} value={startBalance} onChange={(e) => setStartBalance(Number(e.target.value))} required className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Aktuelles Guthaben</span>
            <input type="number" min={0} step={10} value={currentEquity} onChange={(e) => setCurrentEquity(Number(e.target.value))} required className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Währung</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'EUR')} className="field px-2.5 py-1.5 text-xs">
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Max. Tagesverlust (%)</span>
            <input type="number" min={0.5} max={50} step={0.5} value={dailyLossLimitPct} onChange={(e) => setDailyLossLimitPct(Number(e.target.value))} className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Max. Gesamt-Drawdown (%)</span>
            <input type="number" min={1} max={80} step={0.5} value={maxTotalDrawdownPct} onChange={(e) => setMaxTotalDrawdownPct(Number(e.target.value))} className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Profit-Ziel (%) — leer = keins</span>
            <input type="number" min={0.5} max={200} step={0.5} value={profitTargetPct} onChange={(e) => setProfitTargetPct(e.target.value)} placeholder="z. B. 10" className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Gewinnanteil / Split (%)</span>
            <input type="number" min={0} max={100} step={5} value={payoutSplitPct} onChange={(e) => setPayoutSplitPct(Number(e.target.value))} className="field num px-2.5 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Optionale Börsen-API (Live-Sync)</span>
            <select value={exchangeConnectionId} onChange={(e) => setExchangeConnectionId(e.target.value)} className="field px-2.5 py-1.5 text-xs">
              <option value="">Manuelles Tracking (z. B. MT5/cTrader/TradeLocker)</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.exchangeName} {c.label ? `(${c.label})` : ''} · {c.mode}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-1.5">
            <input type="checkbox" checked={trailingDrawdown} onChange={(e) => setTrailingDrawdown(e.target.checked)} className="h-4 w-4 accent-[var(--color-warn)]" />
            <span>Trailing-Drawdown (ab Hoch)</span>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
            <span className="label">Sonderregeln / Notizen (optional)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z. B. Kein News-Trading ±2 Min., max. 1 % Risiko je Trade" className="field px-2.5 py-1.5 text-xs" />
          </label>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-xs font-medium disabled:opacity-50">
              {busy ? 'Speichere …' : '✓ Fremdgeldkonto speichern'}
            </button>
            <a href="#/einstellungen?tab=boersen" className="text-[11px] underline" style={{ color: 'var(--color-cyan)' }}>
              Neue Börsen-API zuerst verbinden →
            </a>
          </div>
        </form>
      )}

      {/* Liste der angebundenen Fremdgeldkonten */}
      {rows === null ? (
        <p className="mt-4 animate-pulse text-xs" style={{ color: 'var(--color-mut)' }}>Lade Fremdgeldkonten …</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-[0.625rem] border border-dashed p-4 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          Noch kein Fremdgeldkonto angebunden. Klicke oben auf eine Anbieter-Vorlage (FTMO, Topstep, Apex, FundedNext, The5ers oder CCXT-Subaccount) oder auf „+ Fremdgeldkonto anbinden“.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {rows.map((r) => {
            const st = STATE_STYLE[r.evaluation.ruleState];
            const eqVal = editEquity[r.id] ?? String(r.currentEquity);
            return (
              <div
                key={r.id}
                className="min-w-0 rounded-[0.625rem] border p-4 text-xs"
                style={{ borderColor: st.color, background: 'rgba(15,23,42,0.4)' }}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{r.name}</p>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                      {r.provider.toUpperCase()} · {PHASE_LABEL[r.phase] ?? r.phase} · Split {r.payoutSplitPct} %
                      {r.trailingDrawdown ? ' · Trailing-DD' : ''}
                    </p>
                  </div>
                  <span className="shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold" style={{ borderColor: st.color, color: st.color }}>
                    {st.label}
                  </span>
                </div>

                <div className="num mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div>
                    <p className="label">Guthaben</p>
                    <p className="mt-0.5 font-semibold">{money(r.currentEquity, r.currency)}</p>
                  </div>
                  <div>
                    <p className="label">Gesamt-PnL</p>
                    <p className="mt-0.5 font-semibold" style={{ color: r.evaluation.pnlUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {r.evaluation.pnlPct >= 0 ? '+' : ''}{r.evaluation.pnlPct.toFixed(2)} %
                    </p>
                  </div>
                  <div>
                    <p className="label">Tages-Puffer</p>
                    <p className="mt-0.5">{money(r.evaluation.remainingDailyBufferUsd, r.currency)}</p>
                  </div>
                  <div>
                    <p className="label">Empf. Risiko/Trade</p>
                    <p className="mt-0.5 font-semibold" style={{ color: 'var(--color-cyan)' }}>
                      ≤ {r.evaluation.recommendedRiskPerTradePct} %
                    </p>
                  </div>
                </div>

                {r.evaluation.targetProgressPct !== null && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--color-mut)' }}>
                      <span>Ziel-Fortschritt ({r.profitTargetPct} %)</span>
                      <span className="num">{r.evaluation.targetProgressPct.toFixed(1)} %</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>
                      <div
                        className="h-full rounded"
                        style={{ width: `${Math.min(100, r.evaluation.targetProgressPct)}%`, background: 'var(--color-pos)' }}
                      />
                    </div>
                  </div>
                )}

                {r.evaluation.warnings.length > 0 && (
                  <ul className="mt-2.5 space-y-1 text-[11px]" style={{ color: st.color }}>
                    {r.evaluation.warnings.map((w, i) => (
                      <li key={i}>⚠ {w}</li>
                    ))}
                  </ul>
                )}

                {r.notes && (
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    Notiz: {r.notes}
                  </p>
                )}

                {/* Stand aktualisieren / Live-Sync / Löschen */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'rgba(148,163,184,0.15)' }}>
                  <input
                    type="number"
                    step={10}
                    value={eqVal}
                    onChange={(e) => setEditEquity((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    className="field num w-28 px-2 py-1 text-xs"
                    aria-label={`Aktuelles Guthaben für ${r.name}`}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveEquity(r, false)}
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{ borderColor: 'rgba(6,182,212,0.45)', color: 'var(--color-cyan)' }}
                  >
                    Stand speichern
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveEquity(r, true)}
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                    title="Aktuellen Stand als neuen Tagesstart setzen"
                  >
                    Neuer Tag
                  </button>
                  {r.exchangeConnectionId && (
                    <button
                      type="button"
                      disabled={syncId !== null}
                      onClick={() => void syncExchange(r)}
                      className="rounded border px-2 py-1 text-[11px]"
                      style={{ borderColor: 'rgba(34,197,94,0.45)', color: 'var(--color-pos)' }}
                    >
                      {syncId === r.id ? 'Sync …' : '🔄 Börsen-Sync'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeAccount(r)}
                    className="ml-auto text-[11px] underline"
                    style={{ color: 'var(--color-neg)' }}
                  >
                    Entfernen
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
