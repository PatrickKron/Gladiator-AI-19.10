import { useMemo, useState } from 'react';
import { DSL_TIMEFRAMES, type DslTimeframe, type InstructionDsl } from '@gladiator/strategy-engine';
import { trpc } from '../api.js';
import { openAssistant } from './AssistantPanel.js';
import { EquityChart, MetricCard, fmt } from './EquityChart.js';
import { Panel } from './ui.js';
import { appLocale } from '../lib/locale.js';

/**
 * Text-zu-Strategie + Sofort-Demo-Backtest (Welle 16):
 * Nutzer beschreibt seine Idee frei in eigenen Worten → deterministische,
 * Zod-validierte DSL (funktioniert sofort, auch ohne API-Key) → sofortiger
 * echter Netto-Demo-Backtest mit KPI-Auswertung, Equity-Kurve, Live-Reglern
 * zum Feinjustieren bis es passt, 1-Klick-Speichern, Labor-Übergabe und Chat-Hilfe.
 */

type CreateFromTextResult = Awaited<ReturnType<typeof trpc.workshop.createFromText.mutate>>;
type BacktestResult = NonNullable<CreateFromTextResult['backtest']>;
type ValidateResult = Awaited<ReturnType<typeof trpc.workshop.saveAndValidateVersion.mutate>>;

const TEXT_EXAMPLES: Array<{ label: string; symbol: string; tf: DslTimeframe; text: string }> = [
  {
    label: 'RSI-Divergenz + EMA200 (BTC 1h)',
    symbol: 'BTC/USDT',
    tf: '1h',
    text: 'Long auf BTC/USDT im 1h Chart bei bullischer RSI Divergenz über EMA 200 mit 2 ATR Stop-Loss und Take-Profit 3R',
  },
  {
    label: 'EMA 20/50 Cross + ADX (ETH 4h)',
    symbol: 'ETH/USDT',
    tf: '4h',
    text: 'Long ETH/USDT im 4h Chart wenn EMA 20 kreuzt EMA 50 und ADX > 20 mit 2 ATR Stop und Trailing 2,5%',
  },
  {
    label: 'Bollinger-Rebound + RSI (SOL 15m)',
    symbol: 'SOL/USDT',
    tf: '15m',
    text: 'Long SOL/USDT auf 15m am unteren Bollinger Band wenn RSI < 32 mit SL 1,5% und TP 2,5R',
  },
  {
    label: 'Supertrend + MACD (Gold 1h)',
    symbol: 'XAU/USD',
    tf: '1h',
    text: 'Long Gold XAU/USD im 1h Chart wenn Supertrend bullisch und MACD positiv mit 1,8 ATR Stop und TP 3R',
  },
];

const QUICK_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XAU/USD', 'EUR/USD', 'SPY', 'QQQ', 'NVDA', 'AAPL'];

function verdictBadge(m: BacktestResult['metrics']): { label: string; tone: string; hint: string } {
  if (m.tradeCount < 10) {
    return {
      label: 'Wenig Trades',
      tone: 'var(--color-warn)',
      hint: `Nur ${m.tradeCount} Trades im Zeitraum — Zeitrahmen oder Bedingungen etwas lockern, um statistisch aussagekräftige Daten zu bekommen.`,
    };
  }
  const pf = m.profitFactor ?? 0;
  if (m.netReturnPct > 0 && pf >= 1.3 && Math.abs(m.maxDrawdownPct) <= 20) {
    return {
      label: 'Vielversprechend',
      tone: 'var(--color-pos)',
      hint: 'Positive Netto-Rendite, stabiler Profit-Faktor und kontrollierter Drawdown — bereit zum Speichern & offiziellen 12-Monats-Gate.',
    };
  }
  if (m.netReturnPct > 0) {
    return {
      label: 'Ausbaufähig',
      tone: 'var(--color-cyan)',
      hint: 'Netto im Plus, aber Drawdown oder Profit-Faktor lassen sich über Stop-Loss, Take-Profit oder Trailing-Stop noch schärfen.',
    };
  }
  return {
    label: 'Anpassung nötig',
    tone: 'var(--color-neg)',
    hint: 'Netto im Minus — passe Zeitebene, Stop-Loss oder Take-Profit unten an oder hol dir gezielte Vorschläge im Gladiator-Chat.',
  };
}

export function TextStrategyBuilder({ onSaved }: { onSaved?: () => void }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [timeframe, setTimeframe] = useState<DslTimeframe>('1h');
  const [lookbackDays, setLookbackDays] = useState(365);

  const [busy, setBusy] = useState<'build' | 'retest' | 'save' | 'promote' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateFromTextResult | null>(null);
  const [dsl, setDsl] = useState<InstructionDsl | null>(null);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [btError, setBtError] = useState<string | null>(null);
  const [savedVal, setSavedVal] = useState<ValidateResult | null>(null);
  const [promotedMsg, setPromotedMsg] = useState<string | null>(null);

  // Interaktive Anpassungs-Regler (direkt auf der aktuellen DSL)
  const [tuneSymbol, setTuneSymbol] = useState('BTC/USDT');
  const [tuneTf, setTuneTf] = useState<DslTimeframe>('1h');
  const [slType, setSlType] = useState<'ATR' | 'pct'>('ATR');
  const [slVal, setSlVal] = useState(2);
  const [tpRr, setTpRr] = useState(3);
  const [trailPct, setTrailPct] = useState<string>('');
  const [riskPct, setRiskPct] = useState(1);

  function syncSlidersFromDsl(next: InstructionDsl) {
    setTuneSymbol(next.symbol);
    setTuneTf(next.timeframe);
    if (next.stopLoss.type === 'pct') {
      setSlType('pct');
      setSlVal(next.stopLoss.pct);
    } else {
      setSlType('ATR');
      setSlVal(next.stopLoss.mult);
    }
    const maxRr = next.takeProfits[next.takeProfits.length - 1]?.rr ?? 3;
    setTpRr(maxRr);
    setTrailPct(next.trailingStop ? String(next.trailingStop.pct) : '');
    setRiskPct(next.risk.riskPctPerTrade);
  }

  async function buildAndBacktest() {
    if (text.trim().length < 6) return;
    setBusy('build');
    setError(null);
    setBtError(null);
    setSavedVal(null);
    setPromotedMsg(null);
    try {
      const res = await trpc.workshop.createFromText.mutate({
        text: text.trim(),
        ...(name.trim().length >= 3 ? { name: name.trim() } : {}),
        symbol: symbol.trim().toUpperCase() || undefined,
        timeframe,
        autoBacktest: true,
        lookbackDays,
      });
      setCreated(res);
      setDsl(res.dsl);
      syncSlidersFromDsl(res.dsl);
      setBacktest(res.backtest);
      setBtError(res.backtestError);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Strategie konnte nicht erstellt werden.');
    } finally {
      setBusy(null);
    }
  }

  async function retestWithTunedParams() {
    if (!created || !dsl) return;
    setBusy('retest');
    setError(null);
    setBtError(null);
    setSavedVal(null);
    try {
      const parsedTrail = trailPct.trim() === '' ? undefined : Number(trailPct.replace(',', '.'));
      const updatedDsl: InstructionDsl = {
        ...dsl,
        symbol: tuneSymbol.trim().toUpperCase() || dsl.symbol,
        timeframe: tuneTf,
        stopLoss: slType === 'pct' ? { type: 'pct', pct: slVal } : { type: 'ATR', mult: slVal },
        takeProfits: tpRr > 1.8 ? [{ rr: Math.round((tpRr / 2) * 10) / 10 }, { rr: tpRr }] : [{ rr: tpRr }],
        ...(parsedTrail !== undefined && Number.isFinite(parsedTrail) && parsedTrail >= 0.2
          ? { trailingStop: { pct: parsedTrail } }
          : { trailingStop: undefined }),
        risk: { ...dsl.risk, riskPctPerTrade: riskPct },
      };
      const upd = await trpc.workshop.updateDraft.mutate({ id: created.session.id, dsl: updatedDsl });
      if (!upd.ok) {
        setError(`Parameter ungültig: ${upd.errors.join('; ')}`);
        return;
      }
      setDsl(upd.dsl);
      const to = new Date();
      const from = new Date(to.getTime() - lookbackDays * 86_400_000);
      const bt = await trpc.workshop.runBacktest.mutate({
        id: created.session.id,
        label: `Tuning ${upd.dsl.symbol} ${upd.dsl.timeframe} · SL ${slVal}${slType === 'pct' ? '%' : '×ATR'} · TP ${tpRr}R`,
        symbol: upd.dsl.symbol,
        timeframe: upd.dsl.timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
        riskPctPerTrade: riskPct,
        autoFetchCandles: true,
      });
      setBacktest(bt);
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Demo-Backtest fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function saveAndValidate() {
    if (!created) return;
    setBusy('save');
    setError(null);
    setPromotedMsg(null);
    try {
      const res = await trpc.workshop.saveAndValidateVersion.mutate({ id: created.session.id });
      setSavedVal(res);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function promoteToPaper() {
    if (!savedVal?.versionId) return;
    setBusy('promote');
    setError(null);
    try {
      await trpc.strategies.promote.mutate({ versionId: savedVal.versionId });
      setPromotedMsg('Strategie ist jetzt für Paper-Signale aktiv!');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Freischaltung fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  function openInChat() {
    if (!dsl) {
      openAssistant(`Hilf mir, eine klare Trading-Strategie zu entwerfen: ${text.trim()}`);
      return;
    }
    const m = backtest?.metrics;
    const stats = m
      ? `Aktueller Netto-Backtest (${backtest.symbol} ${backtest.timeframe}, ${m.tradeCount} Trades): Rendite ${fmt(m.netReturnPct)}%, Trefferquote ${m.winRate !== null ? fmt(m.winRate * 100, 1) : '—'}%, Profit-Faktor ${fmt(m.profitFactor)}, Max Drawdown ${fmt(m.maxDrawdownPct)}%, Sharpe ${fmt(m.sharpe)}.`
      : 'Noch kein Backtest-Ergebnis vorhanden.';
    openAssistant(
      `Ich habe im Text-Strategie-Builder folgende Strategie erstellt: "${created?.session.name ?? dsl.id}" (${dsl.direction.toUpperCase()} auf ${dsl.symbol} ${dsl.timeframe}). Beschreibung: "${text.trim()}". ${stats} Wie können wir Entry-Filter, Stop-Loss oder Take-Profit sinnvoll verbessern?`,
    );
  }

  const verdict = useMemo(() => (backtest ? verdictBadge(backtest.metrics) : null), [backtest]);

  const laborUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (savedVal?.strategyId) params.set('strategy', savedVal.strategyId);
    if (dsl?.symbol) params.set('symbol', dsl.symbol);
    if (dsl?.timeframe) params.set('tf', dsl.timeframe);
    if (savedVal?.versionId) params.set('version', savedVal.versionId);
    const qs = params.toString();
    return qs ? `#/labor?${qs}` : '#/labor';
  }, [savedVal, dsl]);

  return (
    <div className="space-y-5">
      <Panel label="Strategie im Klartext beschreiben → Sofort-Demo-Backtest" stagger={1}>
        <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          Beschreibe frei in eigenen Worten, wann gekauft oder verkauft werden soll — z. B. mit RSI, Divergenzen, EMA-Kreuzung,
          Bollinger-Bändern, MACD, Supertrend, ADX oder Stop-Loss/Take-Profit. Gladiator übersetzt deine Beschreibung sofort in
          prüfbare Regeln und startet direkt einen echten Netto-Backtest (funktioniert auch ohne API-Key).
        </p>

        {/* Schnell-Beispiele */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="label">Beispiele:</span>
          {TEXT_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => {
                setText(ex.text);
                setSymbol(ex.symbol);
                setTimeframe(ex.tf);
              }}
              className="rounded-md border px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-cyan)]"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
            >
              {ex.label}
            </button>
          ))}
        </div>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="label">Deine Strategie-Idee (Klartext)</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="z. B.: Kaufe BTC/USDT im 1h Chart bei bullischer RSI-Divergenz über EMA 200 mit Stop-Loss 2 ATR, Take-Profit 3R und Trailing 2 %."
            className="field px-3 py-2.5 text-sm leading-relaxed"
          />
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="label">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Meine RSI-Divergenz"
              className="field px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="label">Standard-Markt</span>
            <input
              list="text-strat-symbols"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="field num px-3 py-2 text-sm"
            />
            <datalist id="text-strat-symbols">
              {QUICK_SYMBOLS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="label">Zeitebene</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as DslTimeframe)} className="field num px-3 py-2 text-sm">
              {DSL_TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="label">Test-Zeitraum</span>
            <select value={lookbackDays} onChange={(e) => setLookbackDays(Number(e.target.value))} className="field num px-3 py-2 text-sm">
              <option value={90}>Letzte 3 Monate</option>
              <option value={180}>Letzte 6 Monate</option>
              <option value={365}>Letzte 12 Monate</option>
              <option value={730}>Letzte 24 Monate</option>
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void buildAndBacktest()}
            disabled={busy !== null || text.trim().length < 6}
            className="btn-primary px-5 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {busy === 'build' ? 'Übersetze & backteste…' : 'Strategie erzeugen & sofort Demo-Backtest starten'}
          </button>
          <button
            type="button"
            onClick={openInChat}
            className="rounded-[0.625rem] border px-4 py-2.5 text-sm transition-colors hover:border-[var(--color-cyan)]"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
          >
            💬 Im Gladiator-Chat mitentwickeln
          </button>
        </div>

        {error && (
          <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
            {error}
          </p>
        )}
      </Panel>

      {/* ── Ergebnis-Auswertung + interaktive Anpassungs-Regler ── */}
      {created && dsl && (
        <Panel label={`Auswertung & Feinjustierung · ${created.session.name}`} stagger={2}>
          {/* Erkannte Regeln + Verdict */}
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs font-medium" style={{ color: 'var(--color-ink)' }}>
                {created.summary}
              </p>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span
                  className="rounded border px-2 py-0.5 font-semibold"
                  style={{
                    borderColor: dsl.direction === 'long' ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)',
                    color: dsl.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)',
                  }}
                >
                  {dsl.direction.toUpperCase()}
                </span>
                {created.ruleSummary.conditions.map((c, i) => (
                  <span
                    key={i}
                    className="num rounded px-2 py-0.5"
                    style={{ background: 'rgba(6,182,212,0.12)', color: 'var(--color-cyan)' }}
                  >
                    {c}
                  </span>
                ))}
                <span className="num rounded border px-2 py-0.5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                  SL: {created.ruleSummary.stopLoss}
                </span>
                <span className="num rounded border px-2 py-0.5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                  TP: {created.ruleSummary.takeProfits}
                </span>
              </div>
            </div>
            {verdict && (
              <div
                className="rounded-lg border px-3 py-2 text-xs max-w-sm"
                style={{ borderColor: verdict.tone, background: 'rgba(15,23,42,0.5)' }}
              >
                <p className="font-semibold" style={{ color: verdict.tone }}>
                  Bewertung: {verdict.label}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--color-mut)' }}>
                  {verdict.hint}
                </p>
              </div>
            )}
          </div>

          {btError && (
            <div
              className="mt-4 rounded-[0.625rem] border p-3 text-xs"
              style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}
            >
              Demo-Backtest-Hinweis: {btError} — wähle unten ggf. ein anderes Symbol oder eine andere Zeitebene mit mehr historischen Kerzen.
            </div>
          )}

          {/* KPI-Dashboard */}
          {backtest && (
            <div className="mt-5 space-y-5">
              <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
                <MetricCard
                  label="Netto-Rendite"
                  value={`${fmt(backtest.metrics.netReturnPct)} %`}
                  tone={backtest.metrics.netReturnPct >= 0 ? 'pos' : 'neg'}
                />
                <MetricCard
                  label="Netto-Ergebnis"
                  value={`${fmt(backtest.metrics.netPnl)} $`}
                  tone={backtest.metrics.netPnl >= 0 ? 'pos' : 'neg'}
                />
                <MetricCard
                  label="Trefferquote"
                  value={backtest.metrics.winRate === null ? '—' : `${fmt(backtest.metrics.winRate * 100, 1)} %`}
                />
                <MetricCard
                  label="Profit-Faktor"
                  value={fmt(backtest.metrics.profitFactor)}
                  tone={(backtest.metrics.profitFactor ?? 0) >= 1.3 ? 'pos' : undefined}
                />
                <MetricCard label="Max Drawdown" value={`${fmt(backtest.metrics.maxDrawdownPct)} %`} tone="neg" />
                <MetricCard label="Sharpe Ratio" value={fmt(backtest.metrics.sharpe)} />
                <MetricCard
                  label="Erwartungswert"
                  value={backtest.metrics.expectancy === null ? '—' : `${fmt(backtest.metrics.expectancy)} R`}
                />
                <MetricCard label="Trades / Kerzen" value={`${backtest.metrics.tradeCount} / ${fmt(backtest.candles, 0)}`} />
              </div>

              <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
                <p className="label mb-3">
                  Kapitalkurve (Start 10.000 $, netto inkl. Gebühren & Slippage · {backtest.symbol} {backtest.timeframe})
                </p>
                <EquityChart points={backtest.equityCurve} emptyText="Zu wenig Trades für eine Kurve." step />
              </div>
            </div>
          )}

          {/* Interaktive Parameter-Anpassung bis es passt */}
          <div className="mt-5 rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="label">Parameter anpassen bis es passt</p>
              <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
                Jede Änderung rechnet sofort gegen echte historische Kerzen (netto)
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Markt</span>
                <input value={tuneSymbol} onChange={(e) => setTuneSymbol(e.target.value)} className="field num px-2.5 py-1.5 text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Zeitebene</span>
                <select value={tuneTf} onChange={(e) => setTuneTf(e.target.value as DslTimeframe)} className="field num px-2.5 py-1.5 text-sm">
                  {DSL_TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Stop-Loss Typ</span>
                <select value={slType} onChange={(e) => setSlType(e.target.value as 'ATR' | 'pct')} className="field px-2.5 py-1.5 text-sm">
                  <option value="ATR">ATR-Vielfaches</option>
                  <option value="pct">Fester % Abstand</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Stop-Loss ({slType === 'pct' ? `${slVal} %` : `${slVal}× ATR`})</span>
                <input
                  type="range"
                  min={slType === 'pct' ? 0.5 : 0.8}
                  max={slType === 'pct' ? 10 : 5}
                  step={0.1}
                  value={slVal}
                  onChange={(e) => setSlVal(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[var(--color-cyan)]"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Take-Profit Ziel ({tpRr} R)</span>
                <input
                  type="range"
                  min={1}
                  max={6}
                  step={0.2}
                  value={tpRr}
                  onChange={(e) => setTpRr(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[var(--color-pos)]"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Trailing-Stop % (leer = aus)</span>
                <input
                  type="number"
                  min={0.2}
                  max={25}
                  step={0.2}
                  placeholder="aus"
                  value={trailPct}
                  onChange={(e) => setTrailPct(e.target.value)}
                  className="field num px-2.5 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="label">Risiko pro Trade ({riskPct} %)</span>
                <input
                  type="range"
                  min={0.25}
                  max={3}
                  step={0.25}
                  value={riskPct}
                  onChange={(e) => setRiskPct(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[var(--color-violet)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => void retestWithTunedParams()}
                  disabled={busy !== null}
                  className="btn-primary w-full px-4 py-2 text-xs font-medium disabled:opacity-50"
                >
                  {busy === 'retest' ? 'Rechne neu…' : '↻ Mit Anpassungen neu backtesten'}
                </button>
              </div>
            </div>
          </div>

          {/* Aktions-Leiste: Speichern / Labor / Workshop / Chat */}
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void saveAndValidate()}
              disabled={busy !== null}
              className="btn-primary px-4 py-2 text-xs font-medium disabled:opacity-50"
            >
              {busy === 'save' ? 'Speichere & prüfe 12-Monats-Gate…' : '✓ Als Strategie speichern & validieren'}
            </button>
            <a
              href={laborUrl}
              className="rounded-[0.625rem] border px-4 py-2 text-xs font-medium transition-colors hover:border-[var(--color-cyan)]"
              style={{ borderColor: 'rgba(6,182,212,0.5)', color: 'var(--color-cyan)' }}
            >
              🔬 Im Backtest-Labor optimieren →
            </a>
            <a
              href={`#/strategien?tab=workshop&session=${created.session.id}`}
              className="rounded-[0.625rem] border px-4 py-2 text-xs transition-colors"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              ⚙️ Im Workshop bearbeiten
            </a>
            <button
              type="button"
              onClick={openInChat}
              className="rounded-[0.625rem] border px-4 py-2 text-xs transition-colors"
              style={{ borderColor: 'rgba(139,92,246,0.45)', color: 'var(--color-violet)' }}
            >
              💬 Im Chat weiter verfeinern
            </button>
          </div>

          {/* Offizielles Validitäts-Urteil nach Speichern */}
          {savedVal && (
            <div
              className="mt-4 rounded-[0.625rem] border p-3.5 text-xs space-y-2"
              style={{
                borderColor: savedVal.verdict?.passed ? 'rgba(34,197,94,0.5)' : 'rgba(245,182,66,0.45)',
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium" style={{ color: savedVal.verdict?.passed ? 'var(--color-pos)' : 'var(--color-warn)' }}>
                  {savedVal.verdict?.passed
                    ? `✓ Gespeichert (v${savedVal.version}) & offizielles 12-Monats-Gate bestanden!`
                    : `Gespeichert als Entwurf (v${savedVal.version}) — Validitäts-Gate noch nicht vollständig bestanden`}
                </p>
                {savedVal.verdict?.passed && !promotedMsg && (
                  <button
                    type="button"
                    onClick={() => void promoteToPaper()}
                    disabled={busy !== null}
                    className="rounded border px-3 py-1 text-xs font-medium"
                    style={{ borderColor: 'rgba(34,197,94,0.6)', color: 'var(--color-pos)' }}
                  >
                    {busy === 'promote' ? 'Aktiviere…' : '→ Jetzt für Paper-Signale freischalten'}
                  </button>
                )}
                {!savedVal.verdict?.passed && !promotedMsg && (
                  <button
                    type="button"
                    onClick={async () => {
                      setBusy('promote');
                      setError(null);
                      try {
                        await trpc.strategies.setSignalScan.mutate({
                          strategyId: savedVal.strategyId,
                          enabled: true,
                        });
                        setPromotedMsg('Für Paper-Signale aktiviert (Mensch-im-Loop & Risk-Gate bleiben aktiv).');
                        onSaved?.();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Aktivierung fehlgeschlagen.');
                      } finally {
                        setBusy(null);
                      }
                    }}
                    disabled={busy !== null}
                    className="rounded border px-3 py-1 text-xs font-medium"
                    style={{ borderColor: 'rgba(6,182,212,0.55)', color: 'var(--color-cyan)' }}
                  >
                    {busy === 'promote' ? 'Aktiviere…' : '📡 Trotzdem für Paper-Signale aktivieren'}
                  </button>
                )}
              </div>
              {savedVal.verdict && (
                <ul className="grid gap-1 sm:grid-cols-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {savedVal.verdict.checks.map((c, idx) => (
                    <li key={idx} style={{ color: c.passed ? 'var(--color-pos)' : 'var(--color-warn)' }}>
                      {c.passed ? '✓' : '✗'} {c.detail}
                    </li>
                  ))}
                </ul>
              )}
              {savedVal.backtestError && (
                <p style={{ color: 'var(--color-warn)' }}>{savedVal.backtestError}</p>
              )}
              {promotedMsg && (
                <p className="font-medium" style={{ color: 'var(--color-pos)' }}>
                  ✓ {promotedMsg}
                </p>
              )}
            </div>
          )}

          {/* Letzte Demo-Trades */}
          {backtest && backtest.trades.length > 0 && (
            <div className="mt-5">
              <p className="label mb-2">Letzte Demo-Trades ({Math.min(12, backtest.trades.length)} von {backtest.trades.length})</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs num">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1.5 pr-3 font-normal">Einstieg</th>
                      <th className="py-1.5 pr-3 font-normal">Richtung</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Entry</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Exit</th>
                      <th className="py-1.5 pr-3 text-right font-normal">R</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Netto $</th>
                      <th className="py-1.5 font-normal">Grund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backtest.trades.slice(-12).reverse().map((tr, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                        <td className="py-1.5 pr-3">{new Date(tr.entryTs).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'short' })}</td>
                        <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {tr.direction.toUpperCase()}
                        </td>
                        <td className="py-1.5 pr-3 text-right">{fmt(tr.entry, 2)}</td>
                        <td className="py-1.5 pr-3 text-right">{fmt(tr.exitPrice, 2)}</td>
                        <td className="py-1.5 pr-3 text-right" style={{ color: tr.rMultiple >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {tr.rMultiple >= 0 ? '+' : ''}
                          {fmt(tr.rMultiple, 2)}R
                        </td>
                        <td className="py-1.5 pr-3 text-right" style={{ color: tr.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {tr.netPnl >= 0 ? '+' : ''}
                          {fmt(tr.netPnl, 2)} $
                        </td>
                        <td className="py-1.5" style={{ color: 'var(--color-mut)' }}>
                          {tr.exitReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
