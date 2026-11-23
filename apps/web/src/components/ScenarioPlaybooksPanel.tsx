import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { appLocale } from '../lib/locale.js';
import { Empty, ErrorBox, Loading, Panel } from './ui.js';

type ListRes = Awaited<ReturnType<typeof trpc.scenarios.list.query>>;
type TemplateItem = Awaited<ReturnType<typeof trpc.scenarios.templates.query>>[number];
type ParseRes = Awaited<ReturnType<typeof trpc.scenarios.parseText.mutate>>;
type EvalRes = Awaited<ReturnType<typeof trpc.scenarios.evaluate.mutate>>;
type TriggerRes = Awaited<ReturnType<typeof trpc.scenarios.triggerNow.mutate>>;

type TriggerKind = 'news_keywords' | 'macro_threshold' | 'calendar_event' | 'manual_only';
type ConfKind = 'none' | 'bos_down' | 'bos_up' | 'choch_down' | 'choch_up' | 'price_below' | 'price_above';
type TargetScope = 'symbol' | 'all_crypto' | 'top_crypto' | 'all_stocks';
type Tf = '15m' | '1h' | '4h' | '1d';

const CONF_LABELS: Record<ConfKind, string> = {
  none: 'Sofort (kein Chart-Filter)',
  bos_down: 'BOS nach unten (Break of Structure bearish)',
  bos_up: 'BOS nach oben (Break of Structure bullish)',
  choch_down: 'CHoCH nach unten (Trendwechsel bearish)',
  choch_up: 'CHoCH nach oben (Trendwechsel bullish)',
  price_below: 'Kurs schließt unter Zielpreis',
  price_above: 'Kurs schließt über Zielpreis',
};

const SCOPE_LABELS: Record<TargetScope, string> = {
  symbol: 'Einzelne Assets (z. B. BTC/USDT, NVDA)',
  all_crypto: 'Alle Krypto-Assets (aktives Scanner-Universum)',
  top_crypto: 'Top 3 Krypto (BTC, ETH, SOL)',
  all_stocks: 'Alle registrierten Aktien / ETFs',
};

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  armed: { label: '🟢 Scharf (alle 5 Min.)', color: 'var(--color-pos)', bg: 'rgba(16,185,129,0.14)' },
  triggered: { label: '⚡ Ausgelöst', color: '#fbbf24', bg: 'rgba(245,158,11,0.18)' },
  executed: { label: '✅ Ausgeführt', color: 'var(--color-cyan)', bg: 'rgba(6,182,212,0.14)' },
  paused: { label: '⏸ Pausiert', color: 'var(--color-mut)', bg: 'rgba(148,163,184,0.12)' },
  draft: { label: '📝 Entwurf', color: 'var(--color-mut)', bg: 'rgba(148,163,184,0.12)' },
};

/**
 * Szenario-Trading / Wenn-Dann-Wetten unter `#/strategien?tab=szenarien` (Welle 24):
 * Ermöglicht News-/Makro-Szenarien (z. B. Pandemie, Bankenkrise, ETF-Zulassung, CPI-Schock)
 * mit optionalem technischen Bestätigungs-Filter (BOS/CHoCH/Kurs) und kombinierten Aktionen
 * (Short/Long mit Hebel auf Asset oder alle Cryptos, Spot-/Wallet-Verkaufsplan, Hedging).
 */
export function ScenarioPlaybooksPanel() {
  const [listData, setListData] = useState<ListRes | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Freitext-Eingabe & Analyse
  const [rawText, setRawText] = useState(
    'Pandemie bricht aus, dann auf BOS nach unten auf 1h warten, dann mit 5x Hebel alle Cryptos shorten und 100% Bestand auf Binance verkaufen',
  );
  const [parsed, setParsed] = useState<ParseRes | null>(null);
  const [parsing, setParsing] = useState(false);

  // Strukturierter Editor
  const [name, setName] = useState('Pandemie / Black-Swan → Alle Cryptos Short + Spot-Abbau');
  const [executionMode, setExecutionMode] = useState<'signal_only' | 'demo_auto'>('signal_only');
  const [armImmediately, setArmImmediately] = useState(true);

  const [triggerKind, setTriggerKind] = useState<TriggerKind>('news_keywords');
  const [keywordsStr, setKeywordsStr] = useState('pandemic, pandemie, lockdown, who emergency, outbreak');
  const [minKeywordHits, setMinKeywordHits] = useState(1);
  const [lookbackHours, setLookbackHours] = useState(24);
  const [vixMinStr, setVixMinStr] = useState('30');

  const [confKind, setConfKind] = useState<ConfKind>('bos_down');
  const [confSymbol, setConfSymbol] = useState('BTC/USDT');
  const [confTf, setConfTf] = useState<Tf>('1h');
  const [priceLevelStr, setPriceLevelStr] = useState('');

  // Aktion 1: Trade
  const [enableTrade, setEnableTrade] = useState(true);
  const [targetScope, setTargetScope] = useState<TargetScope>('all_crypto');
  const [symbolsStr, setSymbolsStr] = useState('BTC/USDT, ETH/USDT');
  const [direction, setDirection] = useState<'short' | 'long'>('short');
  const [leverage, setLeverage] = useState(5);
  const [riskPct, setRiskPct] = useState(1);
  const [stopLossPct, setStopLossPct] = useState(3);
  const [takeProfitPct, setTakeProfitPct] = useState(9);

  // Aktion 2: Spot-/Wallet-Bestand verkaufen
  const [enableSpotSell, setEnableSpotSell] = useState(true);
  const [spotConnectionId, setSpotConnectionId] = useState<string>('');
  const [spotVenueHint, setSpotVenueHint] = useState('binance');
  const [spotAssetsStr, setSpotAssetsStr] = useState('ALL');
  const [spotSellPct, setSpotSellPct] = useState(100);

  // Aktion 3: Hedging hochfahren
  const [enableHedge, setEnableHedge] = useState(false);
  const [hedgeRatioPct, setHedgeRatioPct] = useState(80);

  // Busy & Feedback pro Playbook
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmTriggerId, setConfirmTriggerId] = useState<string | null>(null);
  const [evalById, setEvalById] = useState<Record<string, EvalRes>>({});
  const [execById, setExecById] = useState<Record<string, TriggerRes>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, tpls] = await Promise.all([
        trpc.scenarios.list.query(),
        trpc.scenarios.templates.query().catch(() => [] as TemplateItem[]),
      ]);
      setListData(res);
      setTemplates(tpls);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Szenarien konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function applySpecToForm(spec: ParseRes['spec']) {
    setName(spec.name);
    setExecutionMode(spec.executionMode);
    setTriggerKind(spec.trigger.kind);
    setKeywordsStr(spec.trigger.keywords.join(', '));
    setMinKeywordHits(spec.trigger.minKeywordHits);
    setLookbackHours(spec.trigger.lookbackHours);
    setVixMinStr(spec.trigger.vixMin !== undefined ? String(spec.trigger.vixMin) : '');

    setConfKind(spec.confirmation.kind);
    setConfSymbol(spec.confirmation.symbol ?? 'BTC/USDT');
    setConfTf(spec.confirmation.timeframe);
    setPriceLevelStr(spec.confirmation.priceLevel !== undefined ? String(spec.confirmation.priceLevel) : '');

    const tradeAct = spec.actions.find((a) => a.type === 'trade');
    if (tradeAct && tradeAct.type === 'trade') {
      setEnableTrade(true);
      setTargetScope(tradeAct.targetScope);
      setSymbolsStr(tradeAct.symbols.join(', ') || 'BTC/USDT');
      setDirection(tradeAct.direction);
      setLeverage(tradeAct.leverage);
      setRiskPct(tradeAct.riskPct);
      setStopLossPct(tradeAct.stopLossPct);
      setTakeProfitPct(tradeAct.takeProfitPct);
    } else {
      setEnableTrade(false);
    }

    const spotAct = spec.actions.find((a) => a.type === 'sell_spot_holdings');
    if (spotAct && spotAct.type === 'sell_spot_holdings') {
      setEnableSpotSell(true);
      setSpotConnectionId(spotAct.connectionId ?? '');
      setSpotVenueHint(spotAct.venueHint);
      setSpotAssetsStr(spotAct.assets.join(', '));
      setSpotSellPct(spotAct.sellPct);
    } else {
      setEnableSpotSell(false);
    }

    const hedgeAct = spec.actions.find((a) => a.type === 'activate_hedge');
    if (hedgeAct && hedgeAct.type === 'activate_hedge') {
      setEnableHedge(true);
      setHedgeRatioPct(hedgeAct.hedgeRatioPct);
    } else {
      setEnableHedge(false);
    }
  }

  async function handleParseText(inputText?: string) {
    const txt = (inputText ?? rawText).trim();
    if (txt.length < 5) return;
    setParsing(true);
    setError(null);
    try {
      const res = await trpc.scenarios.parseText.mutate({ text: txt });
      setParsed(res);
      applySpecToForm(res.spec);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Text-Analyse fehlgeschlagen.');
    } finally {
      setParsing(false);
    }
  }

  async function handleSave() {
    const actions: Array<
      | {
          type: 'trade';
          targetScope: TargetScope;
          symbols: string[];
          direction: 'long' | 'short';
          leverage: number;
          riskPct: number;
          stopLossPct: number;
          takeProfitPct: number;
        }
      | {
          type: 'sell_spot_holdings';
          connectionId?: string;
          venueHint: string;
          assets: string[];
          sellPct: number;
        }
      | {
          type: 'activate_hedge';
          hedgeRatioPct: number;
        }
    > = [];

    if (enableTrade) {
      const syms = symbolsStr
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      actions.push({
        type: 'trade',
        targetScope,
        symbols: targetScope === 'symbol' ? (syms.length > 0 ? syms : ['BTC/USDT']) : [],
        direction,
        leverage: Math.min(25, Math.max(1, Number(leverage) || 1)),
        riskPct: Math.min(5, Math.max(0.25, Number(riskPct) || 1)),
        stopLossPct: Math.min(25, Math.max(0.5, Number(stopLossPct) || 3)),
        takeProfitPct: Math.min(100, Math.max(1, Number(takeProfitPct) || 9)),
      });
    }

    if (enableSpotSell) {
      const assets = spotAssetsStr
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      actions.push({
        type: 'sell_spot_holdings',
        ...(spotConnectionId ? { connectionId: spotConnectionId } : {}),
        venueHint: spotVenueHint.trim() || 'all',
        assets: assets.length > 0 ? assets : ['ALL'],
        sellPct: Math.min(100, Math.max(1, Number(spotSellPct) || 100)),
      });
    }

    if (enableHedge) {
      actions.push({
        type: 'activate_hedge',
        hedgeRatioPct: Math.min(100, Math.max(10, Number(hedgeRatioPct) || 75)),
      });
    }

    if (actions.length === 0) {
      setError('Bitte mindestens eine Reaktions-Aktion (Trading, Spot-Verkauf oder Hedging) aktivieren.');
      return;
    }

    const keywords = keywordsStr
      .split(/[,;]+/)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2);
    const vixMin = vixMinStr.trim() ? Number(vixMinStr) : undefined;
    const priceLevel = priceLevelStr.trim() ? Number(priceLevelStr) : undefined;

    setSaving(true);
    setError(null);
    setSaveNote(null);
    try {
      await trpc.scenarios.create.mutate({
        name: name.trim() || 'Neues Szenario',
        description: rawText.trim().slice(0, 500) || undefined,
        rawText: rawText.trim().slice(0, 2000) || undefined,
        executionMode,
        armImmediately,
        trigger: {
          kind: triggerKind,
          keywords,
          minKeywordHits: Math.min(10, Math.max(1, Number(minKeywordHits) || 1)),
          lookbackHours: Math.min(168, Math.max(1, Number(lookbackHours) || 24)),
          ...(vixMin !== undefined && Number.isFinite(vixMin) && vixMin >= 10 ? { vixMin } : {}),
        },
        confirmation: {
          kind: confKind,
          symbol: confSymbol.trim().toUpperCase() || 'BTC/USDT',
          timeframe: confTf,
          lookbackBars: 6,
          ...(priceLevel !== undefined && Number.isFinite(priceLevel) && priceLevel > 0 ? { priceLevel } : {}),
        },
        actions,
      });
      setSaveNote(
        armImmediately
          ? 'Szenario gespeichert & SCHARF gestellt — der Worker überwacht News, VIX/GRS & Chart-Struktur jetzt alle 5 Minuten.'
          : 'Szenario als Entwurf gespeichert.',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Szenario konnte nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(id: string, nextStatus: 'armed' | 'paused' | 'draft') {
    setBusyId(id);
    setError(null);
    try {
      await trpc.scenarios.setStatus.mutate({ id, status: nextStatus });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status konnte nicht geändert werden.');
    } finally {
      setBusyId(null);
    }
  }

  async function evaluateNow(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await trpc.scenarios.evaluate.mutate({ id });
      setEvalById((prev) => ({ ...prev, [id]: res }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Live-Prüfung fehlgeschlagen.');
    } finally {
      setBusyId(null);
    }
  }

  async function triggerNow(id: string) {
    setBusyId(id);
    setError(null);
    setConfirmTriggerId(null);
    try {
      const res = await trpc.scenarios.triggerNow.mutate({ id });
      setExecById((prev) => ({ ...prev, [id]: res }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auslösung fehlgeschlagen.');
    } finally {
      setBusyId(null);
    }
  }

  async function deletePlaybook(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await trpc.scenarios.delete.mutate({ id });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusyId(null);
    }
  }

  const connections = listData?.connections ?? [];

  return (
    <div className="min-w-0 space-y-5 overflow-hidden">
      {/* ── Einführung & Schnell-Vorlagen ── */}
      <Panel label="🎯 Szenario-Trading & Wenn-Dann-Wetten (News / Makro + Chart-Bestätigung)">
        <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          Definiere konkrete Wenn-Dann-Szenarien (z. B. Pandemie, Bankenkrise, ETF-Zulassung oder CPI-Schock):
          Der Hintergrund-Wächter prüft alle <strong>5 Minuten</strong> echte News-Feeds, VIX/GRS und abgeschlossene
          Chart-Kerzen (BOS / CHoCH). Sobald dein Szenario + Bestätigung greifen, erzeugt er sofort Signale unter{' '}
          <a href="#/signals" className="underline" style={{ color: 'var(--color-cyan)' }}>
            #/signals
          </a>{' '}
          (oder führt im Demo-Konto aus) + erstellt eine Verkaufs-Checkliste für deine gewählte Börse/Wallet.{' '}
          <strong>Sicherheits-Regel:</strong> Immer Paper/Demo-Standard, Hebel wird vom Risk-Gate gedeckelt, nie blinde
          Live-Orders und nie Auszahlungen/Transfers.
        </p>

        {/* Schnell-Vorlagen */}
        {templates.length > 0 && (
          <div className="mt-3">
            <span className="label block mb-1.5">Schnell-Vorlagen (1 Klick lädt das Szenario):</span>
            <div className="flex flex-wrap gap-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => {
                    setRawText(tpl.sampleText);
                    void handleParseText(tpl.sampleText);
                  }}
                  className="rounded-[0.625rem] border px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-cyan)]"
                  style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                >
                  {tpl.badge}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Freitext-Eingabe */}
        <div className="mt-4">
          <label className="label block mb-1.5" htmlFor="scenario-raw-text">
            1. Szenario einfach als Freitext beschreiben (optional — füllt das Formular automatisch):
          </label>
          <textarea
            id="scenario-raw-text"
            rows={3}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="z. B. Pandemie bricht aus, dann auf BOS nach unten auf 1h warten, dann mit 5x Hebel alle Cryptos shorten und Bestand auf Binance verkaufen"
            className="field w-full px-3 py-2 text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={parsing || rawText.trim().length < 5}
              onClick={() => void handleParseText()}
              className="rounded-[0.625rem] border px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--color-cyan)', background: 'rgba(6,182,212,0.16)', color: 'var(--color-ink)' }}
            >
              {parsing ? '⏳ Analysiere…' : '🧠 Text analysieren & Formular füllen'}
            </button>
            {parsed && (
              <span className="text-xs" style={{ color: 'var(--color-cyan)' }}>
                Erkanntes Thema: <strong>{parsed.detectedTheme}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Ehrliche Machbarkeits-Box */}
        {parsed && (
          <div
            className="mt-3 rounded-[0.625rem] border p-3 text-xs space-y-1.5"
            style={{
              borderColor: parsed.feasibility.verdict === 'feasible' ? 'rgba(16,185,129,0.45)' : 'rgba(245,158,11,0.5)',
              background: 'rgba(15,23,42,0.45)',
            }}
          >
            <p className="font-medium">
              {parsed.feasibility.verdict === 'feasible'
                ? '✅ Vollständig umsetzbar'
                : '⚠️ Teilweise automatisch + Sicherheits-/Transparenz-Hinweise'}
            </p>
            <ul className="space-y-1">
              {parsed.feasibility.checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2">
                  <span>{c.ok ? '✅' : '⚠️'}</span>
                  <span>
                    <strong>{c.label}:</strong>{' '}
                    <span style={{ color: 'var(--color-mut)' }}>{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {parsed.feasibility.notes.map((n) => (
              <p key={n} className="pt-1 text-[11px]" style={{ color: 'var(--color-warn)' }}>
                ℹ️ {n}
              </p>
            ))}
          </div>
        )}
      </Panel>

      {/* ── Strukturierter Szenario-Builder ── */}
      <Panel label="2. Szenario-Regeln feinjustieren & scharfstellen">
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="block md:col-span-2">
            <span className="label block">Name des Szenarios</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="field mt-1 w-full px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="label block">Ausführungs-Modus (Sicherheit)</span>
            <select
              value={executionMode}
              onChange={(e) => setExecutionMode(e.target.value as 'signal_only' | 'demo_auto')}
              className="field mt-1 w-full px-2.5 py-1.5 text-xs"
            >
              <option value="signal_only">📡 Signale + Alarm (Mensch im Loop, Standard)</option>
              <option value="demo_auto">🎮 Demo-Konto automatisch ausführen</option>
            </select>
          </label>
        </div>

        {/* WENN: Auslöser */}
        <div className="mt-4 rounded-[0.625rem] border p-3.5 space-y-3" style={{ borderColor: 'var(--color-line)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-cyan)' }}>
            WENN — Ereignis / News / Makro-Auslöser
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="label block">Auslöser-Typ</span>
              <select
                value={triggerKind}
                onChange={(e) => setTriggerKind(e.target.value as TriggerKind)}
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              >
                <option value="news_keywords">📰 News-Schlagwörter (+ optional VIX)</option>
                <option value="macro_threshold">📉 Makro-Schwelle (VIX / GRS)</option>
                <option value="manual_only">✋ Nur manuell auslösen</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="label block">News-Schlagwörter (kommagetrennt)</span>
              <input
                value={keywordsStr}
                onChange={(e) => setKeywordsStr(e.target.value)}
                placeholder="pandemic, lockdown, who, bank run, etf approved…"
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="block">
              <span className="label block">VIX-Schwelle (optional, ≥)</span>
              <input
                type="number"
                value={vixMinStr}
                onChange={(e) => setVixMinStr(e.target.value)}
                placeholder="z. B. 30"
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="label block">Min. News-Treffer</span>
              <input
                type="number"
                min={1}
                max={10}
                value={minKeywordHits}
                onChange={(e) => setMinKeywordHits(Number(e.target.value))}
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="block">
              <span className="label block">News-Fenster (Stunden)</span>
              <input
                type="number"
                min={1}
                max={168}
                value={lookbackHours}
                onChange={(e) => setLookbackHours(Number(e.target.value))}
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
          </div>
        </div>

        {/* UND WARTEN AUF: Technische Bestätigung */}
        <div className="mt-3 rounded-[0.625rem] border p-3.5 space-y-3" style={{ borderColor: 'var(--color-line)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-violet)' }}>
            UND WARTEN AUF — Technische Chart-Bestätigung (echte Marktstruktur)
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block sm:col-span-2">
              <span className="label block">Bestätigungs-Filter</span>
              <select
                value={confKind}
                onChange={(e) => setConfKind(e.target.value as ConfKind)}
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              >
                {(Object.keys(CONF_LABELS) as ConfKind[]).map((k) => (
                  <option key={k} value={k}>
                    {CONF_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label block">Referenz-Asset</span>
              <input
                value={confSymbol}
                onChange={(e) => setConfSymbol(e.target.value)}
                placeholder="BTC/USDT"
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="block">
              <span className="label block">Timeframe</span>
              <select
                value={confTf}
                onChange={(e) => setConfTf(e.target.value as Tf)}
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              >
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="4h">4h</option>
                <option value="1d">1d</option>
              </select>
            </label>
          </div>
          {(confKind === 'price_below' || confKind === 'price_above') && (
            <label className="block max-w-xs">
              <span className="label block">Zielpreis ({confSymbol})</span>
              <input
                type="number"
                step="any"
                value={priceLevelStr}
                onChange={(e) => setPriceLevelStr(e.target.value)}
                placeholder="z. B. 80000"
                className="field mt-1 w-full px-2.5 py-1.5 text-xs"
              />
            </label>
          )}
        </div>

        {/* DANN: Reaktions-Aktionen */}
        <div className="mt-3 rounded-[0.625rem] border p-3.5 space-y-4" style={{ borderColor: 'var(--color-line)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-pos)' }}>
            DANN — Reaktions-Aktionen (frei kombinierbar)
          </p>

          {/* Aktion A: Trading */}
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={enableTrade}
                onChange={(e) => setEnableTrade(e.target.checked)}
              />
              <span>📉📈 Short / Long Position(en) eröffnen (Signale oder Demo-Auto)</span>
            </label>
            {enableTrade && (
              <div className="grid grid-cols-2 gap-2.5 pl-5 sm:grid-cols-3 lg:grid-cols-6">
                <label className="block col-span-2">
                  <span className="label block">Ziel-Assets</span>
                  <select
                    value={targetScope}
                    onChange={(e) => setTargetScope(e.target.value as TargetScope)}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  >
                    {(Object.keys(SCOPE_LABELS) as TargetScope[]).map((k) => (
                      <option key={k} value={k}>
                        {SCOPE_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {targetScope === 'symbol' && (
                  <label className="block col-span-2">
                    <span className="label block">Symbole (kommagetrennt)</span>
                    <input
                      value={symbolsStr}
                      onChange={(e) => setSymbolsStr(e.target.value)}
                      placeholder="BTC/USDT, ETH/USDT, NVDA"
                      className="field mt-1 w-full px-2 py-1.5 text-xs"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="label block">Richtung</span>
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as 'short' | 'long')}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  >
                    <option value="short">🔴 Short</option>
                    <option value="long">🟢 Long</option>
                  </select>
                </label>
                <label className="block">
                  <span className="label block">Hebel (x)</span>
                  <input
                    type="number"
                    min={1}
                    max={25}
                    value={leverage}
                    onChange={(e) => setLeverage(Number(e.target.value))}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="label block">Risiko %</span>
                  <input
                    type="number"
                    step="0.25"
                    min={0.25}
                    max={5}
                    value={riskPct}
                    onChange={(e) => setRiskPct(Number(e.target.value))}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="label block">SL % / TP %</span>
                  <div className="mt-1 flex gap-1">
                    <input
                      type="number"
                      step="0.5"
                      min={0.5}
                      max={25}
                      value={stopLossPct}
                      onChange={(e) => setStopLossPct(Number(e.target.value))}
                      className="field w-1/2 px-1.5 py-1.5 text-xs"
                      title="Stop-Loss %"
                    />
                    <input
                      type="number"
                      step="1"
                      min={1}
                      max={100}
                      value={takeProfitPct}
                      onChange={(e) => setTakeProfitPct(Number(e.target.value))}
                      className="field w-1/2 px-1.5 py-1.5 text-xs"
                      title="Take-Profit %"
                    />
                  </div>
                </label>
              </div>
            )}
          </div>

          {/* Aktion B: Spot-/Wallet-Bestand verkaufen */}
          <div className="space-y-2.5 border-t pt-3" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={enableSpotSell}
                onChange={(e) => setEnableSpotSell(e.target.checked)}
              />
              <span>💼 Spot- / Wallet-Bestand verkaufen (Bestätigungs-Alarm &amp; Checkliste)</span>
            </label>
            {enableSpotSell && (
              <div className="grid grid-cols-1 gap-2.5 pl-5 sm:grid-cols-3">
                <label className="block">
                  <span className="label block">Börse / Wallet</span>
                  {connections.length > 0 ? (
                    <select
                      value={spotConnectionId}
                      onChange={(e) => {
                        setSpotConnectionId(e.target.value);
                        const hit = connections.find((c) => c.id === e.target.value);
                        if (hit) setSpotVenueHint(hit.exchangeId);
                      }}
                      className="field mt-1 w-full px-2 py-1.5 text-xs"
                    >
                      <option value="">Freie Angabe ({spotVenueHint})</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.exchangeName}
                          {c.label ? ` (${c.label})` : ''} — {c.mode === 'read_only' ? 'nur lesend' : 'Trading'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={spotVenueHint}
                      onChange={(e) => setSpotVenueHint(e.target.value)}
                      placeholder="binance, kraken, wallet…"
                      className="field mt-1 w-full px-2 py-1.5 text-xs"
                    />
                  )}
                </label>
                <label className="block">
                  <span className="label block">Assets (ALL oder BTC, ETH…)</span>
                  <input
                    value={spotAssetsStr}
                    onChange={(e) => setSpotAssetsStr(e.target.value)}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="label block">Verkaufs-Anteil (%)</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={spotSellPct}
                    onChange={(e) => setSpotSellPct(Number(e.target.value))}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  />
                </label>
              </div>
            )}
          </div>

          {/* Aktion C: Hedging hochfahren */}
          <div className="space-y-2 border-t pt-3" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={enableHedge}
                onChange={(e) => setEnableHedge(e.target.checked)}
              />
              <span>🛡️ Portfolio-Hedging automatisch aktivieren / hochfahren</span>
            </label>
            {enableHedge && (
              <div className="pl-5 max-w-xs">
                <label className="block">
                  <span className="label block">Ziel-Hedge-Quote (%)</span>
                  <input
                    type="number"
                    min={10}
                    max={100}
                    value={hedgeRatioPct}
                    onChange={(e) => setHedgeRatioPct(Number(e.target.value))}
                    className="field mt-1 w-full px-2 py-1.5 text-xs"
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Speichern */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={armImmediately}
              onChange={(e) => setArmImmediately(e.target.checked)}
            />
            <span>Direkt scharfstellen (alle 5 Min. automatisch überwachen)</span>
          </label>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="rounded-[0.625rem] border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--color-pos)', background: 'rgba(16,185,129,0.18)', color: 'var(--color-ink)' }}
          >
            {saving ? '⏳ Speichert…' : armImmediately ? '💾 Speichern & Scharfstellen' : '💾 Als Entwurf speichern'}
          </button>
        </div>

        {saveNote && (
          <p className="mt-2 rounded border px-3 py-1.5 text-xs" style={{ borderColor: 'rgba(16,185,129,0.45)', color: 'var(--color-pos)' }}>
            {saveNote}
          </p>
        )}
        {error && <div className="mt-2"><ErrorBox message={error} /></div>}
      </Panel>

      {/* ── Gespeicherte Szenario-Playbooks ── */}
      <Panel label={`3. Deine Szenario-Playbooks (${listData?.playbooks.length ?? 0})`}>
        {loading && !listData ? (
          <Loading />
        ) : !listData || listData.playbooks.length === 0 ? (
          <Empty text="Noch keine Szenario-Playbooks angelegt. Wähle oben eine Vorlage oder beschreibe deine erste Wenn-Dann-Wette." />
        ) : (
          <ul className="mt-3 space-y-3">
            {listData.playbooks.map((pb) => {
              const badge = STATUS_BADGE[pb.status] ?? STATUS_BADGE.draft!;
              const trig = pb.trigger as { keywords?: string[]; vixMin?: number; lookbackHours?: number };
              const conf = pb.confirmation as { kind?: ConfKind; symbol?: string; timeframe?: string };
              const acts = (pb.actions as Array<Record<string, unknown>>) ?? [];
              const liveEval = evalById[pb.id] ?? (pb.lastEvaluation as EvalRes | null);
              const execRes = execById[pb.id];
              const isBusy = busyId === pb.id;

              return (
                <li
                  key={pb.id}
                  className="rounded-[0.625rem] border p-3.5 space-y-2.5"
                  style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">{pb.name}</span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px]"
                          style={{ background: badge.bg, color: badge.color }}
                        >
                          {badge.label}
                        </span>
                        <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                          {pb.executionMode === 'demo_auto' ? '🎮 Demo-Auto' : '📡 Signale + Alarm'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                        <strong>WENN:</strong> {(trig.keywords ?? []).slice(0, 6).join(', ') || 'Manuell'}
                        {trig.vixMin ? ` oder VIX ≥ ${trig.vixMin}` : ''} ·{' '}
                        <strong>BESTÄTIGUNG:</strong> {CONF_LABELS[conf.kind ?? 'none']} ({conf.symbol ?? 'BTC/USDT'} {conf.timeframe ?? '1h'})
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                        {acts.map((a, idx) => (
                          <span
                            key={idx}
                            className="rounded border px-2 py-0.5"
                            style={{ borderColor: 'rgba(6,182,212,0.35)', color: 'var(--color-cyan)' }}
                          >
                            {a.type === 'trade'
                              ? `${String(a.direction).toUpperCase()} ${String(a.leverage)}x · ${a.targetScope === 'symbol' ? ((a.symbols as string[]) ?? []).join(', ') : String(a.targetScope)}`
                              : a.type === 'sell_spot_holdings'
                                ? `Spot verkaufen ${String(a.sellPct)}% (${String(a.venueHint)})`
                                : `Hedging → ${String(a.hedgeRatioPct)}%`}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {pb.status === 'armed' ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void toggleStatus(pb.id, 'paused')}
                          className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                        >
                          ⏸ Pausieren
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void toggleStatus(pb.id, 'armed')}
                          className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                          style={{ borderColor: 'rgba(16,185,129,0.55)', color: 'var(--color-pos)' }}
                        >
                          🟢 Scharfstellen
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void evaluateNow(pb.id)}
                        className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                        style={{ borderColor: 'rgba(6,182,212,0.5)', color: 'var(--color-cyan)' }}
                      >
                        🔍 Live prüfen
                      </button>
                      {confirmTriggerId === pb.id ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void triggerNow(pb.id)}
                          className="rounded border px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                          style={{ borderColor: '#f59e0b', background: 'rgba(245,158,11,0.2)', color: '#fbbf24' }}
                        >
                          ⚠️ Bestätigen: Jetzt auslösen!
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmTriggerId(pb.id)}
                          className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                          style={{ borderColor: 'rgba(245,158,11,0.5)', color: '#fbbf24' }}
                        >
                          ⚡ Manuell auslösen
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void deletePlaybook(pb.id)}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                        style={{ borderColor: 'rgba(239,68,68,0.35)', color: 'var(--color-neg)' }}
                        title="Szenario löschen"
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {/* Letztes Live-Prüfergebnis */}
                  {liveEval && (
                    <div
                      className="rounded border p-2.5 text-xs space-y-1"
                      style={{
                        borderColor: liveEval.matched ? 'rgba(245,158,11,0.5)' : 'rgba(148,163,184,0.18)',
                        background: 'rgba(2,6,23,0.4)',
                      }}
                    >
                      <p>
                        <strong>Letzte Prüfung ({new Date(liveEval.checkedAt).toLocaleString(appLocale())}):</strong>{' '}
                        <span style={{ color: liveEval.matched ? '#fbbf24' : 'var(--color-mut)' }}>{liveEval.summary}</span>
                      </p>
                      {liveEval.trigger?.matchedHeadlines && liveEval.trigger.matchedHeadlines.length > 0 && (
                        <ul className="list-disc pl-5 text-[11px]" style={{ color: 'var(--color-ink)' }}>
                          {liveEval.trigger.matchedHeadlines.slice(0, 3).map((h, i) => (
                            <li key={i}>
                              [{h.source}] {h.title} <span style={{ color: 'var(--color-cyan)' }}>({h.keyword})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Sofort-Ausführungs-Ergebnis */}
                  {execRes && (
                    <div
                      className="rounded border p-2.5 text-xs space-y-1.5"
                      style={{ borderColor: 'rgba(16,185,129,0.5)', background: 'rgba(16,185,129,0.08)' }}
                    >
                      <p className="font-medium" style={{ color: 'var(--color-pos)' }}>
                        ⚡ {execRes.summary}
                      </p>
                      <ul className="space-y-1 text-[11px]">
                        {execRes.actionsTaken.map((a, idx) => (
                          <li key={idx}>• {a.detail}</li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-3 pt-1 text-[11px]">
                        <a href="#/signals" className="underline" style={{ color: 'var(--color-cyan)' }}>
                          → Signale in #/signals öffnen
                        </a>
                        <a href="#/demo" className="underline" style={{ color: 'var(--color-cyan)' }}>
                          → Demo-Konto öffnen
                        </a>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* ── Verlauf & Checklisten ── */}
      {listData && listData.runs.length > 0 && (
        <Panel label={`4. Szenario-Protokoll (letzte ${listData.runs.length} Prüfungen & Auslösungen)`}>
          <ul className="mt-2 space-y-1.5 text-xs">
            {listData.runs.slice(0, 15).map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-1.5"
                style={{ borderColor: 'rgba(148,163,184,0.14)' }}
              >
                <span>
                  <span className="font-medium" style={{ color: r.matched ? '#fbbf24' : 'var(--color-mut)' }}>
                    {r.kind === 'manual_trigger' ? '⚡ Manuell' : r.kind === 'trigger' ? '⚡ Auto-Auslöser' : '🔍 Prüfung'}
                  </span>{' '}
                  — {r.summary}
                </span>
                <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {new Date(r.createdAt).toLocaleString(appLocale())}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
