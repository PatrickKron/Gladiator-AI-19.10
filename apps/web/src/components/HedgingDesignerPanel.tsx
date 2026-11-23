import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_HEDGING_CONFIG,
  DEFAULT_HEDGING_STRATEGIES,
  evaluateAssetHedging,
  evaluateHedging,
  type HedgingConfig,
  type HedgingInstrument,
  type HedgingStrategy,
} from '@gladiator/risk';
import { trpc } from '../api.js';
import { Panel } from './ui.js';

/**
 * Hedging-Strategie-Designer & Asset-Zuordnung (Welle 19):
 * 1. Hedging-Strategien frei designen (Vorlagen anpassen oder eigene erstellen)
 * 2. Verschiedenen Assets (BTC/USDT, ETH/USDT, SOL/USDT, RHM.DE, XAU/USD …)
 *    unterschiedliche Hedging-Strategien zuordnen — inkl. Live-Status gegen echte Marktdaten.
 */

const INSTRUMENT_OPTIONS: Array<{ value: HedgingInstrument; label: string; desc: string }> = [
  { value: 'inverse_perp', label: 'Inverse-Perp Short', desc: 'Gegenposition über Perpetual Futures (z. B. 1× Short)' },
  { value: 'spot_short', label: 'Spot-Short / Margin', desc: 'Direkte Short-Gegenposition auf das Ziel-Asset' },
  { value: 'stablecoin_shift', label: 'Stablecoin-Umschichtung', desc: 'Teilverkauf in USD-Stablecoins bei Auslösung' },
  { value: 'index_hedge', label: 'Index-Hedge (SPY/QQQ)', desc: 'Breite Markt-Absicherung über Leitindex' },
];

const SUGGESTED_EXTRA_ASSETS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'UNI/USDT', 'QNT/USDT', 'XAU/USD', 'EUR/USD', 'RHM.DE', 'SPY', 'QQQ', 'NVDA'];

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length >= 2 ? base : `hedge-${Date.now().toString(36).slice(-4)}`;
}

function createDraftStrategy(existingIds: Set<string>): HedgingStrategy {
  let idx = 1;
  let id = `custom-hedge-${idx}`;
  while (existingIds.has(id)) {
    idx++;
    id = `custom-hedge-${idx}`;
  }
  return {
    id,
    name: `Eigene Hedge-Strategie #${idx}`,
    description: 'Individuelle Absicherungs-Regel bei erhöhter Volatilität oder Drawdown.',
    enabled: true,
    triggerDrawdownPct: 5,
    triggerVix: 25,
    triggerOnRiskOff: true,
    maxHedgeRatioPct: 50,
    instrument: 'inverse_perp',
    hedgeSymbol: 'SAME',
    autoReduceExposure: true,
    hedgeStopLossPct: 8,
    builtin: false,
  };
}

export function HedgingDesignerPanel() {
  const [cfg, setCfg] = useState<HedgingConfig>(DEFAULT_HEDGING_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [vix, setVix] = useState<number | null>(null);
  const [grsLabel, setGrsLabel] = useState<string | null>(null);
  const [drawdownPct, setDrawdownPct] = useState<number | null>(null);
  const [netExposureUsd, setNetExposureUsd] = useState<number>(0);
  const [universe, setUniverse] = useState<string[]>([]);

  // Designer-Editor-State
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_HEDGING_STRATEGIES[0]!.id);
  const [draft, setDraft] = useState<HedgingStrategy>({ ...DEFAULT_HEDGING_STRATEGIES[0]! });
  const [isNewDraft, setIsNewDraft] = useState(false);

  // Neues Asset für Zuordnung
  const [newAssetInput, setNewAssetInput] = useState('');
  const [extraAssets, setExtraAssets] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      trpc.settings.get.query(),
      trpc.market.scanUniverse.query(),
      trpc.market.macro.query(),
      trpc.trading.account.query(),
    ]).then(([sRes, uRes, mRes, aRes]) => {
      if (cancelled) return;
      if (sRes.status === 'fulfilled' && sRes.value.hedging) {
        const h = sRes.value.hedging;
        setCfg(h);
        const first = h.strategies[0] ?? DEFAULT_HEDGING_STRATEGIES[0]!;
        setSelectedId(first.id);
        setDraft({ ...first });
      }
      if (uRes.status === 'fulfilled' && Array.isArray(uRes.value)) {
        setUniverse(uRes.value);
      }
      if (mRes.status === 'fulfilled') {
        setVix(mRes.value.grs?.inputs.vix ?? mRes.value.vix?.value ?? null);
        setGrsLabel(mRes.value.grs?.label ?? null);
      }
      if (aRes.status === 'fulfilled') {
        setDrawdownPct(aRes.value.drawdownPct ?? null);
        setNetExposureUsd(aRes.value.netExposureUsd ?? 0);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: HedgingConfig, msg = 'Hedging-Strategien & Asset-Zuordnungen gespeichert.') {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const saved = await trpc.settings.updateHedging.mutate(next);
      setCfg(saved);
      setSavedMsg(msg);
      window.setTimeout(() => setSavedMsg(null), 2800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }

  function selectStrategy(strat: HedgingStrategy) {
    setSelectedId(strat.id);
    setDraft({ ...strat });
    setIsNewDraft(false);
  }

  function startNewStrategy() {
    const ids = new Set(cfg.strategies.map((s) => s.id));
    const fresh = createDraftStrategy(ids);
    setSelectedId(fresh.id);
    setDraft(fresh);
    setIsNewDraft(true);
  }

  function duplicateStrategy(strat: HedgingStrategy) {
    const ids = new Set(cfg.strategies.map((s) => s.id));
    let id = `${strat.id}-copy`;
    let n = 2;
    while (ids.has(id)) {
      id = `${strat.id}-copy-${n++}`;
    }
    const copy: HedgingStrategy = {
      ...strat,
      id,
      name: `${strat.name} (Kopie)`,
      builtin: false,
    };
    setSelectedId(copy.id);
    setDraft(copy);
    setIsNewDraft(true);
  }

  async function saveDraftStrategy() {
    const cleanName = draft.name.trim();
    if (cleanName.length < 2) {
      setError('Bitte einen Strategie-Namen mit mindestens 2 Zeichen angeben.');
      return;
    }
    const finalId = isNewDraft
      ? (() => {
          const base = slugifyId(cleanName);
          const taken = new Set(cfg.strategies.map((s) => s.id));
          if (!taken.has(base)) return base;
          let i = 2;
          while (taken.has(`${base}-${i}`)) i++;
          return `${base}-${i}`;
        })()
      : draft.id;

    const cleanHedgeSym = draft.hedgeSymbol.trim().toUpperCase() || 'SAME';
    const nextStrat: HedgingStrategy = {
      ...draft,
      id: finalId,
      name: cleanName,
      description: draft.description.trim(),
      hedgeSymbol: cleanHedgeSym,
    };

    const exists = cfg.strategies.some((s) => s.id === finalId);
    const nextStrategies = exists
      ? cfg.strategies.map((s) => (s.id === finalId ? nextStrat : s))
      : [...cfg.strategies, nextStrat];

    const nextCfg: HedgingConfig = { ...cfg, strategies: nextStrategies };
    setSelectedId(finalId);
    setDraft(nextStrat);
    setIsNewDraft(false);
    await persist(nextCfg, `Hedging-Strategie „${cleanName}“ gespeichert.`);
  }

  async function deleteStrategy(id: string) {
    const target = cfg.strategies.find((s) => s.id === id);
    if (!target || target.builtin) return;
    const nextStrategies = cfg.strategies.filter((s) => s.id !== id);
    const nextAssignments: Record<string, string> = {};
    for (const [sym, assignedId] of Object.entries(cfg.assetAssignments)) {
      if (assignedId !== id) nextAssignments[sym] = assignedId;
    }
    const nextDefault = cfg.defaultStrategyId === id ? null : cfg.defaultStrategyId;
    const nextCfg: HedgingConfig = {
      ...cfg,
      strategies: nextStrategies,
      assetAssignments: nextAssignments,
      defaultStrategyId: nextDefault,
    };
    const fallback = nextStrategies[0] ?? DEFAULT_HEDGING_STRATEGIES[0]!;
    setSelectedId(fallback.id);
    setDraft({ ...fallback });
    setIsNewDraft(false);
    await persist(nextCfg, `Hedging-Strategie „${target.name}“ gelöscht.`);
  }

  async function assignAsset(symbol: string, strategyId: string) {
    const norm = symbol.trim().toUpperCase();
    if (!norm) return;
    const nextAssignments = { ...cfg.assetAssignments };
    if (strategyId === '__default__') {
      delete nextAssignments[norm];
    } else {
      nextAssignments[norm] = strategyId;
    }
    await persist({ ...cfg, assetAssignments: nextAssignments }, `Hedge-Zuordnung für ${norm} aktualisiert.`);
  }

  function addCustomAsset() {
    const norm = newAssetInput.trim().toUpperCase();
    if (!norm) return;
    if (!allAssets.includes(norm)) {
      setExtraAssets((prev) => [...prev, norm]);
    }
    setNewAssetInput('');
  }

  const allAssets = useMemo(() => {
    const set = new Set<string>([
      ...universe.map((s) => s.toUpperCase()),
      ...Object.keys(cfg.assetAssignments).map((s) => s.toUpperCase()),
      ...extraAssets,
    ]);
    if (set.size === 0) {
      for (const s of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XAU/USD']) set.add(s);
    }
    return [...set].sort();
  }, [universe, cfg.assetAssignments, extraAssets]);

  const draftPreview = useMemo(() => {
    const previewCfg: HedgingConfig = {
      ...cfg,
      enabled: true,
      triggerDrawdownPct: draft.triggerDrawdownPct,
      triggerVix: draft.triggerVix,
      triggerOnRiskOff: draft.triggerOnRiskOff,
      maxHedgeRatioPct: draft.maxHedgeRatioPct,
      instrument: draft.instrument,
      hedgeSymbol: draft.hedgeSymbol === 'SAME' ? 'BTC/USDT' : draft.hedgeSymbol,
      autoReduceExposure: draft.autoReduceExposure,
    };
    return evaluateHedging(previewCfg, {
      drawdownPct,
      vix,
      grsLabel,
      netExposureUsd: netExposureUsd > 0 ? netExposureUsd : 10_000,
    });
  }, [cfg, draft, drawdownPct, vix, grsLabel, netExposureUsd]);

  const globalEval = useMemo(
    () => evaluateHedging(cfg, { drawdownPct, vix, grsLabel, netExposureUsd }),
    [cfg, drawdownPct, vix, grsLabel, netExposureUsd],
  );

  return (
    <div className="space-y-5 min-w-0">
      {/* Kopf-Panel: Globaler Hauptschalter + Makro-Status + Standard-Fallback */}
      <Panel label="🛡️ Hedging-Schaltzentrale & Live-Makro" stagger={1} className="min-w-0 overflow-hidden">
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              Designe eigene Hedging-Strategien (z. B. 1:1 Inverse-Short für Krypto, BTC-Beta-Hedge für Altcoins,
              Index-Hedge für Aktien) und ordne jedem Asset genau die Absicherung zu, die dazu passt.
            </p>
            <p className="num mt-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
              Live-Marktdaten: VIX {vix !== null ? vix.toFixed(1) : '—'} · Makro-Regime: {grsLabel ?? '—'} · Drawdown: {drawdownPct !== null ? `${drawdownPct.toFixed(1)} %` : '—'} ·{' '}
              <span style={{ color: cfg.enabled ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                {globalEval.state === 'active' ? 'Trigger aktiv' : globalEval.state === 'standby' ? 'Überwachung Standby' : 'Hedging ausgeschaltet'}
              </span>
            </p>
          </div>
          <label
            className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium shrink-0"
            style={{ borderColor: cfg.enabled ? 'rgba(34,197,94,0.5)' : 'var(--color-line)' }}
          >
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={!loaded || saving}
              onChange={(e) => void persist({ ...cfg, enabled: e.target.checked }, e.target.checked ? 'Hedging aktiviert.' : 'Hedging deaktiviert.')}
              className="h-4 w-4 accent-[var(--color-pos)]"
            />
            <span style={{ color: cfg.enabled ? 'var(--color-pos)' : 'var(--color-mut)' }}>
              {cfg.enabled ? 'Hedging AKTIV' : 'Hedging AUS'}
            </span>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
          <label className="flex flex-col gap-1 text-xs min-w-[220px]">
            <span className="label">Standard-Hedging für nicht einzeln zugeordnete Assets</span>
            <select
              value={cfg.defaultStrategyId ?? '__global__'}
              disabled={!loaded || saving}
              onChange={(e) => {
                const val = e.target.value === '__global__' ? null : e.target.value;
                void persist({ ...cfg, defaultStrategyId: val }, 'Standard-Hedging-Strategie aktualisiert.');
              }}
              className="field px-2.5 py-2 text-xs"
            >
              <option value="__global__">Globale Basis-Regel ({cfg.maxHedgeRatioPct} % via {cfg.hedgeSymbol})</option>
              {cfg.strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.maxHedgeRatioPct} % · {s.hedgeSymbol === 'SAME' ? '1:1 Asset' : s.hedgeSymbol})
                </option>
              ))}
            </select>
          </label>
          {savedMsg && <span className="text-xs font-medium" style={{ color: 'var(--color-pos)' }}>✓ {savedMsg}</span>}
          {error && <span className="text-xs font-medium" style={{ color: 'var(--color-neg)' }}>{error}</span>}
        </div>
      </Panel>

      {/* Bereich 1: Hedging-Strategien designen */}
      <Panel label="🎨 Hedging-Strategien designen" stagger={2} className="min-w-0 overflow-hidden">
        <div className="mt-3 grid gap-5 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          {/* Linke Liste: Vorlagen & eigene Strategien */}
          <div className="space-y-2 min-w-0">
            <button
              type="button"
              onClick={startNewStrategy}
              className="btn-primary w-full px-3 py-2 text-xs font-medium"
            >
              + Neue Hedging-Strategie designen
            </button>
            <div className="space-y-2">
              {cfg.strategies.map((s) => {
                const active = !isNewDraft && selectedId === s.id;
                const assignedCount = Object.values(cfg.assetAssignments).filter((id) => id === s.id).length;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => selectStrategy(s)}
                    className="w-full rounded-[0.625rem] border p-3 text-left transition-colors"
                    style={{
                      borderColor: active ? 'var(--color-cyan)' : 'var(--color-line)',
                      background: active ? 'rgba(6,182,212,0.10)' : 'rgba(15,23,42,0.35)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold truncate" style={{ color: 'var(--color-ink)' }}>
                        {s.name}
                      </span>
                      <span className="num shrink-0 text-[10px]" style={{ color: 'var(--color-cyan)' }}>
                        {s.maxHedgeRatioPct} %
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--color-mut)' }}>
                      {s.hedgeSymbol === 'SAME' ? '1:1 gleiches Asset' : `Via ${s.hedgeSymbol}`} · DD ≥ {s.triggerDrawdownPct} % · VIX ≥ {s.triggerVix}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span
                        className="rounded border px-1.5 py-0.5"
                        style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                      >
                        {s.builtin ? 'Vorlage' : 'Eigene'}
                      </span>
                      {assignedCount > 0 && (
                        <span
                          className="rounded border px-1.5 py-0.5"
                          style={{ borderColor: 'rgba(34,197,94,0.45)', color: 'var(--color-pos)' }}
                        >
                          {assignedCount} Asset{assignedCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Rechter Baukasten: Formular für gewählte oder neue Hedging-Strategie */}
          <div className="min-w-0 rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
                {isNewDraft ? 'Neue Hedging-Strategie entwerfen' : `Bearbeiten: ${draft.name}`}
              </p>
              <div className="flex flex-wrap gap-2">
                {!isNewDraft && (
                  <button
                    type="button"
                    onClick={() => duplicateStrategy(draft)}
                    className="rounded border px-2.5 py-1 text-[11px]"
                    style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
                  >
                    Duplizieren
                  </button>
                )}
                {!isNewDraft && !draft.builtin && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void deleteStrategy(draft.id)}
                    className="rounded border px-2.5 py-1 text-[11px] disabled:opacity-50"
                    style={{ borderColor: 'rgba(239,68,68,0.45)', color: 'var(--color-neg)' }}
                  >
                    Löschen
                  </button>
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Name der Hedging-Strategie</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="z. B. QNT Volatilitäts-Hedge 50 %"
                  className="field px-2.5 py-2 text-xs"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Absicherungs-Instrument</span>
                <select
                  value={draft.instrument}
                  onChange={(e) => setDraft({ ...draft, instrument: e.target.value as HedgingInstrument })}
                  className="field px-2.5 py-2 text-xs"
                >
                  {INSTRUMENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {INSTRUMENT_OPTIONS.find((o) => o.value === draft.instrument)?.desc}
                </span>
              </label>

              <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                <span className="label">Kurzbeschreibung (wann & wofür gedacht)</span>
                <input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="z. B. Sichert Altcoins bei Marktstress über einen BTC-Short ab"
                  className="field px-2.5 py-2 text-xs"
                />
              </label>

              {/* Zielsymbol-Modus: 1:1 gleiches Asset ODER Cross-Hedge */}
              <div className="flex flex-col gap-1.5 text-xs sm:col-span-2">
                <span className="label">Womit wird abgesichert?</span>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="hedgeSymMode"
                      checked={draft.hedgeSymbol === 'SAME'}
                      onChange={() => setDraft({ ...draft, hedgeSymbol: 'SAME' })}
                    />
                    <span>1:1 auf dasselbe Asset (direkter Gegen-Short)</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="hedgeSymMode"
                      checked={draft.hedgeSymbol !== 'SAME'}
                      onChange={() => setDraft({ ...draft, hedgeSymbol: draft.hedgeSymbol === 'SAME' ? 'BTC/USDT' : draft.hedgeSymbol })}
                    />
                    <span>Cross-Hedge über anderes Symbol</span>
                  </label>
                </div>
                {draft.hedgeSymbol !== 'SAME' && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <input
                      value={draft.hedgeSymbol}
                      onChange={(e) => setDraft({ ...draft, hedgeSymbol: e.target.value.toUpperCase() })}
                      placeholder="BTC/USDT, SPY, QQQ, USDT …"
                      className="field num w-44 px-2.5 py-1.5 text-xs"
                    />
                    {['BTC/USDT', 'ETH/USDT', 'SPY', 'QQQ', 'USDT', 'XAU/USD'].map((sym) => (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setDraft({ ...draft, hedgeSymbol: sym })}
                        className="num rounded border px-2 py-1 text-[11px]"
                        style={{
                          borderColor: draft.hedgeSymbol === sym ? 'var(--color-cyan)' : 'var(--color-line)',
                          color: draft.hedgeSymbol === sym ? 'var(--color-cyan)' : 'var(--color-mut)',
                        }}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Max. Hedge-Quote ({draft.maxHedgeRatioPct} %)</span>
                <input
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  value={draft.maxHedgeRatioPct}
                  onChange={(e) => setDraft({ ...draft, maxHedgeRatioPct: Number(e.target.value) })}
                  className="w-full accent-[var(--color-violet)]"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Drawdown-Trigger ({draft.triggerDrawdownPct} %)</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={0.5}
                  value={draft.triggerDrawdownPct}
                  onChange={(e) => setDraft({ ...draft, triggerDrawdownPct: Number(e.target.value) })}
                  className="w-full accent-[var(--color-warn)]"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label">VIX-Stress-Schwelle ({draft.triggerVix})</span>
                <input
                  type="range"
                  min={15}
                  max={60}
                  step={1}
                  value={draft.triggerVix}
                  onChange={(e) => setDraft({ ...draft, triggerVix: Number(e.target.value) })}
                  className="w-full accent-[var(--color-cyan)]"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Hedge Stop-Loss ({draft.hedgeStopLossPct} %)</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={0.5}
                  value={draft.hedgeStopLossPct}
                  onChange={(e) => setDraft({ ...draft, hedgeStopLossPct: Number(e.target.value) })}
                  className="w-full accent-[var(--color-neg)]"
                />
              </label>

              <div className="flex flex-col gap-2 text-xs sm:col-span-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.triggerOnRiskOff}
                    onChange={(e) => setDraft({ ...draft, triggerOnRiskOff: e.target.checked })}
                    className="h-4 w-4 accent-[var(--color-cyan)]"
                  />
                  <span>Bei Makro-Regime „Risk-Off“ auslösen</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.autoReduceExposure}
                    onChange={(e) => setDraft({ ...draft, autoReduceExposure: e.target.checked })}
                    className="h-4 w-4 accent-[var(--color-cyan)]"
                  />
                  <span>Neue Positionsgrößen bei aktivem Hedge automatisch halbieren</span>
                </label>
              </div>
            </div>

            {/* Live-Vorschau dieser Strategie */}
            <div
              className="mt-4 rounded border p-3 text-xs"
              style={{
                borderColor: draftPreview.state === 'active' ? 'var(--color-warn)' : 'var(--color-line)',
                background: 'rgba(11,13,18,0.55)',
              }}
            >
              <p className="label">Live-Vorschau (bei 10.000 $ Position)</p>
              <p className="mt-1 leading-relaxed" style={{ color: 'var(--color-ink)' }}>
                {draftPreview.summary}
              </p>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={saving || !loaded}
                onClick={() => void saveDraftStrategy()}
                className="btn-primary px-4 py-2 text-xs font-medium disabled:opacity-50"
              >
                {saving ? 'Speichere …' : isNewDraft ? '✓ Neue Hedging-Strategie speichern' : '✓ Änderungen speichern'}
              </button>
            </div>
          </div>
        </div>
      </Panel>

      {/* Bereich 2: Asset-Zuordnung (verschiedene Assets → verschiedene Hedging-Strategien) */}
      <Panel label="🎯 Hedging-Strategie pro Asset auswählen" stagger={3} className="min-w-0 overflow-hidden">
        <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          Wähle für jedes Asset einzeln, welche Hedging-Strategie gelten soll (z. B. BTC/USDT → 1:1 Crash-Schutz,
          SOL/USDT & QNT/USDT → Altcoin-Beta-Hedge über BTC, RHM.DE → Aktien-Index-Hedge über SPY, XAU/USD → Kein Hedge).
        </p>

        {/* Weiteres Asset hinzufügen */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={newAssetInput}
            onChange={(e) => setNewAssetInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustomAsset();
              }
            }}
            placeholder="Weiteres Asset (z. B. QNT/USDT, XAU/USD, NVDA)"
            className="field num min-w-[200px] flex-1 px-2.5 py-1.5 text-xs sm:max-w-xs"
          />
          <button
            type="button"
            onClick={addCustomAsset}
            className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
            style={{ borderColor: 'rgba(6,182,212,0.45)', color: 'var(--color-cyan)' }}
          >
            + Asset hinzufügen
          </button>
          <div className="flex flex-wrap gap-1">
            {SUGGESTED_EXTRA_ASSETS.filter((s) => !allAssets.includes(s)).slice(0, 5).map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => setExtraAssets((prev) => (prev.includes(sym) ? prev : [...prev, sym]))}
                className="num rounded border px-1.5 py-0.5 text-[10px]"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              >
                + {sym}
              </button>
            ))}
          </div>
        </div>

        {/* Zuordnungs-Liste */}
        <div className="mt-4 divide-y rounded-[0.625rem] border" style={{ borderColor: 'var(--color-line)' }}>
          {allAssets.map((sym) => {
            const explicit = cfg.assetAssignments[sym];
            const selectVal = explicit ?? '__default__';
            const evalRes = evaluateAssetHedging(cfg, sym, {
              drawdownPct,
              vix,
              grsLabel,
              netExposureUsd,
            });
            const badgeColor =
              evalRes.mode === 'none' || evalRes.evaluation.state === 'disabled'
                ? 'var(--color-mut)'
                : evalRes.evaluation.state === 'active'
                  ? 'var(--color-warn)'
                  : 'var(--color-pos)';

            return (
              <div
                key={sym}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                style={{ borderColor: 'var(--color-line)' }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-xs font-semibold" style={{ color: 'var(--color-ink)' }}>
                      {sym}
                    </span>
                    <span
                      className="rounded border px-1.5 py-0.5 text-[10px]"
                      style={{ borderColor: badgeColor, color: badgeColor }}
                    >
                      {evalRes.mode === 'none'
                        ? 'Kein Hedge'
                        : evalRes.evaluation.state === 'active'
                          ? `Aktiv · ${evalRes.evaluation.recommendedHedgePct} % via ${evalRes.hedgeSymbol}`
                          : evalRes.evaluation.state === 'standby'
                            ? `Standby · bis ${evalRes.effectiveConfig.maxHedgeRatioPct} % via ${evalRes.hedgeSymbol}`
                            : 'Global AUS'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                    {evalRes.strategyName}
                    {evalRes.mode !== 'none'
                      ? ` · DD ≥ ${evalRes.effectiveConfig.triggerDrawdownPct} % · VIX ≥ ${evalRes.effectiveConfig.triggerVix}`
                      : ''}
                  </p>
                </div>

                <select
                  aria-label={`Hedging-Strategie für ${sym}`}
                  value={selectVal}
                  disabled={!loaded || saving}
                  onChange={(e) => void assignAsset(sym, e.target.value)}
                  className="field min-w-[200px] max-w-full px-2.5 py-1.5 text-xs sm:w-64"
                >
                  <option value="__default__">Standard-Regel (Fallback)</option>
                  <option value="none">Kein Hedge (für {sym} aus)</option>
                  {cfg.strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.maxHedgeRatioPct} % · {s.hedgeSymbol === 'SAME' ? sym : s.hedgeSymbol})
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
