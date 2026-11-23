import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_HEDGING_CONFIG,
  evaluateAssetHedging,
  evaluateHedging,
  type HedgingConfig,
  type HedgingInstrument,
} from '@gladiator/risk';
import { trpc } from '../api.js';
import { Panel } from './ui.js';

/**
 * Konfigurierbares Portfolio- & Asset-Hedging (Welle 17 + Welle 19):
 * Zeigt den Live-Status gegen echte Marktdaten (VIX, GRS, Drawdown, Exposure),
 * erlaubt bei übergebenem `symbol` die direkte Auswahl der Hedging-Strategie
 * genau für dieses Asset und verlinkt direkt in den Hedging-Designer.
 */

const INSTRUMENT_OPTIONS: Array<{ value: HedgingInstrument; label: string; desc: string }> = [
  { value: 'inverse_perp', label: 'Inverse-Perp Short', desc: 'Gegenposition über Perpetual Futures (z. B. 1× Short)' },
  { value: 'spot_short', label: 'Spot-Short / Margin', desc: 'Direkte Short-Gegenposition auf das Ziel-Asset' },
  { value: 'stablecoin_shift', label: 'Stablecoin-Umschichtung', desc: 'Teilverkauf in USD-Stablecoins bei Auslösung' },
  { value: 'index_hedge', label: 'Index-Hedge (SPY/QQQ)', desc: 'Breite Markt-Absicherung über Leitindex' },
];

export function HedgingConfigPanel({
  symbol,
  vix = null,
  grsLabel = null,
  drawdownPct = null,
  netExposureUsd = 0,
  className = 'mt-5',
}: {
  symbol?: string;
  vix?: number | null;
  grsLabel?: string | null;
  drawdownPct?: number | null;
  netExposureUsd?: number;
  className?: string;
}) {
  const [cfg, setCfg] = useState<HedgingConfig>(DEFAULT_HEDGING_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hedgeBusy, setHedgeBusy] = useState(false);
  const [hedgeMsg, setHedgeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void trpc.settings.get
      .query()
      .then((res) => {
        if (!cancelled && res.hedging) {
          setCfg(res.hedging);
        }
        if (!cancelled) setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const assetEval = useMemo(
    () =>
      symbol
        ? evaluateAssetHedging(cfg, symbol, { drawdownPct, vix, grsLabel, netExposureUsd })
        : null,
    [cfg, symbol, drawdownPct, vix, grsLabel, netExposureUsd],
  );

  const evaluation = useMemo(
    () =>
      assetEval
        ? assetEval.evaluation
        : evaluateHedging(cfg, {
            drawdownPct,
            vix,
            grsLabel,
            netExposureUsd,
          }),
    [assetEval, cfg, drawdownPct, vix, grsLabel, netExposureUsd],
  );

  async function save(next: HedgingConfig) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const saved = await trpc.settings.updateHedging.mutate(next);
      setCfg(saved);
      setSavedMsg('Hedging-Konfiguration gespeichert.');
      window.setTimeout(() => setSavedMsg(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }

  async function executeQuickDemoHedge() {
    const target = normSymbol ?? cfg.hedgeSymbol;
    setHedgeBusy(true);
    setHedgeMsg(null);
    try {
      const r = await trpc.demo.placeHedgeOrder.mutate({ targetSymbol: target });
      const fillTxt = r.avgFillPrice !== null ? ` zu ${r.avgFillPrice.toFixed(2)}` : '';
      setHedgeMsg({
        ok: true,
        text: `✓ Demo-Hedge gesetzt: SHORT ${r.qty.toFixed(4)} ${r.hedgeSymbol}${fillTxt} (~${r.notionalUsd} $, SL ${r.stopLoss.toFixed(2)}).`,
      });
    } catch (err) {
      setHedgeMsg({ ok: false, text: err instanceof Error ? err.message : 'Demo-Hedge fehlgeschlagen.' });
    } finally {
      setHedgeBusy(false);
    }
  }

  const normSymbol = symbol ? symbol.trim().toUpperCase() : null;
  const assignedForSymbol = normSymbol ? cfg.assetAssignments[normSymbol] ?? '__default__' : '__default__';
  const assignedPairs = Object.entries(cfg.assetAssignments);

  const stateTone =
    evaluation.state === 'active'
      ? 'var(--color-warn)'
      : evaluation.state === 'standby'
        ? 'var(--color-pos)'
        : 'var(--color-mut)';

  return (
    <Panel label={normSymbol ? `🛡️ Hedging für ${normSymbol}` : '🛡️ Portfolio-Hedging & Absicherungs-Regeln'} stagger={4} className={className}>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed max-w-2xl" style={{ color: 'var(--color-mut)' }}>
          Steuere exakt, wann Gladiator eine Absicherung (Hedge) auslöst oder empfiehlt — global oder individuell pro Asset
          anhand von Drawdown, VIX und Makro-Regime.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="#/strategien?tab=hedging"
            className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-cyan)]"
            style={{ borderColor: 'rgba(6,182,212,0.45)', color: 'var(--color-cyan)' }}
          >
            🎨 Hedging-Designer & Asset-Zuordnung →
          </a>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium" style={{ borderColor: cfg.enabled ? 'rgba(34,197,94,0.5)' : 'var(--color-line)' }}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={!loaded || saving}
              onChange={(e) => {
                const next = { ...cfg, enabled: e.target.checked };
                setCfg(next);
                void save(next);
              }}
              className="h-4 w-4 accent-[var(--color-pos)]"
            />
            <span style={{ color: cfg.enabled ? 'var(--color-pos)' : 'var(--color-mut)' }}>
              {cfg.enabled ? 'Hedging AKTIV' : 'Hedging AUS'}
            </span>
          </label>
        </div>
      </div>

      {/* Direkte Asset-Strategie-Auswahl im Chart/Risiko-Tab */}
      {normSymbol && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[0.625rem] border p-3 text-xs" style={{ borderColor: 'rgba(6,182,212,0.3)', background: 'rgba(6,182,212,0.06)' }}>
          <div className="min-w-0 flex-1">
            <p className="font-semibold" style={{ color: 'var(--color-ink)' }}>
              Zugeordnete Hedging-Strategie für {normSymbol}: <span style={{ color: 'var(--color-cyan)' }}>{assetEval?.strategyName}</span>
            </p>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
              {assetEval?.mode === 'none'
                ? 'Für dieses Asset ist Hedging bewusst ausgeschaltet.'
                : `Absicherung über ${assetEval?.hedgeSymbol} (max. ${assetEval?.effectiveConfig.maxHedgeRatioPct} %).`}
            </p>
          </div>
          <select
            aria-label={`Hedging-Strategie für ${normSymbol}`}
            value={assignedForSymbol}
            disabled={!loaded || saving}
            onChange={(e) => {
              const nextAssignments = { ...cfg.assetAssignments };
              if (e.target.value === '__default__') delete nextAssignments[normSymbol];
              else nextAssignments[normSymbol] = e.target.value;
              const next = { ...cfg, assetAssignments: nextAssignments };
              setCfg(next);
              void save(next);
            }}
            className="field min-w-[200px] px-2.5 py-1.5 text-xs"
          >
            <option value="__default__">Standard-Regel (Fallback)</option>
            <option value="none">Kein Hedge (für {normSymbol} aus)</option>
            {cfg.strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.maxHedgeRatioPct} %)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Kompakte Übersicht bestehender Asset-Zuordnungen (global) */}
      {!normSymbol && assignedPairs.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="label mr-1">Asset-Regeln:</span>
          {assignedPairs.map(([sym, stratId]) => {
            const label = stratId === 'none' ? 'Aus' : cfg.strategies.find((s) => s.id === stratId)?.name ?? stratId;
            return (
              <span
                key={sym}
                className="rounded border px-2 py-0.5"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
              >
                <span className="num font-semibold">{sym}</span> → {label}
              </span>
            );
          })}
        </div>
      )}

      {/* Live-Bewertung gegen echte Marktdaten */}
      <div
        className="mt-4 rounded-[0.625rem] border p-3.5 text-xs"
        style={{ borderColor: stateTone, background: 'rgba(15,23,42,0.4)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold uppercase tracking-wider" style={{ color: stateTone }}>
            Status: {evaluation.state === 'active' ? 'Hedge-Trigger ausgelöst' : evaluation.state === 'standby' ? 'Überwachung aktiv (Standby)' : 'Deaktiviert'}
          </span>
          <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
            VIX: {vix !== null ? vix.toFixed(1) : '—'} · Regime: {grsLabel ?? '—'} · Drawdown: {drawdownPct !== null ? `${drawdownPct.toFixed(1)} %` : '—'}
          </span>
        </div>
        <p className="mt-1.5 leading-relaxed" style={{ color: 'var(--color-ink)' }}>
          {evaluation.summary}
        </p>
        {evaluation.state === 'active' && (assetEval?.instrument ?? cfg.instrument) !== 'stablecoin_shift' && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={hedgeBusy || !loaded}
              onClick={() => void executeQuickDemoHedge()}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ borderColor: 'rgba(245,158,11,0.6)', color: 'var(--color-warn)', background: 'rgba(245,158,11,0.12)' }}
            >
              {hedgeBusy ? 'Eröffne Demo-Hedge …' : '🛡️ Empfohlenen Demo-Hedge jetzt eröffnen'}
            </button>
            <a href="#/traden?tab=demo" className="text-[11px] underline" style={{ color: 'var(--color-cyan)' }}>
              Übungskonto öffnen
            </a>
          </div>
        )}
        {hedgeMsg && (
          <p className="mt-2 text-[11px] font-medium" style={{ color: hedgeMsg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {hedgeMsg.text}
          </p>
        )}
      </div>

      {/* Einstellbare Parameter */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="label">Drawdown-Auslöser ({cfg.triggerDrawdownPct} %)</span>
          <input
            type="range"
            min={1}
            max={30}
            step={0.5}
            value={cfg.triggerDrawdownPct}
            onChange={(e) => setCfg({ ...cfg, triggerDrawdownPct: Number(e.target.value) })}
            className="mt-1 w-full accent-[var(--color-warn)]"
          />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            Greift ab −{cfg.triggerDrawdownPct} % Rückgang vom Hoch
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="label">VIX-Stress-Schwelle ({cfg.triggerVix})</span>
          <input
            type="range"
            min={15}
            max={60}
            step={1}
            value={cfg.triggerVix}
            onChange={(e) => setCfg({ ...cfg, triggerVix: Number(e.target.value) })}
            className="mt-1 w-full accent-[var(--color-cyan)]"
          />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            Löst aus, sobald der Volatilitätsindex VIX ≥ {cfg.triggerVix} steigt
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="label">Max. Hedge-Quote ({cfg.maxHedgeRatioPct} %)</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={cfg.maxHedgeRatioPct}
            onChange={(e) => setCfg({ ...cfg, maxHedgeRatioPct: Number(e.target.value) })}
            className="mt-1 w-full accent-[var(--color-violet)]"
          />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            Maximaler abgesicherter Anteil der offenen Netto-Positionen
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="label">Absicherungs-Instrument</span>
          <select
            value={cfg.instrument}
            onChange={(e) => setCfg({ ...cfg, instrument: e.target.value as HedgingInstrument })}
            className="field px-2.5 py-2 text-xs"
          >
            {INSTRUMENT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {INSTRUMENT_OPTIONS.find((o) => o.value === cfg.instrument)?.desc}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="label">Hedge-Zielsymbol</span>
          <input
            value={cfg.hedgeSymbol}
            onChange={(e) => setCfg({ ...cfg, hedgeSymbol: e.target.value.toUpperCase() })}
            placeholder="BTC/USDT"
            className="field num px-2.5 py-2 text-xs"
          />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            z. B. BTC/USDT, ETH/USDT, SPY oder QQQ
          </span>
        </label>

        <div className="flex flex-col justify-center gap-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.triggerOnRiskOff}
              onChange={(e) => setCfg({ ...cfg, triggerOnRiskOff: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-cyan)]"
            />
            <span>Bei Makro-Regime „Risk-Off“ auslösen</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.autoReduceExposure}
              onChange={(e) => setCfg({ ...cfg, autoReduceExposure: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-cyan)]"
            />
            <span>Neue Positionsgrößen bei aktivem Hedge halbieren</span>
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save(cfg)}
          disabled={saving || !loaded}
          className="btn-primary px-4 py-2 text-xs font-medium disabled:opacity-50"
        >
          {saving ? 'Speichere…' : 'Hedging-Regeln speichern'}
        </button>
        {savedMsg && (
          <span className="text-xs" style={{ color: 'var(--color-pos)' }}>
            ✓ {savedMsg}
          </span>
        )}
        {error && (
          <span className="text-xs" style={{ color: 'var(--color-neg)' }}>
            {error}
          </span>
        )}
      </div>
    </Panel>
  );
}
